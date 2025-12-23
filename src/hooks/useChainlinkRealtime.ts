import { useState, useEffect, useRef, useCallback } from 'react';

interface ChainlinkPrice {
  symbol: string;
  price: number;
  timestamp: number;
}

interface UseChainlinkRealtimeResult {
  btcPrice: number | null;
  ethPrice: number | null;
  isConnected: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'error';
  updateCount: number;
  lastUpdate: Date | null;
}

const RTDS_URL = 'wss://rtds.polymarket.com';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

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

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionState('connecting');
    console.log('[Chainlink WS] Connecting to', RTDS_URL);

    try {
      const ws = new WebSocket(RTDS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Chainlink WS] Connected');
        setIsConnected(true);
        setConnectionState('connected');
        reconnectAttempts.current = 0;

        // Subscribe to Chainlink crypto prices
        const subscribeMessage = {
          action: 'subscribe',
          subscriptions: [{
            topic: 'crypto_prices_chainlink',
            type: '*',
            filters: ''
          }]
        };
        
        ws.send(JSON.stringify(subscribeMessage));
        console.log('[Chainlink WS] Subscribed to crypto_prices_chainlink');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle subscription confirmation
          if (data.type === 'subscribed') {
            console.log('[Chainlink WS] Subscription confirmed:', data.topic);
            return;
          }
          
          // Handle price updates
          if (data.topic === 'crypto_prices_chainlink' && data.payload) {
            const { symbol, value, timestamp } = data.payload;
            
            if (symbol === 'btc/usd' && typeof value === 'number') {
              setBtcPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            } else if (symbol === 'eth/usd' && typeof value === 'number') {
              setEthPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            }
          }
        } catch (err) {
          console.error('[Chainlink WS] Failed to parse message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error('[Chainlink WS] WebSocket error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[Chainlink WS] Disconnected:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        wsRef.current = null;

        // Attempt to reconnect
        if (enabled && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts.current++;
          console.log(`[Chainlink WS] Reconnecting (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})...`);
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };
    } catch (err) {
      console.error('[Chainlink WS] Failed to create WebSocket:', err);
      setConnectionState('error');
    }
  }, [enabled]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setIsConnected(false);
    setConnectionState('disconnected');
  }, []);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return {
    btcPrice,
    ethPrice,
    isConnected,
    connectionState,
    updateCount,
    lastUpdate
  };
}
