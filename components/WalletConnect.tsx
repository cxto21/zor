
import React, { useState, useEffect, useCallback } from 'react';
import { connect, disconnect } from "starknetkit";
import { WalletAccountV6, RpcProvider } from "starknet";
import { createStore } from "@starknet-io/get-starknet-discovery";

const SN_SEPOLIA_CHAIN_ID = BigInt("0x534e5f5345504f4c4941");
const STORAGE_KEY_ADDRESS = "zor_wallet_address";
const SEPOLIA_RPC = "https://starknet-sepolia.public.blastapi.io/rpc/v0_7";

interface WalletConnectProps {
  onAccountChange: (account: any) => void;
}

function extractAddress(
  wallet: Record<string, unknown>,
  account: Record<string, unknown> | null
): string | null {
  if (account && typeof account.address === "string" && account.address.length > 0) {
    return account.address;
  }
  if (account && typeof (account as any).selectedAddress === "string" && (account as any).selectedAddress.length > 0) {
    return (account as any).selectedAddress;
  }
  if (typeof wallet.selectedAddress === "string" && (wallet as any).selectedAddress.length > 0) {
    return (wallet as any).selectedAddress;
  }
  return null;
}

function hasStrk20Support(account: any): boolean {
  return (
    account &&
    typeof account === "object" &&
    typeof account.strk20InvokeTransaction === "function"
  );
}

/**
 * Discover wallets via @starknet-io/get-starknet-discovery.
 * This scans window for injected wallets (Ready, Argent X, etc.)
 * and returns WalletWithStarknetFeatures objects with features["starknet:walletApi"].
 */
async function discoverWallets(): Promise<any[]> {
  return new Promise((resolve) => {
    const store = createStore({
      // Don't use EIP-1193 adapters (prevents MetaMask popups)
      eip1193Adapters: []
    });

    const wallets: any[] = [];

    // Subscribe to wallet changes
    const unsubscribe = store.subscribe((newWallets: any[]) => {
      console.log('[ZOR] Discovery: wallets changed:', newWallets.length, 'wallets');
      for (const w of newWallets) {
        const hasFeatures = !!w.features;
        const hasStrk20Api = !!w.features?.['starknet:walletApi'];
        const hasStandardConnect = !!w.features?.['standard:connect'];
        console.log('[ZOR] Discovery: wallet:', w.name, {
          hasFeatures,
          hasStrk20Api,
          hasStandardConnect,
          features: w.features ? Object.keys(w.features) : []
        });
        if (!wallets.find((x: any) => x.name === w.name)) {
          wallets.push(w);
        }
      }
    });

    // Also check already-discovered wallets
    const existing = store.getWallets();
    console.log('[ZOR] Discovery: existing wallets:', existing.length);
    for (const w of existing) {
      console.log('[ZOR] Discovery: existing wallet:', w.name, {
        hasFeatures: !!w.features,
        features: w.features ? Object.keys(w.features) : []
      });
      if (!wallets.find((x: any) => x.name === w.name)) {
        wallets.push(w);
      }
    }

    // Give the discovery mechanisms time to find injected wallets
    // Try refreshing injected wallets
    try {
      (store as any)._refreshInjectedWallets?.();
    } catch {}

    // Wait for wallets to be discovered
    setTimeout(() => {
      unsubscribe();
      console.log('[ZOR] Discovery complete, found', wallets.length, 'wallets');
      resolve(wallets);
    }, 1000);
  });
}

