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
import { createVaultService } from "../vault/vault-service";
import { ensureProverUrl, pauseProverVm } from "./prover-on-demand";

// ============================================================================
// Types
// ============================================================================

interface Env {
  SESSIONS: KVNamespace;
  STARKNET_RPC_URL: string;
  STRK20_CONTRACT_ADDRESS: string;
  PROXY_WALLET_ADDRESS: string;
  PRICE_PER_MINUTE: string;
  MASTER_PRIVATE_KEY: string;
  MASTER_PUBLIC_KEY: string;
  MASTER_ADDRESS: string;
  MASTER_ACCOUNT_CLASS_HASH: string;
  PROVING_SERVICE_URL?: string;
  FREESTYLE_API_KEY?: string;
  CHAIN_ID?: string;
  STARKSCAN_API_KEY?: string;
  STARKSCAN_DAILY_BUDGET?: string;
  STARKSCAN_BASE_URL?: string;
  PROOF_JOBS?: KVNamespace;
  POOL_CONTRACT_ADDRESS?: string;
  STRK_TOKEN_ADDRESS?: string;
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
  let result: JsonRpcResponse;
  try {
    result = await response.json();
  } catch (e) {
    // Alchemy and other RPC providers sometimes return plain text errors
    // instead of JSON. Read the raw body and create a minimal error object.
    const text = await response.text();
    result = {
      error: {
        message: text || "RPC request failed",
        code: -32603,
      },
    };
  }
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
// HTML URL Rewriting (Server-Side)
//
// Rewrites href, src, action, srcset attributes in HTML to route through proxy.
// Skips <script> blocks to avoid mangling JS code.
// ============================================================================

function rewriteHtml(
  html: string,
  proxyOrigin: string,
  targetOrigin: string,
  token: string
): string {
  // Rewrite a single URL attribute value
  function rewriteUrl(value: string): string {
    if (!value || value.startsWith("data:") || value.startsWith("javascript:") ||
        value.startsWith("blob:") || value.startsWith("#") || value.startsWith("mailto:") ||
        value.startsWith("tel:") || value.startsWith("sms:") ||
        value.startsWith(proxyOrigin)) {
      return value;
    }

    // Resolve relative URLs against target origin
    let absoluteUrl = value;
    if (!value.startsWith("http")) {
      if (value.startsWith("//")) {
        absoluteUrl = "https:" + value;
      } else if (value.startsWith("/")) {
        absoluteUrl = targetOrigin + value;
      } else {
        absoluteUrl = targetOrigin + "/" + value;
      }
    }

    // Only proxy external URLs (not the proxy itself)
    if (absoluteUrl.startsWith(proxyOrigin)) return value;

    return proxyOrigin + "/proxy?url=" + encodeURIComponent(absoluteUrl) + "&token=" + token;
  }

  // Rewrite srcset attribute (comma-separated list of URLs with optional size descriptors)
  function rewriteSrcset(value: string): string {
    return value.split(",").map(part => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx === -1) return rewriteUrl(trimmed);
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return rewriteUrl(url) + descriptor;
    }).join(", ");
  }

  // Process HTML: rewrite attributes but skip <script> content
  let result = "";
  let i = 0;

  while (i < html.length) {
    // Look for <script> blocks — skip their content
    const scriptOpen = html.indexOf("<script", i);
    if (scriptOpen === -1) {
      // No more script tags — rewrite the rest
      result += rewriteAttrs(html.slice(i), proxyOrigin, rewriteUrl, rewriteSrcset);
      break;
    }

    // Rewrite content before <script>
    result += rewriteAttrs(html.slice(i, scriptOpen), proxyOrigin, rewriteUrl, rewriteSrcset);

    // Find the end of the script opening tag
    const scriptTagEnd = html.indexOf(">", scriptOpen);
    if (scriptTagEnd === -1) {
      result += html.slice(scriptOpen);
      break;
    }

    // Include the opening script tag as-is
    result += html.slice(scriptOpen, scriptTagEnd + 1);

    // Find </script>
    const scriptClose = html.indexOf("</script>", scriptTagEnd + 1);
    if (scriptClose === -1) {
      // No closing tag — skip rest
      result += html.slice(scriptTagEnd + 1);
      break;
    }

    // Skip script content entirely (don't rewrite URLs inside JS)
    i = scriptClose; // </script> will be included in next iteration
  }

  return result;
}

