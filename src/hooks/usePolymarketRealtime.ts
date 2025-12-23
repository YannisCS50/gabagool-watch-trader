import { useCallback, useEffect, useRef, useState } from "react";

/**
 * True realtime pricing for Polymarket crypto markets.
 *
 * 1. Fetches active crypto markets from our edge function (avoids CORS)
 * 2. Extracts clobTokenIds (Yes/No token IDs)
 * 3. Subscribes to CLOB market channel for best_ask prices
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "discovering" | "error";

interface PricePoint {
  price: number;
  timestampMs: number;
}

export interface MarketInfo {
  slug: string;
  question: string;
  asset: "BTC" | "ETH" | "SOL" | "XRP";
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: Date;
  eventEndTime: Date;
  marketType: "price_above" | "price_target" | "15min" | "other";
}

interface UsePolymarketRealtimeResult {
  markets: MarketInfo[];
  getPrice: (marketSlug: string, outcome: string) => number | null;
  isConnected: boolean;
  connectionState: ConnectionState;
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  connect: () => void;
  disconnect: () => void;
}

const CLOB_PROXY_WS_URL = "wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/clob-proxy";
const MARKET_TOKENS_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/get-market-tokens";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;
const UI_SYNC_INTERVAL_MS = 100;
const MARKET_REFRESH_INTERVAL_MS = 60000;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

function parseNumber(n: unknown): number | null {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * Fetch active crypto markets from our edge function
 */
