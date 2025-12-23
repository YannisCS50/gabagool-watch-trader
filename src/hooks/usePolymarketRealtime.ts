import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * True realtime Up/Down pricing for Polymarket 15-min crypto markets.
 *
 * 1. Fetches active 15m markets from Gamma API
 * 2. Extracts clobTokenIds (Up/Down token IDs)
 * 3. Subscribes to CLOB market channel for best_ask prices
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "discovering" | "error";

interface PricePoint {
  price: number;
  timestampMs: number;
}

interface MarketInfo {
  slug: string;
  asset: "BTC" | "ETH";
  upTokenId: string;
  downTokenId: string;
  eventStartTime: Date;
  eventEndTime: Date;
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
const GAMMA_API_URL = "https://gamma-api.polymarket.com/events";

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;
const UI_SYNC_INTERVAL_MS = 100;
const MARKET_REFRESH_INTERVAL_MS = 60000; // Refresh market discovery every minute

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

function parseNumber(n: unknown): number | null {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * Fetch active 15-minute crypto markets from Gamma API
 */
async function fetchActive15mMarkets(): Promise<MarketInfo[]> {
  console.log("[Market Discovery] Fetching active 15m crypto markets from Gamma API...");
  
  try {
    // Fetch active events
    const response = await fetch(`${GAMMA_API_URL}?active=true&limit=100`);
    if (!response.ok) {
      console.error("[Market Discovery] Gamma API error:", response.status);
      return [];
    }
    
    const events = await response.json();
    if (!Array.isArray(events)) {
      console.error("[Market Discovery] Invalid response format");
      return [];
    }
    
    console.log("[Market Discovery] Got", events.length, "active events");
    
    const markets: MarketInfo[] = [];
    
    for (const event of events) {
      const title = String(event.title || "").toLowerCase();
      const slug = String(event.slug || "");
      
      // Look for 15-minute crypto markets
      const is15m = title.includes("15") && (title.includes("minute") || title.includes("min") || title.includes("m"));
      const isBtc = title.includes("bitcoin") || title.includes("btc");
      const isEth = title.includes("ethereum") || title.includes("eth");
      const isUpDown = title.includes("up") || title.includes("down") || title.includes("higher") || title.includes("lower");
      
      if (!is15m || (!isBtc && !isEth) || !isUpDown) continue;
      
      // Get the markets array from the event
      const eventMarkets = event.markets || [];
      if (eventMarkets.length === 0) continue;
      
      // Find the main market with token IDs
      const market = eventMarkets[0];
      const clobTokenIds = market.clobTokenIds || market.clob_token_ids || [];
      const outcomes = market.outcomes || [];
      
      if (clobTokenIds.length < 2 || outcomes.length < 2) continue;
      
      // Determine which token is Up and which is Down
      const o0 = String(outcomes[0] || "").toLowerCase();
      const isO0Down = o0.includes("no") || o0.includes("down") || o0.includes("lower");
      
      const upTokenId = isO0Down ? String(clobTokenIds[1]) : String(clobTokenIds[0]);
      const downTokenId = isO0Down ? String(clobTokenIds[0]) : String(clobTokenIds[1]);
      
      // Parse event times
      const startTime = new Date(event.startDate || event.start_date || Date.now());
      const endTime = new Date(event.endDate || event.end_date || Date.now() + 900000);
      
      const asset: "BTC" | "ETH" = isBtc ? "BTC" : "ETH";
      
      markets.push({
        slug: market.slug || slug,
        asset,
        upTokenId,
        downTokenId,
        eventStartTime: startTime,
        eventEndTime: endTime,
      });
      
      console.log("[Market Discovery] Found:", asset, "15m market:", market.slug || slug, "tokens:", upTokenId.slice(0, 8), downTokenId.slice(0, 8));
    }
    
    console.log("[Market Discovery] Total 15m crypto markets found:", markets.length);
    return markets;
    
  } catch (error) {
    console.error("[Market Discovery] Error:", error);
    return [];
  }
}

export function usePolymarketRealtime(enabled: boolean = true): UsePolymarketRealtimeResult {
  // Discovered markets
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  
  // Map: marketSlug -> outcome -> price
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());
  const updateCountRef = useRef(0);
  const lastUpdateTimeRef = useRef(Date.now());

  // Token mapping (tokenId -> { slug, outcome })
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

  // Discover markets and build token mapping
  const discoverMarkets = useCallback(async () => {
    setConnectionState("discovering");
    
    const discovered = await fetchActive15mMarkets();
    setMarkets(discovered);
    
    // Build reverse mapping: tokenId -> { slug, outcome }
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
    console.log("[CLOB WS] Connecting to CLOB proxy with", tokenIds.length, "tokens...");

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
            console.log("[CLOB WS] Proxy connected to CLOB, subscribing to", tokenIds.length, "tokens");
            setIsConnected(true);
            setConnectionState("connected");

            // Subscribe to market channel with all token IDs
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

          // Handle CLOB price_change events
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
              // Aliases
              if (key === "up") marketMap.set("yes", { price: bestAsk, timestampMs: ts });
              if (key === "down") marketMap.set("no", { price: bestAsk, timestampMs: ts });

              updateCountRef.current++;
              lastUpdateTimeRef.current = ts;
              
              console.log("[CLOB WS] Price update:", m.slug, m.outcome, bestAsk);
            }
            return;
          }

          // Handle CLOB book events (initial snapshot)
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
            
            console.log("[CLOB WS] Book snapshot:", m.slug, m.outcome, bestAsk);
            return;
          }
        } catch {
          // non-JSON (e.g. PONG) -> ignore
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
            // Re-discover and reconnect
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

    // First discover markets
    const discovered = await discoverMarkets();
    
    if (discovered.length === 0) {
      console.log("[CLOB] No active 15m markets found");
      setConnectionState("error");
      return;
    }

    // Extract all token IDs
    const tokenIds = discovered.flatMap(m => [m.upTokenId, m.downTokenId]);
    
    // Connect WebSocket
    connectWebSocket(tokenIds);
    
    // Set up periodic market refresh
    if (!marketRefreshIntervalRef.current) {
      marketRefreshIntervalRef.current = setInterval(async () => {
        console.log("[Market Discovery] Refreshing markets...");
        const refreshed = await discoverMarkets();
        if (refreshed.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          // Re-subscribe with new tokens
          const ids = refreshed.flatMap(m => [m.upTokenId, m.downTokenId]);
          wsRef.current.send(JSON.stringify({
            type: "market",
            assets_ids: ids,
          }));
        }
      }, MARKET_REFRESH_INTERVAL_MS);
    }
  }, [enabled, discoverMarkets, connectWebSocket]);

  // Auto-connect when enabled
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
