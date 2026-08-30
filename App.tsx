
import React, { useState, useEffect, useCallback } from 'react';
import RetroWindow from './components/RetroWindow';
import WalletConnect from './components/WalletConnect';
import Browser from './components/Browser';
import {
  activateSession,
  getProxyUrl,
  PROXY_WALLET,
  PRICE_PER_MINUTE,
} from './services/proxyService';

type ViewMode = 'home' | 'browse';

const MINUTE_OPTIONS = [15, 30, 60, 120];
const SESSION_TOKEN_KEY = 'zor_session_token';
const SESSION_EXPIRES_KEY = 'zor_session_expires';

const App: React.FC = () => {
  const [account, setAccount] = useState<any>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [minutes, setMinutes] = useState<number>(30);
  const [url, setUrl] = useState<string>('');
  const [proxyUrl, setProxyUrl] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionExpires, setSessionExpires] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [browserLoading, setBrowserLoading] = useState<boolean>(false);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem(SESSION_TOKEN_KEY);
    const savedExpires = localStorage.getItem(SESSION_EXPIRES_KEY);
    if (savedToken && savedExpires) {
      const expires = parseInt(savedExpires, 10);
      if (Date.now() < expires) {
        setSessionToken(savedToken);
        setSessionExpires(expires);
        setViewMode('browse');
        setStatus('SESSION RESTORED');
      } else {
        localStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(SESSION_EXPIRES_KEY);
      }
    }
  }, []);

  // Session countdown timer
  useEffect(() => {
    if (!sessionExpires) {
      setTimeRemaining('');
      return;
    }

    const tick = () => {
      const now = Date.now();
      const diff = sessionExpires - now;
      if (diff <= 0) {
        setSessionToken(null);
        setSessionExpires(null);
        setProxyUrl('');
        setStatus('SESSION EXPIRED');
        setTimeRemaining('');
        localStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(SESSION_EXPIRES_KEY);
        return;
      }
      const totalSeconds = Math.floor(diff / 1000);
      const hrs = Math.floor(totalSeconds / 3600);
      const mins = Math.floor((totalSeconds % 3600) / 60);
      const secs = totalSeconds % 60;
      setTimeRemaining(
        hrs > 0 ? `${hrs}h ${mins}m ${secs}s` : `${mins}m ${secs}s`
      );
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [sessionExpires]);

  const handlePayAndActivate = async () => {
    if (!account) {
      setStatus('ERROR: Connect wallet first.');
      return;
    }

    setIsLoading(true);
    setStatus('Initiating STRK transfer...');

    try {
      const totalCost = minutes * PRICE_PER_MINUTE;
      const amountWei = BigInt(Math.floor(totalCost * 1e18));

      const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
      const result = await account.execute({
        contractAddress: STRK_TOKEN,
        entrypoint: 'transfer',
        calldata: [
          PROXY_WALLET,
          '0x' + amountWei.toString(16),
          '0'
        ]
      });

      const txHash = result.transaction_hash;
      setStatus(`TX submitted: ${txHash.slice(0, 16)}... Verifying onchain...`);

      const activation = await activateSession(
        account.address || account.selectedAddress,
        txHash,
        minutes
      );

      if (activation.success && activation.token && activation.expiresAt) {
        setSessionToken(activation.token);
        setSessionExpires(activation.expiresAt);
        setStatus('SESSION ACTIVE');
        setViewMode('browse');

        localStorage.setItem(SESSION_TOKEN_KEY, activation.token);
        localStorage.setItem(SESSION_EXPIRES_KEY, activation.expiresAt.toString());
      } else {
        setStatus(`ACTIVATION FAILED: ${activation.error}`);
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('user declined') || msg.includes('user rejected')) {
        setStatus('Payment cancelled by user.');
      } else {
        setStatus(`TX ERROR: ${msg}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadUrl = useCallback(() => {
    if (!url.trim() || !sessionToken) return;
    const formatted = url.startsWith('http') ? url : `https://${url}`;
    setProxyUrl(getProxyUrl(formatted, sessionToken));
    setBrowserLoading(true);
  }, [url, sessionToken]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLoadUrl();
  };

  const handleLogout = () => {
    setSessionToken(null);
    setSessionExpires(null);
    setProxyUrl('');
    setStatus('Session ended.');
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_EXPIRES_KEY);
  };

  const isConnected = !!account;
  const hasActiveSession = !!sessionToken && !!sessionExpires && sessionExpires > Date.now();
  const totalCost = (minutes * PRICE_PER_MINUTE).toFixed(4);

  const renderHome = () => (
    <div className="space-y-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-blue-800 mb-2 font-['VT323'] tracking-widest">ZOR PROXY</h1>
        <p className="text-sm italic">"Anonymous browsing, paid with STRK20."</p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed">
            Welcome to <strong>Zor</strong>. A proof-of-concept anonymous web proxy powered by
            <strong> STRK20 micropayments</strong> on Starknet.
          </p>
          <div className="border-2 border-double border-blue-500 p-2 text-xs bg-blue-50">
            <h4 className="font-bold text-blue-600 uppercase">How it works:</h4>
            <ol className="mt-1 space-y-1 list-decimal list-inside">
              <li>Connect your Starknet wallet</li>
              <li>Pay STRK20 for proxy access (0.001/min)</li>
              <li>Type a URL and browse anonymously</li>
            </ol>
          </div>
          <p className="text-[10px] leading-relaxed text-gray-600">
            Traffic routes through a Cloudflare Worker with <strong>stealth-fetch</strong>.
            Your real IP is never leaked — target sites see only the proxy edge.
          </p>
        </div>
        <div className="flex flex-col items-center justify-center">
          <div className="w-32 h-32 border-4 border-gray-400 bg-gray-300 flex items-center justify-center text-4xl shadow-inner">
            🌐
          </div>
          <span className="text-[10px] uppercase mt-2">v0.1-LAB</span>
        </div>
      </div>

      <div className="retro-border-inset p-2 bg-black text-green-500 font-mono text-xs">
        <p>PROXY STATUS: READY</p>
        <p>NETWORK: STARKNET SEPOLIA</p>
        <p>STEALTH: ENABLED (raw TCP sockets)</p>
        <p>PRIVACY: cf-* HEADERS STRIPPED</p>
      </div>

      <div className="retro-border p-3 bg-gray-100">
        <h4 className="font-bold text-xs uppercase border-b border-gray-400 pb-1 mb-2">Pricing</h4>
        <div className="grid grid-cols-4 gap-2 text-center text-[10px]">
          {MINUTE_OPTIONS.map(m => (
            <div key={m} className="retro-border-inset p-2">
              <span className="block font-bold text-sm">{m}</span>
              <span className="text-gray-500">min</span>
              <span className="block mt-1 font-bold text-blue-700">{(m * PRICE_PER_MINUTE).toFixed(3)} STRK</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderBrowse = () => (
    <div className="space-y-4 h-full flex flex-col">
      {/* Session Status Bar */}
      <div className={`retro-border p-2 flex items-center justify-between ${hasActiveSession ? 'bg-green-100' : 'bg-red-100'}`}>
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${hasActiveSession ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
          <span className="text-xs font-bold uppercase">
            {hasActiveSession ? `SESSION: ${timeRemaining}` : 'NO ACTIVE SESSION'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {hasActiveSession && (
            <button
              onClick={handleLogout}
              className="text-[10px] text-red-600 underline font-bold"
            >
              [END SESSION]
            </button>
          )}
          <span className="text-[10px] text-gray-600">
            {hasActiveSession ? `Expires: ${new Date(sessionExpires!).toLocaleTimeString()}` : 'Purchase time to browse'}
          </span>
        </div>
      </div>

      {/* URL Bar */}
      <div className="retro-border p-2 bg-[#c0c0c0] flex gap-2 items-center">
        <span className="text-[10px] font-bold uppercase px-2">URL:</span>
        <div className="retro-border-inset flex-1 flex items-center">
          <span className="text-[10px] px-2 text-gray-500">https://</span>
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a URL..."
            disabled={!hasActiveSession}
            className="w-full bg-white px-1 py-0.5 text-xs font-mono outline-none disabled:bg-gray-200"
          />
        </div>
        <button
          onClick={handleLoadUrl}
          disabled={!hasActiveSession || !url.trim()}
          className="retro-border retro-button bg-[#c0c0c0] px-4 py-1 text-[10px] font-bold uppercase disabled:opacity-50"
        >
          GO
        </button>
      </div>

      {/* Purchase Panel */}
      {!hasActiveSession && (
        <div className="retro-border p-3 bg-gray-100 space-y-3">
          <h4 className="font-bold text-xs uppercase">Purchase Proxy Time</h4>
          <div className="flex gap-2 items-center">
            <span className="text-[10px] font-bold uppercase">Minutes:</span>
            {MINUTE_OPTIONS.map(m => (
              <button
                key={m}
                onClick={() => setMinutes(m)}
                className={`retro-border px-3 py-1 text-[10px] font-bold ${minutes === m ? 'retro-border-inset bg-blue-100' : 'bg-[#c0c0c0]'}`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold">Total: <span className="text-blue-700">{totalCost} STRK</span></span>
            <button
              onClick={handlePayAndActivate}
              disabled={!isConnected || isLoading}
              className="retro-border retro-button bg-blue-700 text-white px-6 py-2 text-xs font-bold uppercase disabled:opacity-50 disabled:bg-gray-400"
            >
              {isLoading ? 'PROCESSING...' : 'PAY & ACTIVATE'}
            </button>
          </div>
          {!isConnected && (
            <p className="text-[10px] text-red-600 font-bold">Connect your Starknet wallet to proceed.</p>
          )}
          <div className="text-[10px] text-gray-500">
            Payment goes to: {PROXY_WALLET.slice(0, 10)}...{PROXY_WALLET.slice(-6)}
          </div>
        </div>
      )}

      {/* Status */}
      {status && (
        <div className="retro-border-inset p-2 bg-gray-50 font-mono text-[10px]">
          <span className="text-gray-500">[SYS]</span> {status}
        </div>
      )}

      {/* Browser Frame */}
      <div className="retro-border-inset flex-1 bg-white min-h-[400px]">
        <Browser
          proxyUrl={proxyUrl}
          isLoading={browserLoading}
          onLoadStart={() => setBrowserLoading(true)}
          onLoadEnd={() => setBrowserLoading(false)}
          onError={(err) => setStatus(`BROWSER ERROR: ${err}`)}
        />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col crt relative">
      {/* Sticky Navbar */}
      <nav className="sticky top-0 z-50 retro-border bg-[#c0c0c0] border-b-2 border-gray-400">
        <div className="max-w-6xl mx-auto px-4 py-1.5 flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-lg font-bold font-['VT323'] text-blue-900 tracking-wider">ZOR</span>
            <span className="text-[8px] text-gray-600 hidden sm:inline">v0.1-LAB</span>
          </div>

          {/* Nav buttons */}
          <div className="flex gap-1">
            <button
              onClick={() => setViewMode('home')}
              className={`px-3 py-1 text-[10px] font-bold retro-border ${viewMode === 'home' ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}
            >
              HOME
            </button>
            <button
              onClick={() => setViewMode('browse')}
              className={`px-3 py-1 text-[10px] font-bold retro-border ${viewMode === 'browse' ? 'retro-border-inset bg-gray-300' : 'bg-[#c0c0c0]'}`}
            >
              BROWSE
            </button>
          </div>

          {/* Session indicator in navbar */}
          {hasActiveSession && (
            <div className="hidden md:flex items-center gap-1.5 text-[10px] text-green-700 font-bold">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
              {timeRemaining}
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1"></div>

          {/* Wallet — compact inline */}
          <WalletConnect onAccountChange={setAccount} />
        </div>
      </nav>

      {/* Marquee ticker */}
      <div className="bg-black overflow-hidden">
        <div className="whitespace-nowrap animate-marquee py-0.5 text-[10px] font-bold text-green-500 font-mono">
          ZOR_PROXY :: STRK20 ANONYMOUS PROXY LAB :: STEALTH MODE :: NO LOGS :: STARKNET POWERED :: ZERO-KNOWLEDGE PRIVACY ::
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <section className="lg:col-span-3">
            <RetroWindow
              title={viewMode === 'home' ? 'ZOR:\\HOME.EXE' : 'ZOR:\\BROWSER.EXE'}
              className="h-full min-h-[550px]"
            >
              {viewMode === 'home' ? renderHome() : renderBrowse()}
            </RetroWindow>
          </section>

          <aside className="space-y-4">
            {/* Session Info */}
            <RetroWindow title="SESSION_INFO" icon="⏱">
              <div className="space-y-2 text-[10px]">
                <div className="flex justify-between">
                  <span className="font-bold uppercase">Status:</span>
                  <span className={hasActiveSession ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                    {hasActiveSession ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                {hasActiveSession && (
                  <>
                    <div className="flex justify-between">
                      <span className="font-bold uppercase">Time Left:</span>
                      <span className="font-bold">{timeRemaining}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-bold uppercase">Expires:</span>
                      <span>{new Date(sessionExpires!).toLocaleTimeString()}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between">
                  <span className="font-bold uppercase">Wallet:</span>
                  <span>{isConnected ? `${(account.address || account.selectedAddress || '').slice(0, 8)}...` : 'NONE'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold uppercase">Rate:</span>
                  <span>{PRICE_PER_MINUTE} STRK/min</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-bold uppercase">Stealth:</span>
                  <span className="text-green-600 font-bold">ENABLED</span>
                </div>
              </div>
            </RetroWindow>

            <div className="retro-border p-4 bg-gray-200 space-y-2">
              <h4 className="text-[10px] font-bold uppercase underline">Proxy Network</h4>
              <div className="w-full h-24 bg-black border-2 border-white relative overflow-hidden">
                <div className="absolute inset-0 flex items-center justify-around opacity-40">
                  <div className="w-1 h-12 bg-green-500 animate-pulse"></div>
                  <div className="w-1 h-8 bg-green-500 animate-bounce"></div>
                  <div className="w-1 h-16 bg-green-500 animate-pulse delay-75"></div>
                  <div className="w-1 h-10 bg-green-500 animate-bounce delay-150"></div>
                </div>
                <div className="absolute bottom-1 right-1 text-[8px] text-green-500 font-mono">
                  STEALTH: ACTIVE
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto bg-[#c0c0c0] retro-border border-t-2 border-gray-400 py-1 px-4 flex justify-between items-center text-[10px] font-bold">
        <div className="flex gap-2 text-gray-700">
          <span>[Wallet: {isConnected ? 'ON' : 'OFF'}]</span>
          <span>[Session: {hasActiveSession ? 'ACTIVE' : 'NONE'}]</span>
        </div>
        <div className="flex gap-3">
          <div className="retro-border-inset px-2 flex items-center gap-1">
            <span className={hasActiveSession ? 'text-green-600' : 'text-red-600'}>●</span>
            {hasActiveSession ? 'STEALTH_PROXY' : 'PROXY_IDLE'}
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
