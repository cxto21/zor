
import React, { useState, useEffect, useCallback } from 'react';
import RetroWindow from './components/RetroWindow';
import WalletConnect from './components/WalletConnect';
import Browser from './components/Browser';
import {
  getDepositAddress,
  activateSession,
  checkSession,
  getProxyUrl,
  verifyDeposit,
  hasStrk20Support,
  getDeployParams,
  fundAccount,
  PROXY_WALLET,
  PRICE_PER_MINUTE,
  STRK20_CONTRACT,
  PRIVACY_POOL_ADDRESS,
} from './services/proxyService';

type ViewMode = 'home' | 'browse';
type PayStep = 'idle' | 'deposit' | 'funded' | 'activating';

const MINUTE_OPTIONS = [15, 30, 60, 120];
const SESSION_TOKEN_KEY = 'zor_session_token';
const SESSION_DEPOSIT_KEY = 'zor_session_deposit';
const SESSION_BALANCE_KEY = 'zor_session_balance';

const App: React.FC = () => {
  const [account, setAccount] = useState<any>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [minutes, setMinutes] = useState<number>(30);
  const [url, setUrl] = useState<string>('');
  const [proxyUrl, setProxyUrl] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionBalance, setSessionBalance] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [browserLoading, setBrowserLoading] = useState<boolean>(false);

  // Pay flow state
  const [payStep, setPayStep] = useState<PayStep>('idle');
  const [depositAddress, setDepositAddress] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState<string | null>(null);
  const [depositMinutes, setDepositMinutes] = useState<number>(0);
  const [strk20Supported, setStrk20Supported] = useState<boolean>(false);

  // Restore session from localStorage on mount
  useEffect(() => {
    const savedToken = localStorage.getItem(SESSION_TOKEN_KEY);
    const savedBalance = localStorage.getItem(SESSION_BALANCE_KEY);
    if (savedToken) {
      (async () => {
        const result = await checkSession(savedToken);
        if (result.valid) {
          setSessionToken(savedToken);
          setSessionBalance(result.balance || '0');
          setViewMode('browse');
          setStatus('SESSION RESTORED');
        } else {
          localStorage.removeItem(SESSION_TOKEN_KEY);
          localStorage.removeItem(SESSION_BALANCE_KEY);
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
        setStatus('SESSION EXPIRED — insufficient balance');
        setTimeRemaining('');
        localStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(SESSION_BALANCE_KEY);
        return;
      }

      setSessionBalance(result.balance || '0');
      const mins = result.minutesRemaining || 0;
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      setTimeRemaining(hrs > 0 ? `${hrs}h ${m}m` : `${m}m`);

      if (result.lowBalance) {
        setStatus(`LOW BALANCE — ${result.balance} STRK remaining. Top up soon!`);
      }
    };

    tick();
    const interval = setInterval(tick, 15_000); // check every 15s
    return () => clearInterval(interval);
  }, [sessionToken]);

  // Step 1: Get deposit address
  const handleGetDepositAddress = async () => {
    if (!account) {
      setStatus('ERROR: Connect wallet first.');
      return;
    }

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
        setStatus(`Deposit address generated. Send ${result.expectedAmount} STRK to continue.`);
      } else {
        setStatus(`ERROR: ${result.error}`);
      }
    } catch (error: any) {
      setStatus(`ERROR: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Step 2: Send STRK from connected wallet to deposit address
  const handleSendAndActivate = async () => {
    if (!account || !depositAddress || !depositAmount) return;

    setIsLoading(true);
    setStatus('Sending STRK from wallet...');

    try {
      const amountWei = BigInt(Math.floor(parseFloat(depositAmount) * 1e18));

      // Split amount into low/high parts for felt252 (max 128 bits each)
      const amountLow = amountWei & BigInt('0xffffffffffffffffffffffffffffffff');
      const amountHigh = amountWei >> BigInt(128);

      // Pad deposit address to 64 hex chars (32 bytes) for Starknet
      const paddedAddress = depositAddress.toLowerCase().replace('0x', '').padStart(64, '0');

      // Try V3 transaction first (default for starknet.js v10)
      let result: any = null;
      let lastError: any = null;

      // Attempt 1: V3 with explicit resource bounds
      try {
        result = await account.execute(
          {
            contractAddress: STRK20_CONTRACT,
            entrypoint: 'transfer',
            calldata: [
              '0x' + paddedAddress,
              '0x' + amountLow.toString(16),
              '0x' + amountHigh.toString(16),
            ]
          },
          {
            version: 0x3,
            resourceBounds: {
              l1_gas: { max_amount: '0x1000', max_price_per_unit: '0x2386f26fc10000' },
              l2_gas: { max_amount: '0x100000', max_price_per_unit: '0x2386f26fc10000' },
              l1_data_gas: { max_amount: '0x200', max_price_per_unit: '0x2386f26fc10000' },
            }
          }
        );
      } catch (e1) {
        lastError = e1;
        console.warn('V3 tx failed, trying V1 with maxFee:', e1);

        // Attempt 2: V1 with maxFee (fallback for older wallets)
        try {
          result = await account.execute(
            {
              contractAddress: STRK20_CONTRACT,
              entrypoint: 'transfer',
              calldata: [
                '0x' + paddedAddress,
                '0x' + amountLow.toString(16),
                '0x' + amountHigh.toString(16),
              ]
            },
            { version: 0x1, maxFee: '0x1600000' }
          );
        } catch (e2) {
          lastError = e2;
          console.warn('V1 also failed:', e2);
        }
      }

      if (!result) {
        throw lastError || new Error('Failed to send transaction');
      }

      const txHash = result.transaction_hash;
      setStatus(`TX sent: ${txHash.slice(0, 16)}... Waiting for confirmation...`);

      // Wait for tx to be indexed
      await new Promise(resolve => setTimeout(resolve, 8000));

      // Now activate
      setPayStep('funded');
      setStatus('Verifying balance on-chain...');

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
        setStatus('SESSION ACTIVE');
        setViewMode('browse');

        localStorage.setItem(SESSION_TOKEN_KEY, activation.token);
        localStorage.setItem(SESSION_BALANCE_KEY, activation.balance || '0');
      } else {
        setPayStep('deposit');
        setStatus(`ACTIVATION FAILED: ${activation.error || 'Balance not yet available. Try "I sent it manually".'}`);
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('user declined') || msg.includes('user rejected')) {
        setStatus('Payment cancelled by user.');
      } else {
        setStatus(`TX FAILED — use "I sent it manually": ${msg.slice(0, 80)}`);
      }
      setPayStep('deposit');
    } finally {
      setIsLoading(false);
    }
  };

  // Manual "I've sent it" — show retry activate button
  const handleFunded = () => {
    setPayStep('funded');
    setStatus('Click "Verify & Activate" once your TX is confirmed on Starknet.');
  };

  // Step 3: Activate session after funding
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
        setStatus('SESSION ACTIVE');
        setViewMode('browse');

        localStorage.setItem(SESSION_TOKEN_KEY, result.token);
        localStorage.setItem(SESSION_BALANCE_KEY, result.balance || '0');
      } else {
        setPayStep('deposit');
        setStatus(`ACTIVATION FAILED: ${result.error || 'Insufficient balance'}`);
      }
    } catch (error: any) {
      setStatus(`ERROR: ${error.message}`);
      setPayStep('deposit');
    } finally {
      setIsLoading(false);
    }
  };

  // STRK20 Privacy Pool deposit — uses wallet's built-in ZK proof
  const handleStrk20Deposit = async () => {
    if (!account || !strk20Supported) return;

    setIsLoading(true);
    setStatus('Depositing to privacy pool via STRK20...');

    try {
      const amountWei = BigInt(Math.floor(minutes * PRICE_PER_MINUTE * 1e18));

      // Step 1: Deposit into privacy pool via wallet's STRK20 API
      // The wallet handles: approval, ZK proof generation, submission
      const depositResult = await account.strk20InvokeTransaction([
        {
          type: 'deposit',
          token: STRK20_CONTRACT,
          amount: amountWei.toString(),
        },
      ]);

      const txHash = depositResult.transaction_hash;
      setStatus(`Deposit TX sent: ${txHash.slice(0, 16)}... Verifying on-chain...`);

      // Step 2: Wait for confirmation
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Step 3: Verify deposit via worker (worker checks on-chain event)
      const verification = await verifyDeposit(
        txHash,
        account.address || account.selectedAddress,
        amountWei.toString()
      );

      if (verification.success && verification.verified) {
        // Step 4: Activate session
        const activation = await activateSession(
          account.address || account.selectedAddress,
          'strk20-pool', // deposit address is the pool
          minutes
        );

        if (activation.success && activation.token) {
          setSessionToken(activation.token);
          setSessionBalance(activation.balance || '0');
          setPayStep('idle');
          setDepositAddress(null);
          setDepositAmount(null);
          setStatus('SESSION ACTIVE (STRK20 Privacy Pool)');
          setViewMode('browse');

          localStorage.setItem(SESSION_TOKEN_KEY, activation.token);
          localStorage.setItem(SESSION_BALANCE_KEY, activation.balance || '0');
        } else {
          setStatus(`ACTIVATION FAILED: ${activation.error}`);
        }
      } else {
        setStatus(`VERIFICATION FAILED: ${verification.error || 'Deposit not found on-chain'}`);
      }
    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('user declined') || msg.includes('user rejected')) {
        setStatus('Deposit cancelled by user.');
      } else {
        setStatus(`STRK20 DEPOSIT FAILED: ${msg.slice(0, 100)}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Deploy per-user account via master account
  const handleDeployAccount = async () => {
    if (!account) return;

    setIsLoading(true);
    setStatus('Deploying per-user account...');

    try {
      const walletAddress = account.address || account.selectedAddress;
      const depositAddr = depositAddress || '0x00';

      // Step 1: Get deployment parameters from worker
      const deployParams = await getDeployParams(depositAddr, walletAddress);

      if (!deployParams.success || !deployParams.accountAddress || !deployParams.salt) {
        setStatus(`DEPLOY FAILED: ${deployParams.error}`);
        return;
      }

      setStatus(`Account address: ${deployParams.accountAddress.slice(0, 20)}... Deploying...`);

      // Step 2: Fund the account from master (worker signs and broadcasts)
      const fundingWei = BigInt(Math.floor(minutes * PRICE_PER_MINUTE * 1e18)).toString();
      const fundResult = await fundAccount(deployParams.accountAddress, fundingWei);

      if (!fundResult.success) {
        setStatus(`FUND FAILED: ${fundResult.error}`);
        return;
      }

      setStatus(`Account funded. TX: ${fundResult.txHash?.slice(0, 16)}...`);

      // Step 3: Activate session using the new account
      const activation = await activateSession(
        deployParams.accountAddress,
        deployParams.masterAddress || '',
        minutes
      );

      if (activation.success && activation.token) {
        setSessionToken(activation.token);
        setSessionBalance(activation.balance || '0');
        setPayStep('idle');
        setDepositAddress(null);
        setDepositAmount(null);
        setStatus('SESSION ACTIVE (Per-User Account)');
        setViewMode('browse');

        localStorage.setItem(SESSION_TOKEN_KEY, activation.token);
        localStorage.setItem(SESSION_BALANCE_KEY, activation.balance || '0');
      } else {
        setStatus(`ACTIVATION FAILED: ${activation.error}`);
      }
    } catch (error: any) {
      setStatus(`DEPLOY FAILED: ${(error?.message || String(error)).slice(0, 100)}`);
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
    setSessionBalance(null);
    setProxyUrl('');
    setPayStep('idle');
    setDepositAddress(null);
    setStatus('Session ended.');
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_BALANCE_KEY);
  };

  const handleCancelPay = () => {
    setPayStep('idle');
    setDepositAddress(null);
    setDepositAmount(null);
    setStatus('');
  };

  const isConnected = !!account;
  const hasActiveSession = !!sessionToken;
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
              <li>Get a deposit address & send STRK</li>
              <li>Browse — balance is deducted in real time</li>
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
          <span className="text-[10px] uppercase mt-2">v0.2-LAB</span>
        </div>
      </div>

      <div className="retro-border-inset p-2 bg-black text-green-500 font-mono text-xs">
        <p>PROXY STATUS: READY</p>
        <p>NETWORK: STARKNET SEPOLIA</p>
        <p>STEALTH: ENABLED (raw TCP sockets)</p>
        <p>PRIVACY: cf-* HEADERS STRIPPED</p>
        <p>BILLING: BALANCE-BASED (deducts in real time)</p>
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
            {hasActiveSession ? `BALANCE: ${sessionBalance || '0'} STRK — ${timeRemaining}` : 'NO ACTIVE SESSION'}
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

      {/* PAY FLOW */}
      {!hasActiveSession && payStep === 'idle' && (
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

            <div className="flex gap-2">
              <button
                onClick={handleDeployAccount}
                disabled={!isConnected || isLoading}
                className="retro-border retro-button bg-green-700 text-white px-4 py-2 text-xs font-bold uppercase disabled:opacity-50 disabled:bg-gray-400"
              >
                {isLoading ? 'DEPLOYING...' : '🔑 DEPLOY ACCOUNT'}
              </button>

              {strk20Supported ? (
                <button
                  onClick={handleStrk20Deposit}
                  disabled={!isConnected || isLoading}
                  className="retro-border retro-button bg-purple-700 text-white px-4 py-2 text-xs font-bold uppercase disabled:opacity-50 disabled:bg-gray-400"
                >
                  {isLoading ? 'DEPOSITING...' : '🔒 DEPOSIT'}
                </button>
              ) : (
                <button
                  onClick={handleGetDepositAddress}
                  disabled={!isConnected || isLoading}
                  className="retro-border retro-button bg-blue-700 text-white px-4 py-2 text-xs font-bold uppercase disabled:opacity-50 disabled:bg-gray-400"
                >
                  {isLoading ? 'GENERATING...' : 'GET DEPOSIT'}
                </button>
              )}
            </div>
          </div>
          {strk20Supported && (
            <p className="text-[9px] text-purple-600 font-bold">
              🔒 Your wallet supports STRK20 privacy pool. Deposit is private — only the deposit event is public.
            </p>
          )}
          {!isConnected && (
            <p className="text-[10px] text-red-600 font-bold">Connect your Starknet wallet to proceed.</p>
          )}
        </div>
      )}

      {/* DEPOSIT ADDRESS DISPLAY */}
      {!hasActiveSession && payStep === 'deposit' && depositAddress && (
        <div className="retro-border p-3 bg-yellow-50 space-y-3 border-2 border-yellow-400">
          <h4 className="font-bold text-xs uppercase text-yellow-800">⚠ Send STRK to this address</h4>
          <div className="retro-border-inset p-2 bg-white">
            <div className="text-[10px] font-bold uppercase mb-1">Deposit Address:</div>
            <div className="font-mono text-[10px] break-all bg-gray-100 p-2 select-all">
              {depositAddress}
            </div>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span>Amount: <span className="font-bold text-blue-700">{depositAmount} STRK</span></span>
            <span className="text-gray-500">{depositMinutes} min</span>
          </div>

          {/* Primary: Send from connected wallet */}
          <button
            onClick={handleSendAndActivate}
            disabled={isLoading}
            className="retro-border retro-button bg-blue-700 text-white px-6 py-3 text-xs font-bold uppercase w-full disabled:opacity-50"
          >
            {isLoading ? 'SENDING...' : `SEND ${depositAmount} STRK & ACTIVATE`}
          </button>

          {/* Fallback: manual send */}
          <div className="flex gap-2">
            <button
              onClick={handleFunded}
              className="retro-border retro-button bg-green-600 text-white px-4 py-2 text-xs font-bold uppercase flex-1"
            >
              I'VE SENT IT MANUALLY
            </button>
            <button
              onClick={handleCancelPay}
              className="retro-border retro-button bg-gray-400 text-white px-3 py-2 text-xs font-bold uppercase"
            >
              CANCEL
            </button>
          </div>

          <p className="text-[9px] text-gray-500">
            Click the button above to send from your connected wallet, or send manually and click "I've sent it".
          </p>
        </div>
      )}

      {/* FUNDED — waiting for balance confirmation */}
      {!hasActiveSession && payStep === 'funded' && depositAddress && (
        <div className="retro-border p-3 bg-blue-50 space-y-3 border-2 border-blue-400">
          <h4 className="font-bold text-xs uppercase text-blue-800">⏳ Waiting for balance confirmation</h4>
          <div className="retro-border-inset p-2 bg-white">
            <div className="text-[10px] font-bold uppercase mb-1">Deposit Address:</div>
            <div className="font-mono text-[10px] break-all bg-gray-100 p-2 select-all">
              {depositAddress}
            </div>
          </div>
          <p className="text-[10px] text-gray-600">
            If you haven't sent yet, send <span className="font-bold">{depositAmount} STRK</span> to the address above.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleActivate}
              disabled={isLoading}
              className="retro-border retro-button bg-green-600 text-white px-6 py-2 text-xs font-bold uppercase flex-1 disabled:opacity-50"
            >
              {isLoading ? 'CHECKING...' : '✓ VERIFY & ACTIVATE'}
            </button>
            <button
              onClick={handleCancelPay}
              className="retro-border retro-button bg-gray-400 text-white px-3 py-2 text-xs font-bold uppercase"
            >
              CANCEL
            </button>
          </div>
          <p className="text-[9px] text-gray-500">
            Click "Verify & Activate" once your TX is confirmed on Starknet (usually ~30s).
          </p>
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
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-lg font-bold font-['VT323'] text-blue-900 tracking-wider">ZOR</span>
            <span className="text-[8px] text-gray-600 hidden sm:inline">v0.2-LAB</span>
          </div>

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

          {hasActiveSession && (
            <div className="hidden md:flex items-center gap-1.5 text-[10px] text-green-700 font-bold">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
              {sessionBalance} STRK — {timeRemaining}
            </div>
          )}

          <div className="flex-1"></div>

          <WalletConnect onAccountChange={(acc) => {
            setAccount(acc);
            setStrk20Supported(hasStrk20Support(acc));
          }} />
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
                      <span className="font-bold uppercase">Balance:</span>
                      <span className="font-bold">{sessionBalance || '0'} STRK</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-bold uppercase">Time Left:</span>
                      <span className="font-bold">{timeRemaining}</span>
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