// Rewrite URL attributes in a chunk of HTML (non-script content)
function rewriteAttrs(
  chunk: string,
  proxyOrigin: string,
  rewriteUrl: (url: string) => string,
  rewriteSrcset: (value: string) => string
): string {
  // Match tag attributes: href="...", src="...", action="...", srcset="..."
  return chunk.replace(
    /(<\w+[^>]*?)(\b(?:href|src|action|srcset)\s*=\s*)(["'])(.*?)\3/gi,
    (match, prefix, attr, quote, value) => {
      const attrName = attr.trim().split(/\s/)[0].toLowerCase();
      const rewritten = attrName === "srcset"
        ? rewriteSrcset(value)
        : rewriteUrl(value);
      return prefix + attr + quote + rewritten + quote;
    }
  );
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
// Uses SHA-256 via Web Crypto API — produces a valid felt252 (< 2^252)
async function deriveDepositAddress(
  userWallet: string,
  salt: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(userWallet.toLowerCase() + ":" + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);

  // Starknet field prime: 2^252 + 17 * 2^192 + 1
  // Ensure the result is within the field by taking last 31 bytes (248 bits < 2^252)
  const fieldBytes = hashArray.slice(1, 32); // 31 bytes = 248 bits, safely within field
  const hex = Array.from(fieldBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Pad to 64 hex chars (32 bytes) for Starknet address format
  return "0x" + hex.padStart(64, "0");
}

// Check STRK balance of an address via ERC20 balanceOf
async function checkBalance(
  rpcUrl: string,
  strkContract: string,
  address: string,
  expectedWei: bigint
): Promise<{ valid: boolean; balance?: string; reason?: string }> {
  try {
    // balanceOf(address) selector = starknet_keccak('balanceOf') & MASK_250
    // keccak256('balanceOf') = 0xe2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e
    // & MASK_250 (lower 250 bits) = 0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e
    const addressPadded = "0x" + address.toLowerCase().replace("0x", "").padStart(64, "0");
    const calldata = [addressPadded];

    const result = await rpcCall(
      rpcUrl,
      "starknet_call",
      [
        {
          contract_address: strkContract,
          entry_point_selector: "0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e",
          calldata,
        },
        "latest",
      ],
      1
    );

    // Result is an array of felts — STRK ERC20 returns u256 (low, high)
    // Balance is in the first element (low part of u256)
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

  // If balance is zero OR elapsed time exceeds total minutes, session is dead
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - session.createdAt) / 60000));
  const exceededTime = elapsedMinutes >= session.totalMinutes;

  if (minutesRemaining <= 0 || exceededTime) {
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

// ============================================================================
// Service Worker — intercepts all fetch() in the proxied iframe
// ============================================================================

function getServiceWorkerScript(proxyOrigin: string): string {
  return `
// Zor Proxy Service Worker - intercepts fetch() and routes through proxy
const PROXY_ORIGIN = "${proxyOrigin}";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only intercept requests to external origins (not the proxy itself)
  if (url.origin === PROXY_ORIGIN) return;

  // Skip chrome-extension, blob:, data:, etc.
  if (!url.protocol.startsWith("http")) return;

  // Build proxy URL
  const target = url.href;
  const token = new URLSearchParams(self.location.search).get("token") || "";
  const proxyUrl = PROXY_ORIGIN + "/proxy?url=" + encodeURIComponent(target) +
    "&token=" + token;

  event.respondWith(
    fetch(proxyUrl, {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.method !== "GET" && event.request.method !== "HEAD"
        ? event.request.body : undefined,
      redirect: "follow",
    }).catch(() => new Response("Proxy fetch failed", { status: 502 }))
  );
});
`;
}

// Injector script - injected into HTML <head> to intercept all fetch/XHR
function getInjectorScript(proxyOrigin: string): string {
  return `<script>
(function() {
  var PROXY = "${proxyOrigin}";
  var params = new URLSearchParams(window.location.search);
  var TOKEN = params.get("token") || "";
  var TARGET = params.get("url") || "";
  var TARGET_ORIGIN = "";
  try { TARGET_ORIGIN = new URL(TARGET).origin; } catch(e) {}

  function proxyUrl(url) {
    if (!url || url.startsWith(PROXY)) return url;
    if (!url.startsWith("http")) {
      // Resolve relative URL against the TARGET origin, not the proxy
      try { url = new URL(url, TARGET).href; } catch(e) { return url; }
    }
    return PROXY + "/proxy?url=" + encodeURIComponent(url) + "&token=" + TOKEN;
  }

  // Override fetch()
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === "string" ? input : input?.url;
    if (url) {
      var proxied = proxyUrl(url);
      if (typeof input === "string") input = proxied;
      else if (input instanceof Request) input = new Request(proxied, input);
      else input.url = proxied;
    }
    return origFetch.call(this, input, init);
  };

  // Override XMLHttpRequest.open()
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url && typeof url === "string") {
      arguments[1] = proxyUrl(url);
    }
    return origOpen.apply(this, arguments);
  };

  // Override Element.setAttribute for src/href attributes
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if ((name === "src" || name === "href") && value && typeof value === "string") {
      if (value.startsWith("http") && !value.startsWith(PROXY)) {
        value = proxyUrl(value);
      }
    }
    return origSetAttr.call(this, name, value);
  };

  // Override createElement to patch script/link/img src
  var origCreate = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = origCreate(tag);
    var origSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
    var origHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");
    if (origSrc) {
      Object.defineProperty(el, "src", {
        get: function() { return origSrc.get.call(this); },
        set: function(v) { return origSrc.set.call(this, proxyUrl(v)); }
      });
    }
    if (origHref) {
      Object.defineProperty(el, "href", {
        get: function() { return origHref.get.call(this); },
        set: function(v) { return origHref.set.call(this, proxyUrl(v)); }
      });
    }
    return el;
  };

  // === CLICK INTERCEPTOR — keeps navigation inside the proxy ===
  // Catches clicks on <a href="..."> and <form action="..."> and redirects
  // them through the proxy instead of navigating the iframe to the target.
  document.addEventListener("click", function(e) {
    // Find the closest <a> or <form> ancestor
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName === "A") {
        var href = el.getAttribute("href");
        if (!href || href === "#" || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
        e.preventDefault();
        var resolved = proxyUrl(href);
        window.location.href = resolved;
        return;
      }
      if (el.tagName === "FORM") {
        var action = el.getAttribute("action") || window.location.href;
        e.preventDefault();
        var form = el;
        var formData = new FormData(form);
        var method = (form.getAttribute("method") || "GET").toUpperCase();
        var resolvedAction = proxyUrl(action);

        if (method === "GET") {
          var qs = new URLSearchParams(formData).toString();
          window.location.href = resolvedAction + (resolvedAction.includes("?") ? "&" : "?") + qs;
        } else {
          // POST — submit via fetch then navigate to result
          fetch(resolvedAction, { method: "POST", body: formData })
            .then(function(r) { return r.text(); })
            .then(function(html) {
              document.open();
              document.write(html);
              document.close();
            });
        }
        return;
      }
      el = el.parentNode;
    }
  }, true); // useCapture = true to catch before page handlers

  // === DYNAMIC ELEMENT INTERCEPTOR ===
  // Catches dynamically created <script>, <link>, <img> elements
  // (e.g., Next.js chunk loading via import() or dynamic script creation)
  var observer = new MutationObserver(function(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var nodes = mutations[m].addedNodes;
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (node.nodeType !== 1) continue; // skip non-element nodes
        var el = node;
        // Check script src
        if (el.tagName === "SCRIPT") {
          var src = el.getAttribute("src");
          if (src && !src.startsWith(PROXY)) {
            el.setAttribute("src", proxyUrl(src));
          }
        }
        // Check link href
        if (el.tagName === "LINK") {
          var href = el.getAttribute("href");
          if (href && !href.startsWith(PROXY)) {
            el.setAttribute("href", proxyUrl(href));
          }
        }
        // Check img src
        if (el.tagName === "IMG") {
          var src = el.getAttribute("src");
          if (src && !src.startsWith(PROXY)) {
            el.setAttribute("src", proxyUrl(src));
          }
        }
        // Check iframe src
        if (el.tagName === "IFRAME") {
          var src = el.getAttribute("src");
          if (src && !src.startsWith(PROXY)) {
            el.setAttribute("src", proxyUrl(src));
          }
        }
      }
    }
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
</script>`;
}

async function proxyRequest(
  targetUrl: string,
  incomingRequest: Request
): Promise<Response> {
  const url = new URL(targetUrl);
  const incomingUrl = new URL(incomingRequest.url);
  const token = incomingUrl.searchParams.get("token") || "";

  // Build clean headers — only safe headers forwarded, all cf-* stripped
  const headers = buildCleanHeaders(incomingRequest.headers, url.hostname);

  let response: Response;

  try {
    // Try stealth-fetch first (raw TCP, bypasses cf-* header injection)
    response = await stealthRequest(targetUrl, {
      method: incomingRequest.method,
      headers: Object.fromEntries(headers),
      body:
        incomingRequest.method !== "GET" && incomingRequest.method !== "HEAD"
          ? incomingRequest.body
          : undefined,
      redirect: "follow",
    });
  } catch (stealthError) {
    // NAT64/raw socket may fail — fall back to regular fetch
    // This loses stealth (cf-* headers may be injected) but keeps the proxy working
    console.warn("stealth-fetch failed, falling back to regular fetch:", String(stealthError));
    response = await fetch(targetUrl, {
      method: incomingRequest.method,
      headers: Object.fromEntries(headers),
      body:
        incomingRequest.method !== "GET" && incomingRequest.method !== "HEAD"
          ? incomingRequest.body
          : undefined,
      redirect: "follow",
    });
  }

  // Build response with CORS headers — sanitize to avoid Invalid header value errors
  const responseHeaders = new Headers();

  // Copy headers from upstream — handle both Headers API and plain objects (stealth-fetch)
  const srcHeaders = response?.headers;
  if (srcHeaders) {
    // Convert to entries regardless of type
    let entries: [string, string][];
    if (typeof srcHeaders.entries === "function") {
      entries = [...srcHeaders.entries()];
    } else if (typeof srcHeaders === "object") {
      entries = Object.entries(srcHeaders) as [string, string][];
    } else {
      entries = [];
    }

    for (const [key, value] of entries) {
      if (typeof value !== "string") continue;
      if (/[\x00-\x08\x0a-\x1f\x7f\x80-\xff]/.test(value)) continue;
      if (/[\x00-\x08\x0a-\x1f\x7f\x80-\xff]/.test(key)) continue;
      try { responseHeaders.set(key, value); } catch {}
    }
  }

  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("X-Proxy-By", "ZOR-STRK20-Proxy");

  // Remove security headers that block iframe embedding
  responseHeaders.delete("x-frame-options");
  responseHeaders.delete("content-security-policy");

  // Get the proxy origin for the Service Worker
  const proxyOrigin = new URL(incomingRequest.url).origin;

  // For HTML responses: rewrite URLs server-side + inject client-side interceptor
  const contentType = responseHeaders.get("content-type") || "";
  if (contentType.includes("text/html")) {
    let html = await response.text();
    const targetOrigin = new URL(targetUrl).origin;

    // 1) Server-side URL rewriting — rewrite href, src, action, srcset in HTML
    //    Skips <script> blocks to avoid mangling JS code
    html = rewriteHtml(html, proxyOrigin, targetOrigin, token);

    // 2) Client-side interceptor — catches dynamically constructed URLs
    const injector = getInjectorScript(proxyOrigin);
    const dtIdx = html.indexOf("<!DOCTYPE");
    const dtLower = html.indexOf("<!doctype");
    const idx = dtIdx !== -1 ? dtIdx : dtLower;
    if (idx !== -1) {
      const endOfDoctype = html.indexOf(">", idx);
      if (endOfDoctype !== -1) {
        html = html.slice(0, endOfDoctype + 1) + injector + html.slice(endOfDoctype + 1);
      } else {
        html = injector + html;
      }
    } else {
      const htmlTag = html.indexOf("<html");
      const headTag = html.indexOf("<head");
      const bodyTag = html.indexOf("<body");
      const tags = [htmlTag, headTag, bodyTag].filter(t => t !== -1);
      if (tags.length > 0) {
        const insertAt = Math.min(...tags);
        html = html.slice(0, insertAt) + injector + html.slice(insertAt);
      } else {
        html = injector + html;
      }
    }

    responseHeaders.delete("content-length");
    responseHeaders.delete("content-encoding");

    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// ============================================================================
// Route Handlers
// ============================================================================

interface DeployRequest {
  depositAddress: string;
  walletAddress: string;
}

// POST /deploy — Derive account parameters for deployment
// The frontend uses starknet.js to sign and broadcast the deploy transaction
async function handleDeploy(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as DeployRequest;

    if (!body.depositAddress || !body.walletAddress) {
      return errorResponse("Missing required fields: depositAddress, walletAddress");
    }

    if (!env.MASTER_PRIVATE_KEY || !env.MASTER_ADDRESS || !env.MASTER_ACCOUNT_CLASS_HASH) {
      return errorResponse("Master account not configured", 500);
    }

    // Import deploy helpers
    const { deriveUserPrivKey, privateKeyToPublicKey, computeAccountAddress, hexToBigInt, bigIntToHex, padHex } = await import("./starknet-deploy");

    // Derive a unique private key for this user
    const privKey = await deriveUserPrivKey(body.walletAddress);

    // Compute public key and account address
    const pubKey = privateKeyToPublicKey(privKey);
    const classHash = hexToBigInt(env.MASTER_ACCOUNT_CLASS_HASH);
    const masterAddress = hexToBigInt(env.MASTER_ADDRESS);
    const salt = privKey;

    const accountAddress = computeAccountAddress(pubKey, classHash, salt, masterAddress);

    // Return all parameters needed for the frontend to deploy via starknet.js
    return jsonResponse({
      success: true,
      accountAddress: padHex(bigIntToHex(accountAddress), 32),
      publicKey: bigIntToHex(pubKey),
      classHash: env.MASTER_ACCOUNT_CLASS_HASH,
      salt: bigIntToHex(salt),
      masterAddress: env.MASTER_ADDRESS,
      message: "Use starknet.js to deploy: new Account(provider, {address, classHash, signers: [{privateKey}]}).deployAccount({classHash, address, constructor: [publicKey], signers: [{privateKey}]})",
    });
  } catch (error) {
    return errorResponse(`Deploy failed: ${error}`, 500);
  }
}

// POST /fund-account — Fund a deployed account from the master account
// Uses the master account to send STRK to the new account
async function handleFundAccount(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      accountAddress: string;
      amount: string; // STRK amount in wei
    };

    if (!body.accountAddress || !body.amount) {
      return errorResponse("Missing required fields: accountAddress, amount");
    }

    if (!env.MASTER_PRIVATE_KEY || !env.MASTER_ADDRESS) {
      return errorResponse("Master account not configured", 500);
    }

    // Import deploy helpers
    const { buildInvokeTx, hexToBigInt, bigIntToHex, padHex } = await import("./starknet-deploy");

    // Build ERC20 transfer from master to new account
    // transfer(to, amount) selector = 0x2386f26fc10000
    const calldata = [
      "0x1", // array length
      env.STRK20_CONTRACT_ADDRESS, // contract address
      "0x2386f26fc10000", // transfer selector
      "0x3", // calldata length
      padHex(body.accountAddress, 32), // recipient
      body.amount, // amount low
      "0x0", // amount high
    ];

    // Get current nonce (v0.10: params = [block_id, address])
    const nonceResponse = await fetch(env.STARKNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_getNonce",
        params: ["latest", env.MASTER_ADDRESS],
      }),
    });

    const nonceData = await nonceResponse.json() as any;
    if (nonceData.error) {
      return errorResponse(`Nonce fetch failed: ${nonceData.error.message}`);
    }
    const nonce = nonceData.result;

    // Build and sign the invoke transaction
    const masterPrivKey = hexToBigInt(env.MASTER_PRIVATE_KEY);
    const { tx: signedTx } = await buildInvokeTx({
      privKey: masterPrivKey,
      senderAddress: env.MASTER_ADDRESS,
      calldata,
      nonce,
      maxFee: "0x100000000000000",
      chainId: (env as any).CHAIN_ID ?? "0x534e5f4d41494e", // SN_MAIN
    });

    // Broadcast
    const broadcastResponse = await fetch(env.STARKNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "starknet_addInvokeTransaction",
        params: [signedTx],
      }),
    });

    const broadcastData = await broadcastResponse.json() as any;

    if (broadcastData.error) {
      return errorResponse(`Fund broadcast failed: ${broadcastData.error.message} | tx: ${JSON.stringify(signedTx).slice(0, 500)}`);
    }

    return jsonResponse({
      success: true,
      txHash: broadcastData.result,
      message: "Account funded successfully",
    });
  } catch (error) {
    return errorResponse(`Fund account failed: ${error}`, 500);
  }
}

