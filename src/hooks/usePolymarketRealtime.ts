import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Real-time order book data from Polymarket CLOB WebSocket
 */
export interface OrderBookData {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  timestamp: number;
}

/**
 * Market with token IDs for WebSocket subscription
 */
export interface MarketTokens {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
}

interface UsePolymarketRealtimeResult {
  // Price data
  getPrice: (tokenId: string) => number | null;
  getBidAsk: (tokenId: string) => { bid: number; ask: number } | null;
  
  // Connection state
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
  
  // Stats
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  
  // Methods
  connect: () => void;
  disconnect: () => void;
}

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL = 10000;
const RECONNECT_DELAY = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;

export function usePolymarketRealtime(
  tokenIds: string[],
  enabled: boolean = true
): UsePolymarketRealtimeResult {
  // Use refs for high-frequency data to avoid re-renders
  const orderBooksRef = useRef<Map<string, OrderBookData>>(new Map());
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

  // Sync ref data to state every 50ms for smooth UI
  const startUISync = useCallback(() => {
    if (uiUpdateIntervalRef.current) return;
    
    uiUpdateIntervalRef.current = setInterval(() => {
      const now = Date.now();
      if (updateCountRef.current !== updateCount) {
        setUpdateCount(updateCountRef.current);
        setLastUpdateTime(lastUpdateTimeRef.current);
        setLatencyMs(now - lastUpdateTimeRef.current);
      }
    }, 50);
  }, [updateCount]);

  const stopUISync = useCallback(() => {
    if (uiUpdateIntervalRef.current) {
      clearInterval(uiUpdateIntervalRef.current);
      uiUpdateIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled || tokenIds.length === 0) {
      console.log('[CLOB WS] Not connecting - enabled:', enabled, 'tokens:', tokenIds.length);
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnectionState('connecting');
    console.log(`[CLOB WS] Connecting with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[CLOB WS] Connected');
        setConnectionState('connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;

        // Subscribe to market data for all tokens
        const subscribeMsg = {
          assets_ids: tokenIds,
          type: 'market'
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        subscribedTokensRef.current = new Set(tokenIds);
        
        console.log('[CLOB WS] Subscribed to', tokenIds.length, 'tokens');
        console.log('[CLOB WS] First tokens:', tokenIds.slice(0, 2).map(t => t.slice(0, 30) + '...'));

        // Start UI sync
        startUISync();

        // Keep connection alive
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('PING');
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = (event) => {
        const now = Date.now();
        
        // Handle PONG
        if (event.data === 'PONG') return;

        try {
          const data = JSON.parse(event.data);
          
          // Book event - full order book snapshot
          if (data.event_type === 'book' && data.asset_id) {
            const bids = data.bids || [];
            const asks = data.asks || [];
            
            const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
            const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
            const midPrice = (bestBid + bestAsk) / 2;
            const wsTimestamp = parseInt(data.timestamp) || now;

            orderBooksRef.current.set(data.asset_id, {
              tokenId: data.asset_id,
              bestBid,
              bestAsk,
              midPrice,
              timestamp: wsTimestamp
            });
            
            lastUpdateTimeRef.current = wsTimestamp;
            updateCountRef.current++;
            
            console.log(`[CLOB WS] Book: ${data.asset_id.slice(0, 20)}... bid=${bestBid.toFixed(2)} ask=${bestAsk.toFixed(2)}`);
          }
          
          // Price change event
          if (data.event_type === 'price_change' && data.asset_id) {
            const price = parseFloat(data.price);
            const existing = orderBooksRef.current.get(data.asset_id);
            
            orderBooksRef.current.set(data.asset_id, {
              tokenId: data.asset_id,
              bestBid: existing?.bestBid ?? price,
              bestAsk: existing?.bestAsk ?? price,
              midPrice: price,
              timestamp: now
            });
            
            lastUpdateTimeRef.current = now;
            updateCountRef.current++;
          }

          // Last trade price event
          if (data.event_type === 'last_trade_price' && data.asset_id) {
            const price = parseFloat(data.price);
            const existing = orderBooksRef.current.get(data.asset_id);
            
            orderBooksRef.current.set(data.asset_id, {
              tokenId: data.asset_id,
              bestBid: existing?.bestBid ?? price,
              bestAsk: existing?.bestAsk ?? price,
              midPrice: price,
              timestamp: now
            });
            
            lastUpdateTimeRef.current = now;
            updateCountRef.current++;
          }
        } catch (e) {
          // Non-JSON message
        }
      };

      ws.onerror = (error) => {
        console.error('[CLOB WS] Error:', error);
        setConnectionState('error');
      };

      ws.onclose = (event) => {
        console.log('[CLOB WS] Closed:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        stopUISync();
        
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconnect if enabled
        if (enabled && tokenIds.length > 0 && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          console.log(`[CLOB WS] Reconnecting (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY);
        }
      };
    } catch (error) {
      console.error('[CLOB WS] Failed to connect:', error);
      setConnectionState('error');
    }
  }, [enabled, tokenIds, startUISync, stopUISync]);

  const disconnect = useCallback(() => {
    console.log('[CLOB WS] Disconnecting...');
    
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

  // Get mid price for a token
  const getPrice = useCallback((tokenId: string): number | null => {
    return orderBooksRef.current.get(tokenId)?.midPrice ?? null;
  }, []);

  // Get bid/ask for a token
  const getBidAsk = useCallback((tokenId: string): { bid: number; ask: number } | null => {
    const book = orderBooksRef.current.get(tokenId);
    if (!book) return null;
    return { bid: book.bestBid, ask: book.bestAsk };
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
