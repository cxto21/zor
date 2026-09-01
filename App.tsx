
import React, { useState, useEffect, useCallback } from 'react';
import WalletConnect from './components/WalletConnect';
import Browser from './components/Browser';
import {
  getDepositAddress,
  activateSession,
  checkSession,
  getProxyUrl,
  hasStrk20Support,
  PRICE_PER_MINUTE,
  STRK20_CONTRACT,
} from './services/proxyService';

type ViewMode = 'home' | 'browse';
type PayStep = 'idle' | 'deposit' | 'funded';

const MINUTE_OPTIONS = [15, 30, 60, 120];
const SESSION_TOKEN_KEY = 'zor_session_token';
const SESSION_BALANCE_KEY = 'zor_session_balance';
const SESSION_URL_KEY = 'zor_session_url';

const App: React.FC = () => {
  const [account, setAccount] = useState<any>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [minutes, setMinutes] = useState<number>(30);
  const [url, setUrl] = useState<string>('');
  const [proxyUrl, setProxyUrl] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionBalance, setSessionBalance] = useState<string | null>(null);
  const [strk20Supported, setStrk20Supported] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [browserLoading, setBrowserLoading] = useState<boolean>(false);
  const [maximized, setMaximized] = useState<boolean>(false);

  // Pay flow state
  const [payStep, setPayStep] = useState<PayStep>('idle');
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState<string | null>(null);
  const [depositMinutes, setDepositMinutes] = useState<number>(0);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem(SESSION_TOKEN_KEY);
    const savedBalance = localStorage.getItem(SESSION_BALANCE_KEY);
    const savedUrl = localStorage.getItem(SESSION_URL_KEY);
    if (savedToken) {
      (async () => {
        const result = await checkSession(savedToken);
        if (result.valid) {
          setSessionToken(savedToken);
          setSessionBalance(result.balance || '0');
          if (savedUrl) {
            setUrl(savedUrl);
            setProxyUrl(getProxyUrl(savedUrl, savedToken));
          }
          setViewMode('browse');
          setStatus('SESSION RESTORED');
        } else {
          localStorage.removeItem(SESSION_TOKEN_KEY);
          localStorage.removeItem(SESSION_BALANCE_KEY);
          localStorage.removeItem(SESSION_URL_KEY);
        }
      })();
    }
  }, []);

  // Balance-based countdown
  useEffect(() => {
    if (!sessionToken) {
      setTimeRemaining('');
      return;
    }

    const tick = async () => {
      const result = await checkSession(sessionToken);
      if (!result.valid) {
        setSessionToken(null);
        setSessionBalance(null);
        setProxyUrl('');
        setStatus('SESSION EXPIRED');
        setTimeRemaining('');
        localStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(SESSION_BALANCE_KEY);
        localStorage.removeItem(SESSION_URL_KEY);
        setViewMode('home');
        return;
      }

      setSessionBalance(result.balance || '0');
      const mins = result.minutesRemaining || 0;
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      setTimeRemaining(hrs > 0 ? `${hrs}h ${m}m` : `${m}m`);

      if (result.lowBalance) {
        setStatus(`LOW BALANCE — ${result.balance} STRK remaining`);
      }
    };

    tick();
    const interval = setInterval(tick, 15_000);
    return () => clearInterval(interval);
  }, [sessionToken]);

  // PAY & BROWSE — generate deposit address
  const handlePayAndBrowse = async () => {
    if (!account || !url.trim()) return;

    setIsLoading(true);
    setStatus('Generating deposit address...');

    try {
      const result = await getDepositAddress(
        account.address || account.selectedAddress,
        minutes
      );

      if (result.success && result.depositAddress) {
        setDepositAddress(result.depositAddress);
        setDepositAmount(result.expectedAmount || '0');
        setDepositMinutes(minutes);
        setPayStep('deposit');
        setStatus(`Send ${result.expectedAmount} STRK to activate.`);
      } else {
        setStatus(`ERROR: ${result.error}`);
      }
    } catch (error: any) {
      setStatus(`ERROR: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Send payment & activate
  const handleSendPayment = async () => {
    if (!account || !depositAddress || !depositAmount) return;

    setIsLoading(true);
    setStatus(strk20Supported ? 'Sending STRK20 private transfer...' : 'Sending STRK...');

    try {
      const amountWei = BigInt(Math.floor(parseFloat(depositAmount) * 1e18));
      const amountHex = '0x' + amountWei.toString(16);
      const recipientHex = depositAddress.toLowerCase();

      let txHash: string | null = null;

      if (strk20Supported && typeof account.strk20InvokeTransaction === 'function') {
        setStatus('Generating ZK proof via wallet...');
        try {
          const result = await account.strk20InvokeTransaction([{
            type: 'transfer',
            token: STRK20_CONTRACT,
            amount: amountHex,
            recipient: recipientHex,
          }]);
          txHash = result?.transaction_hash || null;
        } catch (e: any) {
          const msg = e?.message || String(e);
          if (msg.includes('WALLET_TIMEOUT') || msg.includes('timeout')) {
            setStatus('Transfer submitted (wallet timeout). Proceeding...');
          } else if (msg.includes('USER_REFUSED') || msg.includes('user declined') || msg.includes('user rejected')) {
            setStatus('Payment cancelled.');
            setPayStep('deposit');
            setIsLoading(false);
            return;
          } else {
            throw e;
          }
        }
      } else {
        const amountLow = amountWei & BigInt('0xffffffffffffffffffffffffffffffff');
        const amountHigh = amountWei >> BigInt(128);
        const paddedAddress = depositAddress.toLowerCase().replace('0x', '').padStart(64, '0');
        let result: any = null;
        try {
          result = await account.execute(
            { contractAddress: STRK20_CONTRACT, entrypoint: 'transfer',
              calldata: ['0x' + paddedAddress, '0x' + amountLow.toString(16), '0x' + amountHigh.toString(16)] },
            { version: 0x3, resourceBounds: {
              l1_gas: { max_amount: '0x1000', max_price_per_unit: '0x2386f26fc10000' },
              l2_gas: { max_amount: '0x100000', max_price_per_unit: '0x2386f26fc10000' },
              l1_data_gas: { max_amount: '0x200', max_price_per_unit: '0x2386f26fc10000' },
            }}
          );
        } catch {
          result = await account.execute(
            { contractAddress: STRK20_CONTRACT, entrypoint: 'transfer',
              calldata: ['0x' + paddedAddress, '0x' + amountLow.toString(16), '0x' + amountHigh.toString(16)] },
            { version: 0x1, maxFee: '0x1600000' }
          );
        }
        txHash = result?.transaction_hash || null;
      }

      if (txHash) {
        setStatus(`TX sent: ${txHash.slice(0, 16)}... Waiting...`);
        await new Promise(resolve => setTimeout(resolve, 8000));
      }

      // Activate session
      setStatus('Activating session...');
      const activation = await activateSession(
        account.address || account.selectedAddress,
        depositAddress,
        depositMinutes
      );

      if (activation.success && activation.token) {
        setSessionToken(activation.token);
        setSessionBalance(activation.balance || '0');
        setPayStep('idle');
        setDepositAddress(null);
        setDepositAmount(null);

        // Auto-navigate to the URL
        const formatted = url.startsWith('http') ? url : `https://${url}`;
        const fullUrl = getProxyUrl(formatted, activation.token);
        setProxyUrl(fullUrl);

        localStorage.setItem(SESSION_TOKEN_KEY, activation.token);
        localStorage.setItem(SESSION_BALANCE_KEY, activation.balance || '0');
        localStorage.setItem(SESSION_URL_KEY, formatted);

        setViewMode('browse');
        setStatus(strk20Supported ? 'SESSION ACTIVE (STRK20 Private)' : 'SESSION ACTIVE');
      } else {
        setPayStep('deposit');
        setStatus(`ACTIVATION FAILED: ${activation.error || 'Try "I sent it manually".'}`);
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('user declined') || msg.includes('user rejected')) {
        setStatus('Payment cancelled.');
      } else {
        setStatus(`TX FAILED: ${msg.slice(0, 80)}`);
      }
      setPayStep('deposit');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFunded = () => {
    setPayStep('funded');
    setStatus('Click "Verify & Activate" once TX is confirmed (~30s).');
  };

  const handleActivate = async () => {
    if (!account || !depositAddress) return;
    setIsLoading(true);
    setStatus('Checking balance...');
    try {
      const result = await activateSession(
        account.address || account.selectedAddress,
        depositAddress,
        depositMinutes
      );
      if (result.success && result.token) {
        setSessionToken(result.token);
        setSessionBalance(result.balance || '0');
        setPayStep('idle');
        setDepositAddress(null);
        setDepositAmount(null);

        const formatted = url.startsWith('http') ? url : `https://${url}`;
        const fullUrl = getProxyUrl(formatted, result.token);
        setProxyUrl(fullUrl);

        localStorage.setItem(SESSION_TOKEN_KEY, result.token);
        localStorage.setItem(SESSION_BALANCE_KEY, result.balance || '0');
        localStorage.setItem(SESSION_URL_KEY, formatted);

        setViewMode('browse');
        setStatus('SESSION ACTIVE');
      } else {
        setPayStep('deposit');
        setStatus(`FAILED: ${result.error || 'Insufficient balance'}`);
      }
    } catch (error: any) {
      setStatus(`ERROR: ${error.message}`);
      setPayStep('deposit');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadUrl = useCallback(() => {
    if (!url.trim() || !sessionToken) return;
    const formatted = url.startsWith('http') ? url : `https://${url}`;
    setProxyUrl(getProxyUrl(formatted, sessionToken));
    setBrowserLoading(true);
    localStorage.setItem(SESSION_URL_KEY, formatted);
  }, [url, sessionToken]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLoadUrl();
  };

  const handleLogout = () => {
    setSessionToken(null);
    setSessionBalance(null);
    setProxyUrl('');
    setUrl('');
    setPayStep('idle');
    setDepositAddress(null);
    setStatus('Session ended.');
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_BALANCE_KEY);
    localStorage.removeItem(SESSION_URL_KEY);
    setViewMode('home');
  };

  const isConnected = !!account;
  const hasActiveSession = !!sessionToken;
  const totalCost = (minutes * PRICE_PER_MINUTE).toFixed(4);

  return (
    <div className="min-h-screen bg-[#008080] flex flex-col">
      {/* Nav bar */}
      <nav className="retro-border bg-[#c0c0c0] px-3 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold font-['VT323'] tracking-widest text-blue-900">ZOR://PROXY</h1>
          {hasActiveSession && (
            <span className="text-[9px] font-mono text-green-700 bg-green-100 px-2 py-0.5 rounded">
              {sessionBalance || '0'} STRK — {timeRemaining}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasActiveSession && (
            <button onClick={handleLogout} className="text-[9px] text-red-600 font-bold hover:underline">
              [END]
            </button>
          )}
          <WalletConnect onAccountChange={(acc) => {
            setAccount(acc);
            setStrk20Supported(hasStrk20Support(acc));
          }} />
        </div>
      </nav>

      {/* Marquee */}
      <div className="bg-black overflow-hidden">
        <div className="whitespace-nowrap animate-marquee py-0.5 text-[10px] font-bold text-green-500 font-mono">
          ZOR_PROXY :: STRK20 ANONYMOUS PROXY LAB :: STEALTH MODE :: NO LOGS :: STARKNET POWERED :: ZERO-KNOWLEDGE PRIVACY ::
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-4">
        {viewMode === 'home' && !hasActiveSession && (
          <div className="space-y-4">
            {/* Hero */}
            <div className="text-center">
              <h1 className="text-4xl font-bold text-white mb-2 font-['VT323'] tracking-widest drop-shadow-lg">ZOR PROXY</h1>
              <p className="text-sm text-white/80 italic">Anonymous browsing, paid with STRK20.</p>
            </div>

            {/* URL Input — main CTA */}
            <div className="retro-border p-4 bg-white space-y-3">
              <h4 className="font-bold text-xs uppercase text-gray-600">What do you want to browse?</h4>
              <div className="flex gap-2 items-center">
                <div className="retro-border-inset flex-1 flex items-center">
                  <span className="text-xs px-2 text-gray-400 font-mono">https://</span>
                  <input
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="example.com"
                    disabled={!isConnected}
                    className="w-full bg-white px-1 py-1.5 text-sm font-mono outline-none disabled:bg-gray-100"
                  />
                </div>
              </div>

              {/* Tier selection */}
              <div className="flex gap-2 items-center">
                <span className="text-[10px] font-bold uppercase text-gray-500">Time:</span>
                {MINUTE_OPTIONS.map(m => (
                  <button
                    key={m}
                    onClick={() => setMinutes(m)}
                    className={`retro-border px-3 py-1 text-[10px] font-bold ${minutes === m ? 'retro-border-inset bg-blue-100 text-blue-800' : 'bg-[#c0c0c0]'}`}
                  >
                    {m}m — {(m * PRICE_PER_MINUTE).toFixed(3)} STRK
                  </button>
                ))}
              </div>

              {/* Pay button */}
              {!isConnected ? (
                <p className="text-[10px] text-red-600 font-bold">Connect your Starknet wallet to proceed.</p>
              ) : (
                <button
                  onClick={handlePayAndBrowse}
                  disabled={!url.trim() || isLoading}
                  className="retro-border retro-button bg-blue-700 text-white px-6 py-2 text-xs font-bold uppercase disabled:opacity-50 disabled:bg-gray-400 w-full"
                >
                  {isLoading ? 'GENERATING...' : strk20Supported ? `🔒 PAY ${totalCost} STRK20 & BROWSE` : `💳 PAY ${totalCost} STRK & BROWSE`}
                </button>
              )}

              {isConnected && strk20Supported && (
                <p className="text-[9px] text-green-600 font-bold">🔒 Ready wallet — payments use STRK20 private transfers.</p>
              )}
            </div>

            {/* Deposit address display */}
            {payStep === 'deposit' && depositAddress && (
              <div className="retro-border p-3 bg-yellow-50 space-y-3 border-2 border-yellow-400">
                <h4 className="font-bold text-xs uppercase text-yellow-800">⚠ Send STRK to this address</h4>
                <div className="retro-border-inset p-2 bg-white">
                  <div className="text-[10px] font-bold uppercase mb-1">Deposit Address:</div>
                  <div className="font-mono text-[10px] break-all bg-gray-100 p-2 select-all">{depositAddress}</div>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span>Amount: <span className="font-bold text-blue-700">{depositAmount} STRK</span></span>
                  <span className="text-gray-500">{depositMinutes} min</span>
                </div>
                <button
                  onClick={handleSendPayment}
                  disabled={isLoading}
                  className="retro-border retro-button bg-blue-700 text-white px-6 py-3 text-xs font-bold uppercase w-full disabled:opacity-50"
                >
                  {isLoading ? 'SENDING...' : strk20Supported ? `🔒 SEND ${depositAmount} STRK20 PRIVATE` : `SEND ${depositAmount} STRK & ACTIVATE`}
                </button>
                <div className="flex gap-2">
                  <button onClick={handleFunded} className="retro-border retro-button bg-green-600 text-white px-4 py-2 text-xs font-bold uppercase flex-1">
                    I'VE SENT IT MANUALLY
                  </button>
                  <button onClick={() => { setPayStep('idle'); setDepositAddress(null); setStatus(''); }}
                    className="retro-border retro-button bg-gray-400 text-white px-3 py-2 text-xs font-bold uppercase">
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Funded — waiting */}
            {payStep === 'funded' && depositAddress && (
              <div className="retro-border p-3 bg-blue-50 space-y-3 border-2 border-blue-400">
                <h4 className="font-bold text-xs uppercase text-blue-800">⏳ Waiting for confirmation</h4>
                <div className="retro-border-inset p-2 bg-white">
                  <div className="font-mono text-[10px] break-all bg-gray-100 p-2 select-all">{depositAddress}</div>
                </div>
                <button
                  onClick={handleActivate}
                  disabled={isLoading}
                  className="retro-border retro-button bg-green-600 text-white px-6 py-2 text-xs font-bold uppercase w-full disabled:opacity-50"
                >
                  {isLoading ? 'CHECKING...' : '✓ VERIFY & ACTIVATE'}
                </button>
                <button onClick={() => { setPayStep('idle'); setDepositAddress(null); setStatus(''); }}
                  className="retro-border retro-button bg-gray-400 text-white px-3 py-2 text-xs font-bold uppercase w-full">
                  CANCEL
                </button>
              </div>
            )}

            {/* Status */}
            {status && (
              <div className="retro-border-inset p-2 bg-black text-green-500 font-mono text-xs">
                <p>{status}</p>
              </div>
            )}

            {/* Info */}
            <div className="retro-border p-3 bg-white/90">
              <div className="grid grid-cols-2 gap-4 text-[10px]">
                <div>
                  <h4 className="font-bold uppercase text-gray-600 mb-1">How it works</h4>
                  <ol className="space-y-0.5 list-decimal list-inside text-gray-500">
                    <li>Connect your Starknet wallet</li>
                    <li>Enter a URL & select time</li>
                    <li>Pay with STRK/STRK20</li>
                    <li>Browse anonymously</li>
                  </ol>
                </div>
                <div>
                  <h4 className="font-bold uppercase text-gray-600 mb-1">Privacy</h4>
                  <ul className="space-y-0.5 text-gray-500">
                    <li>• Your IP is never leaked</li>
                    <li>• cf-* headers stripped</li>
                    <li>• Stealth TCP sockets</li>
                    <li>• Balance-based billing</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BROWSE MODE */}
        {(viewMode === 'browse' || hasActiveSession) && (
          <div className={`space-y-2 ${maximized ? 'fixed inset-0 z-50 bg-[#008080] p-2' : ''}`}>
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
                  className="w-full bg-white px-1 py-0.5 text-xs font-mono outline-none"
                />
              </div>
              <button
                onClick={handleLoadUrl}
                disabled={!url.trim()}
                className="retro-border retro-button bg-[#c0c0c0] px-4 py-1 text-[10px] font-bold uppercase disabled:opacity-50"
              >
                GO
              </button>
              <button
                onClick={() => setMaximized(!maximized)}
                className="retro-border retro-button bg-[#c0c0c0] px-2 py-1 text-[10px] font-bold"
                title={maximized ? 'Restore' : 'Maximize'}
              >
                {maximized ? '□' : '□'}
              </button>
            </div>

            {/* Browser */}
            <div className={maximized ? 'flex-1' : ''}>
              <Browser
                proxyUrl={proxyUrl}
                isLoading={browserLoading}
                maximized={maximized}
                onLoadStart={() => setBrowserLoading(true)}
                onLoadEnd={() => setBrowserLoading(false)}
              />
            </div>
          </div>
        )}
      </main>

      {/* Status bar */}
      <div className="retro-border p-0.5 px-3 bg-[#c0c0c0] flex items-center justify-between">
        <span className="text-[8px] font-mono text-gray-600">
          {hasActiveSession ? `✅ ACTIVE — ${sessionBalance || '0'} STRK — ${timeRemaining}` : '💤 No session'}
        </span>
        <span className="text-[8px] font-mono text-gray-600">ZOR v0.2 • STRK20 • STARKNET SEPOLIA</span>
      </div>
    </div>
  );
};

export default App;
