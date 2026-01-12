import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Dedicated CLOB Orderbook hook with correct protocol handling
 * - Connects via backend proxy to avoid CORS and handle PING/PONG
 * - Uses correct subscription format: { type: "market", assets_ids: [...] }
 * - Handles plain-text PONG frames gracefully
 * - Implements exponential backoff for reconnection
 */

interface OrderbookEntry {
  bid: number | null;
  ask: number | null;
  timestamp: number;
  isRealBook: boolean; // true if from 'book' event, false if from 'price_change'
}

interface ClobState {
  orderbooks: Map<string, { up: OrderbookEntry; down: OrderbookEntry }>;
  connected: boolean;
  connecting: boolean;
  messageCount: number;
  lastUpdate: number;
  error: string | null;
}

interface TokenInfo {
  asset: string;
  outcome: 'up' | 'down';
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

export function useClobOrderbook(enabled: boolean = true) {
  const [state, setState] = useState<ClobState>({
    orderbooks: new Map(),
    connected: false,
    connecting: false,
    messageCount: 0,
    lastUpdate: Date.now(),
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const tokenMapRef = useRef<Map<string, TokenInfo>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);

  // Fetch token IDs from backend
  const fetchTokenIds = useCallback(async (): Promise<string[]> => {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/get-market-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        console.warn('[CLOB] Failed to fetch token IDs:', response.status);
        return [];
      }

      const data = await response.json();
      if (!data?.success || !Array.isArray(data?.markets)) {
        return [];
      }

      const tokenIds: string[] = [];
      tokenMapRef.current.clear();

      for (const m of data.markets) {
        if (m.upTokenId) {
          const id = String(m.upTokenId);
          tokenIds.push(id);
          tokenMapRef.current.set(id, { asset: m.asset, outcome: 'up' });
        }
        if (m.downTokenId) {
          const id = String(m.downTokenId);
          tokenIds.push(id);
          tokenMapRef.current.set(id, { asset: m.asset, outcome: 'down' });
        }
      }

      console.log(`[CLOB] Fetched ${tokenIds.length} token IDs for ${tokenMapRef.current.size / 2} markets`);
      return tokenIds;
    } catch (err) {
      console.error('[CLOB] Error fetching token IDs:', err);
      return [];
    }
  }, []);

  // Parse orderbook level from various formats
  const parseLevel = (level: unknown): number | null => {
    if (typeof level === 'object' && level !== null) {
      const obj = level as Record<string, unknown>;
      if ('price' in obj) return parseFloat(String(obj.price));
      if ('p' in obj) return parseFloat(String(obj.p));
    }
    if (Array.isArray(level) && level.length > 0) {
      return parseFloat(String(level[0]));
    }
    if (typeof level === 'string' || typeof level === 'number') {
      return parseFloat(String(level));
    }
    return null;
  };

