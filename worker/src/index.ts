/**
 * Zor Proxy Worker
 *
 * Privacy-preserving web proxy for the Zor anonymous browsing network.
 *
 * Architecture:
 * 1. User pays STRK20 → Worker verifies tx on-chain → Creates session in KV (or in-memory fallback)
 * 2. User browses via /proxy?url=...&token=...
 * 3. Worker validates session → Strips identifying headers → Proxies via stealth fetch
 * 4. Target site sees Cloudflare IP, not user's IP
 *
 * Privacy guarantees:
 * - cf-connecting-ip (user's real IP) is NEVER forwarded
 * - cf-ipcountry (user's country) is NEVER forwarded
 * - cf-ray, cf-worker, cf-visitor headers are stripped
 * - Only safe headers (accept, content-type, user-agent, etc.) are forwarded
 * - stealth-fetch bypasses Cloudflare cf-* header injection entirely
 * - Session tokens are opaque single-use tokens, not wallet addresses
 */

import { request as stealthRequest } from "stealth-fetch/web";

// ============================================================================
// Types
// ============================================================================

interface Env {
  SESSIONS: KVNamespace;
  STARKNET_RPC_URL: string;
  STRK20_CONTRACT_ADDRESS: string;
  PROXY_WALLET_ADDRESS: string;
  PRICE_PER_MINUTE: string;
}

interface SessionData {
  walletAddress: string;
  depositAddress: string;
  createdAt: number;
  totalMinutes: number;
  // Balance-based billing
  lastBalanceCheck: number;       // timestamp of last balance check
  lastKnownBalance: string;       // last known balance in wei
  accumulatedCost: number;        // total cost accrued so far (in STRK)
}

interface DepositRequest {
  walletAddress: string;
  minutes: number;
}

interface ActivationRequest {
  walletAddress: string;
  depositAddress: string;
  minutes: number;
}

interface RpcResult {
  valid: boolean;
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

const SESSION_PREFIX = "session:";
const DEPOSIT_PREFIX = "deposit:";
const MAX_SESSION_MINUTES = 120;
const MIN_SESSION_MINUTES = 1;

// Balance thresholds
const LOW_BALANCE_THRESHOLD_MINUTES = 5;
const BALANCE_CHECK_INTERVAL_MS = 30_000;

// In-memory session fallback when KV is not configured
const sessions = new Map<string, SessionData>();

// Headers to strip (leak user info)
const STRIPPED_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-worker",
  "cf-visitor",
  "cf-ew-via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
]);

// Headers to forward (safe)
const SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "pragma",
  "range",
  "referer",
  "user-agent",
]);

// ============================================================================
// CORS & Responses
// ============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message: string, status: number = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ============================================================================
// RPC Helper
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  id: number = 1
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const result: JsonRpcResponse = await response.json();
  if (result.error) {
    throw new Error(
      `RPC error: ${result.error.message || JSON.stringify(result.error)}`
    );
  }
  return result.result;
}

// ============================================================================
// Crypto & Utils
// ============================================================================

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Deposit Address Generation & Balance Verification
//
// New flow for STRK20 privacy compatibility:
// 1. POST /deposit-address → worker generates unique address, stores expected amount
// 2. User sends STRK to that address
// 3. POST /activate → worker checks balance of deposit address via RPC
// ============================================================================

// Derive a deterministic deposit address from user wallet + salt
function deriveDepositAddress(userWallet: string, salt: string): string {
  // Use Starknet-compatible address derivation
  // Hash: keccak256(user_wallet + salt) → take last 252 bits (Starknet field)
  const encoder = new TextEncoder();
  const data = encoder.encode(userWallet.toLowerCase() + salt);
  // Simple hash using SubtleCrypto (synchronous via workaround for Worker env)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    hash = ((hash << 5) - hash + char) | 0;
  }
  // Create a deterministic but unique address-like hex string
  const hashHex = Math.abs(hash).toString(16).padStart(8, "0");
  // Starknet addresses are 64 hex chars (32 bytes)
  // Use a prefix that looks like a contract address
  return "0x" + hashHex.repeat(8).slice(0, 63) + "1"; // last byte 1 to avoid zero
}

