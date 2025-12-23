import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * True realtime pricing for Polymarket crypto markets via CLOB WebSocket.
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
  openPrice: number | null;     // The "Price to Beat" (oracle open price)
  strikePrice: number | null;   // Legacy alias for openPrice
}

export interface ExpiredMarket {
  slug: string;
  asset: "BTC" | "ETH";
  question: string;
  eventStartTime: Date;
  eventEndTime: Date;
  openPrice: number | null;      // The "Price to Beat" at market start
  strikePrice: number | null;    // Legacy alias
  closePrice: number | null;     // Settlement price at market end
  upPriceAtClose: number | null;
  downPriceAtClose: number | null;
  result: "UP" | "DOWN" | "UNKNOWN" | null;
}

interface UsePolymarketRealtimeResult {
  markets: MarketInfo[];
  expiredMarkets: ExpiredMarket[];
  getPrice: (marketSlug: string, outcome: string) => number | null;
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

const MARKET_TOKENS_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/get-market-tokens";
const CLOB_WS_PROXY_URL = "wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/clob-proxy";
const SAVE_EXPIRED_URL = "https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/save-expired-market";
const MARKET_REFRESH_INTERVAL_MS = 60000;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

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
      openPrice: m.openPrice ?? m.strikePrice ?? null,
      strikePrice: m.openPrice ?? m.strikePrice ?? null, // Legacy alias
    }));
    
    console.log("[Market Discovery] Found", markets.length, "markets");
    return markets;
    
  } catch (error) {
    console.error("[Market Discovery] Error:", error);
    return [];
  }
}

async function fetchExpiredMarketsFromDB(): Promise<ExpiredMarket[]> {
  console.log("[History] Fetching expired markets from database...");
  
  try {
    const { data, error } = await supabase
      .from('market_history')
      .select('*')
      .order('event_end_time', { ascending: false })
      .limit(50);
    
    if (error) {
      console.error("[History] Error fetching:", error);
      return [];
    }
    
    const expired: ExpiredMarket[] = (data || []).map((m: any) => ({
      slug: m.slug,
      asset: m.asset as "BTC" | "ETH",
      question: m.question || '',
      eventStartTime: new Date(m.event_start_time),
      eventEndTime: new Date(m.event_end_time),
      openPrice: m.open_price ?? m.strike_price ?? null,
      strikePrice: m.open_price ?? m.strike_price ?? null, // Legacy alias
      closePrice: m.close_price,
      upPriceAtClose: m.up_price_at_close,
      downPriceAtClose: m.down_price_at_close,
      result: m.result as "UP" | "DOWN" | "UNKNOWN" | null,
    }));
    
    console.log("[History] Loaded", expired.length, "expired markets");
    return expired;
    
  } catch (error) {
    console.error("[History] Error:", error);
    return [];
  }
}

async function saveExpiredMarket(
  market: MarketInfo, 
  upPrice: number | null, 
  downPrice: number | null,
  closePrice: number | null
): Promise<void> {
  console.log("[History] Saving expired market:", market.slug);
  
  try {
    await fetch(SAVE_EXPIRED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: market.slug,
        asset: market.asset,
        question: market.question,
        eventStartTime: market.eventStartTime.toISOString(),
        eventEndTime: market.eventEndTime.toISOString(),
        strikePrice: market.strikePrice,
        closePrice: closePrice,
        upPriceAtClose: upPrice,
        downPriceAtClose: downPrice,
        upTokenId: market.upTokenId,
        downTokenId: market.downTokenId,
      })
    });
    console.log("[History] Saved:", market.slug);
  } catch (error) {
    console.error("[History] Error saving:", error);
  }
}

