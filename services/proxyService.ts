// STRK20 Proxy Service
// Communication layer between the frontend and the Cloudflare Worker proxy

const WORKER_URL = import.meta.env.VITE_PROXY_WORKER_URL || 'http://localhost:8787';

const PROXY_WALLET = '0x6bac485e95d541c9d3e5bed098b47d137143a6a9e51d62b4e3ba31249d9700bd';
const PRICE_PER_MINUTE = 0.001;
const STRK20_CONTRACT = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/**
 * Get a unique deposit address for this user.
 * User sends STRK there, then calls activate.
 */
export async function getDepositAddress(
  userAddress: string,
  minutes: number
): Promise<{
  success: boolean;
  depositAddress?: string;
  expectedAmount?: string;
  expectedWei?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${WORKER_URL}/deposit-address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: userAddress, minutes }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
}

/**
 * Activate session after user funded the deposit address.
 * Worker checks balance of the deposit address.
 */
export async function activateSession(
  userAddress: string,
  depositAddress: string,
  minutes: number
): Promise<{
  success: boolean;
  token?: string;
  balance?: string;
  minutesAvailable?: number;
  error?: string;
}> {
  try {
    const response = await fetch(`${WORKER_URL}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: userAddress,
        depositAddress,
        minutes,
      }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
}

/**
 * Get the proxied URL for a target website.
 */
export function getProxyUrl(url: string, token: string): string {
  return `${WORKER_URL}/proxy?url=${encodeURIComponent(url)}&token=${token}`;
}

/**
 * Check session validity, balance, and remaining time.
 */
export async function checkSession(
  token: string
): Promise<{
  valid: boolean;
  balance?: string;
  minutesRemaining?: number;
  lowBalance?: boolean;
  depositAddress?: string;
}> {
  try {
    const response = await fetch(`${WORKER_URL}/session?token=${token}`);
    return await response.json();
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