async function fetchActiveMarkets(): Promise<MarketInfo[]> {
  console.log("[Market Discovery] Fetching from edge function...");
  
  try {
    const response = await fetch(MARKET_TOKENS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    if (!response.ok) {
      console.error("[Market Discovery] Edge function error:", response.status);
      return [];
    }
    
    const data = await response.json();
    console.log("[Market Discovery] Response:", data);
    
    if (!data.success || !Array.isArray(data.markets)) {
      console.error("[Market Discovery] Invalid response format");
      return [];
    }
    
    const markets: MarketInfo[] = data.markets.map((m: any) => ({
      slug: m.slug,
      question: m.question || '',
      asset: m.asset as "BTC" | "ETH" | "SOL" | "XRP",
      conditionId: m.conditionId || '',
      upTokenId: m.upTokenId,
      downTokenId: m.downTokenId,
      eventStartTime: new Date(m.eventStartTime),
      eventEndTime: new Date(m.eventEndTime),
      marketType: m.marketType || 'other',
    }));
    
    console.log("[Market Discovery] Found", markets.length, "markets");
    return markets;
    
  } catch (error) {
    console.error("[Market Discovery] Error:", error);
    return [];
  }
}

export function usePolymarketRealtime(enabled: boolean = true): UsePolymarketRealtimeResult {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());
  const updateCountRef = useRef(0);
  const lastUpdateTimeRef = useRef(Date.now());

  const tokenToMarketRef = useRef<Map<string, { slug: string; outcome: "up" | "down" }>>(new Map());

  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const uiSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const marketRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

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

  const disconnect = useCallback(() => {
    stopUiSync();

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (marketRefreshIntervalRef.current) {
      clearInterval(marketRefreshIntervalRef.current);
      marketRefreshIntervalRef.current = null;
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

  const discoverMarkets = useCallback(async () => {
    setConnectionState("discovering");
    
    const discovered = await fetchActiveMarkets();
    setMarkets(discovered);
    
    const mapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
    for (const m of discovered) {
      mapping.set(m.upTokenId, { slug: m.slug, outcome: "up" });
      mapping.set(m.downTokenId, { slug: m.slug, outcome: "down" });
    }
    tokenToMarketRef.current = mapping;
    
    return discovered;
  }, []);

  const connectWebSocket = useCallback((tokenIds: string[]) => {
    if (tokenIds.length === 0) {
      console.log("[CLOB WS] No token IDs to subscribe to");
      setConnectionState("error");
      return;
    }

    setConnectionState("connecting");
    console.log("[CLOB WS] Connecting with", tokenIds.length, "tokens...");

    try {
      const ws = new WebSocket(CLOB_PROXY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[CLOB WS] WebSocket opened");
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        const now = Date.now();

        try {
          const msg = JSON.parse(event.data);

          if (msg?.type === "proxy_connected") {
            console.log("[CLOB WS] Proxy connected, subscribing to", tokenIds.length, "tokens");
            setIsConnected(true);
            setConnectionState("connected");

            ws.send(JSON.stringify({
              type: "market",
              assets_ids: tokenIds,
            }));

            startUiSync();
            return;
          }

          if (msg?.type === "proxy_error" || msg?.type === "proxy_disconnected") {
            console.log("[CLOB WS] Proxy error/disconnect:", msg);
            setIsConnected(false);
            setConnectionState("error");
            return;
          }

          const eventType = msg?.event_type;

          if (eventType === "price_change" && Array.isArray(msg.price_changes)) {
            const ts = parseNumber(msg.timestamp) ?? now;

            for (const pc of msg.price_changes) {
              const tokenId = String((pc as any)?.asset_id ?? "");
              const bestAsk = parseNumber((pc as any)?.best_ask);
              if (!tokenId || bestAsk == null) continue;

              const m = tokenToMarketRef.current.get(tokenId);
              if (!m) continue;

              let marketMap = pricesRef.current.get(m.slug);
              if (!marketMap) {
                marketMap = new Map();
                pricesRef.current.set(m.slug, marketMap);
              }

              const key = m.outcome;
              marketMap.set(key, { price: bestAsk, timestampMs: ts });
              if (key === "up") marketMap.set("yes", { price: bestAsk, timestampMs: ts });
              if (key === "down") marketMap.set("no", { price: bestAsk, timestampMs: ts });

              updateCountRef.current++;
              lastUpdateTimeRef.current = ts;
              
              console.log("[CLOB WS] Price:", m.slug, m.outcome, bestAsk);
            }
            return;
          }

          if (eventType === "book") {
            const tokenId = String(msg.asset_id ?? "");
            const asks = Array.isArray(msg.asks) ? msg.asks : [];
            const bestAsk = asks.length > 0 ? parseNumber(asks[0]?.price) : null;
            const ts = parseNumber(msg.timestamp) ?? now;

            if (!tokenId || bestAsk == null) return;

            const m = tokenToMarketRef.current.get(tokenId);
            if (!m) return;

            let marketMap = pricesRef.current.get(m.slug);
            if (!marketMap) {
              marketMap = new Map();
              pricesRef.current.set(m.slug, marketMap);
            }

            const key = m.outcome;
            marketMap.set(key, { price: bestAsk, timestampMs: ts });
            if (key === "up") marketMap.set("yes", { price: bestAsk, timestampMs: ts });
            if (key === "down") marketMap.set("no", { price: bestAsk, timestampMs: ts });

            updateCountRef.current++;
            lastUpdateTimeRef.current = ts;
            
            console.log("[CLOB WS] Book:", m.slug, m.outcome, bestAsk);
            return;
          }
        } catch {
          // non-JSON
        }
      };

      ws.onerror = (err) => {
        console.error("[CLOB WS] Error:", err);
        setConnectionState("error");
      };

      ws.onclose = () => {
        console.log("[CLOB WS] Disconnected");
        setIsConnected(false);
        wsRef.current = null;
        stopUiSync();

        if (!enabled) return;

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          console.log(`[CLOB WS] Reconnecting (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);
          reconnectTimeoutRef.current = setTimeout(() => {
            discoverMarkets().then(discovered => {
              const ids = discovered.flatMap(m => [m.upTokenId, m.downTokenId]);
              connectWebSocket(ids);
            });
          }, RECONNECT_DELAY_MS);
        } else {
          setConnectionState("error");
        }
      };
    } catch (err) {
      console.error("[CLOB WS] Failed to connect:", err);
      setConnectionState("error");
    }
  }, [enabled, startUiSync, stopUiSync, discoverMarkets]);

  const connect = useCallback(async () => {
    if (!enabled) return;

    const discovered = await discoverMarkets();
    
    if (discovered.length === 0) {
      console.log("[CLOB] No active 15m markets found");
      // Still set connected state so we show the "no markets" message
      setConnectionState("connected");
      setIsConnected(true);
      return;
    }

    const tokenIds = discovered.flatMap(m => [m.upTokenId, m.downTokenId]);
    connectWebSocket(tokenIds);
    
    if (!marketRefreshIntervalRef.current) {
      marketRefreshIntervalRef.current = setInterval(async () => {
        console.log("[Market Discovery] Refreshing...");
        const refreshed = await discoverMarkets();
        if (refreshed.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          const ids = refreshed.flatMap(m => [m.upTokenId, m.downTokenId]);
          wsRef.current.send(JSON.stringify({
            type: "market",
            assets_ids: ids,
          }));
        }
      }, MARKET_REFRESH_INTERVAL_MS);
    }
  }, [enabled, discoverMarkets, connectWebSocket]);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => disconnect();
  }, [enabled, connect, disconnect]);

  const getPrice = useCallback((marketSlug: string, outcome: string) => {
    const market = pricesRef.current.get(marketSlug);
    if (!market) return null;
    return market.get(normalizeOutcome(outcome))?.price ?? null;
  }, []);

  return {
    markets,
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
