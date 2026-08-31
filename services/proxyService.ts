// STRK20 Proxy Service
// Communication layer between the frontend and the Cloudflare Worker proxy

const WORKER_URL = import.meta.env.VITE_PROXY_WORKER_URL || 'http://localhost:8787';

const PROXY_WALLET = '0x6bac485e95d541c9d3e5bed098b47d137143a6a9e51d62b4e3ba31249d9700bd';
const PRICE_PER_MINUTE = 0.001;
const STRK20_CONTRACT = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

// Privacy Pool (Sepolia v2.0)
const PRIVACY_POOL_ADDRESS = '0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91';

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
 * Get deployment parameters for a user account.
 */
export async function getDeployParams(
  depositAddress: string,
  walletAddress: string
): Promise<{
  success: boolean;
  accountAddress?: string;
  publicKey?: string;
  classHash?: string;
  salt?: string;
  masterAddress?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${WORKER_URL}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAddress, walletAddress }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
}

/**
 * Fund a deployed account from the master account.
 */
export async function fundAccount(
  accountAddress: string,
  amount: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const response = await fetch(`${WORKER_URL}/fund-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountAddress, amount }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
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

/**
 * Verify a privacy pool deposit via the worker.
 * The worker checks the on-chain deposit event from the tx hash.
 */
export async function verifyDeposit(
  txHash: string,
  walletAddress: string,
  expectedAmount: string
): Promise<{
  success: boolean;
  verified?: boolean;
  amount?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${WORKER_URL}/verify-deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, walletAddress, expectedAmount }),
    });
    return await response.json();
  } catch (error) {
    return { success: false, error: `Network error: ${error}` };
  }
}

/**
 * Check if a wallet supports STRK20 privacy pool operations.
 */
export function hasStrk20Support(account: any): boolean {
  return (
    account &&
    typeof account === 'object' &&
    typeof account.strk20InvokeTransaction === 'function' &&
    typeof account.strk20Balances === 'function'
  );
}

export {
  PROXY_WALLET,
  PRICE_PER_MINUTE,
  STRK20_CONTRACT,
  PRIVACY_POOL_ADDRESS,
};
