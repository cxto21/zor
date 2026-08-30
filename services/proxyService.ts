// STRK20 Proxy Service
// Communication layer between the frontend and the Cloudflare Worker proxy

// Worker URL — change to your deployed worker URL in production
const WORKER_URL = import.meta.env.VITE_PROXY_WORKER_URL || 'http://localhost:8787';

// Proxy wallet address — receives STRK20 payments
const PROXY_WALLET = '0x6bac485e95d541c9d3e5bed098b47d143a6a8a9e51d62b4e3ba31249d9700bd';

// Price per minute of browsing time (in STRK20 tokens)
const PRICE_PER_MINUTE = 0.001;

// STRK20 contract on Starknet Sepolia (Privacy Pool)
const STRK20_CONTRACT = '0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

/**
 * Activate a proxy session after the user sends STRK20 tokens.
 * Returns a session token that must be included in proxy requests.
 */
export async function activateSession(
  userAddress: string,
  txHash: string,
  minutes: number
): Promise<{ success: boolean; token?: string; expiresAt?: number; error?: string }> {
  try {
    const response = await fetch(`${WORKER_URL}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: userAddress, txHash, minutes }),
    });
    const result = await response.json();
    if (result.success) {
      return { success: true, token: result.token, expiresAt: result.expiresAt };
    }
    return { success: false, error: result.error || result.details || 'Activation failed' };
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
}

/**
 * Get the proxied URL for a target website.
 * Includes the session token for authentication.
 */
export function getProxyUrl(url: string, token: string): string {
  return `${WORKER_URL}/proxy?url=${encodeURIComponent(url)}&token=${token}`;
}

/**
 * Check session validity and get remaining time.
 */
export async function checkSession(
  token: string
): Promise<{ valid: boolean; remainingMs?: number; expiresAt?: number }> {
  try {
    const response = await fetch(`${WORKER_URL}/status?token=${token}`);
    const result = await response.json();
    return result;
  } catch {
    return { valid: false };
  }
}

/**
 * Get the worker base URL
 */
export function getWorkerUrl(): string {
  return WORKER_URL;
}

export { PROXY_WALLET, PRICE_PER_MINUTE, STRK20_CONTRACT };
