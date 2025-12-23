import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Polymarket crypto prices via RTDS proxy edge function
 * Falls back to REST API polling if WebSocket fails
 */

interface UseChainlinkRealtimeResult {
  btcPrice: number | null;
  ethPrice: number | null;
  isConnected: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'error';
  updateCount: number;
  lastUpdate: Date | null;
}

const PROXY_WS_URL = 'wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/rtds-proxy';
const PROXY_REST_URL = 'https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/rtds-proxy';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const REST_POLL_INTERVAL = 3000;

export function useChainlinkRealtime(enabled: boolean = true): UseChainlinkRealtimeResult {
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [ethPrice, setEthPrice] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const useRestFallback = useRef(false);

  // REST API fallback polling
  const pollPrices = useCallback(async () => {
    try {
      const response = await fetch(PROXY_REST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_slugs: [] })
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.crypto?.btc) {
          setBtcPrice(data.crypto.btc);
          setUpdateCount(prev => prev + 1);
          setLastUpdate(new Date());
        }
        if (data.crypto?.eth) {
          setEthPrice(data.crypto.eth);
          setUpdateCount(prev => prev + 1);
          setLastUpdate(new Date());
        }
        setIsConnected(true);
        setConnectionState('connected');
      }
    } catch (err) {
      console.error('[Crypto REST] Poll error:', err);
    }
  }, []);

  const startRestPolling = useCallback(() => {
    if (pollIntervalRef.current) return;
    console.log('[Crypto] Starting REST API polling fallback');
    useRestFallback.current = true;
    pollPrices(); // Initial fetch
    pollIntervalRef.current = setInterval(pollPrices, REST_POLL_INTERVAL);
  }, [pollPrices]);

  const stopRestPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionState('connecting');
    console.log('[Crypto WS] Connecting via proxy...');

    try {
      const ws = new WebSocket(PROXY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Crypto WS] Connected to proxy');
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Proxy connected confirmation
          if (data.type === 'proxy_connected') {
            console.log('[Crypto WS] Proxy connected to RTDS, subscribing...');
            setIsConnected(true);
            setConnectionState('connected');
            stopRestPolling();
            useRestFallback.current = false;
            
            // Subscribe to crypto prices
            ws.send(JSON.stringify({
              action: 'subscribe',
              subscriptions: [
                { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'BTCUSDT' }) },
                { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'ETHUSDT' }) }
              ]
            }));
            return;
          }
          
          // Proxy error - fall back to REST
          if (data.type === 'proxy_error' || data.type === 'proxy_disconnected') {
            console.log('[Crypto WS] Proxy error, falling back to REST');
            startRestPolling();
            return;
          }
          
          // Handle crypto price updates from RTDS
          if (data.topic === 'crypto_prices_chainlink' && data.payload) {
            const { symbol, value } = data.payload;
            if (symbol === 'BTCUSDT' && typeof value === 'number') {
              setBtcPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            } else if (symbol === 'ETHUSDT' && typeof value === 'number') {
              setEthPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            }
          }
        } catch (err) {
          // Non-JSON message
        }
      };

      ws.onerror = (error) => {
        console.error('[Crypto WS] Error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[Crypto WS] Disconnected:', event.code);
        setIsConnected(false);
        wsRef.current = null;

        // Fall back to REST polling
        if (enabled && !useRestFallback.current) {
          if (reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts.current++;
            console.log(`[Crypto WS] Reconnecting (${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})...`);
            reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
          } else {
            console.log('[Crypto WS] Max reconnects reached, using REST fallback');
            startRestPolling();
          }
        }
      };
    } catch (err) {
      console.error('[Crypto WS] Failed to connect:', err);
      setConnectionState('error');
      startRestPolling();
    }
  }, [enabled, startRestPolling, stopRestPolling]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    stopRestPolling();
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setIsConnected(false);
    setConnectionState('disconnected');
  }, [stopRestPolling]);

  useEffect(() => {
    if (enabled) {
      // Start with REST polling immediately for fast initial data
      startRestPolling();
      // Then try WebSocket for real-time updates
      connect();
    } else {
      disconnect();
    }

    return () => disconnect();
  }, [enabled, connect, disconnect, startRestPolling]);

  return {
    btcPrice,
    ethPrice,
    isConnected,
    connectionState,
    updateCount,
    lastUpdate
  };
}