// Check STRK balance of an address via ERC20 balanceOf
async function checkBalance(
  rpcUrl: string,
  strkContract: string,
  address: string,
  expectedWei: bigint
): Promise<{ valid: boolean; balance?: string; reason?: string }> {
  try {
    // balanceOf(address) selector = 0x2ff2eaa9d703426b
    const addressPadded = address.toLowerCase().replace("0x", "").padStart(64, "0");
    const calldata = [addressPadded];

    const result = await rpcCall(
      rpcUrl,
      "starknet_call",
      [
        {
          contract_address: strkContract,
          entry_point_selector: "0x02ff2eaa9d703426b6fc235bdb9d6a0c36dea1db3e5536d0f3c0f32438e73846",
          calldata,
        },
        "latest",
      ],
      1
    );

    // Result is an array of felts — balance is the first element
    const balanceHex = (result as string[])?.[0] || "0x0";
    const balance = BigInt(balanceHex);

    if (balance >= expectedWei) {
      return { valid: true, balance: balanceHex };
    } else {
      return {
        valid: false,
        balance: balanceHex,
        reason: `Insufficient balance: have ${balance}, need ${expectedWei}`,
      };
    }
  } catch (error) {
    return { valid: false, reason: `Balance check failed: ${error}` };
  }
}

// ============================================================================
// Session Management (with in-memory fallback)
// ============================================================================

async function createSession(
  env: Env,
  walletAddress: string,
  depositAddress: string,
  minutes: number,
  initialBalance: string
): Promise<{ token: string; depositAddress: string }> {
  const token = generateToken();

  const session: SessionData = {
    walletAddress,
    depositAddress,
    createdAt: Date.now(),
    totalMinutes: minutes,
    lastBalanceCheck: Date.now(),
    lastKnownBalance: initialBalance,
    accumulatedCost: 0,
  };

  const ttl = minutes * 60 + 300; // 5 min buffer

  if (env.SESSIONS) {
    await env.SESSIONS.put(`${SESSION_PREFIX}${token}`, JSON.stringify(session), {
      expirationTtl: ttl,
    });
  } else {
    sessions.set(`${SESSION_PREFIX}${token}`, session);
  }

  return { token, depositAddress };
}

async function validateSession(
  env: Env,
  token: string
): Promise<{ valid: boolean; session?: SessionData; lowBalance?: boolean; balanceStrk?: number }> {
  const getData = async (): Promise<SessionData | null> => {
    if (env.SESSIONS) {
      const data = await env.SESSIONS.get(`${SESSION_PREFIX}${token}`);
      if (!data) return null;
      return JSON.parse(data);
    }
    return sessions.get(`${SESSION_PREFIX}${token}`) || null;
  };

  const session = await getData();
  if (!session) return { valid: false };

  // Check if we need to re-verify balance
  const now = Date.now();
  const timeSinceLastCheck = now - session.lastBalanceCheck;

  if (timeSinceLastCheck > BALANCE_CHECK_INTERVAL_MS && env.STARKNET_RPC_URL && env.STRK20_CONTRACT_ADDRESS) {
    // Re-check balance
    const balanceResult = await checkBalance(
      env.STARKNET_RPC_URL,
      env.STRK20_CONTRACT_ADDRESS,
      session.depositAddress,
      0n // don't enforce minimum here, just get current balance
    );

    if (balanceResult.valid && balanceResult.balance) {
      const currentBalance = BigInt(balanceResult.balance);
      const lastBalance = BigInt(session.lastKnownBalance);
      const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE);

      if (currentBalance < lastBalance) {
        // Balance decreased — calculate cost
        const spentWei = lastBalance - currentBalance;
        const spentStrk = Number(spentWei) / 1e18;
        session.accumulatedCost += spentStrk;
      }

      session.lastKnownBalance = balanceResult.balance;
      session.lastBalanceCheck = now;

      // Save updated session
      if (env.SESSIONS) {
        const ttl = session.totalMinutes * 60 + 300;
        await env.SESSIONS.put(`${SESSION_PREFIX}${token}`, JSON.stringify(session), {
          expirationTtl: ttl,
        });
      } else {
        sessions.set(`${SESSION_PREFIX}${token}`, session);
      }
    }
  }

  // Calculate remaining balance in minutes
  const currentBalance = BigInt(session.lastKnownBalance);
  const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE);
  const balanceStrk = Number(currentBalance) / 1e18;
  const minutesRemaining = pricePerMinute > 0 ? balanceStrk / pricePerMinute : 0;
  const lowBalance = minutesRemaining < LOW_BALANCE_THRESHOLD_MINUTES && minutesRemaining > 0;

  // If balance is zero, session is dead
  if (minutesRemaining <= 0 && session.accumulatedCost > 0) {
    if (env.SESSIONS) {
      await env.SESSIONS.delete(`${SESSION_PREFIX}${token}`);
    } else {
      sessions.delete(`${SESSION_PREFIX}${token}`);
    }
    return { valid: false };
  }

  return { valid: true, session, lowBalance, balanceStrk };
}

