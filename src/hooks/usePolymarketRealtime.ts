import { useCallback, useEffect, useRef, useState } from "react";

/**
 * True realtime pricing for Polymarket crypto markets via CLOB WebSocket.
 *
 * 1. Fetches active crypto markets from our edge function
 * 2. Connects to CLOB WebSocket via our proxy
 * 3. Subscribes with asset_ids (clobTokenIds)
 * 4. Parses orderbook data: asks[0][0] = best ask price
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
const CLOB_WS_PROXY_URL = "wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/clob-proxy";

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
    
    console.log("[Market Discovery] Found", markets.length, "markets with tokens");
    markets.forEach(m => {
      console.log(`  - ${m.slug}: UP=${m.upTokenId?.slice(0, 20)}... DOWN=${m.downTokenId?.slice(0, 20)}...`);
    });
    
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

  // Map token ID -> { slug, outcome }
  const tokenToMarketRef = useRef<Map<string, { slug: string; outcome: "up" | "down" }>>(new Map());
  // Map conditionId -> slug
  const conditionToSlugRef = useRef<Map<string, string>>(new Map());

  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const marketRefreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const marketsRef = useRef<MarketInfo[]>([]);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const disconnect = useCallback(() => {
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

    setIsConnected(false);
    setConnectionState("disconnected");
  }, []);

  const processOrderbookMessage = useCallback((data: any) => {
    // Handle different message formats from CLOB WebSocket
    // Format 1: { event_type: "book", asset_id, bids, asks }
    // Format 2: { event_type: "price_change", price_changes: [...] }
    
    const now = Date.now();
    
    if (data.event_type === 'book' && data.asset_id) {
      const tokenId = data.asset_id;
      const marketInfo = tokenToMarketRef.current.get(tokenId);
      
      if (!marketInfo) {
        console.log(`[WS] Unknown token: ${tokenId.slice(0, 20)}...`);
        return;
      }
      
      // Extract best ask: asks[0][0]
      const asks = data.asks || [];
      const bids = data.bids || [];
      
      const bestAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
      const bestBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;
      
      console.log(`[WS] Book update ${marketInfo.outcome.toUpperCase()}: bestAsk=${bestAsk}, bestBid=${bestBid}`);
      
      const pricePoint: PricePoint = {
        price: bestAsk ?? bestBid ?? 0.5,
        bestAsk,
        bestBid,
        timestampMs: now,
      };
      
      let marketMap = pricesRef.current.get(marketInfo.slug);
      if (!marketMap) {
        marketMap = new Map();
        pricesRef.current.set(marketInfo.slug, marketMap);
      }
      
      marketMap.set(marketInfo.outcome, pricePoint);
      if (marketInfo.outcome === "up") marketMap.set("yes", pricePoint);
      if (marketInfo.outcome === "down") marketMap.set("no", pricePoint);
      
      updateCountRef.current++;
      lastUpdateTimeRef.current = now;
      setUpdateCount(updateCountRef.current);
      setLastUpdateTime(now);
      
    } else if (data.event_type === 'price_change' && Array.isArray(data.price_changes)) {
      for (const change of data.price_changes) {
        const tokenId = change.asset_id;
        const marketInfo = tokenToMarketRef.current.get(tokenId);
        
        if (!marketInfo) continue;
        
        const price = parseFloat(change.price);
        console.log(`[WS] Price change ${marketInfo.outcome.toUpperCase()}: ${price}`);
        
        let marketMap = pricesRef.current.get(marketInfo.slug);
        if (!marketMap) {
          marketMap = new Map();
          pricesRef.current.set(marketInfo.slug, marketMap);
        }
        
        const existing = marketMap.get(marketInfo.outcome);
        const pricePoint: PricePoint = {
          price,
          bestAsk: price,
          bestBid: existing?.bestBid ?? null,
          timestampMs: now,
        };
        
        marketMap.set(marketInfo.outcome, pricePoint);
        if (marketInfo.outcome === "up") marketMap.set("yes", pricePoint);
        if (marketInfo.outcome === "down") marketMap.set("no", pricePoint);
        
        updateCountRef.current++;
        lastUpdateTimeRef.current = now;
      }
      
      setUpdateCount(updateCountRef.current);
      setLastUpdateTime(now);
    }
    
    setLatencyMs(Date.now() - now);
  }, []);

  const subscribeToMarkets = useCallback((ws: WebSocket) => {
    const currentMarkets = marketsRef.current;
    if (currentMarkets.length === 0) return;
    
    // Collect all token IDs
    const tokenIds: string[] = [];
    for (const m of currentMarkets) {
      if (m.upTokenId) tokenIds.push(m.upTokenId);
      if (m.downTokenId) tokenIds.push(m.downTokenId);
    }
    
    if (tokenIds.length === 0) return;
    
    // Subscribe to MARKET channel with asset_ids
    const subscribeMsg = {
      type: "MARKET",
      assets_ids: tokenIds
    };
    
    console.log(`[WS] Subscribing to ${tokenIds.length} tokens...`);
    console.log(`[WS] Subscribe payload:`, JSON.stringify(subscribeMsg).slice(0, 200));
    
    ws.send(JSON.stringify(subscribeMsg));
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
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
        
        // Handle proxy status messages
        if (data.type === 'proxy_connected') {
          console.log("[WS] Proxy connected to CLOB");
          setIsConnected(true);
          setConnectionState("connected");
          subscribeToMarkets(ws);
          return;
        }
        
        if (data.type === 'proxy_disconnected') {
          console.log("[WS] Proxy disconnected from CLOB");
          setIsConnected(false);
          setConnectionState("disconnected");
          return;
        }
        
        if (data.type === 'proxy_error') {
          console.error("[WS] Proxy error:", data.error);
          setConnectionState("error");
          return;
        }
        
        // Process orderbook/price data
        processOrderbookMessage(data);
        
      } catch (e) {
        // Non-JSON message (like PONG)
      }
    };
    
    ws.onerror = (error) => {
      console.error("[WS] Error:", error);
      setConnectionState("error");
    };
    
    ws.onclose = (event) => {
      console.log("[WS] Closed:", event.code, event.reason);
      setIsConnected(false);
      setConnectionState("disconnected");
      wsRef.current = null;
      
      // Reconnect after 3 seconds if still enabled
      if (enabled) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log("[WS] Reconnecting...");
          connectWebSocket();
        }, 3000);
      }
    };
  }, [enabled, subscribeToMarkets, processOrderbookMessage]);

  const discoverMarkets = useCallback(async () => {
    setConnectionState("discovering");
    
    const discovered = await fetchActiveMarkets();
    setMarkets(discovered);
    marketsRef.current = discovered;
    
    // Build token -> market mapping
    const tokenMapping = new Map<string, { slug: string; outcome: "up" | "down" }>();
    const conditionMapping = new Map<string, string>();
    
    for (const m of discovered) {
      if (m.upTokenId) tokenMapping.set(m.upTokenId, { slug: m.slug, outcome: "up" });
      if (m.downTokenId) tokenMapping.set(m.downTokenId, { slug: m.slug, outcome: "down" });
      if (m.conditionId) conditionMapping.set(m.conditionId, m.slug);
    }
    
    tokenToMarketRef.current = tokenMapping;
    conditionToSlugRef.current = conditionMapping;
    
    console.log(`[Discovery] Mapped ${tokenMapping.size} tokens to ${discovered.length} markets`);
    
    return discovered;
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

    // Connect to WebSocket
    connectWebSocket();
    
    // Set up market refresh interval
    if (!marketRefreshIntervalRef.current) {
      marketRefreshIntervalRef.current = setInterval(async () => {
        console.log("[Market Discovery] Refreshing...");
        await discoverMarkets();
        
        // Re-subscribe with new tokens
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          subscribeToMarkets(wsRef.current);
        }
      }, MARKET_REFRESH_INTERVAL_MS);
    }
  }, [enabled, discoverMarkets, connectWebSocket, subscribeToMarkets]);

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