export function usePolymarketRealtime(enabled: boolean = true): UsePolymarketRealtimeResult {
  // All state declarations at the top - stable order
  const [markets, setMarkets] = useState<MarketInfo[]>([]);
  const [expiredMarkets, setExpiredMarkets] = useState<ExpiredMarket[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);
  
  // STAP 1: pricesVersion state om UI re-renders te forceren
  const [pricesVersion, setPricesVersion] = useState(0);

  // All refs
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());
  const tokenToMarketRef = useRef<Map<string, { slug: string; outcome: "up" | "down" }>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const marketRefreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const marketsRef = useRef<MarketInfo[]>([]);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  const uiUpdateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPriceUpdateRef = useRef<number>(Date.now());
  const savedExpiredSlugsRef = useRef<Set<string>>(new Set());
  const chainlinkPricesRef = useRef<{ btc: number | null; eth: number | null }>({ btc: null, eth: null });
  
  // Keep enabledRef in sync
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  
  // Load expired markets from database on mount
  useEffect(() => {
    if (enabled) {
      fetchExpiredMarketsFromDB().then(expired => {
        setExpiredMarkets(expired);
        // Mark these slugs as already saved
        for (const m of expired) {
          savedExpiredSlugsRef.current.add(m.slug);
        }
      });
    }
  }, [enabled]);

  // Get midpoint price (average of bid and ask) - this is what Polymarket UI shows
  const getPrice = useCallback((marketSlug: string, outcome: string) => {
    const market = pricesRef.current.get(marketSlug);
    if (!market) {
      return null;
    }
    const normalizedOutcome = normalizeOutcome(outcome);
    const point = market.get(normalizedOutcome);
    if (!point) return null;
    
    // Calculate midpoint if we have both bid and ask
    if (point.bestBid !== null && point.bestAsk !== null) {
      return (point.bestBid + point.bestAsk) / 2;
    }
    // Fallback to ask or price if we don't have bid
    return point.bestAsk ?? point.price ?? null;
  }, [pricesVersion]); // Depend on pricesVersion to re-create when prices update

  const disconnect = useCallback(() => {
    console.log("[WS] Disconnecting...");
    
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
    
    if (uiUpdateIntervalRef.current) {
      clearInterval(uiUpdateIntervalRef.current);
      uiUpdateIntervalRef.current = null;
    }

    setIsConnected(false);
    setConnectionState("disconnected");
  }, []);

  const connect = useCallback(async () => {
    if (!enabledRef.current) return;
    
    // Discover markets first
    setConnectionState("discovering");
    const discovered = await fetchActiveMarkets();
    
    setMarkets(discovered);
    marketsRef.current = discovered;
    
    // Build token -> market mapping
    const tokenMapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
    for (const m of discovered) {
      if (m.upTokenId) {
        tokenMapping.set(m.upTokenId, { slug: m.slug, outcome: "up" });
        console.log(`[Token Map] ${m.upTokenId.slice(0,20)}... -> ${m.slug} UP`);
      }
      if (m.downTokenId) {
        tokenMapping.set(m.downTokenId, { slug: m.slug, outcome: "down" });
        console.log(`[Token Map] ${m.downTokenId.slice(0,20)}... -> ${m.slug} DOWN`);
      }
    }
    tokenToMarketRef.current = tokenMapping;
    
    if (discovered.length === 0) {
      console.log("[CLOB] No active markets found");
      setConnectionState("connected");
      setIsConnected(true);
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    console.log("[WS] Connecting to CLOB proxy...");
    setConnectionState("connecting");
    
    const ws = new WebSocket(CLOB_WS_PROXY_URL);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log("[WS] Connected to proxy");
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const now = Date.now();
        
        // Handle proxy status messages
        if (data.type === 'proxy_connected') {
          console.log("[WS] Proxy connected to CLOB, subscribing...");
          setIsConnected(true);
          setConnectionState("connected");
          
          // Subscribe to markets
          const tokenIds: string[] = [];
          for (const m of marketsRef.current) {
            if (m.upTokenId) tokenIds.push(m.upTokenId);
            if (m.downTokenId) tokenIds.push(m.downTokenId);
          }
          
          if (tokenIds.length > 0 && ws.readyState === WebSocket.OPEN) {
            const subscribeMsg = { type: "MARKET", assets_ids: tokenIds };
            console.log(`[WS] Subscribing to ${tokenIds.length} tokens`);
            ws.send(JSON.stringify(subscribeMsg));
          }
          return;
        }
        
        if (data.type === 'proxy_disconnected') {
          console.log("[WS] Proxy disconnected");
          setIsConnected(false);
          setConnectionState("disconnected");
          return;
        }
        
        if (data.type === 'proxy_error') {
          console.error("[WS] Proxy error:", data.error);
          setConnectionState("error");
          return;
        }
        
        // STAP 2: Process price_change events als primaire bron
        if (data.event_type === 'price_change' && Array.isArray(data.price_changes)) {
          let updatedAny = false;
          
          for (const change of data.price_changes) {
            const tokenId = change.asset_id;
            const marketInfo = tokenToMarketRef.current.get(tokenId);
            
            if (marketInfo) {
              const price = parseFloat(change.price);
              
              let marketMap = pricesRef.current.get(marketInfo.slug);
              if (!marketMap) {
                marketMap = new Map();
                pricesRef.current.set(marketInfo.slug, marketMap);
              }
              
              // Preserve existing bid if we have one
              const existing = marketMap.get(marketInfo.outcome);
              const existingBid = existing?.bestBid ?? null;
              
              const pricePoint: PricePoint = {
                price,
                bestAsk: price,
                bestBid: existingBid, // Keep existing bid for midpoint calc
                timestampMs: now,
              };
              
              marketMap.set(marketInfo.outcome, pricePoint);
              if (marketInfo.outcome === "up") marketMap.set("yes", pricePoint);
              if (marketInfo.outcome === "down") marketMap.set("no", pricePoint);
              
              updatedAny = true;
              lastPriceUpdateRef.current = now;
            }
          }
          
          if (updatedAny) {
            // Throttle UI updates to max 5 per second for balance between real-time and stability
            const timeSinceLastUIUpdate = now - lastUpdateTime;
            if (timeSinceLastUIUpdate >= 200) {
              setPricesVersion(v => v + 1);
              setUpdateCount(c => c + 1);
              setLastUpdateTime(now);
              setLatencyMs(Date.now() - now);
            }
          }
        }
        
        // Also process book events (backup) - with robust parsing to avoid NaN
        if (data.event_type === 'book' && data.asset_id) {
          const tokenId = data.asset_id;
          const marketInfo = tokenToMarketRef.current.get(tokenId);
          
          if (marketInfo) {
            // Robust parsing: check that asks/bids are arrays of arrays
            const rawAsks = Array.isArray(data.asks) ? data.asks : [];
            const rawBids = Array.isArray(data.bids) ? data.bids : [];
            
            // Parse best ask/bid with validation
            let bestAsk: number | null = null;
            let bestBid: number | null = null;
            
            if (rawAsks.length > 0 && Array.isArray(rawAsks[0]) && rawAsks[0].length > 0) {
              const parsed = parseFloat(rawAsks[0][0]);
              if (!isNaN(parsed) && parsed > 0) {
                bestAsk = parsed;
              }
            }
            
            if (rawBids.length > 0 && Array.isArray(rawBids[0]) && rawBids[0].length > 0) {
              const parsed = parseFloat(rawBids[0][0]);
              if (!isNaN(parsed) && parsed > 0) {
                bestBid = parsed;
              }
            }
            
            // Only update if we have valid data (not NaN)
            if (bestAsk !== null || bestBid !== null) {
              console.log(`[BOOK] ${marketInfo.slug} ${marketInfo.outcome}: ask=${bestAsk} bid=${bestBid}`);
              
              let marketMap = pricesRef.current.get(marketInfo.slug);
              if (!marketMap) {
                marketMap = new Map();
                pricesRef.current.set(marketInfo.slug, marketMap);
              }
              
              const pricePoint: PricePoint = {
                price: bestAsk ?? bestBid ?? 0.5,
                bestAsk,
                bestBid,
                timestampMs: now,
              };
              
              marketMap.set(marketInfo.outcome, pricePoint);
              if (marketInfo.outcome === "up") marketMap.set("yes", pricePoint);
              if (marketInfo.outcome === "down") marketMap.set("no", pricePoint);
              
              setPricesVersion(v => v + 1);
              setUpdateCount(c => c + 1);
              setLastUpdateTime(now);
              lastPriceUpdateRef.current = now;
            }
          }
        }
        
        // Handle last_trade_price events too
        if (data.event_type === 'last_trade_price' && Array.isArray(data.price_changes)) {
          for (const change of data.price_changes) {
            const tokenId = change.asset_id;
            const marketInfo = tokenToMarketRef.current.get(tokenId);
            
            if (marketInfo) {
              const price = parseFloat(change.price);
              console.log(`[TRADE] ${marketInfo.slug} ${marketInfo.outcome}: ${(price * 100).toFixed(1)}¢`);
              
              let marketMap = pricesRef.current.get(marketInfo.slug);
              if (!marketMap) {
                marketMap = new Map();
                pricesRef.current.set(marketInfo.slug, marketMap);
              }
              
              // Only update if we don't have a price yet
              const existing = marketMap.get(marketInfo.outcome);
              if (!existing || (now - existing.timestampMs) > 5000) {
                const pricePoint: PricePoint = {
                  price,
                  bestAsk: price,
                  bestBid: null,
                  timestampMs: now,
                };
                
                marketMap.set(marketInfo.outcome, pricePoint);
                if (marketInfo.outcome === "up") marketMap.set("yes", pricePoint);
                if (marketInfo.outcome === "down") marketMap.set("no", pricePoint);
                
                setPricesVersion(v => v + 1);
                lastPriceUpdateRef.current = now;
              }
            }
          }
        }
        
      } catch {
        // Non-JSON message (like PONG)
      }
    };
    
    ws.onerror = (error) => {
      console.error("[WS] Error:", error);
      setConnectionState("error");
    };
    
    ws.onclose = (event) => {
      console.log("[WS] Closed:", event.code);
      setIsConnected(false);
      setConnectionState("disconnected");
      wsRef.current = null;
      
      // Reconnect after 3 seconds if still enabled
      if (enabledRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[WS] Reconnecting...");
          connect();
        }, 3000);
      }
    };
    
    // STAP 3: Timer voor smooth UI updates (elke 100ms)
    if (uiUpdateIntervalRef.current) {
      clearInterval(uiUpdateIntervalRef.current);
    }
    uiUpdateIntervalRef.current = setInterval(() => {
      // Force UI update als er recente prijswijzigingen zijn
      const timeSinceUpdate = Date.now() - lastPriceUpdateRef.current;
      if (timeSinceUpdate < 500) {
        setPricesVersion(v => v + 1);
      }
    }, 100);
    
    // Set up market refresh interval
    if (marketRefreshIntervalRef.current) {
      clearInterval(marketRefreshIntervalRef.current);
    }
    marketRefreshIntervalRef.current = setInterval(async () => {
      console.log("[Market Discovery] Refreshing...");
      const refreshed = await fetchActiveMarkets();
      setMarkets(refreshed);
      marketsRef.current = refreshed;
      
      const newMapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
      for (const m of refreshed) {
        if (m.upTokenId) newMapping.set(m.upTokenId, { slug: m.slug, outcome: "up" });
        if (m.downTokenId) newMapping.set(m.downTokenId, { slug: m.slug, outcome: "down" });
      }
      tokenToMarketRef.current = newMapping;
    }, MARKET_REFRESH_INTERVAL_MS);
    
  }, []);

  // Main effect - connect on mount
  useEffect(() => {
    if (enabled) {
      connect();
    }
    
    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  // STAP 5: Calculate time since last update for debugging
  const timeSinceLastUpdate = Date.now() - lastUpdateTime;
  
  // Check for expired markets and save them
  useEffect(() => {
    const checkExpired = () => {
      const now = Date.now();
      for (const market of marketsRef.current) {
        const isExpired = market.eventEndTime.getTime() <= now;
        const alreadySaved = savedExpiredSlugsRef.current.has(market.slug);
        
        if (isExpired && !alreadySaved) {
          console.log("[Expiry] Market expired:", market.slug);
          savedExpiredSlugsRef.current.add(market.slug);
          
          // Get final prices
          const upPrice = pricesRef.current.get(market.slug)?.get("up")?.price ?? null;
          const downPrice = pricesRef.current.get(market.slug)?.get("down")?.price ?? null;
          
          // Get close price from chainlink (would need to be passed in)
          const closePrice = market.asset === 'BTC' 
            ? chainlinkPricesRef.current.btc 
            : chainlinkPricesRef.current.eth;
          
          // Save to database
          saveExpiredMarket(market, upPrice, downPrice, closePrice);
          
          // Add to local expired list
          setExpiredMarkets(prev => {
            const exists = prev.some(m => m.slug === market.slug);
            if (exists) return prev;
            
            const openPrice = market.openPrice ?? market.strikePrice;
            let result: "UP" | "DOWN" | "UNKNOWN" = "UNKNOWN";
            if (closePrice && openPrice) {
              result = closePrice > openPrice ? "UP" : "DOWN";
            }
            
            return [{
              slug: market.slug,
              asset: market.asset as "BTC" | "ETH",
              question: market.question,
              eventStartTime: market.eventStartTime,
              eventEndTime: market.eventEndTime,
              openPrice,
              strikePrice: openPrice, // Legacy alias
              closePrice,
              upPriceAtClose: upPrice,
              downPriceAtClose: downPrice,
              result,
            }, ...prev].slice(0, 50);
          });
        }
      }
    };
    
    const interval = setInterval(checkExpired, 5000);
    return () => clearInterval(interval);
  }, [markets]);
  
  // Method to update chainlink prices from outside
  const updateChainlinkPrices = useCallback((btc: number | null, eth: number | null) => {
    chainlinkPricesRef.current = { btc, eth };
  }, []);

  return {
    markets,
    expiredMarkets,
    getPrice,
    isConnected,
    connectionState,
    updateCount,
    lastUpdateTime,
    latencyMs,
    connect,
    disconnect,
    pricesVersion,
    timeSinceLastUpdate,
  };
}
