
import React, { useState, useEffect, useCallback } from 'react';
import { connect, disconnect } from "starknetkit";
import { WalletAccountV6, RpcProvider } from "starknet";

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

/** Check if the account supports STRK20 wallet API methods */
function hasStrk20Support(account: any): boolean {
  return (
    account &&
    typeof account === "object" &&
    typeof account.strk20InvokeTransaction === "function"
  );
}

/**
 * Discover wallet providers via EIP-6963.
 * Returns a provider with features["standard:connect"] that WalletAccountV6 needs.
 */
async function discoverEip6963Wallets(): Promise<any[]> {
  return new Promise((resolve) => {
    const wallets: any[] = [];
    const handler = (event: any) => {
      const info = event?.detail?.info;
      const provider = event?.detail?.provider;
      if (provider && typeof provider === 'object') {
        console.log('[ZOR] EIP-6963 wallet discovered:', info?.name, 'has features:', !!provider.features, 'features keys:', provider.features ? Object.keys(provider.features) : []);
        wallets.push({ info, provider });
      }
    };

    window.addEventListener('eip6963:announceProvider', handler);
    // Trigger discovery
    window.dispatchEvent(new CustomEvent('eip6963:requestProvider'));

    // Wait a bit for wallets to announce themselves
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', handler);
      console.log('[ZOR] EIP-6963 discovery complete, found', wallets.length, 'wallets');
      resolve(wallets);
    }, 500);
  });
}

/** Get the raw wallet provider with features["standard:connect"] */
async function getWalletProvider(): Promise<any> {
  // Method 1: EIP-6963 discovery (returns providers with features)
  console.log('[ZOR] Trying EIP-6963 wallet discovery...');
  const eip6963Wallets = await discoverEip6963Wallets();

  for (const w of eip6963Wallets) {
    if (w.provider?.features?.['standard:connect']) {
      console.log('[ZOR] Found EIP-6963 wallet with standard:connect:', w.info?.name);
      return w.provider;
    }
  }

  // Method 2: Check window.starknet.features (some wallets expose it directly)
  const sn = (window as any)?.starknet;
  if (sn?.features?.['standard:connect']) {
    console.log('[ZOR] window.starknet has features["standard:connect"]');
    return sn;
  }

  // Method 3: Try to wrap window.starknet's request() into a features interface
  if (sn && typeof sn.request === 'function') {
    console.log('[ZOR] Creating wrapper for window.starknet with features interface...');
    // Build the full wrapper with all methods WalletAccountV6 needs
    const wrapper = {
      ...sn,
      // Ensure on/off are present (WalletAccountV6 needs them for event listening)
      on: sn.on || ((event: string, handler: Function) => {
        console.log('[ZOR] wrapper.on called:', event);
        return sn;
      }),
      off: sn.off || ((event: string, handler: Function) => {
        console.log('[ZOR] wrapper.off called:', event);
        return sn;
      }),
      features: {
        'standard:connect': {
          connect: async (opts: any) => {
            console.log('[ZOR] standard:connect called via wrapper');
            const accounts = await sn.request({ type: 'wallet_requestAccounts', params: { silent: opts?.silent } });
            return { accounts: Array.isArray(accounts) ? accounts.map((a: string) => ({ address: a })) : [] };
          }
        },
        'standard:events': {
          on: (event: string, handler: Function) => {
            console.log('[ZOR] standard:events.on called:', event);
            if (sn.on) sn.on(event, handler);
            // Return unsubscribe function
            return () => {
              if (sn.off) sn.off(event, handler);
            };
          }
        },
        'wallet_getPermissions': {
          getPermissions: async () => {
            return await sn.request({ type: 'wallet_getPermissions' });
          }
        },
        'wallet_requestAccounts': {
          requestAccounts: async (opts: any) => {
            return await sn.request({ type: 'wallet_requestAccounts', params: opts });
          }
        },
        'wallet_addInvokeTransaction': {
          addInvokeTransaction: async (params: any) => {
            return await sn.request({ type: 'wallet_addInvokeTransaction', params });
          }
        },
        'wallet_signMessage': {
          signMessage: async (params: any) => {
            return await sn.request({ type: 'wallet_signMessage', params });
          }
        },
        'wallet_switchStarknetChain': {
          switchStarknetChain: async (params: any) => {
            return await sn.request({ type: 'wallet_switchStarknetChain', params });
          }
        },
        'wallet_requestChainId': {
          requestChainId: async () => {
            return await sn.request({ type: 'wallet_requestChainId' });
          }
        }
      }
    };
    console.log('[ZOR] Wrapper created, features keys:', Object.keys(wrapper.features), 'has on:', typeof wrapper.on, 'has off:', typeof wrapper.off);
    return wrapper;
  }

  console.warn('[ZOR] No wallet provider with standard:connect found');
  return null;
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

  /** Create WalletAccountV6 with STRK20 support from wallet provider */
  async function createStrk20Account(walletProvider: any): Promise<any> {
    const provider = new RpcProvider({ nodeUrl: SEPOLIA_RPC });
    try {
      console.log('[ZOR] Attempting WalletAccountV6.connect...');
      console.log('[ZOR] Wallet provider features:', walletProvider?.features ? Object.keys(walletProvider.features) : 'none');
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

  useEffect(() => {
    const savedAddress = localStorage.getItem(STORAGE_KEY_ADDRESS);
    if (!savedAddress) return;

    (async () => {
      try {
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
          // Try EIP-6963 / features-based wallet for STRK20
          const walletProvider = await getWalletProvider();
          if (walletProvider) {
            const strk20Account = await createStrk20Account(walletProvider);
            if (strk20Account) {
              initAccount(strk20Account, addr, connectorData?.chainId);
              return;
            }
          }

          // Fallback: use starknetkit account (no STRK20)
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
      const result = await connect({
        modalMode: "alwaysAsk",
        modalTheme: "light",
      });

      const connector = result?.connector;
      const wallet = result?.wallet;
      const connectorData = result?.connectorData;

      if (!connector && !wallet) {
        throw new Error("No wallet returned. Is a Starknet wallet installed?");
      }

      const addr = connectorData?.account || extractAddress(
        (wallet || {}) as unknown as Record<string, unknown>,
        null
      );
      if (!addr) {
        throw new Error("Could not determine wallet address.");
      }

      // Try EIP-6963 / features-based wallet for STRK20
      const walletProvider = await getWalletProvider();
      let account: any = null;

      if (walletProvider) {
        account = await createStrk20Account(walletProvider);
      }

      // Fallback: use starknetkit account
      if (!account) {
        console.log('[ZOR] Falling back to starknetkit account (no STRK20)');
        if (connector && typeof connector.account === "function") {
          try {
            account = await connector.account({ nodeUrl: SEPOLIA_RPC });
          } catch {}
        }
      }

      if (!account) {
        throw new Error("Could not read account from wallet. Make sure it is unlocked.");
      }

      console.log('[ZOR] Final account:', {
        address: account.address || account.selectedAddress,
        hasStrk20Invoke: typeof account.strk20InvokeTransaction,
      });

      initAccount(account, addr, connectorData?.chainId);
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
