import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Polymarket RTDS WebSocket for real-time market prices
 * Uses clob_market topic for price_change events
 */

export interface MarketTokens {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
}

interface PriceData {
  price: number;
  timestamp: number;
}

interface UsePolymarketRealtimeResult {
  getPrice: (tokenId: string) => number | null;
  getBidAsk: (tokenId: string) => { bid: number; ask: number } | null;
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  connect: () => void;
  disconnect: () => void;
}

const RTDS_URL = 'wss://rtds.polymarket.com';
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const PING_INTERVAL = 30000;
const UI_UPDATE_INTERVAL = 100; // Update UI every 100ms

export function usePolymarketRealtime(
  tokenIds: string[],
  enabled: boolean = true
): UsePolymarketRealtimeResult {
  // Use refs for high-frequency data to avoid re-renders
  const pricesRef = useRef<Map<string, PriceData>>(new Map());
  const lastUpdateTimeRef = useRef<number>(Date.now());
  const updateCountRef = useRef<number>(0);
  
  // State for UI (updated less frequently)
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);
  
  // WebSocket refs
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const uiUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const subscribedTokensRef = useRef<Set<string>>(new Set());

  // Sync ref data to state periodically for smooth UI
  const startUISync = useCallback(() => {
    if (uiUpdateIntervalRef.current) return;
    
    uiUpdateIntervalRef.current = setInterval(() => {
      const now = Date.now();
      if (updateCountRef.current !== updateCount) {
        setUpdateCount(updateCountRef.current);
        setLastUpdateTime(lastUpdateTimeRef.current);
        setLatencyMs(now - lastUpdateTimeRef.current);
      }
    }, UI_UPDATE_INTERVAL);
  }, [updateCount]);

  const stopUISync = useCallback(() => {
    if (uiUpdateIntervalRef.current) {
      clearInterval(uiUpdateIntervalRef.current);
      uiUpdateIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled || tokenIds.length === 0) {
      console.log('[RTDS Market] Not connecting - enabled:', enabled, 'tokens:', tokenIds.length);
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnectionState('connecting');
    console.log(`[RTDS Market] Connecting with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(RTDS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[RTDS Market] Connected');
        setConnectionState('connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;

        // Subscribe to clob_market price_change for all token IDs
        // Filter format: array of token IDs as strings
        const subscribeMsg = {
          action: 'subscribe',
          subscriptions: [
            {
              topic: 'clob_market',
              type: 'price_change',
              filters: JSON.stringify(tokenIds)
            },
            {
              topic: 'clob_market',
              type: 'last_trade_price',
              filters: JSON.stringify(tokenIds)
            }
          ]
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        subscribedTokensRef.current = new Set(tokenIds);
        
        console.log('[RTDS Market] Subscribed to', tokenIds.length, 'tokens');
        console.log('[RTDS Market] First tokens:', tokenIds.slice(0, 2).map(t => t.slice(0, 30) + '...'));

        // Start UI sync
        startUISync();

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
          const now = Date.now();
          
          // Handle subscription confirmation
          if (data.type === 'subscribed' || data.action === 'subscribed') {
            console.log('[RTDS Market] Subscription confirmed:', data.topic);
            return;
          }

          // Handle pong
          if (data.type === 'pong' || data.action === 'pong') {
            return;
          }

          // Handle price_change events
          // Format: { topic: 'clob_market', type: 'price_change', payload: { asset_id, price, timestamp } }
          if (data.topic === 'clob_market' && data.payload) {
            const { asset_id, price, timestamp } = data.payload;
            
            if (asset_id && typeof price === 'number') {
              const wsTimestamp = timestamp || now;
              
              pricesRef.current.set(asset_id, {
                price,
                timestamp: wsTimestamp
              });
              
              lastUpdateTimeRef.current = wsTimestamp;
              updateCountRef.current++;
              
              console.log(`[RTDS Market] ${data.type}: ${asset_id.slice(0, 20)}... = ${price.toFixed(4)}`);
            }
          }

          // Handle array format (initial dump)
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.asset_id && typeof item.price === 'number') {
                pricesRef.current.set(item.asset_id, {
                  price: item.price,
                  timestamp: item.timestamp || now
                });
                updateCountRef.current++;
              }
            }
            lastUpdateTimeRef.current = now;
          }
        } catch (e) {
          // Non-JSON message - ignore
          console.log('[RTDS Market] Message:', event.data);
        }
      };

      ws.onerror = (error) => {
        console.error('[RTDS Market] WebSocket error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[RTDS Market] Disconnected:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        stopUISync();

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Attempt to reconnect
        if (enabled && tokenIds.length > 0 && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          console.log(`[RTDS Market] Reconnecting (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };
    } catch (error) {
      console.error('[RTDS Market] Failed to connect:', error);
      setConnectionState('error');
    }
  }, [enabled, tokenIds, startUISync, stopUISync]);

  const disconnect = useCallback(() => {
    console.log('[RTDS Market] Disconnecting...');
    
    stopUISync();
    
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
    subscribedTokensRef.current = new Set();
  }, [stopUISync]);

  // Connect when tokens change
  useEffect(() => {
    if (enabled && tokenIds.length > 0) {
      const currentTokens = Array.from(subscribedTokensRef.current);
      const tokensChanged = tokenIds.some(t => !subscribedTokensRef.current.has(t)) ||
                           currentTokens.length !== tokenIds.length;
      
      if (tokensChanged || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        disconnect();
        connect();
      }
    } else if (!enabled) {
      disconnect();
    }
  }, [enabled, tokenIds.join(','), connect, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  // Get price for a token
  const getPrice = useCallback((tokenId: string): number | null => {
    return pricesRef.current.get(tokenId)?.price ?? null;
  }, []);

  // Get bid/ask for a token (approximation based on price)
  const getBidAsk = useCallback((tokenId: string): { bid: number; ask: number } | null => {
    const priceData = pricesRef.current.get(tokenId);
    if (!priceData) return null;
    // Approximate spread of 1%
    const spread = 0.01;
    return { 
      bid: priceData.price * (1 - spread / 2), 
      ask: priceData.price * (1 + spread / 2) 
    };
  }, []);

  return {
    getPrice,
    getBidAsk,
    isConnected,
    connectionState,
    updateCount,
    lastUpdateTime,
    latencyMs,
    connect,
    disconnect
  };
}