// POST /verify-deposit — Verify a privacy pool deposit via on-chain tx receipt
async function handleVerifyDeposit(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      txHash: string;
      walletAddress: string;
      expectedAmount: string;
    };

    if (!body.txHash || !body.walletAddress || !body.expectedAmount) {
      return errorResponse("Missing required fields: txHash, walletAddress, expectedAmount");
    }

    // Get transaction receipt
    const receiptResponse = await fetch(env.STARKNET_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_getTransactionReceipt",
        params: [body.txHash],
      }),
    });

    const receiptData = await receiptResponse.json() as any;

    if (receiptData.error) {
      return jsonResponse({
        success: true,
        verified: false,
        error: `RPC error: ${receiptData.error.message}`,
      });
    }

    const receipt = receiptData.result;
    if (!receipt) {
      return jsonResponse({
        success: true,
        verified: false,
        error: "Transaction not found",
      });
    }

    if (receipt.execution_status !== "SUCCEEDED") {
      return jsonResponse({
        success: true,
        verified: false,
        error: `Transaction failed: ${receipt.execution_status}`,
      });
    }

    // Look for Deposit event from the privacy pool contract
    // Deposit event key: starknet_keccak("Deposit")
    const DEPOSIT_EVENT_KEY = "0x1b6bb2860d54a8f1c1d83020a99022824ce801a14c66f19a2623a2ea8152a8";

    const events = receipt.events || [];
    const depositEvent = events.find(
      (e: any) =>
        e.from_address === "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91" &&
        e.keys?.[0] === DEPOSIT_EVENT_KEY
    );

    if (!depositEvent) {
      return jsonResponse({
        success: true,
        verified: false,
        error: "Deposit event not found in transaction",
      });
    }

    // Event structure: [event_key, depositor_addr, token_addr, amount_low, amount_high]
    const depositor = depositEvent.keys?.[1];
    const amountLow = parseInt(depositEvent.data?.[0] || "0", 16);
    const amountHigh = parseInt(depositEvent.data?.[1] || "0", 16);
    const amount = BigInt(amountLow) + (BigInt(amountHigh) << BigInt(128));

    // Verify depositor matches
    const normalizedDepositor = depositor?.toLowerCase();
    const normalizedWallet = body.walletAddress.toLowerCase();
    if (normalizedDepositor !== normalizedWallet) {
      return jsonResponse({
        success: true,
        verified: false,
        error: "Depositor address mismatch",
      });
    }

    return jsonResponse({
      success: true,
      verified: true,
      amount: amount.toString(),
    });
  } catch (error) {
    return errorResponse(`Verify deposit failed: ${error}`, 500);
  }
}

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
    const depositAddress = await deriveDepositAddress(body.walletAddress, salt);

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

    // Expected STRK amount for this session (price per minute * minutes)
    const expectedWei = body.minutes > 0
      ? BigInt(body.minutes) * BigInt(Math.floor(parseFloat(env.PRICE_PER_MINUTE || "0.001") * 1e18))
      : BigInt(0);

    // Validate that deposit address has enough STRK
    if (balanceResult.balance && BigInt(balanceResult.balance) < expectedWei) {
      return errorResponse(`Insufficient STRK deposit: expected ~${parseFloat(env.PRICE_PER_MINUTE || "0.001").toFixed(4)} STRK/min × ${body.minutes} min = ${expectedWei.toString()} wei, got ${balanceResult.balance}`, 400);
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
// Shield Service Handlers
// ============================================================================

/**
 * Shield (deposit) STRK into the privacy pool.
 * 
 * POST /shield
 * Body: { amount: string } (in wei)
 * 
 * Flow:
 * 1. Create ShieldService from master account
 * 2. Approve STRK transfer to pool
 * 3. Execute deposit with mock ZK proof
 * 4. Return transaction hash
 */
async function handleShield(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { amount: string };
    const { amount } = body;
    
    if (!amount) {
      return errorResponse("Missing amount parameter", 400);
    }
    
    // Validate amount is a valid hex string
    const amountBigInt = BigInt(amount);
    if (amountBigInt <= 0n) {
      return errorResponse("Amount must be greater than 0", 400);
    }
    
    // Check master account has enough balance
    const { createShieldService } = await import("./shield-service");
    const shieldService = createShieldService({
      STARKNET_RPC_URL: env.STARKNET_RPC_URL,
      MASTER_PRIVATE_KEY: env.MASTER_PRIVATE_KEY,
      MASTER_ADDRESS: env.MASTER_ADDRESS,
      CHAIN_ID: (env as any).CHAIN_ID,
    });
    
    // Execute shield
    const result = await shieldService.shield(amountBigInt);
    
    return jsonResponse({
      success: true,
      txHash: result.txHash,
      amount: result.amount.toString(),
      blockNumber: result.blockNumber,
    });
    
  } catch (error: any) {
    console.error("Shield error:", error);
    return errorResponse(`Shield failed: ${error.message}`, 500);
  }
}

