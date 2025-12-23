import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * True realtime Up/Down pricing for Polymarket markets.
 *
 * For arbitrage you want the *cost to buy now*, so we track best ASK (top of book)
 * per outcome token via Polymarket CLOB market websocket (proxied server-side).
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

const CLOB_PROXY_WS_URL = "wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/clob-proxy";

const RECONNECT_DELAY_MS = 1500;
const MAX_RECONNECT_ATTEMPTS = 10;
const UI_SYNC_INTERVAL_MS = 75;

const normalizeOutcome = (o: string) => o.trim().toLowerCase();

function parseNumber(n: unknown): number | null {
  const v = typeof n === "number" ? n : typeof n === "string" ? Number(n) : NaN;
  return Number.isFinite(v) ? v : null;
}

function inferUpDownTokenIds(outcomes: unknown, tokenIds: unknown): { up: string; down: string } | null {
  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) return null;
  if (tokenIds.length < 2) return null;

  const o0 = String(outcomes[0] ?? "").toLowerCase();
  const id0 = String(tokenIds[0] ?? "");
  const id1 = String(tokenIds[1] ?? "");

  const o0IsDown = o0.includes("no") || o0.includes("down");
  return o0IsDown ? { up: id1, down: id0 } : { up: id0, down: id1 };
}

async function fetchSlugTokenIds(slug: string) {
  const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
  if (!r.ok) return null;
  const markets = await r.json();
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const m = markets[0] as any;
  // Polymarket markets often expose these
  const tokenIds = m.clobTokenIds ?? m.clob_token_ids ?? null;
  const outcomes = m.outcomes ?? null;

  const inferred = inferUpDownTokenIds(outcomes, tokenIds);
  if (!inferred) return null;

  return {
    upTokenId: inferred.up,
    downTokenId: inferred.down,
  };
}

export function usePolymarketRealtime(
  marketSlugs: string[],
  enabled: boolean = true,
): UsePolymarketRealtimeResult {
  // Map: marketSlug -> outcome -> price
  const pricesRef = useRef<Map<string, Map<string, PricePoint>>>(new Map());
  const updateCountRef = useRef(0);
  const lastUpdateTimeRef = useRef(Date.now());

  // Token mapping (tokenId -> { slug, outcome })
  const tokenToMarketRef = useRef<Map<string, { slug: string; outcome: "up" | "down" }>>(new Map());
  const tokenCacheRef = useRef<Map<string, { upTokenId: string; downTokenId: string }>>(new Map());

  const [tokenIds, setTokenIds] = useState<string[]>([]);

  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [updateCount, setUpdateCount] = useState(0);
  const [lastUpdateTime, setLastUpdateTime] = useState(Date.now());
  const [latencyMs, setLatencyMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const uiSyncIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const slugsKey = useMemo(() => marketSlugs.slice().sort().join(","), [marketSlugs]);

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

  // Fetch token IDs for current slugs (fast, parallel, cached)
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!enabled || marketSlugs.length === 0) {
        setTokenIds([]);
        return;
      }

      const missing = marketSlugs.filter((s) => !tokenCacheRef.current.has(s));
      if (missing.length > 0) {
        const results = await Promise.all(
          missing.map(async (slug) => {
            try {
              const t = await fetchSlugTokenIds(slug);
              return { slug, tokens: t };
            } catch {
              return { slug, tokens: null };
            }
          }),
        );

        for (const r of results) {
          if (r.tokens) tokenCacheRef.current.set(r.slug, r.tokens);
        }
      }

      // Build tokenId list + reverse mapping
      const nextTokenToMarket = new Map<string, { slug: string; outcome: "up" | "down" }>();
      const nextTokenIds: string[] = [];

      for (const slug of marketSlugs) {
        const t = tokenCacheRef.current.get(slug);
        if (!t) continue;

        nextTokenToMarket.set(t.upTokenId, { slug, outcome: "up" });
        nextTokenToMarket.set(t.downTokenId, { slug, outcome: "down" });
        nextTokenIds.push(t.upTokenId, t.downTokenId);
      }

      if (!cancelled) {
        tokenToMarketRef.current = nextTokenToMarket;
        setTokenIds(nextTokenIds);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [enabled, slugsKey]);

  const connect = useCallback(() => {
    if (!enabled) return;
    if (tokenIds.length === 0) return;

    setConnectionState("connecting");

    try {
      const ws = new WebSocket(CLOB_PROXY_WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event) => {
        const now = Date.now();

        // Proxy control messages
        try {
          const msg = JSON.parse(event.data);

          if (msg?.type === "proxy_connected") {
            setIsConnected(true);
            setConnectionState("connected");

            // Initial subscription (CLOB market channel)
            ws.send(
              JSON.stringify({
                type: "market",
                assets_ids: tokenIds,
              }),
            );

            startUiSync();
            return;
          }

          if (msg?.type === "proxy_error" || msg?.type === "proxy_disconnected") {
            setIsConnected(false);
            setConnectionState("error");
            return;
          }

          // CLOB messages
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
              // outcome aliases
              if (key === "up") marketMap.set("yes", { price: bestAsk, timestampMs: ts });
              if (key === "down") marketMap.set("no", { price: bestAsk, timestampMs: ts });

              updateCountRef.current++;
              lastUpdateTimeRef.current = ts;
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
            return;
          }
        } catch {
          // non-JSON (e.g. PONG) -> ignore
        }
      };

      ws.onerror = () => {
        setConnectionState("error");
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        stopUiSync();

        if (!enabled) return;

        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttemptsRef.current++;
          reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        } else {
          setConnectionState("error");
        }
      };
    } catch {
      setConnectionState("error");
    }
  }, [enabled, tokenIds, startUiSync, stopUiSync]);

  // (Re)connect when token set changes
  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }

    if (tokenIds.length === 0) {
      disconnect();
      return;
    }

    disconnect();
    connect();
  }, [enabled, tokenIds.join(","), connect, disconnect]);

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
