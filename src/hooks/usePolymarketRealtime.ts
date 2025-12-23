import { useState, useEffect, useRef, useCallback } from 'react';

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

export const usePolymarketRealtime = ({
  tokenIds,
  enabled = true
}: UsePolymarketRealtimeProps) => {
  const [orderBooks, setOrderBooks] = useState<Map<string, OrderBookUpdate>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [updateCount, setUpdateCount] = useState(0);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const subscribedTokensRef = useRef<Set<string>>(new Set());

  const connect = useCallback(() => {
    if (!enabled || tokenIds.length === 0) {
      console.log('[WebSocket] Disabled or no token IDs, tokens:', tokenIds.length);
      return;
    }

    // Cleanup existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setConnectionState('connecting');
    console.log(`[WebSocket] Connecting with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WebSocket] Connected, subscribing to', tokenIds.length, 'tokens');
        setConnectionState('connected');
        setIsConnected(true);

        // Subscribe to market channel with token IDs
        const subscribeMsg = {
          assets_ids: tokenIds,
          type: 'market'
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        subscribedTokensRef.current = new Set(tokenIds);
        console.log('[WebSocket] Subscribed to tokens:', tokenIds.slice(0, 4), '...');

        // Keep connection alive with PING
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('PING');
          }
        }, 10000);
      };

      ws.onmessage = (event) => {
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

            console.log(`[WebSocket] Book update: ${data.asset_id.slice(0, 20)}... bid=${bestBid} ask=${bestAsk}`);

            setOrderBooks(prev => {
              const newBooks = new Map(prev);
              newBooks.set(data.asset_id, {
                assetId: data.asset_id,
                bestBid,
                bestAsk,
                midPrice,
                timestamp: parseInt(data.timestamp) || Date.now()
              });
              return newBooks;
            });
            
            setUpdateCount(c => c + 1);
          }
          
          // Handle price_change events
          if (data.event_type === 'price_change' && data.asset_id) {
            const newPrice = parseFloat(data.price);
            console.log(`[WebSocket] Price change: ${data.asset_id.slice(0, 20)}... price=${newPrice}`);
            
            setOrderBooks(prev => {
              const newBooks = new Map(prev);
              const existing = newBooks.get(data.asset_id);
              
              if (existing) {
                newBooks.set(data.asset_id, {
                  ...existing,
                  midPrice: newPrice,
                  timestamp: Date.now()
                });
              } else {
                newBooks.set(data.asset_id, {
                  assetId: data.asset_id,
                  bestBid: newPrice,
                  bestAsk: newPrice,
                  midPrice: newPrice,
                  timestamp: Date.now()
                });
              }
              
              return newBooks;
            });
            
            setUpdateCount(c => c + 1);
          }

          // Handle last_trade_price events
          if (data.event_type === 'last_trade_price' && data.asset_id) {
            const lastPrice = parseFloat(data.price);
            console.log(`[WebSocket] Last trade: ${data.asset_id.slice(0, 20)}... price=${lastPrice}`);
            
            setOrderBooks(prev => {
              const newBooks = new Map(prev);
              const existing = newBooks.get(data.asset_id);
              
              if (existing) {
                newBooks.set(data.asset_id, {
                  ...existing,
                  midPrice: lastPrice,
                  timestamp: Date.now()
                });
              } else {
                newBooks.set(data.asset_id, {
                  assetId: data.asset_id,
                  bestBid: lastPrice,
                  bestAsk: lastPrice,
                  midPrice: lastPrice,
                  timestamp: Date.now()
                });
              }
              
              return newBooks;
            });
            
            setUpdateCount(c => c + 1);
          }
        } catch (e) {
          // Not JSON, likely a PONG or other message
          if (event.data !== 'PONG') {
            console.log('[WebSocket] Non-JSON message:', event.data);
          }
        }
      };

      ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        setConnectionState('disconnected');
      };

      ws.onclose = (event) => {
        console.log('[WebSocket] Closed:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconnect after delay if still enabled
        if (enabled && tokenIds.length > 0) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('[WebSocket] Attempting reconnect...');
            connect();
          }, 5000);
        }
      };
    } catch (error) {
      console.error('[WebSocket] Error creating connection:', error);
      setConnectionState('disconnected');
    }
  }, [enabled, tokenIds]);

  const disconnect = useCallback(() => {
    console.log('[WebSocket] Disconnecting...');
    
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
  }, []);

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

  // Get price for a specific token
  const getPrice = useCallback((tokenId: string): number | null => {
    const book = orderBooks.get(tokenId);
    return book?.midPrice ?? null;
  }, [orderBooks]);

  return {
    orderBooks,
    isConnected,
    connectionState,
    updateCount,
    connect,
    disconnect,
    getPrice
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
    // Use Supabase edge function to fetch from Gamma API
    const response = await fetch(
      'https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/get-market-tokens',
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1enBkanBsYXNuZHl2YnpobHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYzNTE5OTEsImV4cCI6MjA4MTkyNzk5MX0.fIs55-6uaB2M5y0fovJGY65130G5PFMmurosL2BE1dM',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1enBkanBsYXNuZHl2YnpobHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYzNTE5OTEsImV4cCI6MjA4MTkyNzk5MX0.fIs55-6uaB2M5y0fovJGY65130G5PFMmurosL2BE1dM'
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Edge function error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[Gamma] Found ${data.markets?.length || 0} 15-min markets with token IDs`);
    return { markets: data.markets || [] };
  } catch (error) {
    console.error('[Gamma] Error fetching market token IDs:', error);
    return { markets: [] };
  }
}
