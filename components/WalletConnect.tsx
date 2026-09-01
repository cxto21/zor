
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

  /** Get the raw wallet extension (Ready/X) for STRK20 methods */
  function getRawWallet(): any {
    // @ts-ignore
    const sn = window?.starknet;
    if (sn) return sn;
    // @ts-ignore
    const re = window?.starknetWallet;
    if (re) return re;
    return null;
  }

  /** Create WalletAccountV6 with STRK20 support from raw wallet */
  async function createStrk20Account(rawWallet: any, preferredAddress?: string): Promise<any> {
    const provider = new RpcProvider({ nodeUrl: SEPOLIA_RPC });
    try {
      const account = await WalletAccountV6.connect(provider, rawWallet);
      console.log('WalletAccountV6 created, has strk20InvokeTransaction:', typeof account.strk20InvokeTransaction);
      return account;
    } catch (e) {
      console.warn('WalletAccountV6.connect failed:', e);
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
          // Try to create WalletAccountV6 with STRK20 support
          const rawWallet = getRawWallet();
          if (rawWallet) {
            const strk20Account = await createStrk20Account(rawWallet, addr);
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

      // Try to create WalletAccountV6 with STRK20 support
      const rawWallet = getRawWallet();
      let account: any = null;

      if (rawWallet) {
        account = await createStrk20Account(rawWallet, addr);
      }

      // Fallback: use starknetkit account
      if (!account) {
        if (connector && typeof connector.account === "function") {
          try {
            account = await connector.account({ nodeUrl: SEPOLIA_RPC });
          } catch {}
        }
      }

      if (!account) {
        throw new Error("Could not read account from wallet. Make sure it is unlocked.");
      }

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
      {/* Network warning — compact pill */}
      {wrongNetwork && (
        <span className="text-[9px] bg-yellow-400 text-black font-bold px-2 py-0.5 rounded">
          WRONG NETWORK
        </span>
      )}

      {/* Error — compact */}
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