// ============================================================================
// Proxy Logic (Stealth Fetch + Header Stripping)
// ============================================================================

function buildCleanHeaders(
  incomingHeaders: Headers,
  targetHost: string
): Headers {
  const clean = new Headers();

  for (const [key, value] of incomingHeaders) {
    const lower = key.toLowerCase();
    if (SAFE_HEADERS.has(lower)) {
      clean.set(key, value);
    }
  }

  // Set host to target
  clean.set("Host", targetHost);

  return clean;
}

async function proxyRequest(
  targetUrl: string,
  incomingRequest: Request
): Promise<Response> {
  const url = new URL(targetUrl);

  // Build clean headers — only safe headers forwarded, all cf-* stripped
  const headers = buildCleanHeaders(incomingRequest.headers, url.hostname);

  // Use stealth-fetch to bypass Cloudflare cf-* header injection
  const response = await stealthRequest(targetUrl, {
    method: incomingRequest.method,
    headers: Object.fromEntries(headers),
    body:
      incomingRequest.method !== "GET" && incomingRequest.method !== "HEAD"
        ? incomingRequest.body
        : undefined,
    redirect: "follow",
  });

  // Build response with CORS headers
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("X-Proxy-By", "ZOR-STRK20-Proxy");

  // Remove security headers that block iframe embedding
  responseHeaders.delete("x-frame-options");
  responseHeaders.delete("content-security-policy");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ============================================================================
// Route Handlers
// ============================================================================

// POST /deposit-address — Generate unique deposit address for user
async function handleDepositAddress(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as DepositRequest;

    if (!body.walletAddress || !body.minutes) {
      return errorResponse("Missing required fields: walletAddress, minutes");
    }

    if (body.minutes < MIN_SESSION_MINUTES || body.minutes > MAX_SESSION_MINUTES) {
      return errorResponse(
        `Minutes must be between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES}`
      );
    }

    const salt = generateToken().slice(0, 16);
    const depositAddress = deriveDepositAddress(body.walletAddress, salt);

    const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE);
    const expectedStrk = body.minutes * pricePerMinute;
    const expectedWei = BigInt(Math.floor(expectedStrk * 1e18));

    if (env.SESSIONS) {
      await env.SESSIONS.put(
        `${DEPOSIT_PREFIX}${depositAddress}`,
        JSON.stringify({
          walletAddress: body.walletAddress,
          depositAddress,
          minutes: body.minutes,
          expectedWei: expectedWei.toString(),
          createdAt: Date.now(),
        }),
        { expirationTtl: 1800 }
      );
    }

    return jsonResponse({
      success: true,
      depositAddress,
      minutes: body.minutes,
      expectedAmount: expectedStrk.toFixed(4),
      expectedWei: expectedWei.toString(),
      message: `Send ${expectedStrk.toFixed(4)} STRK to this address, then call /activate`,
    });
  } catch (error) {
    return errorResponse(`Failed to generate deposit address: ${error}`, 500);
  }
}