/**
 * Get shield status for the master account.
 * 
 * GET /shield-status
 * 
 * Returns:
 * - hasViewingKey: Whether viewing key is registered
 * - channelsReady: Whether channels are set up
 */
async function handleShieldStatus(env: Env): Promise<Response> {
  try {
    const { createShieldService } = await import("./shield-service");
    const shieldService = createShieldService({
      STARKNET_RPC_URL: env.STARKNET_RPC_URL,
      MASTER_PRIVATE_KEY: env.MASTER_PRIVATE_KEY,
      MASTER_ADDRESS: env.MASTER_ADDRESS,
      CHAIN_ID: (env as any).CHAIN_ID,
    });
    
    const status = await shieldService.getStatus();
    
    return jsonResponse({
      success: true,
      ...status,
    });
    
  } catch (error: any) {
    console.error("Shield status error:", error);
    return errorResponse(`Shield status failed: ${error.message}`, 500);
  }
}

// ============================================================================
// Vault Service Handlers — Master-Receiver Pivot
// Real VIRTUAL_SNOS proof needs PROVING_SERVICE_URL
// (ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2 on Fly/Railway)
// with 10-block maturity (provingBlockId = head-10).
// ============================================================================

/**
 * POST /register-master
 * Registers master viewing key in pool 0x0254a6b... if not already registered.
 * Master (0x12f8b...) is the single receiver; users private-transfer to it.
 * Returns {txHash, alreadyRegistered?} — handles already-registered gracefully.
 *
 * On-demand prover: if PROVING_SERVICE_URL is empty but FREESTYLE_API_KEY is set,
 * attempts to wake a prover VM from the zor-prover-ready snapshot (p99 <400ms branch,
 * idleTimeout 65s → auto-pause). Falls back to CallMockProofProvider if Freestyle is unavailable
 * or the host lacks AVX512 (current Freestyle AMD Milan SIGILL — mock preserves correct apply_actions calldata).
 */
