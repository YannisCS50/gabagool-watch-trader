import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Rebuilt: reliable top-of-book (bid/ask) + mid (market) pricing using backend polling.
 * No WebSocket dependency.
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "discovering" | "error";

interface PricePoint {
  price: number | null; // mid/last fallback
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
const CLOB_PRICES_URL = `${FUNCTIONS_BASE_URL}/clob-prices`;
const SAVE_EXPIRED_URL = `${FUNCTIONS_BASE_URL}/save-expired-market`;

const MARKET_REFRESH_INTERVAL_MS = 60_000;
const PRICES_POLL_INTERVAL_MS = 1_000;

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

  const pricesPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marketRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const stopIntervals = useCallback(() => {
    if (pricesPollIntervalRef.current) {
      clearInterval(pricesPollIntervalRef.current);
      pricesPollIntervalRef.current = null;
    }
    if (marketRefreshIntervalRef.current) {
      clearInterval(marketRefreshIntervalRef.current);
      marketRefreshIntervalRef.current = null;
    }
  }, []);

  const pollPricesOnce = useCallback(async () => {
    const tokenIds: string[] = [];
    for (const m of marketsRef.current) {
      if (m.upTokenId) tokenIds.push(String(m.upTokenId));
      if (m.downTokenId) tokenIds.push(String(m.downTokenId));
    }
    const uniqueTokenIds = Array.from(new Set(tokenIds));
    if (uniqueTokenIds.length === 0) return { ok: true, updatedAny: false, latency: 0 };

    const started = performance.now();
    const res = await fetch(CLOB_PRICES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenIds: uniqueTokenIds }),
    });
    const ended = performance.now();

    if (!res.ok) return { ok: false, updatedAny: false, latency: Math.round(ended - started) };

    const json = await res.json();
    const prices: Record<string, any> = json?.prices || {};

    const now = Date.now();
    let updatedAny = false;

    for (const [tokenId, raw] of Object.entries(prices)) {
      const marketInfo = tokenToMarketRef.current.get(String(tokenId));
      if (!marketInfo) continue;

      const bestAsk = typeof raw?.bestAsk === "number" ? raw.bestAsk : null;
      const bestBid = typeof raw?.bestBid === "number" ? raw.bestBid : null;
      const price = typeof raw?.price === "number" ? raw.price : null;

      if (bestAsk === null && bestBid === null && price === null) continue;

      let marketMap = pricesRef.current.get(marketInfo.slug);
      if (!marketMap) {
        marketMap = new Map();
        pricesRef.current.set(marketInfo.slug, marketMap);
      }

      const point: PricePoint = {
        price: price ?? midpoint(bestBid, bestAsk),
        bestAsk,
        bestBid,
        timestampMs: now,
      };

      marketMap.set(marketInfo.outcome, point);
      if (marketInfo.outcome === "up") marketMap.set("yes", point);
      if (marketInfo.outcome === "down") marketMap.set("no", point);

      updatedAny = true;
    }

    if (updatedAny) {
      setPricesVersion((v) => v + 1);
      setUpdateCount((c) => c + 1);
      setLastUpdateTime(now);
    }

    return { ok: true, updatedAny, latency: Math.round(ended - started) };
  }, []);

  const connect = useCallback(async () => {
    if (!enabledRef.current || !manualEnabled) return;

    setConnectionState("discovering");
    const discovered = await fetchActiveMarkets();

    setMarkets(discovered);
    marketsRef.current = discovered;
    rebuildTokenMap(discovered);

    setConnectionState("connecting");

    // Prime one poll (so we can show "connected" immediately after first success)
    try {
      const first = await pollPricesOnce();
      setLatencyMs(first.latency);
      setIsConnected(first.ok);
      setConnectionState(first.ok ? "connected" : "error");
    } catch {
      setIsConnected(false);
      setConnectionState("error");
    }

    stopIntervals();

    pricesPollIntervalRef.current = setInterval(async () => {
      if (!enabledRef.current || !manualEnabled) return;
      try {
        const r = await pollPricesOnce();
        setLatencyMs(r.latency);
        if (!r.ok) {
          setIsConnected(false);
          setConnectionState("error");
        } else {
          setIsConnected(true);
          setConnectionState("connected");
        }
      } catch {
        setIsConnected(false);
        setConnectionState("error");
      }
    }, PRICES_POLL_INTERVAL_MS);

    marketRefreshIntervalRef.current = setInterval(async () => {
      if (!enabledRef.current || !manualEnabled) return;
      const refreshed = await fetchActiveMarkets();
      setMarkets(refreshed);
      marketsRef.current = refreshed;
      rebuildTokenMap(refreshed);
    }, MARKET_REFRESH_INTERVAL_MS);
  }, [manualEnabled, pollPricesOnce, rebuildTokenMap, stopIntervals]);

  const disconnect = useCallback(() => {
    stopIntervals();
    setIsConnected(false);
    setConnectionState("disconnected");
  }, [stopIntervals]);

  // Main effect
  useEffect(() => {
    if (enabled && manualEnabled) {
      connect();
      return () => disconnect();
    }
    disconnect();
    return;
  }, [enabled, manualEnabled, connect, disconnect]);

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

  // Expiry saving (unchanged behavior)
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