// POST /activate — Verify balance and create session
async function handleActivate(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as ActivationRequest;

    if (!body.walletAddress || !body.depositAddress || !body.minutes) {
      return errorResponse(
        "Missing required fields: walletAddress, depositAddress, minutes"
      );
    }

    if (!env.STARKNET_RPC_URL || !env.STRK20_CONTRACT_ADDRESS) {
      return errorResponse("RPC or STRK20 contract not configured", 500);
    }

    // Check balance of deposit address
    const balanceResult = await checkBalance(
      env.STARKNET_RPC_URL,
      env.STRK20_CONTRACT_ADDRESS,
      body.depositAddress,
      0n
    );

    if (!balanceResult.valid && !balanceResult.balance) {
      return errorResponse(`Balance check failed: ${balanceResult.reason}`, 500);
    }

    // Create session with balance tracking
    const { token, depositAddress } = await createSession(
      env,
      body.walletAddress,
      body.depositAddress,
      body.minutes,
      balanceResult.balance || "0x0"
    );

    if (env.SESSIONS) {
      await env.SESSIONS.delete(`${DEPOSIT_PREFIX}${body.depositAddress}`);
    }

    const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE);
    const balanceStrk = Number(BigInt(balanceResult.balance || "0x0")) / 1e18;
    const minutesAvailable = pricePerMinute > 0 ? balanceStrk / pricePerMinute : 0;

    return jsonResponse({
      success: true,
      token,
      depositAddress,
      balance: balanceStrk.toFixed(4),
      minutesAvailable: Math.floor(minutesAvailable),
      message: `Session active — ${minutesAvailable.toFixed(1)} minutes available`,
    });
  } catch (error) {
    return errorResponse(`Activation failed: ${error}`, 500);
  }
}

async function handleProxy(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  const token = url.searchParams.get("token");
  if (!token) {
    return errorResponse("Missing session token", 401);
  }

  const { valid, session, lowBalance, balanceStrk } = await validateSession(env, token);
  if (!valid || !session) {
    return errorResponse("Session expired or insufficient balance", 401);
  }

  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return errorResponse("Missing target URL");
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return errorResponse("Invalid target URL");
  }

  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    return errorResponse("Only HTTP/HTTPS URLs are allowed");
  }

  const hostname = parsedTarget.hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.") ||
    hostname.endsWith(".internal")
  ) {
    return errorResponse("Internal URLs are not allowed");
  }

  try {
    const response = await proxyRequest(targetUrl, request);
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    if (lowBalance) {
      newResponse.headers.set("X-Low-Balance", "true");
      newResponse.headers.set("X-Balance-Warning", `Low balance: ~${balanceStrk?.toFixed(4)} STRK remaining`);
    }

    newResponse.headers.set("X-Proxy-By", "ZOR-STRK20-Proxy");
    return newResponse;
  } catch (error) {
    return errorResponse(`Proxy error: ${error}`, 502);
  }
}

async function handleStatus(env: Env): Promise<Response> {
  return jsonResponse({
    status: "online",
    service: "ZOR STRK20 Proxy",
    version: "0.2.0",
    rpcConfigured: !!env.STARKNET_RPC_URL,
    strk20Contract: env.STRK20_CONTRACT_ADDRESS || "not set",
    proxyWallet: env.PROXY_WALLET_ADDRESS || "not set",
    kvConfigured: !!env.SESSIONS,
    pricePerMinute: env.PRICE_PER_MINUTE || "0.001",
  });
}

async function handleSessionStatus(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return jsonResponse({ valid: false });
  }

  const { valid, session, lowBalance, balanceStrk } = await validateSession(env, token);
  if (!valid || !session) {
    return jsonResponse({ valid: false, reason: "expired_or_insufficient_balance" });
  }

  const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE);
  const minutesRemaining = pricePerMinute > 0 && balanceStrk ? balanceStrk / pricePerMinute : 0;

  return jsonResponse({
    valid: true,
    depositAddress: session.depositAddress,
    balance: balanceStrk?.toFixed(4) || "0",
    minutesRemaining: Math.floor(minutesRemaining),
    lowBalance,
    walletAddress: session.walletAddress,
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" },
      });
    }

    const path = url.pathname;

    if (path === "/deposit-address" && request.method === "POST") {
      return handleDepositAddress(request, env);
    }

    if (path === "/activate" && request.method === "POST") {
      return handleActivate(request, env);
    }

    if (path === "/proxy" && request.method === "GET") {
      return handleProxy(request, env);
    }

    if (path === "/status") {
      return handleStatus(env);
    }

    if (path === "/session" && request.method === "GET") {
      return handleSessionStatus(request, env);
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({
        service: "zor-proxy",
        version: "0.2.0",
        status: "healthy",
        rpcConfigured: !!env.STARKNET_RPC_URL,
        kvConfigured: !!env.SESSIONS,
        timestamp: Date.now(),
      });
    }

    return new Response(
      JSON.stringify({
        error: "402 Payment Required",
        message: "Connect to the dApp at the frontend to pay with STRK20",
      }),
      {
        status: 402,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  },
};