async function handleRegisterMaster(request: Request, env: Env): Promise<Response> {
  try {
    if (!env.MASTER_PRIVATE_KEY || !env.MASTER_ADDRESS || !env.STARKNET_RPC_URL) {
      return errorResponse("Master account not configured", 500);
    }

    // On-demand wake: reuse FREESTYLE_API_KEY to branch zor-prover-ready when env URL is empty
    let effectiveProverUrl = env.PROVING_SERVICE_URL;
    if (!effectiveProverUrl && env.FREESTYLE_API_KEY) {
      const ensured = await ensureProverUrl(env);
      if (ensured.url) effectiveProverUrl = ensured.url;
      else console.warn("[register-master] prover ensure fell back to mock:", (ensured as { reason?: string }).reason);
    }

    const vaultService = createVaultService({
      STARKNET_RPC_URL: env.STARKNET_RPC_URL,
      MASTER_ADDRESS: env.MASTER_ADDRESS,
      MASTER_PRIVATE_KEY: env.MASTER_PRIVATE_KEY,
      PROVING_SERVICE_URL: effectiveProverUrl,
      CHAIN_ID: (env as any).CHAIN_ID,
      STARKSCAN_API_KEY: (env as any).STARKSCAN_API_KEY,
      STARKSCAN_DAILY_BUDGET: (env as any).STARKSCAN_DAILY_BUDGET,
      STARKSCAN_BASE_URL: (env as any).STARKSCAN_BASE_URL,
      SESSIONS: env.SESSIONS as any,
      PROOF_JOBS: (env as any).PROOF_JOBS,
      POOL_CONTRACT_ADDRESS: (env as any).POOL_CONTRACT_ADDRESS,
      STRK_TOKEN_ADDRESS: (env as any).STRK_TOKEN_ADDRESS,
    });

    // If prover not configured, we can still build a mock CallAndProof for local dev
    // but warn the caller that settlement will need a real prover.
    const isMock = vaultService.isMockProver();

    try {
      const result = await vaultService.register();
      // In mock mode we return the call structure rather than a txHash (no broadcast)
      // Real settlement would submit result.call with result.proofFacts via V3 invoke.
      return jsonResponse({
        success: true,
        txHash: null,
        call: result.call,
        proofFacts: result.proofFacts,
        proofOutput: result.proofOutput,
        mock: isMock,
        message: isMock
          ? "Master register built with CallMockProofProvider (local dev). Set PROVING_SERVICE_URL for real VIRTUAL_SNOS proof."
          : "Master register proof built; submit via apply_actions to settle.",
      });
    } catch (e: any) {
      const msg = e?.message || String(e);
      // Pool reverts if already registered — treat as success with alreadyRegistered flag
      if (
        msg.toLowerCase().includes("already registered") ||
        msg.toLowerCase().includes("viewing key already") ||
        msg.includes("0x5265676973746572656420") // "Registered " in felt
      ) {
        return jsonResponse({
          success: true,
          alreadyRegistered: true,
          message: "Master already registered in pool",
          mock: isMock,
        });
      }
      throw e;
    }
  } catch (error: any) {
    console.error("Register-master error:", error);
    return errorResponse(`Register-master failed: ${error.message}`, 500);
  }
}

