import { useCallback, useEffect, useRef, useState } from "react";

/**
 * True realtime pricing for Polymarket crypto markets.
 *
 * 1. Fetches active crypto markets from our edge function (avoids CORS)
 * 2. Extracts clobTokenIds (Yes/No token IDs)
 * 3. Polls CLOB REST API for prices (with WebSocket as enhancement when available)
 */

type ConnectionState = "disconnected" | "connecting" | "connected" | "discovering" | "error";

interface PricePoint {
  price: number;
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

const MARKET_TOKENS_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/get-market-tokens";
const CLOB_PRICES_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/clob-prices";

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
const MARKET_REFRESH_INTERVAL_MS = 60000;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

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

/**
 * Fetch prices from CLOB REST API
 */
async function fetchClobPrices(tokenIds: string[]): Promise<Map<string, PricePoint>> {
  const prices = new Map<string, PricePoint>();
  
  if (tokenIds.length === 0) return prices;
  
  try {
    const response = await fetch(CLOB_PRICES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenIds })
    });
    
    if (!response.ok) {
      console.error("[CLOB Prices] Fetch error:", response.status);
      return prices;
    }
    
    const data = await response.json();
    
    if (!data.success || !data.prices) {
      return prices;
    }
    
    const now = Date.now();
    for (const [tokenId, priceData] of Object.entries(data.prices)) {
      const p = priceData as any;
      prices.set(tokenId, {
        price: p.price ?? p.bestAsk ?? 0.5,
        bestAsk: p.bestAsk,
        bestBid: p.bestBid,
        timestampMs: p.timestamp || now,
      });
    }
    
    console.log("[CLOB Prices] Fetched", prices.size, "prices");
    
  } catch (error) {
    console.error("[CLOB Prices] Error:", error);
  }
  
  return prices;
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

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const marketRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const marketsRef = useRef<MarketInfo[]>([]);

  const disconnect = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    
    if (marketRefreshIntervalRef.current) {
      clearInterval(marketRefreshIntervalRef.current);
      marketRefreshIntervalRef.current = null;
    }

    setIsConnected(false);
    setConnectionState("disconnected");
  }, []);

  const discoverMarkets = useCallback(async () => {
    setConnectionState("discovering");
    
    const discovered = await fetchActiveMarkets();
    setMarkets(discovered);
    marketsRef.current = discovered;
    
    const mapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
    for (const m of discovered) {
      mapping.set(m.upTokenId, { slug: m.slug, outcome: "up" });
      mapping.set(m.downTokenId, { slug: m.slug, outcome: "down" });
    }
    tokenToMarketRef.current = mapping;
    
    return discovered;
  }, []);

  const pollPrices = useCallback(async () => {
    const currentMarkets = marketsRef.current;
    if (currentMarkets.length === 0) return;
    
    const tokenIds = currentMarkets.flatMap(m => [m.upTokenId, m.downTokenId]);
    const fetchedPrices = await fetchClobPrices(tokenIds);
    
    if (fetchedPrices.size === 0) return;
    
    const now = Date.now();
    
    for (const [tokenId, pricePoint] of fetchedPrices) {
      const marketInfo = tokenToMarketRef.current.get(tokenId);
      if (!marketInfo) continue;
      
      let marketMap = pricesRef.current.get(marketInfo.slug);
      if (!marketMap) {
        marketMap = new Map();
        pricesRef.current.set(marketInfo.slug, marketMap);
      }
      
      const key = marketInfo.outcome;
      marketMap.set(key, pricePoint);
      
      // Also set yes/no aliases
      if (key === "up") marketMap.set("yes", pricePoint);
      if (key === "down") marketMap.set("no", pricePoint);
      
      updateCountRef.current++;
      lastUpdateTimeRef.current = now;
    }
    
    // Update UI state
    setUpdateCount(updateCountRef.current);
    setLastUpdateTime(lastUpdateTimeRef.current);
    setLatencyMs(Date.now() - lastUpdateTimeRef.current);
    
  }, []);

  const connect = useCallback(async () => {
    if (!enabled) return;

    const discovered = await discoverMarkets();
    
    if (discovered.length === 0) {
      console.log("[CLOB] No active markets found");
      setConnectionState("connected");
      setIsConnected(true);
      return;
    }

    // Start polling
    setConnectionState("connecting");
    
    // Initial fetch
    await pollPrices();
    
    setIsConnected(true);
    setConnectionState("connected");
    
    // Set up polling interval
    if (!pollIntervalRef.current) {
      pollIntervalRef.current = setInterval(pollPrices, POLL_INTERVAL_MS);
    }
    
    // Set up market refresh interval
    if (!marketRefreshIntervalRef.current) {
      marketRefreshIntervalRef.current = setInterval(async () => {
        console.log("[Market Discovery] Refreshing...");
        await discoverMarkets();
      }, MARKET_REFRESH_INTERVAL_MS);
    }
  }, [enabled, discoverMarkets, pollPrices]);

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
    const point = market.get(normalizeOutcome(outcome));
    return point?.bestAsk ?? point?.price ?? null;
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
