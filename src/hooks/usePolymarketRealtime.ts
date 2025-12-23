import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polymarket market prices via RTDS proxy edge function
 * Subscribes to activity/trades for market_slug updates
 * Falls back to REST polling if WebSocket fails
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface PricePoint {
  price: number;
  timestampMs: number;
}

interface UsePolymarketRealtimeResult {
  getPrice: (marketSlug: string, outcome: string) => number | null;
  isConnected: boolean;
  connectionState: ConnectionState;
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  connect: () => void;
  disconnect: () => void;
}

const PROXY_WS_URL = "wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/rtds-proxy";
const PROXY_REST_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/rtds-proxy";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 5;
const REST_POLL_INTERVAL = 3000;
const UI_SYNC_INTERVAL_MS = 100;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

export function usePolymarketRealtime(
  marketSlugs: string[],
  enabled: boolean = true
): UsePolymarketRealtimeResult {
  // Map: marketSlug -> outcome -> price
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());
  const updateCountRef = useRef(0);
  const lastUpdateTimeRef = useRef(Date.now());

  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const uiSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const subscribedSlugsRef = useRef<string>("");
  const useRestFallback = useRef(false);

  const startUiSync = useCallback(() => {
    if (uiSyncIntervalRef.current) return;
    uiSyncIntervalRef.current = setInterval(() => {
      const now = Date.now();
      if (updateCountRef.current !== updateCount) {
        setUpdateCount(updateCountRef.current);
        setLastUpdateTime(lastUpdateTimeRef.current);
        setLatencyMs(now - lastUpdateTimeRef.current);
      }
    }, UI_SYNC_INTERVAL_MS);
  }, [updateCount]);

  const stopUiSync = useCallback(() => {
    if (uiSyncIntervalRef.current) {
      clearInterval(uiSyncIntervalRef.current);
      uiSyncIntervalRef.current = null;
    }
  }, []);

  // REST API fallback polling
  const pollPrices = useCallback(async () => {
    if (marketSlugs.length === 0) return;
    
    try {
      const response = await fetch(PROXY_REST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_slugs: marketSlugs })
      });
      
      if (response.ok) {
        const data = await response.json();
        const now = Date.now();
        
        if (data.markets) {
          for (const [slug, prices] of Object.entries(data.markets)) {
            const p = prices as { up: number; down: number };
            let marketMap = pricesRef.current.get(slug);
            if (!marketMap) {
              marketMap = new Map();
              pricesRef.current.set(slug, marketMap);
            }
            marketMap.set('up', { price: p.up, timestampMs: now });
            marketMap.set('yes', { price: p.up, timestampMs: now });
            marketMap.set('down', { price: p.down, timestampMs: now });
            marketMap.set('no', { price: p.down, timestampMs: now });
          }
          updateCountRef.current++;
          lastUpdateTimeRef.current = now;
        }
        
        setIsConnected(true);
        setConnectionState('connected');
      }
    } catch (err) {
      console.error('[Market REST] Poll error:', err);
    }
  }, [marketSlugs]);

  const startRestPolling = useCallback(() => {
    if (pollIntervalRef.current) return;
    console.log('[Market] Starting REST API polling fallback');
    useRestFallback.current = true;
    pollPrices();
    pollIntervalRef.current = setInterval(pollPrices, REST_POLL_INTERVAL);
    startUiSync();
  }, [pollPrices, startUiSync]);

  const stopRestPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    stopUiSync();
    stopRestPolling();

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    setIsConnected(false);
    setConnectionState("disconnected");
  }, [stopUiSync, stopRestPolling]);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (marketSlugs.length === 0) {
      console.log("[Market WS] No market slugs, not connecting");
      return;
    }

    setConnectionState("connecting");
    console.log("[Market WS] Connecting via proxy...", { count: marketSlugs.length });

    try {
      const ws = new WebSocket(PROXY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[Market WS] Connected to proxy");
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        const now = Date.now();
        
        let msg: any = null;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        // Proxy connected - subscribe to trades
        if (msg.type === 'proxy_connected') {
          console.log('[Market WS] Proxy connected to RTDS, subscribing...');
          setIsConnected(true);
          setConnectionState('connected');
          stopRestPolling();
          useRestFallback.current = false;
          
          const subscriptions = marketSlugs.map((slug) => ({
            topic: "activity",
            type: "trades",
            filters: JSON.stringify({ market_slug: slug }),
          }));
          
          ws.send(JSON.stringify({ action: "subscribe", subscriptions }));
          subscribedSlugsRef.current = marketSlugs.join(",");
          startUiSync();
          return;
        }

        // Proxy error - fall back to REST
        if (msg.type === 'proxy_error' || msg.type === 'proxy_disconnected') {
          console.log('[Market WS] Proxy error, falling back to REST');
          startRestPolling();
          return;
        }

        // Handle trade updates
        if (msg.topic === "activity" && msg.payload) {
          const { slug, outcome, price, timestamp } = msg.payload;
          if (!slug || !outcome || typeof price !== "number") return;

          const outcomeKey = normalizeOutcome(outcome);
          const timestampMs = typeof timestamp === "number" 
            ? (timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp) 
            : now;

          let marketMap = pricesRef.current.get(slug);
          if (!marketMap) {
            marketMap = new Map();
            pricesRef.current.set(slug, marketMap);
          }
          marketMap.set(outcomeKey, { price, timestampMs });

          updateCountRef.current++;
          lastUpdateTimeRef.current = timestampMs;
          
          console.log(`[Market WS] Trade: ${slug} ${outcomeKey}=${price.toFixed(2)}`);
        }
      };

      ws.onerror = (err) => {
        console.error("[Market WS] Error:", err);
        setConnectionState("error");
      };

      ws.onclose = (event) => {
        console.log("[Market WS] Disconnected:", event.code);
        setIsConnected(false);
        wsRef.current = null;
        stopUiSync();

        if (enabled && !useRestFallback.current) {
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current++;
            reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
          } else {
            console.log('[Market WS] Max reconnects reached, using REST fallback');
            startRestPolling();
          }
        }
      };
    } catch (e) {
      console.error("[Market WS] Failed to connect:", e);
      setConnectionState("error");
      startRestPolling();
    }
  }, [enabled, marketSlugs, startUiSync, stopUiSync, startRestPolling, stopRestPolling]);

  // Reconnect when subscription set changes
  useEffect(() => {
    const next = marketSlugs.join(",");
    const changed = next !== subscribedSlugsRef.current;

    if (!enabled) {
      disconnect();
      return;
    }

    if (marketSlugs.length === 0) {
      disconnect();
      return;
    }

    if (changed || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      disconnect();
      // Start with REST polling for immediate data
      startRestPolling();
      // Then try WebSocket
      connect();
    }
  }, [enabled, marketSlugs.join(","), connect, disconnect, startRestPolling]);

  useEffect(() => () => disconnect(), [disconnect]);

  const getPrice = useCallback((marketSlug: string, outcome: string) => {
    const market = pricesRef.current.get(marketSlug);
    if (!market) return null;
    return market.get(normalizeOutcome(outcome))?.price ?? null;
  }, []);

  return {
    getPrice,
    isConnected,
    connectionState,
    updateCount,
    lastUpdateTime,
    latencyMs,
    connect,
    disconnect,
  };
}
