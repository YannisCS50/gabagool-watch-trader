import { useState, useEffect, useRef, useCallback } from 'react';

interface UseChainlinkRealtimeResult {
  btcPrice: number | null;
  ethPrice: number | null;
  isConnected: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'error';
  updateCount: number;
  lastUpdate: Date | null;
}

// Use CoinGecko public API for crypto prices (no API key needed)
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd';
const POLL_INTERVAL = 5000; // 5 seconds

export function useChainlinkRealtime(enabled: boolean = true): UseChainlinkRealtimeResult {
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchPrices = useCallback(async () => {
    if (!enabled) return;
    
    try {
      // Cancel previous request if still pending
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      const response = await fetch(COINGECKO_API, {
        signal: abortControllerRef.current.signal,
        headers: { 'Accept': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.bitcoin?.usd) {
        setBtcPrice(data.bitcoin.usd);
      }
      if (data.ethereum?.usd) {
        setEthPrice(data.ethereum.usd);
      }
      
      setIsConnected(true);
      setConnectionState('connected');
      setUpdateCount(prev => prev + 1);
      setLastUpdate(new Date());
      
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return; // Ignore aborted requests
      }
      console.error('[CryptoPrice] Fetch error:', err);
      setConnectionState('error');
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      setConnectionState('connecting');
      console.log('[CryptoPrice] Starting price polling...');
      
      // Initial fetch
      fetchPrices();
      
      // Poll every 5 seconds
      intervalRef.current = setInterval(fetchPrices, POLL_INTERVAL);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setIsConnected(false);
      setConnectionState('disconnected');
    };
  }, [enabled, fetchPrices]);

  return {
    btcPrice,
    ethPrice,
    isConnected,
    connectionState,
    updateCount,
    lastUpdate
  };
}
