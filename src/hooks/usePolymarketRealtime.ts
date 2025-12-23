import { useState, useEffect, useRef, useCallback } from 'react';

interface OrderBookUpdate {
  assetId: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  timestamp: number;
}

interface MarketPrices {
  upTokenId: string;
  downTokenId: string;
  upPrice: number;
  downPrice: number;
  combinedPrice: number;
  lastUpdate: number;
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

  const connect = useCallback(() => {
    if (!enabled || tokenIds.length === 0) {
      console.log('WebSocket disabled or no token IDs');
      return;
    }

    // Cleanup existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    setConnectionState('connecting');
    console.log(`Connecting to Polymarket WebSocket with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('Polymarket WebSocket connected, subscribing to tokens...');
        setConnectionState('connected');
        setIsConnected(true);

        // Subscribe to market channel with token IDs
        const subscribeMsg = {
          assets_ids: tokenIds,
          type: 'market'
        };
        
        ws.send(JSON.stringify(subscribeMsg));
        console.log('Subscribed to tokens:', tokenIds);

        // Keep connection alive
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('PING');
          }
        }, 10000); // Ping every 10 seconds
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
          if (data.event_type === 'price_change') {
            setOrderBooks(prev => {
              const newBooks = new Map(prev);
              const existing = newBooks.get(data.asset_id);
              
              if (existing) {
                existing.midPrice = parseFloat(data.price);
                existing.timestamp = Date.now();
                newBooks.set(data.asset_id, existing);
              }
              
              return newBooks;
            });
            
            setUpdateCount(c => c + 1);
          }
        } catch (e) {
          // Not JSON, likely a PONG or other message
          if (event.data !== 'PONG') {
            console.log('Non-JSON message:', event.data);
          }
        }
      };

      ws.onerror = (error) => {
        console.error('Polymarket WebSocket error:', error);
        setConnectionState('disconnected');
      };

      ws.onclose = (event) => {
        console.log('Polymarket WebSocket closed:', event.code, event.reason);
        setIsConnected(false);
        setConnectionState('disconnected');
        
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Reconnect after delay if still enabled
        if (enabled) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect...');
            connect();
          }, 5000);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setConnectionState('disconnected');
    }
  }, [enabled, tokenIds]);

  const disconnect = useCallback(() => {
    console.log('Disconnecting WebSocket...');
    
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

  // Subscribe to new tokens
  const subscribeToTokens = useCallback((newTokenIds: string[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        assets_ids: newTokenIds,
        operation: 'subscribe'
      }));
      console.log('Subscribed to new tokens:', newTokenIds);
    }
  }, []);

  // Connect on mount/token change
  useEffect(() => {
    if (enabled && tokenIds.length > 0) {
      connect();
    }
    
    return () => {
      disconnect();
    };
  }, [enabled, tokenIds.join(',')]); // Reconnect when tokens change

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
    subscribeToTokens,
    getPrice
  };
};

// Helper to fetch token IDs from Gamma API for 15-min markets
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
    // Fetch active 15-min markets from Gamma API
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false'
    );
    
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }
    
    const events = await response.json();
    const markets: Array<{
      slug: string;
      asset: 'BTC' | 'ETH';
      upTokenId: string;
      downTokenId: string;
      eventStartTime: string;
      eventEndTime: string;
    }> = [];
    
    // Filter for 15-min crypto markets
    for (const event of events) {
      const title = (event.title || '').toLowerCase();
      const slug = event.slug || '';
      
      if (!title.includes('15') || (!title.includes('bitcoin') && !title.includes('ethereum'))) {
        continue;
      }
      
      const asset = title.includes('bitcoin') ? 'BTC' : 'ETH';
      
      // Get token IDs from markets array
      if (event.markets && event.markets.length >= 2) {
        const upMarket = event.markets.find((m: any) => 
          (m.outcome || '').toLowerCase() === 'up' || (m.outcome || '').toLowerCase() === 'yes'
        );
        const downMarket = event.markets.find((m: any) => 
          (m.outcome || '').toLowerCase() === 'down' || (m.outcome || '').toLowerCase() === 'no'
        );
        
        if (upMarket?.clobTokenIds?.[0] && downMarket?.clobTokenIds?.[0]) {
          markets.push({
            slug,
            asset,
            upTokenId: upMarket.clobTokenIds[0],
            downTokenId: downMarket.clobTokenIds[0],
            eventStartTime: event.startDate || new Date().toISOString(),
            eventEndTime: event.endDate || new Date().toISOString()
          });
        }
      }
    }
    
    console.log(`Found ${markets.length} 15-min markets with token IDs`);
    return { markets };
  } catch (error) {
    console.error('Error fetching market token IDs:', error);
    return { markets: [] };
  }
}
