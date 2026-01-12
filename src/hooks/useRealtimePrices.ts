import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for real-time Binance spot prices via WebSocket
 * Uses correct multi-stream URL format: wss://stream.binance.com:9443/stream?streams=...
 * Implements exponential backoff for reconnection
 */

interface SpotPrice {
  asset: string;
  price: number;
  timestamp: number;
}

interface BinanceState {
  spotPrices: Map<string, SpotPrice>;
  connected: boolean;
  messageCount: number;
  lastUpdate: number;
}

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];
const BINANCE_SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt'];

export function useRealtimePrices(enabled: boolean = true) {
  const [state, setState] = useState<BinanceState>({
    spotPrices: new Map(),
    connected: false,
    messageCount: 0,
    lastUpdate: Date.now(),
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);

  // Connect to Binance WebSocket
  const connect = useCallback(() => {
    if (!enabledRef.current || !mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Correct multi-stream format
    const streams = BINANCE_SYMBOLS.map((s) => `${s}@trade`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    console.log('[Binance] Connecting...');

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Binance] ✅ Connected');
        reconnectAttemptsRef.current = 0;

        if (!mountedRef.current) {
          ws.close();
          return;
        }

        setState((prev) => ({ ...prev, connected: true }));
      };

      ws.onmessage = (event) => {
        try {
          const wrapper = JSON.parse(event.data);
          const now = Date.now();

          // Multi-stream format: { stream: "btcusdt@trade", data: { e: "trade", ... } }
          const msg = wrapper.data || wrapper;

          if (msg.e === 'trade' && msg.s && msg.p) {
            const symbol = msg.s.replace('USDT', '').toUpperCase();
            if (ASSETS.includes(symbol)) {
              const price = parseFloat(msg.p);
              const timestamp = msg.T || now;

              setState((prev) => {
                const newSpotPrices = new Map(prev.spotPrices);
                newSpotPrices.set(symbol, { asset: symbol, price, timestamp });
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
        console.error('[Binance] Error:', err);
        setState((prev) => ({ ...prev, connected: false }));
      };

      ws.onclose = (event) => {
        console.log('[Binance] Disconnected:', event.code);
        wsRef.current = null;

        if (!mountedRef.current) return;

        setState((prev) => ({ ...prev, connected: false }));

        // Exponential backoff
        if (enabledRef.current) {
          const attempts = reconnectAttemptsRef.current;
          const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
          reconnectAttemptsRef.current = attempts + 1;

          console.log(`[Binance] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
        }
      };
    } catch (err) {
      console.error('[Binance] Failed to create WebSocket:', err);
    }
  }, []);

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

  // Lifecycle
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

  // Helper functions
  const getSpotPrice = useCallback(
    (asset: string): number | null => {
      return state.spotPrices.get(asset)?.price ?? null;
    },
    [state.spotPrices]
  );

  const getSpotTimestamp = useCallback(
    (asset: string): number | null => {
      return state.spotPrices.get(asset)?.timestamp ?? null;
    },
    [state.spotPrices]
  );

  const isSpotStale = useCallback(
    (asset: string, maxAgeMs: number = 5000): boolean => {
      const ts = state.spotPrices.get(asset)?.timestamp;
      if (!ts) return true;
      return Date.now() - ts > maxAgeMs;
    },
    [state.spotPrices]
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
    binanceConnected: state.connected,
    assets: ASSETS,
    getSpotPrice,
    getSpotTimestamp,
    isSpotStale,
    getDelta,
    reconnect: () => {
      disconnect();
      reconnectAttemptsRef.current = 0;
      connect();
    },
  };
}
