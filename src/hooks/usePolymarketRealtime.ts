import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polymarket RTDS WebSocket client for live trade prices.
 * We subscribe to topic `activity` / type `trades` filtered by market_slug.
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type OutcomeKey = string;

interface TradePayload {
  slug?: string; // market slug
  outcome?: string;
  price?: number;
  timestamp?: number;
}

interface MessageEnvelope {
  topic?: string;
  type?: string;
  payload?: TradePayload;
}

interface PricePoint {
  price: number;
  timestampMs: number;
}

interface UsePolymarketRealtimeResult {
  getPrice: (marketSlug: string, outcome: OutcomeKey) => number | null;
  isConnected: boolean;
  connectionState: ConnectionState;
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  connect: () => void;
  disconnect: () => void;
}

const RTDS_URL = "wss://rtds.polymarket.com";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const UI_SYNC_INTERVAL_MS = 100;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

const toTimestampMs = (t: number, fallbackMs: number) => {
  // Some feeds send seconds, some ms
  if (t < 1_000_000_000_000) return t * 1000;
  return t;
};

export function usePolymarketRealtime(
  marketSlugs: string[],
  enabled: boolean = true
): UsePolymarketRealtimeResult {
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
  const subscribedSlugsRef = useRef<string>("");

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
    if (!uiSyncIntervalRef.current) return;
    clearInterval(uiSyncIntervalRef.current);
    uiSyncIntervalRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    stopUiSync();

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
  }, [stopUiSync]);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (marketSlugs.length === 0) {
      console.log("[RTDS Trades] No market slugs, not connecting");
      return;
    }

    setConnectionState("connecting");
    console.log("[RTDS Trades] Connecting…", { count: marketSlugs.length });

    try {
      const ws = new WebSocket(RTDS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[RTDS Trades] Connected");
        setIsConnected(true);
        setConnectionState("connected");
        reconnectAttemptsRef.current = 0;

        const subscriptions = marketSlugs.map((slug) => ({
          topic: "activity",
          type: "trades",
          filters: JSON.stringify({ market_slug: slug }),
        }));

        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions,
          })
        );

        subscribedSlugsRef.current = marketSlugs.join(",");
        startUiSync();
      };

      ws.onmessage = (event) => {
        const now = Date.now();

        let msg: MessageEnvelope | null = null;
        try {
          msg = JSON.parse(event.data) as MessageEnvelope;
        } catch {
          return;
        }

        if (!msg || !msg.payload) return;
        if (msg.topic !== "activity") return;
        if (msg.type !== "trades" && msg.type !== "orders_matched") return;

        const slug = msg.payload.slug;
        const outcome = msg.payload.outcome;
        const price = msg.payload.price;
        const ts = msg.payload.timestamp;

        if (!slug || !outcome || typeof price !== "number") return;

        const outcomeKey = normalizeOutcome(outcome);
        const timestampMs = typeof ts === "number" ? toTimestampMs(ts, now) : now;

        let marketMap = pricesRef.current.get(slug);
        if (!marketMap) {
          marketMap = new Map();
          pricesRef.current.set(slug, marketMap);
        }

        marketMap.set(outcomeKey, { price, timestampMs });

        updateCountRef.current++;
        lastUpdateTimeRef.current = timestampMs;
      };

      ws.onerror = (err) => {
        console.error("[RTDS Trades] WebSocket error:", err);
        setConnectionState("error");
      };

      ws.onclose = (event) => {
        console.log("[RTDS Trades] Disconnected:", event.code, event.reason);
        setIsConnected(false);
        setConnectionState("disconnected");
        stopUiSync();

        if (enabled && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    } catch (e) {
      console.error("[RTDS Trades] Failed to connect:", e);
      setConnectionState("error");
    }
  }, [enabled, marketSlugs, startUiSync, stopUiSync]);

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
      connect();
    }
  }, [enabled, marketSlugs.join(","), connect, disconnect]);

  useEffect(() => () => disconnect(), [disconnect]);

  const getPrice = useCallback((marketSlug: string, outcome: OutcomeKey) => {
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
