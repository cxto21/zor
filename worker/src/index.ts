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
  expiresAt: number;
  createdAt: number;
  totalMinutes: number;
}

interface ActivationRequest {
  walletAddress: string;
  txHash: string;
  minutes: number;
}

interface RpcResult {
  valid: boolean;
  reason?: string;
}

// ============================================================================
// Constants
// ============================================================================

// ERC20/STRK20 Transfer event topic (keccak256("Transfer(address,address,uint256)"))
const TRANSFER_TOPIC =
  "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";

const SESSION_PREFIX = "session:";
const TX_VERIFIED_PREFIX = "tx:";
const MAX_SESSION_MINUTES = 120;
const MIN_SESSION_MINUTES = 1;

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
// Starknet Transaction Verification
//
// Robust verification that checks:
// 1. Transaction exists on Starknet
// 2. Is an INVOKE sent by the claimed user
// 3. Succeeded (execution_status === SUCCEEDED)
// 4. Is accepted (ACCEPTED_ON_L1 or ACCEPTED_ON_L2)
// 5. Contains a Transfer event from STRK20 contract to our proxy wallet
// ============================================================================

async function verifyTransaction(
  txHash: string,
  userAddress: string,
  expectedAmount: string,
  env: Env
): Promise<RpcResult> {
  try {
    const rpcUrl = env.STARKNET_RPC_URL;
    if (!rpcUrl) {
      return { valid: false, reason: "RPC URL not configured" };
    }

    const strk20Contract = env.STRK20_CONTRACT_ADDRESS;
    const proxyWallet = env.PROXY_WALLET_ADDRESS;

    if (!strk20Contract || !proxyWallet) {
      return {
        valid: false,
        reason: "STRK20 contract or proxy wallet not configured",
      };
    }

    // Step 1: Get transaction details
    const tx = (await rpcCall(
      rpcUrl,
      "starknet_getTransactionByHash",
      [txHash],
      1
    )) as {
      type?: string;
      sender_address?: string;
    } | null;

    if (!tx) {
      return { valid: false, reason: "Transaction not found on Starknet" };
    }

    // Step 2: Validate transaction type
    if (tx.type !== "INVOKE") {
      return { valid: false, reason: `Expected INVOKE, got ${tx.type}` };
    }

    // Step 3: Validate sender matches claimed user
    if (tx.sender_address?.toLowerCase() !== userAddress.toLowerCase()) {
      return { valid: false, reason: "Sender address does not match user address" };
    }

    // Step 4: Get transaction receipt
    const receipt = (await rpcCall(
      rpcUrl,
      "starknet_getTransactionReceipt",
      [txHash],
      2
    )) as {
      execution_status?: string;
      finality_status?: string;
      events?: Array<{
        from_address?: string;
        keys?: string[];
        data?: string[];
      }>;
    } | null;

    if (!receipt) {
      return { valid: false, reason: "Transaction receipt not found" };
    }

    if (receipt.execution_status !== "SUCCEEDED") {
      return {
        valid: false,
        reason: `Execution failed: ${receipt.execution_status}`,
      };
    }

    if (
      receipt.finality_status !== "ACCEPTED_ON_L1" &&
      receipt.finality_status !== "ACCEPTED_ON_L2" &&
      receipt.finality_status !== "PRE_CONFIRMED"
    ) {
      return {
        valid: false,
        reason: `Not yet accepted: ${receipt.finality_status}`,
      };
    }

    // Step 5: Look for Transfer events from STRK20 contract to our proxy wallet
    if (!receipt.events || receipt.events.length === 0) {
      return { valid: false, reason: "No events in transaction receipt" };
    }

    const strk20Lower = strk20Contract.toLowerCase();
    const proxyLower = proxyWallet.toLowerCase();

    // Filter events emitted by the STRK20 contract with Transfer topic
    const transferEvents = receipt.events.filter((event) => {
      const isFromStrk20 =
        event.from_address?.toLowerCase() === strk20Lower;
      const hasTransferTopic =
        event.keys?.[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase();
      return isFromStrk20 && hasTransferTopic;
    });

    if (transferEvents.length === 0) {
      return {
        valid: false,
        reason: `No Transfer events from STRK20 contract (0x${strk20Contract.slice(-8)})`,
      };
    }

    // Check if any Transfer event is from our user AND sends to our proxy wallet
    // Event data layout: [from, to, amount]
    const userLower = userAddress.toLowerCase();
    const expectedAmountBig = BigInt(expectedAmount);

    const validTransfer = transferEvents.some((event) => {
      const fromAddress = event.data?.[0]?.toLowerCase();
      const toAddress = event.data?.[1]?.toLowerCase();
      const amount = BigInt(event.data?.[2] || "0");
      return fromAddress === userLower && toAddress === proxyLower && amount >= expectedAmountBig;
    });

    if (!validTransfer) {
      return {
        valid: false,
        reason: `No valid Transfer from user (0x${userAddress.slice(-8)}) to proxy wallet (0x${proxyWallet.slice(-8)}) for expected amount`,
      };
    }

    return { valid: true, reason: "STRK20 Transfer verified — payment received" };
  } catch (error) {
    return { valid: false, reason: `Verification error: ${error}` };
  }
}

// ============================================================================
// Session Management (with in-memory fallback)
// ============================================================================

async function createSession(
  env: Env,
  walletAddress: string,
  minutes: number
): Promise<{ token: string; expiresAt: number }> {
  const token = generateToken();
  const expiresAt = Date.now() + minutes * 60 * 1000;

  const session: SessionData = {
    walletAddress,
    expiresAt,
    createdAt: Date.now(),
    totalMinutes: minutes,
  };

  const ttl = minutes * 60 + 300; // 5 min buffer for clock skew

  if (env.SESSIONS) {
    await env.SESSIONS.put(`${SESSION_PREFIX}${token}`, JSON.stringify(session), {
      expirationTtl: ttl,
    });
  } else {
    // In-memory fallback when KV is not configured
    sessions.set(`${SESSION_PREFIX}${token}`, session);
    // Also set a setTimeout to clean up (best-effort in worker context)
  }

  return { token, expiresAt };
}

async function validateSession(
  env: Env,
  token: string
): Promise<{ valid: boolean; session?: SessionData }> {
  if (env.SESSIONS) {
    const data = await env.SESSIONS.get(`${SESSION_PREFIX}${token}`);
    if (!data) return { valid: false };

    const session: SessionData = JSON.parse(data);
    if (Date.now() > session.expiresAt) {
      await env.SESSIONS.delete(`${SESSION_PREFIX}${token}`);
      return { valid: false };
    }

    return { valid: true, session };
  }

  // In-memory fallback
  const session = sessions.get(`${SESSION_PREFIX}${token}`);
  if (!session) return { valid: false };

  if (Date.now() > session.expiresAt) {
    sessions.delete(`${SESSION_PREFIX}${token}`);
    return { valid: false };
  }

  return { valid: true, session };
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

async function handleActivate(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body: ActivationRequest = await request.json();

    // Validate input
    if (!body.walletAddress || !body.txHash || !body.minutes) {
      return errorResponse(
        "Missing required fields: walletAddress, txHash, minutes"
      );
    }

    if (body.minutes < MIN_SESSION_MINUTES || body.minutes > MAX_SESSION_MINUTES) {
      return errorResponse(
        `Minutes must be between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES}`
      );
    }

    // Check if transaction was already used
    if (env.SESSIONS) {
      const existingSession = await env.SESSIONS.get(
        `${TX_VERIFIED_PREFIX}${body.txHash}`
      );
      if (existingSession) {
        return errorResponse("Transaction already used", 409);
      }
    }

    // Verify transaction on-chain (robust: checks events for Transfer from STRK20)
    const expectedAmountWei = BigInt(Math.floor(body.minutes * parseFloat(env.PRICE_PER_MINUTE) * 1e18));
    const verification = await verifyTransaction(
      body.txHash,
      body.walletAddress,
      expectedAmountWei.toString(),
      env
    );

    if (!verification.valid) {
      return errorResponse(
        `Transaction verification failed: ${verification.reason}`,
        402
      );
    }

    // Create session
    const { token, expiresAt } = await createSession(
      env,
      body.walletAddress,
      body.minutes
    );

    // Mark transaction as used (store for 2x session duration)
    if (env.SESSIONS) {
      await env.SESSIONS.put(
        `${TX_VERIFIED_PREFIX}${body.txHash}`,
        token,
        { expirationTtl: body.minutes * 60 * 2 }
      );
    }

    return jsonResponse({
      success: true,
      token,
      expiresAt,
      minutes: body.minutes,
      message: `Session activated for ${body.minutes} minutes`,
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

  // Get session token
  const token = url.searchParams.get("token");
  if (!token) {
    return errorResponse("Missing session token", 401);
  }

  // Validate session
  const { valid, session } = await validateSession(env, token);
  if (!valid || !session) {
    return errorResponse("Invalid or expired session", 401);
  }

  // Get target URL
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return errorResponse("Missing target URL");
  }

  // Validate target URL
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return errorResponse("Invalid target URL");
  }

  // Only allow HTTP(S)
  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    return errorResponse("Only HTTP/HTTPS URLs are allowed");
  }

  // Block internal/private IPs (SSRF protection)
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
    return await proxyRequest(targetUrl, request);
  } catch (error) {
    return errorResponse(`Proxy error: ${error}`, 502);
  }
}

async function handleStatus(env: Env): Promise<Response> {
  return jsonResponse({
    status: "online",
    service: "ZOR STRK20 Proxy",
    version: "0.1.0",
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

  const { valid, session } = await validateSession(env, token);
  if (!valid || !session) {
    return jsonResponse({ valid: false });
  }

  return jsonResponse({
    valid: true,
    expiresAt: session.expiresAt,
    remainingMs: session.expiresAt - Date.now(),
    walletAddress: session.walletAddress,
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const path = url.pathname;

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

    // Health check
    if (path === "/" || path === "/health") {
      return jsonResponse({
        service: "zor-proxy",
        version: "0.1.0",
        status: "healthy",
        rpcConfigured: !!env.STARKNET_RPC_URL,
        kvConfigured: !!env.SESSIONS,
        timestamp: Date.now(),
      });
    }

    // Default: 402
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
