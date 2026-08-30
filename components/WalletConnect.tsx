
import React, { useState, useEffect, useCallback } from 'react';
import { connect, disconnect } from "starknetkit";

// Sepolia chainId as felt252 short string
const SN_SEPOLIA_CHAIN_ID = BigInt("0x534e5f5345504f4c4941");
const STORAGE_KEY_ADDRESS = "zor_wallet_address";

interface WalletConnectProps {
  onAccountChange: (account: any) => void;
}

/**
 * Extract a usable account object from the wallet.
 * Different wallets expose the account through different properties.
 * We try wallet.account first (most common), then getSelectedAccount(),
 * then accountObject.  The returned object must have .execute() and .address
 * for App.tsx to work.
 */
async function extractAccount(wallet: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  // 1. wallet.account — ArgentX, Braavos, Ready, Xverse all set this
  const walletAccount = wallet.account;
  if (
    walletAccount &&
    typeof walletAccount === "object" &&
    typeof (walletAccount as any).execute === "function"
  ) {
    return walletAccount as Record<string, unknown>;
  }

  // 2. wallet.getSelectedAccount() — async in some wallets (e.g. older ArgentX)
  const getSelected = wallet.getSelectedAccount;
  if (typeof getSelected === "function") {
    try {
      const selected = await (getSelected as () => Promise<any>).call(wallet);
      if (selected && typeof selected.execute === "function") {
        return selected;
      }
    } catch {
      // Silently ignore — will fall through to next strategy
    }
  }

  // 3. wallet.accountObject — used by some wallet implementations
  const accountObject = wallet.accountObject;
  if (
    accountObject &&
    typeof accountObject === "object" &&
    typeof (accountObject as any).execute === "function"
  ) {
    return accountObject as Record<string, unknown>;
  }

  return null;
}

/**
 * Extract the hex address from the wallet or account object.
 * Tries multiple paths wallets use to expose the address.
 */
function extractAddress(
  wallet: Record<string, unknown>,
  account: Record<string, unknown> | null
): string | null {
  // From the account object (most reliable after extraction)
  if (account && typeof account.address === "string" && account.address.length > 0) {
    return account.address;
  }
  // From the account object (selectedAddress fallback)
  if (account && typeof account.selectedAddress === "string" && account.selectedAddress.length > 0) {
    return account.selectedAddress;
  }
  // From the wallet directly
  if (typeof wallet.selectedAddress === "string" && wallet.selectedAddress.length > 0) {
    return wallet.selectedAddress;
  }
  return null;
}

const WalletConnect: React.FC<WalletConnectProps> = ({ onAccountChange }) => {
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [copied, setCopied] = useState(false);

  const checkNetwork = useCallback((chainId: bigint | undefined) => {
    if (chainId !== undefined && chainId !== SN_SEPOLIA_CHAIN_ID) {
      setWrongNetwork(true);
    } else {
      setWrongNetwork(false);
    }
  }, []);

  // Restore connection from localStorage on mount
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

        // Try to get account from connector first (starknetkit v3+)
        let account: any = null;
        if (connector && typeof connector.account === "function") {
          try {
            account = await connector.account({ nodeUrl: "https://starknet-sepolia.public.blastapi.io/rpc/v0_7" });
          } catch {
            // fallback to wallet extraction
          }
        }

        // Fallback: extract from wallet object
        if (!account && wallet) {
          account = await extractAccount(wallet as unknown as Record<string, unknown>);
        }

        const addr = connectorData?.account || extractAddress(
          (wallet || {}) as unknown as Record<string, unknown>,
          account as Record<string, unknown> | null
        );

        // Verify it's the same address we saved
        if (addr && addr.toLowerCase() === savedAddress.toLowerCase() && account) {
          setAddress(addr);
          onAccountChange(account);
          checkNetwork(connectorData?.chainId);
        } else {
          localStorage.removeItem(STORAGE_KEY_ADDRESS);
        }
      } catch {
        // Silent reconnect failed — wallet may have been uninstalled or locked
        localStorage.removeItem(STORAGE_KEY_ADDRESS);
      }
    })();
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // Try to get account from connector first (starknetkit v3+)
      let account: any = null;
      if (connector && typeof connector.account === "function") {
        try {
          account = await connector.account({ nodeUrl: "https://starknet-sepolia.public.blastapi.io/rpc/v0_7" });
        } catch {
          // fallback to wallet extraction
        }
      }

      // Fallback: extract from wallet object
      if (!account && wallet) {
        account = await extractAccount(wallet as unknown as Record<string, unknown>);
      }

      if (!account) {
        throw new Error(
          "Could not read account from wallet. Make sure it is unlocked."
        );
      }

      const addr = connectorData?.account || extractAddress(
        (wallet || {}) as unknown as Record<string, unknown>,
        account as Record<string, unknown>
      );
      if (!addr) {
        throw new Error("Could not determine wallet address.");
      }

      setAddress(addr);
      onAccountChange(account);
      localStorage.setItem(STORAGE_KEY_ADDRESS, addr);
      checkNetwork(connectorData?.chainId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      // Don't show error for user cancellations
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
    localStorage.removeItem(STORAGE_KEY_ADDRESS);
    onAccountChange(null);
  };

  const handleCopyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be blocked in some contexts
    }
  };

  const truncateAddress = (addr: string) =>
    `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="flex flex-col gap-2">
      {/* Network warning */}
      {wrongNetwork && (
        <div className="retro-border-inset p-2 text-[10px] bg-yellow-300 text-black font-bold uppercase">
          ⚠ Wrong network — switch to Sepolia testnet
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="retro-border-inset p-2 text-[10px] bg-red-600 text-white font-bold uppercase break-all">
          ✗ {error}
        </div>
      )}

      {address ? (
        <div className="flex flex-col gap-2">
          {/* Connected address */}
          <div className="retro-border-inset p-2 text-[10px]">
            <div className="font-bold uppercase text-[10px] mb-1">Connected:</div>
            <button
              onClick={handleCopyAddress}
              className="text-left hover:underline w-full cursor-pointer"
              title={address}
            >
              {copied ? "Copied!" : truncateAddress(address)}
            </button>
          </div>

          <button
            onClick={handleDisconnect}
            className="retro-border retro-button bg-[#c0c0c0] px-4 py-2 text-sm font-bold uppercase shadow-[inset_1px_1px_#fff,inset_-1px_-1px_#808080]"
          >
            Disconnect Wallet
          </button>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          disabled={isConnecting}
          className="retro-border retro-button bg-[#c0c0c0] px-4 py-2 text-sm font-bold uppercase shadow-[inset_1px_1px_#fff,inset_-1px_-1px_#808080] disabled:opacity-60"
        >
          {isConnecting ? "Connecting..." : "Connect Starknet"}
        </button>
      )}

      <div className="mt-2 text-[10px] text-gray-600 italic">
        *Payments powered by STRK20 Privacy Pool on Starknet.
      </div>
    </div>
  );
};

export default WalletConnect;