const WalletConnect: React.FC<WalletConnectProps> = ({ onAccountChange }) => {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [strk20Ready, setStrk20Ready] = useState(false);

  const checkNetwork = useCallback((chainId: bigint | undefined) => {
    setWrongNetwork(chainId !== undefined && chainId !== SN_SEPOLIA_CHAIN_ID);
  }, []);

  const initAccount = useCallback((account: any, addr: string, chainId?: bigint) => {
    setAddress(addr);
    onAccountChange(account);
    localStorage.setItem(STORAGE_KEY_ADDRESS, addr);
    checkNetwork(chainId);
    setStrk20Ready(hasStrk20Support(account));
  }, [onAccountChange, checkNetwork]);

  /**
   * Create WalletAccountV6 with STRK20 support using discovered wallet.
   */
  async function createStrk20Account(walletProvider: any): Promise<any> {
    const provider = new RpcProvider({ nodeUrl: SEPOLIA_RPC });
    try {
      console.log('[ZOR] WalletAccountV6.connect with discovered wallet:', walletProvider.name);
      const account = await WalletAccountV6.connect(provider, walletProvider);
      console.log('[ZOR] WalletAccountV6 created!', {
        address: account?.address,
        hasStrk20Invoke: typeof account?.strk20InvokeTransaction,
        hasStrk20Balances: typeof account?.strk20Balances,
      });
      return account;
    } catch (e: any) {
      console.error('[ZOR] WalletAccountV6.connect FAILED:', e?.message || e);
      return null;
    }
  }

  /**
   * Try to find a wallet with STRK20 support:
   * 1. Use get-starknet-discovery to find injected wallets
   * 2. Fall back to starknetkit
   */
  async function findStrk20Wallet(): Promise<{ wallet: any; address: string; chainId?: bigint } | null> {
    // Method 1: Discovery
    console.log('[ZOR] Trying wallet discovery...');
    const discoveredWallets = await discoverWallets();

    // Find wallet with starknet:walletApi (STRK20-capable)
    const strk20Wallet = discoveredWallets.find((w: any) =>
      w.features?.['starknet:walletApi'] && w.features?.['standard:connect']
    );
    if (strk20Wallet) {
      console.log('[ZOR] Found STRK20-capable wallet via discovery:', strk20Wallet.name);
      // Get address from the wallet
      try {
        const addr = await strk20Wallet.features['wallet_requestAccounts']?.requestAccounts();
        const address = Array.isArray(addr) ? addr[0] : (typeof addr === 'string' ? addr : null);
        if (address) {
          return { wallet: strk20Wallet, address, chainId: undefined };
        }
      } catch (e) {
        console.warn('[ZOR] Could not get address from discovered wallet:', e);
      }
    }

    // Find any wallet (even without STRK20) for fallback
    const anyWallet = discoveredWallets[0];
    if (anyWallet) {
      console.log('[ZOR] Found wallet (no STRK20):', anyWallet.name, 'features:', anyWallet.features ? Object.keys(anyWallet.features) : 'none');
    }

    // Method 2: starknetkit fallback (gets us the address)
    console.log('[ZOR] Using starknetkit for address...');
    const result = await connect({ modalMode: "alwaysAsk", modalTheme: "light" });
    const connector = result?.connector;
    const wallet = result?.wallet;
    const connectorData = result?.connectorData;

    const addr = connectorData?.account || extractAddress(
      (wallet || {}) as unknown as Record<string, unknown>,
      null
    );
    if (!addr) return null;

    // If we found a STRK20 wallet via discovery, use it
    if (strk20Wallet) {
      return { wallet: strk20Wallet, address: addr, chainId: connectorData?.chainId };
    }

    // Otherwise return the starknetkit wallet (no STRK20)
    return { wallet: null, address: addr, chainId: connectorData?.chainId };
  }

  useEffect(() => {
    const savedAddress = localStorage.getItem(STORAGE_KEY_ADDRESS);
    if (!savedAddress) return;

    (async () => {
      try {
        // Try discovery first
        const discoveredWallets = await discoverWallets();
        const strk20Wallet = discoveredWallets.find((w: any) =>
          w.features?.['starknet:walletApi'] && w.features?.['standard:connect']
        );

        if (strk20Wallet) {
          // Try silent connect
          try {
            const accounts = await strk20Wallet.features['wallet_requestAccounts']?.requestAccounts({ silent: true });
            const addr = Array.isArray(accounts) ? accounts[0] : (typeof accounts === 'string' ? accounts : null);
            if (addr && addr.toLowerCase() === savedAddress.toLowerCase()) {
              const strk20Account = await createStrk20Account(strk20Wallet);
              if (strk20Account) {
                initAccount(strk20Account, addr);
                return;
              }
            }
          } catch {}
        }

        // Fallback to starknetkit
        const result = await connect({ modalMode: "neverAsk" });
        const connector = result?.connector;
        const wallet = result?.wallet;
        const connectorData = result?.connectorData;

        if (!connector && !wallet) {
          localStorage.removeItem(STORAGE_KEY_ADDRESS);
          return;
        }

        const addr = connectorData?.account || extractAddress(
          (wallet || {}) as unknown as Record<string, unknown>,
          null
        );

        if (addr && addr.toLowerCase() === savedAddress.toLowerCase()) {
          // Try to create WalletAccountV6 with discovered wallet
          if (strk20Wallet) {
            const strk20Account = await createStrk20Account(strk20Wallet);
            if (strk20Account) {
              initAccount(strk20Account, addr, connectorData?.chainId);
              return;
            }
          }

          // Fallback: use starknetkit account
          let account: any = null;
          if (connector && typeof connector.account === "function") {
            try {
              account = await connector.account({ nodeUrl: SEPOLIA_RPC });
            } catch {}
          }
          if (account) {
            initAccount(account, addr, connectorData?.chainId);
          } else {
            localStorage.removeItem(STORAGE_KEY_ADDRESS);
          }
        } else {
          localStorage.removeItem(STORAGE_KEY_ADDRESS);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY_ADDRESS);
      }
    })();
  }, []);

  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);
    setWrongNetwork(false);

    try {
      const walletInfo = await findStrk20Wallet();
      if (!walletInfo) {
        throw new Error("No wallet found. Is a Starknet wallet installed?");
      }

      const { wallet, address, chainId } = walletInfo;

      let account: any = null;

      if (wallet) {
        // Create WalletAccountV6 with STRK20 support
        account = await createStrk20Account(wallet);
      }

      if (!account) {
        // Fallback to starknetkit
        console.log('[ZOR] Falling back to starknetkit account (no STRK20)');
        const result = await connect({ modalMode: "alwaysAsk", modalTheme: "light" });
        const connector = result?.connector;
        if (connector && typeof connector.account === "function") {
          try {
            account = await connector.account({ nodeUrl: SEPOLIA_RPC });
          } catch {}
        }
      }

      if (!account) {
        throw new Error("Could not read account from wallet. Make sure it is unlocked.");
      }

      initAccount(account, address, chainId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.toLowerCase().includes("user declined") ||
        msg.toLowerCase().includes("user rejected") ||
        msg.toLowerCase().includes("user cancel")
      ) {
        setError(null);
      } else {
        setError(msg);
      }
      console.error("Wallet connection error:", e);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect({ clearLastWallet: true });
    } catch (e) {
      console.error("Disconnect error:", e);
    }
    setAddress(null);
    setError(null);
    setWrongNetwork(false);
    setStrk20Ready(false);
    localStorage.removeItem(STORAGE_KEY_ADDRESS);
    onAccountChange(null);
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="flex items-center gap-2">
      {wrongNetwork && (
        <span className="text-[9px] bg-yellow-400 text-black font-bold px-2 py-0.5 rounded">
          WRONG NETWORK
        </span>
      )}

      {error && (
        <span className="text-[9px] bg-red-600 text-white font-bold px-2 py-0.5 rounded max-w-[200px] truncate" title={error}>
          ✗ {error.length > 30 ? error.slice(0, 30) + '…' : error}
        </span>
      )}

      {address ? (
        <div className="flex items-center gap-1.5">
          {strk20Ready && (
            <span className="text-[8px] bg-green-600 text-white font-bold px-1.5 py-0.5 rounded" title="Wallet supports STRK20 private payments">
              🔒 STRK20
            </span>
          )}
          <span className="text-[10px] font-mono text-gray-700 bg-white retro-border-inset px-2 py-0.5">
            {truncateAddress(address)}
          </span>
          <button
            onClick={handleDisconnect}
            className="text-[9px] text-red-600 font-bold hover:underline cursor-pointer"
            title="Disconnect wallet"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          disabled={isConnecting}
          className="retro-border retro-button bg-[#c0c0c0] px-3 py-1 text-[10px] font-bold uppercase disabled:opacity-60 cursor-pointer"
        >
          {isConnecting ? '...' : 'Connect Wallet'}
        </button>
      )}
    </div>
  );
};

export default WalletConnect;
