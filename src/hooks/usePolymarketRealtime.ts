import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface OrderBookUpdate {
  assetId: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  timestamp: number;
}

interface UsePolymarketRealtimeProps {
  tokenIds: string[];
  enabled?: boolean;
}

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const UI_UPDATE_INTERVAL = 50; // Update UI every 50ms for smooth display

export const usePolymarketRealtime = ({
  tokenIds,
  enabled = true
}: UsePolymarketRealtimeProps) => {
  // Use refs for high-frequency data (no re-renders)
  const orderBooksRef = useRef<Map<string, OrderBookUpdate>>(new Map());
  const lastWsUpdateRef = useRef<number>(Date.now());
  const updateCountRef = useRef(0);
  
  // State for UI (updated at throttled interval)
  const [orderBooks, setOrderBooks] = useState<Map<string, OrderBookUpdate>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [updateCount, setUpdateCount] = useState(0);
  const [lastWsTimestamp, setLastWsTimestamp] = useState<number>(Date.now());
  const [latencyMs, setLatencyMs] = useState<number>(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const uiUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const subscribedTokensRef = useRef<Set<string>>(new Set());

  // Sync ref data to state at throttled interval
  const startUIUpdater = useCallback(() => {
    if (uiUpdateIntervalRef.current) return;
    
    uiUpdateIntervalRef.current = setInterval(() => {
      // Only update if there's new data
      if (updateCountRef.current !== updateCount) {
        setOrderBooks(new Map(orderBooksRef.current));
        setUpdateCount(updateCountRef.current);
        setLastWsTimestamp(lastWsUpdateRef.current);
        setLatencyMs(Date.now() - lastWsUpdateRef.current);
      }
    }, UI_UPDATE_INTERVAL);
  }, [updateCount]);

  const stopUIUpdater = useCallback(() => {
    if (uiUpdateIntervalRef.current) {
      clearInterval(uiUpdateIntervalRef.current);
      uiUpdateIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!enabled || tokenIds.length === 0) {
      console.log('[WS] Disabled or no token IDs, tokens:', tokenIds.length);
      return;
    }

    // Cleanup existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setConnectionState('connecting');
    console.log(`[WS] Connecting with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected, subscribing to', tokenIds.length, 'tokens');
        setConnectionState('connected');
        setIsConnected(true);

        // Subscribe to market channel with token IDs
        const subscribeMsg = {
          assets_ids: tokenIds,
          type: 'market'
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        subscribedTokensRef.current = new Set(tokenIds);
        console.log('[WS] Subscribed to tokens:', tokenIds.slice(0, 2).map(t => t.slice(0, 20) + '...'));

        // Start UI updater
        startUIUpdater();

        // Keep connection alive with PING
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('PING');
          }
        }, 10000);
      };

      ws.onmessage = (event) => {
        const now = Date.now();
        
        try {
          // Handle PONG responses
          if (event.data === 'PONG') {
            return;
          }

          const data = JSON.parse(event.data);
          
          // Handle book events (order book snapshots/updates)
          if (data.event_type === 'book' && data.asset_id) {
            const bids = data.bids || [];
            const asks = data.asks || [];
            
            // Get best bid and ask
            const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
            const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
            const midPrice = (bestBid + bestAsk) / 2;
            
            const wsTimestamp = parseInt(data.timestamp) || now;

            orderBooksRef.current.set(data.asset_id, {
              assetId: data.asset_id,
              bestBid,
              bestAsk,
              midPrice,
              timestamp: wsTimestamp
            });
            
            lastWsUpdateRef.current = wsTimestamp;
            updateCountRef.current++;
          }
          
          // Handle price_change events
          if (data.event_type === 'price_change' && data.asset_id) {
            const newPrice = parseFloat(data.price);
            const existing = orderBooksRef.current.get(data.asset_id);
            
            orderBooksRef.current.set(data.asset_id, {
              assetId: data.asset_id,
              bestBid: existing?.bestBid ?? newPrice,
              bestAsk: existing?.bestAsk ?? newPrice,
              midPrice: newPrice,
              timestamp: now
            });
            
            lastWsUpdateRef.current = now;
            updateCountRef.current++;
          }

          // Handle last_trade_price events
          if (data.event_type === 'last_trade_price' && data.asset_id) {
            const lastPrice = parseFloat(data.price);
            const existing = orderBooksRef.current.get(data.asset_id);
            
            orderBooksRef.current.set(data.asset_id, {
              assetId: data.asset_id,
              bestBid: existing?.bestBid ?? lastPrice,
              bestAsk: existing?.bestAsk ?? lastPrice,
              midPrice: lastPrice,
              timestamp: now
            });
            
            lastWsUpdateRef.current = now;
            updateCountRef.current++;
          }
        } catch (e) {
          // Not JSON, likely a PONG or other message
        }
      };

      ws.onerror = (error) => {
        console.error('[WS] Error:', error);
        setConnectionState('disconnected');
      };

      ws.onclose = (event) => {
        console.log('[WS] Closed:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        stopUIUpdater();
        
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconnect after delay if still enabled
        if (enabled && tokenIds.length > 0) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[WS] Attempting reconnect...');
            connect();
          }, 3000);
        }
      };
    } catch (error) {
      console.error('[WS] Error creating connection:', error);
      setConnectionState('disconnected');
    }
  }, [enabled, tokenIds, startUIUpdater, stopUIUpdater]);

  const disconnect = useCallback(() => {
    console.log('[WS] Disconnecting...');
    
    stopUIUpdater();
    
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
  }, [stopUIUpdater]);

  // Connect on mount/token change
  useEffect(() => {
    if (enabled && tokenIds.length > 0) {
      // Check if we need to reconnect (different tokens)
      const currentTokens = Array.from(subscribedTokensRef.current);
      const newTokens = tokenIds.filter(t => !subscribedTokensRef.current.has(t));
      
      if (newTokens.length > 0 || currentTokens.length !== tokenIds.length) {
        disconnect();
        connect();
      } else if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connect();
      }
    }
    
    return () => {
      // Don't disconnect on every render, only on unmount
    };
  }, [enabled, tokenIds.join(','), connect, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Get price for a specific token (from ref for instant access)
  const getPrice = useCallback((tokenId: string): number | null => {
    const book = orderBooksRef.current.get(tokenId);
    return book?.midPrice ?? null;
  }, []);

  // Get book data for a specific token
  const getBook = useCallback((tokenId: string): OrderBookUpdate | null => {
    return orderBooksRef.current.get(tokenId) ?? null;
  }, []);

  return {
    orderBooks,
    isConnected,
    connectionState,
    updateCount,
    lastWsTimestamp,
    latencyMs,
    connect,
    disconnect,
    getPrice,
    getBook
  };
};

// Helper to fetch token IDs via edge function (avoids CORS issues)
export async function fetch15MinMarketTokenIds(): Promise<{
  markets: Array<{
    slug: string;
    asset: 'BTC' | 'ETH';
    upTokenId: string;
    downTokenId: string;
    eventStartTime: string;
    eventEndTime: string;
  }>;
}> {
  try {
    const { data, error } = await supabase.functions.invoke('get-market-tokens');
    
    if (error) {
      console.error('[Tokens] Edge function error:', error);
      return { markets: [] };
    }
    
    console.log(`[Tokens] Found ${data?.markets?.length || 0} 15-min markets with token IDs`);
    return { markets: data?.markets || [] };
  } catch (error) {
    console.error('[Tokens] Error fetching market token IDs:', error);
    return { markets: [] };
  }
}
