
import React, { useState, useRef, useCallback, useEffect } from 'react';

interface BrowserProps {
  proxyUrl: string | null;
  isLoading: boolean;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: (error: string) => void;
}

const MAX_URL_DISPLAY_LENGTH = 60;

const Browser: React.FC<BrowserProps> = ({
  proxyUrl,
  isLoading,
  onLoadStart,
  onLoadEnd,
  onError,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [loadProgress, setLoadProgress] = useState<number>(0);

  // Track loading progress with a timer for the retro bar effect
  useEffect(() => {
    if (!isLoading) {
      setLoadProgress(0);
      return;
    }
    setLoadProgress(10);
    const t1 = setTimeout(() => setLoadProgress(40), 200);
    const t2 = setTimeout(() => setLoadProgress(65), 600);
    const t3 = setTimeout(() => setLoadProgress(85), 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [isLoading]);

  // Update history when proxyUrl changes
  useEffect(() => {
    if (proxyUrl) {
      setCurrentUrl(proxyUrl);
      setError(null);
      setHistory(prev => {
        // Don't duplicate if navigating to the same URL via history
        const newHistory = prev.slice(0, historyIndex + 1);
        newHistory.push(proxyUrl);
        return newHistory;
      });
      setHistoryIndex(prev => prev + 1);
    }
  }, [proxyUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleIframeLoad = useCallback(() => {
    setLoadProgress(100);
    setTimeout(() => {
      onLoadEnd?.();
    }, 150);
  }, [onLoadEnd]);

  const handleIframeError = useCallback(() => {
    const msg = 'Failed to load page. Check the URL or try again.';
    setError(msg);
    onError?.(msg);
  }, [onError]);

  const handleReload = useCallback(() => {
    if (iframeRef.current && currentUrl) {
      setError(null);
      onLoadStart?.();
      // Force reload by resetting the src
      const frame = iframeRef.current;
      const src = frame.src;
      frame.src = 'about:blank';
      setTimeout(() => {
        if (frame) {
          frame.src = src;
        }
      }, 50);
    }
  }, [currentUrl, onLoadStart]);

  const handleBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setCurrentUrl(history[newIndex]);
      setError(null);
      onLoadStart?.();
    }
  }, [historyIndex, history, onLoadStart]);

  const handleForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setCurrentUrl(history[newIndex]);
      setError(null);
      onLoadStart?.();
    }
  }, [historyIndex, history, onLoadStart]);

  const handleRetry = useCallback(() => {
    setError(null);
    onLoadStart?.();
    // Re-trigger load by toggling src
    if (iframeRef.current && currentUrl) {
      const frame = iframeRef.current;
      frame.src = 'about:blank';
      setTimeout(() => {
        if (frame) {
          frame.src = currentUrl;
        }
      }, 50);
    }
  }, [currentUrl, onLoadStart]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const displayUrl = currentUrl
    ? currentUrl.length > MAX_URL_DISPLAY_LENGTH
      ? currentUrl.slice(0, MAX_URL_DISPLAY_LENGTH) + '...'
      : currentUrl
    : 'about:blank';

  return (
    <div className="retro-border flex flex-col h-full min-h-[400px]">
      {/* Title bar */}
      <div className="win95-title">
        <div className="flex items-center gap-2">
          <span className="text-xs">🌐</span>
          <span className="text-sm uppercase tracking-wider font-['VT323']">
            ZOR://BROWSER.EXE
          </span>
        </div>
        <div className="flex gap-1">
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center">
            _
          </button>
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center">
            □
          </button>
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center font-bold">
            ×
          </button>
        </div>
      </div>

      {/* Navigation toolbar */}
      <div className="retro-border p-1 bg-[#c0c0c0] flex items-center gap-1 border-b-0">
        {/* Back */}
        <button
          onClick={handleBack}
          disabled={!canGoBack}
          className="retro-border retro-button bg-[#c0c0c0] px-2 py-0.5 text-[10px] font-bold uppercase disabled:opacity-40 disabled:cursor-default"
          title="Back"
        >
          ◄
        </button>
        {/* Forward */}
        <button
          onClick={handleForward}
          disabled={!canGoForward}
          className="retro-border retro-button bg-[#c0c0c0] px-2 py-0.5 text-[10px] font-bold uppercase disabled:opacity-40 disabled:cursor-default"
          title="Forward"
        >
          ►
        </button>
        {/* Reload */}
        <button
          onClick={handleReload}
          disabled={!currentUrl}
          className="retro-border retro-button bg-[#c0c0c0] px-2 py-0.5 text-[10px] font-bold uppercase disabled:opacity-40 disabled:cursor-default"
          title="Reload"
        >
          ↻
        </button>
        {/* Stop */}
        <button
          onClick={() => {
            if (iframeRef.current) {
              iframeRef.current.src = 'about:blank';
            }
          }}
          disabled={!isLoading}
          className="retro-border retro-button bg-[#c0c0c0] px-2 py-0.5 text-[10px] font-bold uppercase disabled:opacity-40 disabled:cursor-default"
          title="Stop"
        >
          ■
        </button>

        {/* Separator */}
        <div className="w-px h-4 bg-gray-500 mx-1" />

        {/* URL display */}
        <div className="retro-border-inset flex-1 flex items-center min-w-0">
          <span className="text-[10px] font-bold text-gray-500 px-1 shrink-0">🔗</span>
          <span className="text-[10px] font-mono px-1 truncate select-all">
            {displayUrl}
          </span>
        </div>
      </div>

      {/* Loading bar */}
      {(isLoading || loadProgress > 0) && (
        <div className="h-3 bg-[#c0c0c0] retro-border-inset mx-1 flex items-center">
          <div
            className="h-full bg-blue-700 transition-all duration-300"
            style={{ width: `${loadProgress}%` }}
          />
          {loadProgress > 0 && loadProgress < 100 && (
            <span className="absolute right-3 text-[8px] font-mono text-gray-600">
              {loadProgress}%
            </span>
          )}
        </div>
      )}

      {/* Content area */}
      <div className="retro-border-inset flex-1 bg-white relative min-h-[350px]">
        {/* Empty state — no URL loaded */}
        {!proxyUrl && !error && (
          <div className="flex flex-col items-center justify-center h-full min-h-[350px] text-center p-6">
            <div className="text-6xl mb-4 opacity-30">🌐</div>
            <h2 className="text-2xl font-bold font-['VT323'] text-gray-400 tracking-widest mb-2">
              ZOR PROXY BROWSER
            </h2>
            <p className="text-xs text-gray-400 font-mono mb-4">
              about:blank
            </p>
            <div className="retro-border-inset p-3 bg-gray-50 max-w-xs">
              <p className="text-[10px] text-gray-500 leading-relaxed">
                Enter a URL in the address bar above to start anonymous browsing.
                All traffic is routed through the ZOR stealth proxy network.
              </p>
            </div>
            <div className="mt-4 text-[8px] text-gray-400 font-mono">
              STRK20 POWERED • STEALTH MODE • NO LOGS
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="flex flex-col items-center justify-center h-full min-h-[350px] text-center p-6">
            <div className="text-5xl mb-4">⚠️</div>
            <h3 className="text-lg font-bold font-['VT323'] text-red-700 tracking-wide mb-2">
              CONNECTION ERROR
            </h3>
            <div className="retro-border-inset p-3 bg-red-50 max-w-sm mb-4">
              <p className="text-xs text-red-700 font-mono leading-relaxed">
                {error}
              </p>
            </div>
            <button
              onClick={handleRetry}
              className="retro-border retro-button bg-[#c0c0c0] px-6 py-2 text-xs font-bold uppercase"
            >
              ↻ RETRY
            </button>
            <p className="mt-3 text-[9px] text-gray-500 font-mono">
              If this persists, the target site may be blocking proxy requests.
            </p>
          </div>
        )}

        {/* Iframe — only rendered when we have a URL and no blocking error */}
        {proxyUrl && !error && (
          <iframe
            ref={iframeRef}
            src={proxyUrl}
            className="w-full h-full border-0 min-h-[350px]"
            title="Proxy Browser"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        )}
      </div>

      {/* Status bar */}
      <div className="retro-border p-0.5 px-2 bg-[#c0c0c0] flex items-center justify-between border-t-0">
        <span className="text-[8px] font-mono text-gray-600">
          {isLoading
            ? '⏳ Loading...'
            : error
              ? '❌ Error'
              : proxyUrl
                ? '✅ Ready'
                : '💤 Idle'}
        </span>
        <span className="text-[8px] font-mono text-gray-600">
          STEALTH PROXY • ZOR v0.1
        </span>
      </div>
    </div>
  );
};

export default Browser;
