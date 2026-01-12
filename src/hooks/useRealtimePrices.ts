import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Hook for real-time price data from Binance WebSocket + Polymarket CLOB
 * Provides millisecond-precision price updates for trading decisions
 */

interface SpotPrice {
  asset: string;
  price: number;
  timestamp: number;
  source: 'binance' | 'chainlink' | 'polymarket';
}

interface OrderbookPrice {
  asset: string;
  outcome: 'up' | 'down';
  bid: number | null;
  ask: number | null;
  timestamp: number;
}

interface RealtimeState {
  spotPrices: Map<string, SpotPrice>;
  orderbooks: Map<string, { up: OrderbookPrice; down: OrderbookPrice }>;
  connected: boolean;
  binanceConnected: boolean;
  clobConnected: boolean;
  messageCount: number;
  lastUpdate: number;
}

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BINANCE_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];

export function useRealtimePrices(enabled: boolean = true) {
  const [state, setState] = useState<RealtimeState>({
    spotPrices: new Map(),
    orderbooks: new Map(),
    connected: false,
    binanceConnected: false,
    clobConnected: false,
    messageCount: 0,
    lastUpdate: Date.now(),
  });

  const enabledRef = useRef(enabled);
  const binanceWsRef = useRef<WebSocket | null>(null);
  const clobWsRef = useRef<WebSocket | null>(null);
  const tokenMapRef = useRef<Map<string, { asset: string; outcome: 'up' | 'down' }>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch token IDs for CLOB subscription
  const fetchTokenIds = useCallback(async () => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-market-tokens`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      if (!response.ok) return [];

      const data = await response.json();
      if (!data?.success || !Array.isArray(data?.markets)) return [];

      const tokenIds: string[] = [];
      tokenMapRef.current.clear();

      for (const m of data.markets) {
        if (m.upTokenId) {
          tokenIds.push(String(m.upTokenId));
          tokenMapRef.current.set(String(m.upTokenId), { asset: m.asset, outcome: 'up' });
        }
        if (m.downTokenId) {
          tokenIds.push(String(m.downTokenId));
          tokenMapRef.current.set(String(m.downTokenId), { asset: m.asset, outcome: 'down' });
        }
      }

      return tokenIds;
    } catch {
      return [];
    }
  }, []);

  // Connect to Binance WebSocket for spot prices
  const connectBinance = useCallback(() => {
    if (!enabledRef.current) return;
    if (binanceWsRef.current?.readyState === WebSocket.OPEN) return;

    const streams = BINANCE_SYMBOLS.map((s) => `${s}@trade`).join('/');
    const url = `${BINANCE_WS_URL}/${streams}`;

    console.log('[RealtimePrices] Connecting to Binance...');

    try {
      const ws = new WebSocket(url);
      binanceWsRef.current = ws;

      ws.onopen = () => {
        console.log('[RealtimePrices] ✅ Binance connected');
        setState((prev) => ({ ...prev, binanceConnected: true, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const now = Date.now();

          if (msg.e === 'trade' && msg.s && msg.p) {
            const symbol = msg.s.replace('USDT', '').toUpperCase();
            if (ASSETS.includes(symbol)) {
              const price = parseFloat(msg.p);
              const timestamp = msg.T || now;

              setState((prev) => {
                const newSpotPrices = new Map(prev.spotPrices);
                newSpotPrices.set(symbol, {
                  asset: symbol,
                  price,
                  timestamp,
                  source: 'binance',
                });
                return {
                  ...prev,
                  spotPrices: newSpotPrices,
                  messageCount: prev.messageCount + 1,
                  lastUpdate: now,
                };
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = (err) => {
        console.error('[RealtimePrices] Binance error:', err);
        setState((prev) => ({ ...prev, binanceConnected: false }));
      };

      ws.onclose = () => {
        console.log('[RealtimePrices] Binance disconnected');
        setState((prev) => ({ ...prev, binanceConnected: false }));
        binanceWsRef.current = null;

        // Reconnect after 3s
        if (enabledRef.current) {
          reconnectTimeoutRef.current = setTimeout(connectBinance, 3000);
        }
      };
    } catch (err) {
      console.error('[RealtimePrices] Failed to create Binance WebSocket:', err);
    }
  }, []);

  // Connect to CLOB WebSocket for orderbook prices
  const connectCLOB = useCallback(async () => {
    if (!enabledRef.current) return;
    if (clobWsRef.current?.readyState === WebSocket.OPEN) return;

    const tokenIds = await fetchTokenIds();
    if (tokenIds.length === 0) {
      console.log('[RealtimePrices] No token IDs found');
      return;
    }

    console.log(`[RealtimePrices] Connecting to CLOB with ${tokenIds.length} tokens...`);

    try {
      const ws = new WebSocket(CLOB_WS_URL);
      clobWsRef.current = ws;

      ws.onopen = () => {
        console.log('[RealtimePrices] ✅ CLOB connected');
        setState((prev) => ({ ...prev, clobConnected: true, connected: true }));

        // Subscribe to each token
        for (const tokenId of tokenIds) {
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              channel: 'market',
              assets_ids: [tokenId],
            })
          );
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const now = Date.now();

          if (data.asset_id) {
            const tokenId = String(data.asset_id);
            const info = tokenMapRef.current.get(tokenId);

            if (info) {
              let bestBid: number | null = null;
              let bestAsk: number | null = null;

              if (Array.isArray(data.bids) && data.bids.length > 0) {
                const firstBid = data.bids[0];
                bestBid =
                  typeof firstBid === 'object' && firstBid.price
                    ? parseFloat(firstBid.price)
                    : Array.isArray(firstBid)
                    ? parseFloat(firstBid[0])
                    : null;
              }

              if (Array.isArray(data.asks) && data.asks.length > 0) {
                const firstAsk = data.asks[0];
                bestAsk =
                  typeof firstAsk === 'object' && firstAsk.price
                    ? parseFloat(firstAsk.price)
                    : Array.isArray(firstAsk)
                    ? parseFloat(firstAsk[0])
                    : null;
              }

              setState((prev) => {
                const newOrderbooks = new Map(prev.orderbooks);
                const existing = newOrderbooks.get(info.asset) || {
                  up: { asset: info.asset, outcome: 'up', bid: null, ask: null, timestamp: 0 },
                  down: { asset: info.asset, outcome: 'down', bid: null, ask: null, timestamp: 0 },
                };

                existing[info.outcome] = {
                  asset: info.asset,
                  outcome: info.outcome,
                  bid: bestBid,
                  ask: bestAsk,
                  timestamp: now,
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
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = (err) => {
        console.error('[RealtimePrices] CLOB error:', err);
        setState((prev) => ({ ...prev, clobConnected: false }));
      };

      ws.onclose = () => {
        console.log('[RealtimePrices] CLOB disconnected');
        setState((prev) => ({ ...prev, clobConnected: false }));
        clobWsRef.current = null;

        // Reconnect after 3s
        if (enabledRef.current) {
          setTimeout(connectCLOB, 3000);
        }
      };
    } catch (err) {
      console.error('[RealtimePrices] Failed to create CLOB WebSocket:', err);
    }
  }, [fetchTokenIds]);

  // Cleanup
  const cleanup = useCallback(() => {
    if (binanceWsRef.current) {
      binanceWsRef.current.close();
      binanceWsRef.current = null;
    }
    if (clobWsRef.current) {
      clobWsRef.current.close();
      clobWsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // Connect on mount
  useEffect(() => {
    enabledRef.current = enabled;

    if (enabled) {
      connectBinance();
      connectCLOB();
    }

    return cleanup;
  }, [enabled, connectBinance, connectCLOB, cleanup]);

  // Helper functions
  const getSpotPrice = useCallback(
    (asset: string): number | null => {
      return state.spotPrices.get(asset)?.price ?? null;
    },
    [state.spotPrices]
  );

  const getOrderbook = useCallback(
    (asset: string, outcome: 'up' | 'down'): { bid: number | null; ask: number | null } | null => {
      const ob = state.orderbooks.get(asset);
      if (!ob) return null;
      return { bid: ob[outcome].bid, ask: ob[outcome].ask };
    },
    [state.orderbooks]
  );

  const getDelta = useCallback(
    (asset: string, strikePrice: number): { delta: number; side: 'UP' | 'DOWN' } | null => {
      const spot = getSpotPrice(asset);
      if (spot === null) return null;
      const delta = spot - strikePrice;
      return { delta, side: delta >= 0 ? 'UP' : 'DOWN' };
    },
    [getSpotPrice]
  );

  return {
    ...state,
    getSpotPrice,
    getOrderbook,
    getDelta,
    reconnect: () => {
      cleanup();
      connectBinance();
      connectCLOB();
    },
  };
}
