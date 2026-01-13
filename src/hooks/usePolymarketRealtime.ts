import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Realtime Polymarket prices via WebSocket (CLOB WS).
 * Uses the rtds-proxy edge function for WebSocket proxying.
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "discovering" | "error";

interface PricePoint {
  price: number | null;
  bestAsk: number | null;
  bestBid: number | null;
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
  openPrice: number | null;
  strikePrice: number | null;
  previousClosePrice: number | null;
}

export interface ExpiredMarket {
  slug: string;
  asset: "BTC" | "ETH";
  question: string;
  eventStartTime: Date;
  eventEndTime: Date;
  openPrice: number | null;
  strikePrice: number | null;
  closePrice: number | null;
  upPriceAtClose: number | null;
  downPriceAtClose: number | null;
  result: "UP" | "DOWN" | "UNKNOWN" | null;
}

interface UsePolymarketRealtimeResult {
  markets: MarketInfo[];
  expiredMarkets: ExpiredMarket[];
  getPrice: (marketSlug: string, outcome: string) => number | null;
  getOrderbook: (marketSlug: string, outcome: string) => { bid: number | null; ask: number | null } | null;
  isConnected: boolean;
  connectionState: ConnectionState;
  updateCount: number;
  lastUpdateTime: number;
  latencyMs: number;
  connect: () => void;
  disconnect: () => void;
  pricesVersion: number;
  timeSinceLastUpdate: number;
}

const FUNCTIONS_BASE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const MARKET_TOKENS_URL = `${FUNCTIONS_BASE_URL}/get-market-tokens`;
const SAVE_EXPIRED_URL = `${FUNCTIONS_BASE_URL}/save-expired-market`;

// Direct CLOB WebSocket URL
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const MARKET_REFRESH_INTERVAL_MS = 60_000;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

async function fetchActiveMarkets(): Promise<MarketInfo[]> {
  try {
    const response = await fetch(MARKET_TOKENS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok) return [];

    const data = await response.json();
    if (!data?.success || !Array.isArray(data?.markets)) return [];

    return data.markets.map((m: any) => ({
      slug: m.slug,
      question: m.question || "",
      asset: m.asset as "BTC" | "ETH" | "SOL" | "XRP",
      conditionId: m.conditionId || "",
      upTokenId: String(m.upTokenId),
      downTokenId: String(m.downTokenId),
      eventStartTime: new Date(m.eventStartTime),
      eventEndTime: new Date(m.eventEndTime),
      marketType: m.marketType || "other",
      openPrice: m.openPrice ?? m.strikePrice ?? null,
      strikePrice: m.openPrice ?? m.strikePrice ?? null,
      previousClosePrice: m.previousClosePrice ?? null,
    }));
  } catch {
    return [];
  }
}

async function fetchExpiredMarketsFromDB(): Promise<ExpiredMarket[]> {
  try {
    const { data, error } = await supabase
      .from("market_history")
      .select("*")
      .order("event_end_time", { ascending: false })
      .limit(50);

    if (error) return [];

    return (data || []).map((m: any) => ({
      slug: m.slug,
      asset: m.asset as "BTC" | "ETH",
      question: m.question || "",
      eventStartTime: new Date(m.event_start_time),
      eventEndTime: new Date(m.event_end_time),
      openPrice: m.open_price ?? m.strike_price ?? null,
      strikePrice: m.open_price ?? m.strike_price ?? null,
      closePrice: m.close_price,
      upPriceAtClose: m.up_price_at_close,
      downPriceAtClose: m.down_price_at_close,
      result: m.result as "UP" | "DOWN" | "UNKNOWN" | null,
    }));
  } catch {
    return [];
  }
}

async function saveExpiredMarket(
  market: MarketInfo,
  upPrice: number | null,
  downPrice: number | null,
  closePrice: number | null,
): Promise<void> {
  try {
    await fetch(SAVE_EXPIRED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: market.slug,
        asset: market.asset,
        question: market.question,
        eventStartTime: market.eventStartTime.toISOString(),
        eventEndTime: market.eventEndTime.toISOString(),
        strikePrice: market.strikePrice,
        closePrice,
        upPriceAtClose: upPrice,
        downPriceAtClose: downPrice,
        upTokenId: market.upTokenId,
        downTokenId: market.downTokenId,
      }),
    });
  } catch {
    // ignore
  }
}