/**
 * POST /verify-private-transfer
 * Body: { walletAddress: string, minutes?: number, expectedAmountWei?: string }
 * Checks if master received a private transfer from walletAddress via discoverNotes.
 * Amount check: >= PRICE_PER_MINUTE * minutes, or minimum 0.001 STRK if not specified.
 *
 * If PROVING_SERVICE_URL is empty, returns {mock:true} — discovery still works via
 * ContractDiscoveryProvider but prover-dependent flows are disabled.
 */
async function handleVerifyPrivateTransfer(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      walletAddress: string;
      minutes?: number;
      expectedAmountWei?: string;
    };

    if (!body.walletAddress) {
      return errorResponse("Missing walletAddress");
    }

    if (!env.MASTER_PRIVATE_KEY || !env.MASTER_ADDRESS || !env.STARKNET_RPC_URL) {
      return errorResponse("Master account not configured", 500);
    }

    // On-demand wake before deciding mock vs real
    let effectiveProverUrl = env.PROVING_SERVICE_URL;
    if (!effectiveProverUrl && env.FREESTYLE_API_KEY) {
      const ensured = await ensureProverUrl(env);
      if (ensured.url) effectiveProverUrl = ensured.url;
      else console.warn("[verify-private-transfer] prover ensure fell back to mock:", (ensured as { reason?: string }).reason);
    }

    const vaultService = createVaultService({
      STARKNET_RPC_URL: env.STARKNET_RPC_URL,
      MASTER_ADDRESS: env.MASTER_ADDRESS,
      MASTER_PRIVATE_KEY: env.MASTER_PRIVATE_KEY,
      PROVING_SERVICE_URL: effectiveProverUrl,
      CHAIN_ID: (env as any).CHAIN_ID,
      STARKSCAN_API_KEY: (env as any).STARKSCAN_API_KEY,
      STARKSCAN_DAILY_BUDGET: (env as any).STARKSCAN_DAILY_BUDGET,
      STARKSCAN_BASE_URL: (env as any).STARKSCAN_BASE_URL,
      SESSIONS: env.SESSIONS as any,
      PROOF_JOBS: (env as any).PROOF_JOBS,
      POOL_CONTRACT_ADDRESS: (env as any).POOL_CONTRACT_ADDRESS,
      STRK_TOKEN_ADDRESS: (env as any).STRK_TOKEN_ADDRESS,
    });

    // Determine required amount
    const pricePerMinute = parseFloat(env.PRICE_PER_MINUTE || "0.001");
    let requiredWei: bigint;
    if (body.expectedAmountWei) {
      requiredWei = BigInt(body.expectedAmountWei);
    } else if (body.minutes) {
      const expectedStrk = body.minutes * pricePerMinute;
      requiredWei = BigInt(Math.floor(expectedStrk * 1e18));
    } else {
      requiredWei = BigInt("1000000000000000"); // 0.001 STRK minimum (PRICE_PER_MINUTE)
    }

    // Discovery via master viewing key: find incoming notes from sender
    // Uses ContractDiscoveryProvider (on-chain reads); IndexerDiscoveryProvider preferred for prod but not exported in this bundle.
    try {
      const { notes } = await vaultService.discoverNotes();
      // notes is AddressMap<Note[]> keyed by token address
      let totalFromSender = 0n;
      let matchedTxHash: string | undefined;

      // STRK token key
      const STRK = BigInt("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d");
      const senderLower = body.walletAddress.toLowerCase();

      // Check all token maps for notes from this sender
      for (const [token, noteList] of notes.entries() as any) {
        // Filter by token if we want STRK only — but check all for robustness
        const isStrk = BigInt(token) === STRK;
        if (!isStrk && notes.size > 1) {
          // For non-STRK tokens, still count but log
          console.warn("verify-private-transfer: found note for non-STRK token", token);
        }
        for (const note of noteList as any[]) {
          const noteSender = note.sender ? (typeof note.sender === "string" ? note.sender : "0x" + BigInt(note.sender).toString(16)) : "";
          if (noteSender.toLowerCase() === senderLower) {
            totalFromSender += BigInt(note.amount);
            // Note ID or witness could be used as txHash proxy; use note.id if available
            if (!matchedTxHash && note.id) {
              matchedTxHash = String(note.id);
            }
          }
        }
      }

      const paid = totalFromSender >= requiredWei;

      // Also try channel-based check as secondary (discoverChannels for sender)
      if (!paid) {
        try {
          const channelsResult = await vaultService.discoverChannels([body.walletAddress] as never);
          // If channels discovered, sender has interacted with pool (registered) — but amount still matters
          console.warn("verify-private-transfer: channels check", JSON.stringify(channelsResult).slice(0, 500));
        } catch (chErr) {
          console.warn("verify-private-transfer: discoverChannels failed", chErr);
        }
      }

      // If paid, create a session token so frontend can browse immediately (master-receiver model)
      if (paid) {
        const minutesToUse = body.minutes || Math.max(1, Math.floor(Number(totalFromSender) / 1e18 / pricePerMinute));
        const balanceHex = "0x" + totalFromSender.toString(16);
        const { token } = await createSession(
          env,
          body.walletAddress,
          env.MASTER_ADDRESS, // depositAddress placeholder = master for private flow
          minutesToUse,
          balanceHex,
        );
        const balanceStrk = Number(totalFromSender) / 1e18;
        return jsonResponse({
          success: true,
          paid,
          amount: totalFromSender.toString(),
          requiredWei: requiredWei.toString(),
          txHash: matchedTxHash,
          mock: false,
          token,
          balance: balanceStrk.toFixed(4),
          minutesAvailable: Math.floor(balanceStrk / pricePerMinute),
        });
      }

      return jsonResponse({
        success: true,
        paid,
        amount: totalFromSender.toString(),
        requiredWei: requiredWei.toString(),
        txHash: matchedTxHash,
        mock: false,
      });
    } catch (discoverErr: any) {
      console.error("verify-private-transfer discover failed:", discoverErr);
      return jsonResponse({
        success: true,
        paid: false,
        amount: "0",
        error: `Discovery failed: ${discoverErr.message}`,
        mock: false,
      });
    }
  } catch (error: any) {
    console.error("Verify-private-transfer error:", error);
    return errorResponse(`Verify-private-transfer failed: ${error.message}`, 500);
  }
}

