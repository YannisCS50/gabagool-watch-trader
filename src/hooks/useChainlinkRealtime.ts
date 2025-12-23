import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Polymarket RTDS WebSocket for real-time crypto prices
 * Uses crypto_prices_chainlink topic for BTC/ETH
 */

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
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000;

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
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionState('connecting');
    console.log('[RTDS] Connecting to', RTDS_URL);

    try {
      const ws = new WebSocket(RTDS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[RTDS] Connected');
        setIsConnected(true);
        setConnectionState('connected');
        reconnectAttempts.current = 0;

        // Subscribe to Chainlink crypto prices for BTC and ETH
        const subscribeMessage = {
          action: 'subscribe',
          subscriptions: [
            {
              topic: 'crypto_prices_chainlink',
              type: 'update',
              filters: JSON.stringify({ symbol: 'BTCUSDT' })
            },
            {
              topic: 'crypto_prices_chainlink',
              type: 'update', 
              filters: JSON.stringify({ symbol: 'ETHUSDT' })
            }
          ]
        };
        
        ws.send(JSON.stringify(subscribeMessage));
        console.log('[RTDS] Subscribed to crypto_prices_chainlink (BTC, ETH)');

        // Keep-alive ping
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle subscription confirmation
          if (data.type === 'subscribed' || data.action === 'subscribed') {
            console.log('[RTDS] Subscription confirmed:', data.topic || data);
            return;
          }

          // Handle pong
          if (data.type === 'pong' || data.action === 'pong') {
            return;
          }
          
          // Handle crypto price updates
          // Format: { topic: 'crypto_prices_chainlink', type: 'update', payload: { symbol, value, timestamp } }
          if (data.topic === 'crypto_prices_chainlink' && data.payload) {
            const { symbol, value } = data.payload;
            
            if (symbol === 'BTCUSDT' && typeof value === 'number') {
              console.log('[RTDS] BTC price:', value);
              setBtcPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            } else if (symbol === 'ETHUSDT' && typeof value === 'number') {
              console.log('[RTDS] ETH price:', value);
              setEthPrice(value);
              setUpdateCount(prev => prev + 1);
              setLastUpdate(new Date());
            }
          }

          // Also handle initial data dump format (array of prices)
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.symbol === 'BTCUSDT' && typeof item.value === 'number') {
                setBtcPrice(item.value);
                setUpdateCount(prev => prev + 1);
                setLastUpdate(new Date());
              } else if (item.symbol === 'ETHUSDT' && typeof item.value === 'number') {
                setEthPrice(item.value);
                setUpdateCount(prev => prev + 1);
                setLastUpdate(new Date());
              }
            }
          }
        } catch (err) {
          // Non-JSON or parse error - ignore
          console.log('[RTDS] Message:', event.data);
        }
      };

      ws.onerror = (error) => {
        console.error('[RTDS] WebSocket error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[RTDS] Disconnected:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        wsRef.current = null;

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Attempt to reconnect
        if (enabled && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts.current++;
          console.log(`[RTDS] Reconnecting (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})...`);
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };
    } catch (err) {
      console.error('[RTDS] Failed to create WebSocket:', err);
      setConnectionState('error');
    }
  }, [enabled]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
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