function midpoint(bid: number | null, ask: number | null): number | null {
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return ask ?? bid ?? null;
}

export function usePolymarketRealtime(enabled: boolean = true): UsePolymarketRealtimeResult {
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [expiredMarkets, setExpiredMarkets] = useState<ExpiredMarket[]>([]);

  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);
  const [pricesVersion, setPricesVersion] = useState(0);

  const enabledRef = useRef(enabled);
  const marketsRef = useRef<MarketInfo[]>([]);
  const tokenToMarketRef = useRef<Map<string, { slug: string; outcome: "up" | "down" }>>(new Map());
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const marketRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const savedExpiredSlugsRef = useRef<Set<string>>(new Set());
  const chainlinkPricesRef = useRef<{ btc: number | null; eth: number | null }>({ btc: null, eth: null });

  const [manualEnabled, setManualEnabled] = useState(true);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (enabled) {
      fetchExpiredMarketsFromDB().then((expired) => {
        setExpiredMarkets(expired);
        for (const m of expired) savedExpiredSlugsRef.current.add(m.slug);
      });
    }
  }, [enabled]);

  const rebuildTokenMap = useCallback((list: MarketInfo[]) => {
    const mapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
    for (const m of list) {
      if (m.upTokenId) mapping.set(String(m.upTokenId), { slug: m.slug, outcome: "up" });
      if (m.downTokenId) mapping.set(String(m.downTokenId), { slug: m.slug, outcome: "down" });
    }
    tokenToMarketRef.current = mapping;
  }, []);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (marketRefreshIntervalRef.current) {
      clearInterval(marketRefreshIntervalRef.current);
      marketRefreshIntervalRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const subscribeToTokens = useCallback((ws: WebSocket, tokenIds: string[]) => {
    if (ws.readyState !== WebSocket.OPEN || tokenIds.length === 0) return;

    // The upstream CLOB market WS expects a single subscribe payload:
    // { assets_ids: [...], type: "market" }
    // (NOT per-token "subscribe" messages)
    const subscribeMsg = {
      assets_ids: tokenIds,
      type: "market",
    };

    console.log("[CLOB WS] Subscribing to", tokenIds.length, "tokens");
    ws.send(JSON.stringify(subscribeMsg));
  }, []);

  const handleWsMessage = useCallback((event: MessageEvent) => {
    try {
      const raw = event.data;

      // Some frames can be non-string (binary); ignore.
      if (typeof raw !== "string") return;

      // Proxy / upstream can send plain-text control/error frames.
      if (raw === "PONG") return;
      if (raw === "INVALID") {
        // This typically indicates an unsupported message format was sent.
        // We ignore it to avoid breaking the stream + reconnect loop.
        console.warn("[CLOB WS] Received INVALID message (ignoring)");
        return;
      }

      const trimmed = raw.trimStart();
      const firstChar = trimmed[0];
      if (firstChar !== "{" && firstChar !== "[") return;

      const data = JSON.parse(trimmed);
      const now = Date.now();

      // Handle price updates from CLOB WS
      // Format: { event_type: 'book', asset_id, bids: [[price, size]], asks: [[price, size]], ... }
      if (data.asset_id) {
        const tokenId = String(data.asset_id);
        const marketInfo = tokenToMarketRef.current.get(tokenId);

        if (marketInfo) {
          // Parse bids and asks
          let bestBid: number | null = null;
          let bestAsk: number | null = null;

          if (Array.isArray(data.bids) && data.bids.length > 0) {
            // Bids are sorted DESC, first is best
            const firstBid = data.bids[0];
            bestBid = typeof firstBid === "object" && firstBid.price
              ? parseFloat(firstBid.price)
              : (Array.isArray(firstBid) ? parseFloat(firstBid[0]) : null);
          }

          if (Array.isArray(data.asks) && data.asks.length > 0) {
            // Asks are sorted ASC, first is best
            const firstAsk = data.asks[0];
            bestAsk = typeof firstAsk === "object" && firstAsk.price
              ? parseFloat(firstAsk.price)
              : (Array.isArray(firstAsk) ? parseFloat(firstAsk[0]) : null);
          }

          // Also check for direct price field
          if (data.price !== undefined) {
            const directPrice = parseFloat(data.price);
            if (!isNaN(directPrice)) {
              bestBid = bestBid ?? directPrice;
              bestAsk = bestAsk ?? directPrice;
            }
          }

          const mid = midpoint(bestBid, bestAsk);
          if (mid === null && bestBid === null && bestAsk === null) return;

          let marketMap = pricesRef.current.get(marketInfo.slug);
          if (!marketMap) {
            marketMap = new Map();
            pricesRef.current.set(marketInfo.slug, marketMap);
          }

          const point: PricePoint = {
            price: mid,
            bestAsk,
            bestBid,
            timestampMs: now,
          };

          marketMap.set(marketInfo.outcome, point);
          if (marketInfo.outcome === "up") marketMap.set("yes", point);
          if (marketInfo.outcome === "down") marketMap.set("no", point);

          // Calculate latency if timestamp provided
          if (data.timestamp) {
            const serverTs = typeof data.timestamp === "number" ? data.timestamp : Date.parse(data.timestamp);
            if (!isNaN(serverTs)) {
              setLatencyMs(now - serverTs);
            }
          }

          setPricesVersion((v) => v + 1);
          setUpdateCount((c) => c + 1);
          setLastUpdateTime(now);
        }
      }
    } catch (err) {
      console.error("[CLOB WS] Parse error:", err);
    }
  }, []);

  const connectWs = useCallback(async () => {
    if (!enabledRef.current || !manualEnabled) return;

    cleanup();
    setConnectionState("discovering");

    // Fetch markets first
    const discovered = await fetchActiveMarkets();
    setMarkets(discovered);
    marketsRef.current = discovered;
    rebuildTokenMap(discovered);

    if (discovered.length === 0) {
      console.log("[CLOB WS] No markets found");
      setConnectionState("error");
      return;
    }

    // Collect all token IDs
    const tokenIds: string[] = [];
    for (const m of discovered) {
      if (m.upTokenId) tokenIds.push(m.upTokenId);
      if (m.downTokenId) tokenIds.push(m.downTokenId);
    }

    if (tokenIds.length === 0) {
      console.log("[CLOB WS] No token IDs");
      setConnectionState("error");
      return;
    }

    console.log(`[CLOB WS] Connecting to ${CLOB_WS_URL} with ${tokenIds.length} tokens...`);
    setConnectionState("connecting");

    const ws = new WebSocket(CLOB_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[CLOB WS] Connected!");
      setIsConnected(true);
      setConnectionState("connected");

      // Subscribe to all tokens
      subscribeToTokens(ws, tokenIds);

      // Keep-alive is handled by the server-side proxy (sends plain "PING").
    };

    ws.onmessage = handleWsMessage;

    ws.onerror = (err) => {
      console.error("[CLOB WS] Error:", err);
      setConnectionState("error");
    };

    ws.onclose = (event) => {
      console.log("[CLOB WS] Closed:", event.code, event.reason);
      setIsConnected(false);
      setConnectionState("disconnected");

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Reconnect after 3s if still enabled
      if (enabledRef.current && manualEnabled) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[CLOB WS] Reconnecting...");
          connectWs();
        }, 3000);
      }
    };

    // Refresh markets periodically
    marketRefreshIntervalRef.current = setInterval(async () => {
      if (!enabledRef.current || !manualEnabled) return;
      const refreshed = await fetchActiveMarkets();
      
      // Find new tokens to subscribe
      const existingTokens = new Set(tokenToMarketRef.current.keys());
      const newTokenIds: string[] = [];
      
      for (const m of refreshed) {
        if (m.upTokenId && !existingTokens.has(m.upTokenId)) {
          newTokenIds.push(m.upTokenId);
        }
        if (m.downTokenId && !existingTokens.has(m.downTokenId)) {
          newTokenIds.push(m.downTokenId);
        }
      }

      setMarkets(refreshed);
      marketsRef.current = refreshed;
      rebuildTokenMap(refreshed);

      // Subscribe to new tokens
      if (newTokenIds.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
        subscribeToTokens(wsRef.current, newTokenIds);
      }
    }, MARKET_REFRESH_INTERVAL_MS);
  }, [manualEnabled, cleanup, rebuildTokenMap, subscribeToTokens, handleWsMessage]);

  const disconnect = useCallback(() => {
    cleanup();
    setIsConnected(false);
    setConnectionState("disconnected");
  }, [cleanup]);

  // Main effect
  useEffect(() => {
    if (enabled && manualEnabled) {
      connectWs();
      return () => cleanup();
    }
    cleanup();
    return;
  }, [enabled, manualEnabled, connectWs, cleanup]);

  const getPrice = useCallback(
    (marketSlug: string, outcome: string) => {
      const market = pricesRef.current.get(marketSlug);
      if (!market) return null;
      const point = market.get(normalizeOutcome(outcome));
      if (!point) return null;

      const mid = midpoint(point.bestBid, point.bestAsk);
      return mid ?? point.price ?? null;
    },
    [pricesVersion],
  );

  const getOrderbook = useCallback(
    (marketSlug: string, outcome: string) => {
      const market = pricesRef.current.get(marketSlug);
      if (!market) return null;
      const point = market.get(normalizeOutcome(outcome));
      if (!point) return null;
      return { bid: point.bestBid, ask: point.bestAsk };
    },
    [pricesVersion],
  );

  const timeSinceLastUpdate = useMemo(() => Date.now() - lastUpdateTime, [lastUpdateTime, pricesVersion]);

  // Expiry saving
  useEffect(() => {
    const checkExpired = () => {
      const now = Date.now();
      for (const market of marketsRef.current) {
        const isExpired = market.eventEndTime.getTime() <= now;
        const alreadySaved = savedExpiredSlugsRef.current.has(market.slug);
        if (!isExpired || alreadySaved) continue;

        savedExpiredSlugsRef.current.add(market.slug);

        const upPrice = pricesRef.current.get(market.slug)?.get("up")?.price ?? null;
        const downPrice = pricesRef.current.get(market.slug)?.get("down")?.price ?? null;

        const closePrice = market.asset === "BTC" ? chainlinkPricesRef.current.btc : chainlinkPricesRef.current.eth;

        saveExpiredMarket(market, upPrice, downPrice, closePrice);

        setExpiredMarkets((prev) => {
          const exists = prev.some((m) => m.slug === market.slug);
          if (exists) return prev;

          const openPrice = market.openPrice ?? market.strikePrice;
          let result: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
          if (closePrice && openPrice) result = closePrice > openPrice ? "UP" : "DOWN";

          return [
            {
              slug: market.slug,
              asset: market.asset as "BTC" | "ETH",
              question: market.question,
              eventStartTime: market.eventStartTime,
              eventEndTime: market.eventEndTime,
              openPrice,
              strikePrice: openPrice,
              closePrice,
              upPriceAtClose: upPrice,
              downPriceAtClose: downPrice,
              result,
            },
            ...prev,
          ].slice(0, 50);
        });
      }
    };

    const interval = setInterval(checkExpired, 5_000);
    return () => clearInterval(interval);
  }, [markets]);

  return {
    markets,
    expiredMarkets,
    getPrice,
    getOrderbook,
    isConnected,
    connectionState,
    updateCount,
    lastUpdateTime,
    latencyMs,
    connect: () => setManualEnabled(true),
    disconnect: () => setManualEnabled(false),
    pricesVersion,
    timeSinceLastUpdate,
  };
}