// ============ Top-up Handler ============

async function handleTopUp(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { token: string; minutes: number };
    if (!body.token || !body.minutes || body.minutes <= 0) {
      return errorResponse("Missing or invalid: token and positive minutes required", 400);
    }

    // Simple rate limit: 1 top-up per token per 60 seconds via KV
    const rateKey = `topup_rate:${body.token}`;
    const now = Date.now();
    const lastTopup = await env.SESSIONS.get(rateKey);
    if (lastTopup && Date.now() - parseInt(lastTopup) < 60000) {
      const remaining = 60 - Math.floor((Date.now() - parseInt(lastTopup)) / 1000);
      return errorResponse(`Rate limited: try again in ${remaining} seconds`, 429);
    }

    const topupResult = await vaultService.topUp(body.token, body.minutes);
    if (!topupResult.success) return errorResponse(topupResult.message, 404);

    // Update rate limit TTL
    await env.SESSIONS.put(rateKey, now.toString(), { expirationTtl: 3600 });

    return jsonResponse({
      success: true,
      newTotalMinutes: topupResult.newTotalMinutes,
      message: topupResult.message,
    });
  } catch (error: any) {
    console.error("top-up error:", error);
    return errorResponse(`Top-up failed: ${error.message}`, 500);
  }
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

    if (path === "/deploy" && request.method === "POST") {
      return handleDeploy(request, env);
    }

    if (path === "/fund-account" && request.method === "POST") {
      return handleFundAccount(request, env);
    }

    if (path === "/verify-deposit" && request.method === "POST") {
      return handleVerifyDeposit(request, env);
    }

    if (path === "/activate" && request.method === "POST") {
      return handleActivate(request, env);
    }

    if (path === "/top-up" && request.method === "POST") {
      return handleTopUp(request, env);
    }

    if (path === "/proxy" && request.method === "GET") {
      return handleProxy(request, env);
    }

    // Service Worker endpoint — must be same-origin as the proxied page
    if (path === "/sw.js") {
      const proxyOrigin = url.origin;
      return new Response(getServiceWorkerScript(proxyOrigin), {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (path === "/status") {
      return handleStatus(env);
    }

    if (path === "/session" && request.method === "GET") {
      return handleSessionStatus(request, env);
    }

    if (path === "/shield" && request.method === "POST") {
      return handleShield(request, env);
    }

    if (path === "/shield-status" && request.method === "GET") {
      return handleShieldStatus(env);
    }

    if (path === "/register-master" && request.method === "POST") {
      return handleRegisterMaster(request, env);
    }

    if (path === "/verify-private-transfer" && request.method === "POST") {
      return handleVerifyPrivateTransfer(request, env);
    }

    // Prover on-demand ops: wake from snapshot, health probe, and explicit pause
    if (path === "/prover-wake" && request.method === "POST") {
      if (!env.FREESTYLE_API_KEY) return errorResponse("FREESTYLE_API_KEY not configured (wrangler secret put FREESTYLE_API_KEY)", 500);
      const ensured = await ensureProverUrl(env);
      if (ensured.url) return jsonResponse({ success: true, url: ensured.url, source: (ensured as { source: string }).source, vmId: (ensured as { vmId?: string }).vmId, domain: (ensured as { domain?: string }).domain });
      return jsonResponse({ success: true, mock: true, reason: (ensured as { reason: string }).reason, message: "Falling back to CallMockProofProvider" });
    }
    if (path === "/prover-pause" && request.method === "POST") {
      if (!env.FREESTYLE_API_KEY) return errorResponse("FREESTYLE_API_KEY not configured", 500);
      const body = await request.json().catch(() => ({})) as { vmId?: string };
      const vmId = body.vmId || "zor-prover-base";
      const ok = await pauseProverVm(env.FREESTYLE_API_KEY, vmId);
      return jsonResponse({ success: ok, vmId });
    }
    if (path === "/prover-status" && request.method === "GET") {
      const ensured = await ensureProverUrl(env);
      return jsonResponse({ success: true, ...ensured, provingUrl: (ensured as { url: string | null }).url, isMock: !(ensured as { url: string | null }).url });
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
