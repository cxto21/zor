
import React, { useState, useEffect } from 'react';
import { connect, disconnect } from "starknetkit";

interface WalletConnectProps {
  onAccountChange: (account: any) => void;
}

const WalletConnect: React.FC<WalletConnectProps> = ({ onAccountChange }) => {
  const [address, setAddress] = useState<string | null>(null);

  const handleConnect = async () => {
    try {
      const { wallet } = await connect({
        modalMode: "alwaysAsk",
        modalTheme: "light",
      });
      
      if (wallet && wallet.isConnected) {
        setAddress(wallet.selectedAddress);
        onAccountChange(wallet.account);
      }
    } catch (e) {
      console.error("Connection error", e);
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
    setAddress(null);
    onAccountChange(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {address ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs break-all border p-2 bg-gray-100">
            Connected: {address}
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
          className="retro-border retro-button bg-[#c0c0c0] px-4 py-2 text-sm font-bold uppercase shadow-[inset_1px_1px_#fff,inset_-1px_-1px_#808080]"
        >
          Connect Starknet
        </button>
      )}
      <div className="mt-2 text-[10px] text-gray-600 italic">
        *Payments powered by Tongo for Zero-Knowledge anonymity.
      </div>
    </div>
  );
};

export default WalletConnect;
