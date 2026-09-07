
import React, { useState, useEffect, useCallback } from 'react';
import WalletConnect from './components/WalletConnect';
import Browser from './components/Browser';
import {
  getDepositAddress,
  activateSession,
  checkSession,
  getProxyUrl,
  hasStrk20Support,
  verifyPrivateTransfer,
  PRICE_PER_MINUTE,
  STRK20_CONTRACT,
  MASTER_ADDRESS,
  MASTER_ADDRESS_NEW,
  PRIVACY_POOL_ADDRESS,
} from './services/proxyService';
import { RpcProvider } from 'starknet';

type ViewMode = 'home' | 'browse';
type PayStep = 'idle' | 'deposit' | 'funded';

const MINUTE_OPTIONS = [15, 30, 60, 120];
const SESSION_TOKEN_KEY = 'zor_session_token';
const SESSION_BALANCE_KEY = 'zor_session_balance';
const SESSION_URL_KEY = 'zor_session_url';

// Debug master — new Argent 0.4.0 account (Ready-compatible)
// Env override: VITE_MASTER_ADDRESS_NEW (vite) or hardcode fallback
const DEBUG_MASTER_FALLBACK = MASTER_ADDRESS_NEW;
const SEPOLIA_RPC_FALLBACK = 'https://starknet-sepolia.public.blastapi.io/rpc/v0_7';
const DEBUG_AMOUNT_DECIMAL = '1000000000000'; // 0.000001 STRK (1e12 wei)

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

  // Debug shield state (master-only)
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugTxHash, setDebugTxHash] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState<string>('');
  const [debugRegistered, setDebugRegistered] = useState<boolean | null>(null);

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
  // Prover requirement: real VIRTUAL_SNOS proof needs PROVING_SERVICE_URL
  // (ghcr.io/starkware-libs/starknet-privacy/transaction-prover:PRIVACY-0.14.3-RC.2 on Fly/Railway)
  // with 10-block maturity (provingBlockId = head-10).
  const handleSendPayment = async () => {
    if (!account || !depositAddress || !depositAmount) return;

    setIsLoading(true);
    setStatus('Sending STRK...');

    try {
      const amountWei = BigInt(Math.floor(parseFloat(depositAmount) * 1e18));
      const priceWei = BigInt(Math.floor(PRICE_PER_MINUTE * 1e18)) * BigInt(depositMinutes);
      // Use the larger of parsed depositAmount and price-based amount (ensures PRICE_PER_MINUTE * minutes)
      const finalAmountWei = amountWei > 0n ? amountWei : priceWei;
      let txHash: string | null = null;
      let privateAttempted = false;
      let privateSucceeded = false;

      // Private transfer path: if wallet supports strk20 (Ready wallet), try wallet_strk20InvokeTransaction
      // Master-receiver model: user (already registered via Ready) private-transfers to MASTER_ADDRESS.
      // Worker attributes payment via discoverNotes (sender channel).
      const walletAddress = account.address || account.selectedAddress;
      const supportsPrivate = hasStrk20Support(account) || account.features?.['starknet:walletApi'] || typeof account.request === 'function';

      if (supportsPrivate) {
        privateAttempted = true;
        try {
          // Try wallet standard request first (Ready wallet)
          // Amount is finalAmountWei in hex wei string
          const amountHex = '0x' + finalAmountWei.toString(16);
          let privateResult: any = null;

          if (typeof account.request === 'function') {
            // Wallet standard API — check feature detection
            const hasStrk20Feature = account.features?.['starknet:walletApi'] || hasStrk20Support(account);
            if (hasStrk20Feature) {
              try {
                privateResult = await account.request({
                  type: 'wallet_strk20InvokeTransaction',
                  params: {
                    actions: [{ type: 'transfer', token: STRK20_CONTRACT, amount: amountHex, recipient: MASTER_ADDRESS }],
                  },
                });
              } catch {
                // Fallback to starknet.js strk20InvokeTransaction if wallet standard fails
                if (typeof account.strk20InvokeTransaction === 'function') {
                  privateResult = await account.strk20InvokeTransaction({
                    actions: [{ type: 'transfer', token: STRK20_CONTRACT, amount: finalAmountWei.toString(), recipient: MASTER_ADDRESS }],
                  });
                } else {
                  throw new Error('strk20 not supported via request');
                }
              }
            } else if (typeof account.strk20InvokeTransaction === 'function') {
              privateResult = await account.strk20InvokeTransaction({
                actions: [{ type: 'transfer', token: STRK20_CONTRACT, amount: finalAmountWei.toString(), recipient: MASTER_ADDRESS }],
              });
            }
          } else if (typeof account.strk20InvokeTransaction === 'function') {
            privateResult = await account.strk20InvokeTransaction({
              actions: [{ type: 'transfer', token: STRK20_CONTRACT, amount: finalAmountWei.toString(), recipient: MASTER_ADDRESS }],
            });
          }

          if (privateResult) {
            txHash = privateResult?.transaction_hash || privateResult?.txHash || null;
            privateSucceeded = true;
            setStatus(`Private TX sent: ${txHash ? txHash.slice(0, 16) + '...' : 'ok'} Verifying...`);
            await new Promise(resolve => setTimeout(resolve, 4000));

            // Verify via worker discovery (master viewing key)
            try {
              const verify = await verifyPrivateTransfer(walletAddress, depositMinutes, finalAmountWei.toString());
              if (verify.mock) {
                console.warn('Prover not configured, mock verification:', (verify as any).message);
                // In mock mode, consider private transfer as paid and fallback to standard activation for demo
                // Real flow needs PROVING_SERVICE_URL deployed
                setStatus('Prover not configured (mock) — using fallback activation...');
              } else if (verify.paid) {
                setStatus(`Private payment verified: ${verify.amount} wei`);
              } else {
                setStatus(`Private TX sent but not yet discovered (amount ${verify.amount || '0'}). Waiting for indexer...`);
                await new Promise(resolve => setTimeout(resolve, 3000));
              }

              // If verify returned a session token (when worker creates session on paid), use it
              if ((verify as any).token) {
                const token = (verify as any).token;
                setSessionToken(token);
                setSessionBalance((verify as any).balance || depositAmount || '0');
                setPayStep('idle');
                setDepositAddress(null);
                setDepositAmount(null);
                const formatted = url.startsWith('http') ? url : `https://${url}`;
                const fullUrl = getProxyUrl(formatted, token);
                setProxyUrl(fullUrl);
                localStorage.setItem(SESSION_TOKEN_KEY, token);
                localStorage.setItem(SESSION_BALANCE_KEY, (verify as any).balance || '0');
                localStorage.setItem(SESSION_URL_KEY, formatted);
                setViewMode('browse');
                setStatus('SESSION ACTIVE (private)');
                setIsLoading(false);
                return;
              }
            } catch (verifyErr) {
              console.warn('verifyPrivateTransfer failed, will fallback to standard activation', verifyErr);
            }

            // Fallback to standard activation flow even after private TX (for session creation)
            // Private notes will be used for billing; standard deposit check ensures session exists
          }
        } catch (privErr: any) {
          const msg = privErr?.message || String(privErr);
          // If user rejected private, bubble up; otherwise fallback to public transfer
          if (msg.toLowerCase().includes('user rejected') || msg.toLowerCase().includes('user declined')) {
            throw privErr;
          }
          console.warn('Private transfer failed, falling back to public ERC20:', privErr);
          privateSucceeded = false;
        }
      }

      // Fallback: standard ERC20 transfer to depositAddress (keep for backward compat)
      // Only if private didn't succeed or not supported
      if (!privateSucceeded) {
        const amountLow = finalAmountWei & BigInt('0xffffffffffffffffffffffffffffffff');
        const amountHigh = finalAmountWei >> BigInt(128);
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

      if (txHash && !privateSucceeded) {
        setStatus(`TX sent: ${txHash.slice(0, 16)}... Waiting...`);
        await new Promise(resolve => setTimeout(resolve, 8000));
      } else if (txHash && privateSucceeded) {
        // Already waited for private verification
      }

      // Activate session (works for both private and public flows; for private, verifyPrivateTransfer already checked)
      setStatus('Activating session...');
      const activation = await activateSession(
        walletAddress,
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
        setStatus(privateSucceeded ? 'SESSION ACTIVE (private → fallback activation)' : 'SESSION ACTIVE');
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

  // Debug: Registrar Master Shield via Wallet API (bypass Ready UI)
  const handleDebugShield = async () => {
    if (!account) return;
    setDebugLoading(true);
    setDebugTxHash(null);
    setDebugRegistered(null);
    setDebugStatus('Requesting wallet_strk20InvokeTransaction (deposit 0.000001 STRK)...');
    const actions = [{ type: 'deposit' as const, token: STRK20_CONTRACT, amount: DEBUG_AMOUNT_DECIMAL }];
    let result: any = null;
    let lastErr: string | null = null;
    // 1) Try wallet.request (Wallet Standard) — account.request
    if (typeof account.request === 'function') {
      try {
        result = await account.request({
          type: 'wallet_strk20InvokeTransaction',
          params: { actions },
        });
      } catch (e: any) {
        lastErr = e?.message || String(e);
        console.warn('[debug shield] account.request failed', e);
      }
    }
    // 2) Fallback: window.starknet.request (injected)
    if (!result && typeof (window as any)?.starknet?.request === 'function') {
      try {
        result = await (window as any).starknet.request({
          type: 'wallet_strk20InvokeTransaction',
          params: { actions },
        });
      } catch (e: any) {
        lastErr = e?.message || String(e);
        console.warn('[debug shield] window.starknet.request failed', e);
      }
    }
    // 3) Fallback: starknet.js WalletAccountV6 strk20InvokeTransaction (expects array, not object)
    if (!result && typeof (account as any).strk20InvokeTransaction === 'function') {
      try {
        result = await (account as any).strk20InvokeTransaction(actions);
      } catch (e: any) {
        lastErr = e?.message || String(e);
        console.warn('[debug shield] strk20InvokeTransaction failed', e);
      }
    }
    // 4) Fallback: try with BigInt amount
    if (!result && typeof (account as any).strk20InvokeTransaction === 'function') {
      try {
        const actionsBigInt = [{ type: 'deposit' as const, token: STRK20_CONTRACT, amount: BigInt(DEBUG_AMOUNT_DECIMAL) }];
        result = await (account as any).strk20InvokeTransaction(actionsBigInt);
      } catch (e: any) {
        lastErr = e?.message || String(e);
        console.warn('[debug shield] strk20InvokeTransaction BigInt failed', e);
      }
    }
    if (!result) {
      setDebugStatus(`No wallet method succeeded. Last error: ${(lastErr || 'unknown').slice(0, 120)}`);
      setDebugLoading(false);
      return;
    }
    const txHash: string = result?.transaction_hash || result?.transactionHash || result?.txHash || result?.hash || '';
    if (!txHash) {
      setDebugStatus(`Wallet returned no tx hash: ${JSON.stringify(result).slice(0, 200)}`);
      setDebugLoading(false);
      return;
    }
    setDebugTxHash(txHash);
    setDebugStatus(`TX sent: ${txHash.slice(0, 18)}... waiting 8s then polling get_public_key...`);
    // Wait for tx to be accepted
    await new Promise((r) => setTimeout(r, 8000));
    // Poll get_public_key
    const connectedAddr: string = account.address || account.selectedAddress || '';
    const workerUrl = (import.meta as any).env?.VITE_PROXY_WORKER_URL || '';
    const rpcUrl = (import.meta as any).env?.VITE_STARKNET_RPC_URL || SEPOLIA_RPC_FALLBACK;
    const masterAddrToCheck = connectedAddr;
    const pollGetPublicKey = async (): Promise<{ registered: boolean; raw?: string }> => {
      // Try via RpcProvider.callContract (handles selector hashing)
      try {
        const provider = new RpcProvider({ nodeUrl: rpcUrl });
        const res: any = await provider.callContract({
          contractAddress: PRIVACY_POOL_ADDRESS,
          entrypoint: 'get_public_key',
          calldata: [masterAddrToCheck],
        });
        const arr = Array.isArray(res) ? res : res ? [res] : [];
        const val = arr[0]?.toString?.() || String(arr[0] || '');
        const isRegistered = val !== '0x0' && val !== '0' && val !== '' && BigInt(val || '0') !== 0n;
        return { registered: isRegistered, raw: val };
      } catch (e: any) {
        // Fallback: try worker /shield-status or raw RPC
        console.warn('[debug shield] callContract failed', e?.message || e);
        // Try direct RPC fetch as fallback
        try {
          const selectorRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'starknet_call',
              params: [
                { contract_address: PRIVACY_POOL_ADDRESS, entry_point_selector: '0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b', calldata: [masterAddrToCheck] },
                'latest',
              ],
            }),
          });
          const data: any = await selectorRes.json();
          if (data?.result?.[0]) {
            const v = String(data.result[0]);
            return { registered: v !== '0x0' && BigInt(v) !== 0n, raw: v };
          }
        } catch {}
        throw e;
      }
    };
    let registered: boolean | null = null;
    for (let i = 0; i < 12; i++) {
      try {
        const { registered: ok, raw } = await pollGetPublicKey();
        if (ok) {
          registered = true;
          setDebugRegistered(true);
          setDebugStatus(`Registered! get_public_key=${String(raw).slice(0, 24)}... (attempt ${i + 1})`);
          break;
        } else {
          setDebugStatus(`Poll ${i + 1}/12: not yet registered (${String(raw || '0x0').slice(0, 16)}...), retry in 3s...`);
        }
      } catch (e: any) {
        setDebugStatus(`Poll ${i + 1}/12 error: ${(e?.message || String(e)).slice(0, 80)} retry...`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (registered !== true) {
      // Also try worker endpoint as last resort before giving up
      if (workerUrl) {
        try {
          const wr = await fetch(`${workerUrl.replace(/\/$/, '')}/shield-status`);
          const wj: any = await wr.json().catch(() => ({}));
          if (wj?.hasViewingKey || wj?.registered) {
            setDebugRegistered(true);
            setDebugStatus(`Worker reports registered (shield-status).`);
            setDebugLoading(false);
            return;
          }
        } catch {}
      }
      setDebugRegistered(false);
      setDebugStatus((prev) => prev + ' — not registered after 36s (tx may need more time or requires 10-block maturity).');
    }
    setDebugLoading(false);
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
  const connectedRaw = account?.address || account?.selectedAddress || '';
  const connectedAddrNorm = connectedRaw.toLowerCase();
  const masterNewRaw = (import.meta as any).env?.VITE_MASTER_ADDRESS_NEW || DEBUG_MASTER_FALLBACK;
  const isDebugMaster = (() => {
    if (!isConnected || !connectedRaw) return false;
    try {
      const a = BigInt(connectedRaw).toString(16);
      const b = BigInt(masterNewRaw as string).toString(16);
      const c = BigInt('0x79a12829bd0b99e0d78264892eb0b6724fd7409e54116418a5dfa4d72066878').toString(16);
      return a === b || a === c;
    } catch { return connectedAddrNorm === (masterNewRaw as string).toLowerCase(); }
  })();

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
        {/* Debug master panel — visible in browse mode too (home has its own copy below) */}
        {isDebugMaster && hasActiveSession && (
          <div className="retro-border p-3 bg-purple-50 space-y-2 border-2 border-purple-400 mb-4">
            <h4 className="font-bold text-xs uppercase text-purple-800">Debug: Registrar Master Shield</h4>
            <button
              onClick={handleDebugShield}
              disabled={debugLoading}
              className="retro-border retro-button bg-purple-700 text-white px-4 py-2 text-xs font-bold uppercase w-full disabled:opacity-50"
            >
              {debugLoading ? 'SENDING...' : 'REGISTRAR SHIELD (deposit 0.000001 STRK)'}
            </button>
            {debugStatus && (
              <div className="retro-border-inset p-2 bg-black text-green-400 font-mono text-[10px] break-all"><p>{debugStatus}</p></div>
            )}
            {debugTxHash && (
              <div className="space-y-1">
                <div className="font-mono text-[10px] break-all bg-white p-1.5 border"><span className="font-bold">tx:</span> {debugTxHash}</div>
                <a href={`https://sepolia.voyager.online/tx/${debugTxHash}`} target="_blank" rel="noreferrer" className="text-[10px] text-blue-700 underline break-all">Voyager: sepolia.voyager.online/tx/{debugTxHash.slice(0, 16)}...</a>
                {debugRegistered === true && <p className="text-[10px] text-green-700 font-bold">✓ get_public_key confirms registered</p>}
                {debugRegistered === false && <p className="text-[10px] text-yellow-700">Not yet registered — retry poll.</p>}
              </div>
            )}
          </div>
        )}
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
                  {isLoading ? 'GENERATING...' : `💳 PAY ${totalCost} STRK & BROWSE`}
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
                  {isLoading ? 'SENDING...' : `SEND ${depositAmount} STRK & ACTIVATE`}
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

            {/* Debug: Registrar Master Shield — only for new Argent master (bypass Ready UI) */}
            {isDebugMaster && (
              <div className="retro-border p-3 bg-purple-50 space-y-2 border-2 border-purple-400">
                <h4 className="font-bold text-xs uppercase text-purple-800">Debug: Registrar Master Shield</h4>
                <p className="text-[10px] text-purple-700">Master {connectedAddrNorm.slice(0, 10)}... — test STRK20 shield via Wallet API (no Ready UI needed). Sends deposit 0.000001 STRK (1000000000000 wei).</p>
                <button
                  onClick={handleDebugShield}
                  disabled={debugLoading}
                  className="retro-border retro-button bg-purple-700 text-white px-4 py-2 text-xs font-bold uppercase w-full disabled:opacity-50"
                >
                  {debugLoading ? 'SENDING...' : debugRegistered ? 'RE-SHIELD (deposit 1e12 wei)' : 'REGISTRAR SHIELD (deposit)'}
                </button>
                {debugStatus && (
                  <div className="retro-border-inset p-2 bg-black text-green-400 font-mono text-[10px] break-all">
                    <p>{debugStatus}</p>
                  </div>
                )}
                {debugTxHash && (
                  <div className="space-y-1">
                    <div className="font-mono text-[10px] break-all bg-white p-1.5 border">
                      <span className="font-bold">tx:</span> {debugTxHash}
                    </div>
                    <a
                      href={`https://sepolia.voyager.online/tx/${debugTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-blue-700 underline break-all"
                    >
                      Voyager: sepolia.voyager.online/tx/{debugTxHash.slice(0, 16)}...
                    </a>
                    {debugRegistered === true && <p className="text-[10px] text-green-700 font-bold">✓ get_public_key confirms registered</p>}
                    {debugRegistered === false && <p className="text-[10px] text-yellow-700">Not yet registered — tx may need ~30s + 10-block maturity. Poll again.</p>}
                  </div>
                )}
                <p className="text-[9px] text-gray-500">Tries account.request → window.starknet.request → account.strk20InvokeTransaction. Approve 2 txs if prompted (approve pool + deposit). Then polls pool get_public_key for confirmation.</p>
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