  // Process incoming WebSocket message
  const processMessage = useCallback((data: string) => {
    // Handle plain-text PONG (from CLOB keepalive)
    if (data === 'PONG' || data === 'pong') {
      return;
    }

    // Ignore non-JSON
    if (!data.startsWith('{') && !data.startsWith('[')) {
      console.warn('[CLOB] Ignoring non-JSON message:', data.substring(0, 50));
      return;
    }

    try {
      const msg = JSON.parse(data);
      const now = Date.now();

      // Handle proxy connected confirmation
      if (msg.type === 'proxy_connected') {
        console.log('[CLOB] Proxy connected, subscribing to markets...');
        return;
      }

      // Handle book event (full orderbook snapshot)
      if (msg.event_type === 'book' && msg.asset_id) {
        const tokenId = String(msg.asset_id);
        const info = tokenMapRef.current.get(tokenId);
        if (!info) return;

        const bestBid = Array.isArray(msg.bids) && msg.bids.length > 0 ? parseLevel(msg.bids[0]) : null;
        const bestAsk = Array.isArray(msg.asks) && msg.asks.length > 0 ? parseLevel(msg.asks[0]) : null;

        setState((prev) => {
          const newOrderbooks = new Map(prev.orderbooks);
          const existing = newOrderbooks.get(info.asset) || {
            up: { bid: null, ask: null, timestamp: 0, isRealBook: false },
            down: { bid: null, ask: null, timestamp: 0, isRealBook: false },
          };

          existing[info.outcome] = {
            bid: bestBid,
            ask: bestAsk,
            timestamp: now,
            isRealBook: true,
          };

          newOrderbooks.set(info.asset, existing);

          return {
            ...prev,
            orderbooks: newOrderbooks,
            messageCount: prev.messageCount + 1,
            lastUpdate: now,
          };
        });
        return;
      }

      // Handle price_change event (fallback)
      if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
        for (const pc of msg.price_changes) {
          const tokenId = String(pc.asset_id || pc.token_id);
          const info = tokenMapRef.current.get(tokenId);
          if (!info) continue;

          // Only use price_change if we don't have a real book yet
          setState((prev) => {
            const existing = prev.orderbooks.get(info.asset);
            if (existing?.[info.outcome]?.isRealBook) {
              // Don't overwrite real book data with price_change
              return prev;
            }

            const newOrderbooks = new Map(prev.orderbooks);
            const entry = newOrderbooks.get(info.asset) || {
              up: { bid: null, ask: null, timestamp: 0, isRealBook: false },
              down: { bid: null, ask: null, timestamp: 0, isRealBook: false },
            };

            // price_change typically has price field as midpoint
            const price = parseFloat(String(pc.price));
            if (!isNaN(price)) {
              entry[info.outcome] = {
                bid: price - 0.005, // estimate spread
                ask: price + 0.005,
                timestamp: now,
                isRealBook: false,
              };
              newOrderbooks.set(info.asset, entry);
            }

            return {
              ...prev,
              orderbooks: newOrderbooks,
              messageCount: prev.messageCount + 1,
              lastUpdate: now,
            };
          });
        }
        return;
      }

      // Handle direct asset_id message (legacy format)
      if (msg.asset_id && (msg.bids || msg.asks)) {
        const tokenId = String(msg.asset_id);
        const info = tokenMapRef.current.get(tokenId);
        if (!info) return;

        const bestBid = Array.isArray(msg.bids) && msg.bids.length > 0 ? parseLevel(msg.bids[0]) : null;
        const bestAsk = Array.isArray(msg.asks) && msg.asks.length > 0 ? parseLevel(msg.asks[0]) : null;

        setState((prev) => {
          const newOrderbooks = new Map(prev.orderbooks);
          const existing = newOrderbooks.get(info.asset) || {
            up: { bid: null, ask: null, timestamp: 0, isRealBook: false },
            down: { bid: null, ask: null, timestamp: 0, isRealBook: false },
          };

          existing[info.outcome] = {
            bid: bestBid,
            ask: bestAsk,
            timestamp: now,
            isRealBook: true,
          };

          newOrderbooks.set(info.asset, existing);

          return {
            ...prev,
            orderbooks: newOrderbooks,
            messageCount: prev.messageCount + 1,
            lastUpdate: now,
          };
        });
      }
    } catch (err) {
      console.warn('[CLOB] Parse error:', err, 'data:', data.substring(0, 100));
    }
  }, []);

  // Connect to CLOB via proxy
  const connect = useCallback(async () => {
    if (!enabledRef.current || !mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setState((prev) => ({ ...prev, connecting: true, error: null }));

    const tokenIds = await fetchTokenIds();
    if (tokenIds.length === 0) {
      setState((prev) => ({ ...prev, connecting: false, error: 'No token IDs found' }));
      return;
    }

    // Use backend proxy for CLOB connection
    const wsUrl = SUPABASE_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/functions/v1/clob-proxy';
    
    console.log('[CLOB] Connecting to proxy:', wsUrl);

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[CLOB] ✅ WebSocket connected');
        reconnectAttemptsRef.current = 0;

        if (!mountedRef.current) {
          ws.close();
          return;
        }

        setState((prev) => ({ ...prev, connected: true, connecting: false, error: null }));

        // Send subscription using correct CLOB format
        const subscribeMsg = JSON.stringify({
          type: 'market',
          assets_ids: tokenIds,
        });
        console.log('[CLOB] Subscribing to', tokenIds.length, 'tokens');
        ws.send(subscribeMsg);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          processMessage(event.data);
        }
      };

      ws.onerror = (err) => {
        console.error('[CLOB] WebSocket error:', err);
        setState((prev) => ({ ...prev, connected: false, connecting: false, error: 'Connection error' }));
      };

      ws.onclose = (event) => {
        console.log('[CLOB] WebSocket closed:', event.code, event.reason);
        wsRef.current = null;

        if (!mountedRef.current) return;

        setState((prev) => ({ ...prev, connected: false, connecting: false }));

        // Exponential backoff reconnect
        if (enabledRef.current) {
          const attempts = reconnectAttemptsRef.current;
          const delay = Math.min(1000 * Math.pow(2, attempts), 30000); // Max 30s
          reconnectAttemptsRef.current = attempts + 1;

          console.log(`[CLOB] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };
    } catch (err) {
      console.error('[CLOB] Failed to create WebSocket:', err);
      setState((prev) => ({ ...prev, connecting: false, error: 'Failed to connect' }));
    }
  }, [fetchTokenIds, processMessage]);

  // Disconnect and cleanup
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Mount/unmount lifecycle
  useEffect(() => {
    mountedRef.current = true;
    enabledRef.current = enabled;

    if (enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  // Periodically refresh token IDs (markets change hourly)
  useEffect(() => {
    if (!enabled) return;

    const interval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        fetchTokenIds().then((tokenIds) => {
          if (tokenIds.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'market',
              assets_ids: tokenIds,
            }));
          }
        });
      }
    }, 60000); // Every minute

    return () => clearInterval(interval);
  }, [enabled, fetchTokenIds]);

  // Helper functions
  const getOrderbook = useCallback(
    (asset: string, outcome: 'up' | 'down'): OrderbookEntry | null => {
      const ob = state.orderbooks.get(asset);
      return ob?.[outcome] ?? null;
    },
    [state.orderbooks]
  );

  const getBestAsk = useCallback(
    (asset: string, outcome: 'up' | 'down'): number | null => {
      return getOrderbook(asset, outcome)?.ask ?? null;
    },
    [getOrderbook]
  );

  const getBestBid = useCallback(
    (asset: string, outcome: 'up' | 'down'): number | null => {
      return getOrderbook(asset, outcome)?.bid ?? null;
    },
    [getOrderbook]
  );

  const isStale = useCallback(
    (asset: string, maxAgeMs: number = 15000): boolean => {
      const up = state.orderbooks.get(asset)?.up;
      const down = state.orderbooks.get(asset)?.down;
      const now = Date.now();

      const upAge = up?.timestamp ? now - up.timestamp : Infinity;
      const downAge = down?.timestamp ? now - down.timestamp : Infinity;

      return upAge > maxAgeMs && downAge > maxAgeMs;
    },
    [state.orderbooks]
  );

  return {
    ...state,
    assets: ASSETS,
    getOrderbook,
    getBestAsk,
    getBestBid,
    isStale,
    reconnect: () => {
      disconnect();
      reconnectAttemptsRef.current = 0;
      connect();
    },
  };
}
