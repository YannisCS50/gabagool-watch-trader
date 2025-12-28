import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// LIVE TRADING BOT - Real-time WebSocket Worker (Event-Driven)
// Connects to Polymarket CLOB WebSocket and reacts to price changes
// SIGNALS ONLY - Orders go to order_queue for local-runner to execute
// (Edge functions get blocked by Cloudflare, so we queue orders instead)
// ============================================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Outcome = "UP" | "DOWN";

interface TopOfBook {
  up: { bid: number | null; ask: number | null; isFromRealBook: boolean };
  down: { bid: number | null; ask: number | null; isFromRealBook: boolean };
  updatedAtMs: number;
}

interface MarketPosition {
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
}

interface MarketContext {
  slug: string;
  remainingSeconds: number;
  book: TopOfBook;
  position: MarketPosition;
  lastTradeAtMs: number;
  lastDecisionKey?: string | null;
  inFlight?: boolean;
  strikePrice?: number | null;  // Cached strike price for endgame logic
  evidentSide?: Outcome | null; // Which side is likely to win
}

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

// Strategy config - CONSERVATIVE for live trading (smaller than paper)
// POLYMARKET RATE LIMITS: Respect exchange rules to avoid bans
const STRATEGY = {
  opening: {
    notional: 5,          // $5 initial trade
    maxPrice: 0.52,        // Only enter if price <= 52¢
  },
  hedge: {
    triggerCombined: 0.98, // Hedge when combined < 98¢
    notional: 5,           // $5 per hedge
    cushionTicks: 3,       // Extra ticks above ask for guaranteed fill
    tickSize: 0.01,        // 1¢ tick size
    forceTimeoutSec: 45,   // Force hedge after 45s if still one-sided
    maxPrice: 0.65,        // Max price for hedge (to prevent overpaying)
  },
  accumulate: {
    triggerCombined: 0.97, // Accumulate when combined < 97¢
    notional: 5,           // $5 per accumulate
  },
  limits: {
    maxSharesPerSide: 100,  // Max 100 shares per side
    maxTotalInvested: 50,   // Max $50 total per market
  },
  entry: {
    minSecondsRemaining: 60,
    minPrice: 0.03,
    maxPrice: 0.92,
    maxPriceEndgame: 0.97, // Extended max price in last 3 min when side is evident
    staleBookMs: 2000,
  },
  // Endgame mode: last 3 min + evident side = relaxed limits
  endgame: {
    triggerSeconds: 180,      // Last 3 minutes
    skipHedgeThresholdUsd: 120, // $120 distance from strike = evident
    maxPrice: 0.97,           // Allow buying up to 97¢ in endgame
  },
  cooldownMs: 15000,       // 15s cooldown between trades per market (Polymarket-friendly)
  dedupeWindowMs: 10000,   // 10s dedupe window
  globalCooldownMs: 5000,  // 5s global cooldown between ANY orders
};

// Helper functions
function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function makeDecisionKey(slug: string, up: number, down: number, combined: number, nowMs: number): string {
  const bucket = Math.floor(nowMs / STRATEGY.dedupeWindowMs);
  const r = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
  return `${slug}|${bucket}|u=${r(up)}|d=${r(down)}|c=${r(combined)}`;
}

function calcShares(notional: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(notional / price);
}

// Check if we're in endgame mode (last 3 min + evident side)
interface EndgameCheck {
  isEndgame: boolean;
  evidentSide: Outcome | null;
  distanceUsd: number;
  maxPrice: number; // Allowed max price in current mode
}

function checkEndgameMode(
  remainingSeconds: number,
  currentPrice: number | null,
  strikePrice: number | null,
  asset: string
): EndgameCheck {
  const defaultResult: EndgameCheck = {
    isEndgame: false,
    evidentSide: null,
    distanceUsd: 0,
    maxPrice: STRATEGY.entry.maxPrice,
  };

  // Not in last 3 minutes? Normal mode
  if (remainingSeconds > STRATEGY.endgame.triggerSeconds) {
    return defaultResult;
  }

  // No strike price? Can't determine evident side
  if (!strikePrice || strikePrice <= 0 || !currentPrice) {
    return defaultResult;
  }

  const distanceUsd = currentPrice - strikePrice;
  const absDistance = Math.abs(distanceUsd);

  // Distance must exceed threshold to be "evident"
  if (absDistance < STRATEGY.endgame.skipHedgeThresholdUsd) {
    return defaultResult;
  }

  // Evident side: price above strike = UP wins, below = DOWN wins
  const evidentSide: Outcome = distanceUsd > 0 ? 'UP' : 'DOWN';

  return {
    isEndgame: true,
    evidentSide,
    distanceUsd,
    maxPrice: STRATEGY.endgame.maxPrice, // 97¢ in endgame
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Live Trade Bot WebSocket - Expected WebSocket connection", { 
      status: 200,
      headers: corsHeaders,
    });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let clobSocket: WebSocket | null = null;
  let markets: Map<string, MarketToken> = new Map();
  let tokenToMarket: Map<string, { slug: string; side: 'up' | 'down' }> = new Map();
  let marketContexts: Map<string, MarketContext> = new Map();
  let isEnabled = false;
  let tradeCount = 0;
  let evaluationCount = 0;
  let statusLogInterval: ReturnType<typeof setInterval> | null = null;
  let lastGlobalOrderAtMs = 0; // Global cooldown tracker
  
  // Chainlink price cache for endgame logic
  let chainlinkBtcPrice: number | null = null;
  let chainlinkLastFetchMs = 0;
  const CHAINLINK_CACHE_MS = 10000; // Refresh every 10s
  
  // Track pending orders per market (realtime updated)
  let pendingOrdersByMarket: Map<string, Set<string>> = new Map(); // market_slug -> Set of order IDs
  let orderQueueChannel: any = null;

  const log = (msg: string) => {
    console.log(`[LiveBot] ${msg}`);
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
      }
    } catch {}
  };

  const sendStatus = () => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'status',
          isEnabled,
          marketsCount: markets.size,
          positionsCount: [...marketContexts.values()].filter(c => c.position.upShares > 0 || c.position.downShares > 0).length,
          timestamp: Date.now(),
        }));
      }
    } catch {}
  };

  const checkBotEnabled = async (): Promise<boolean> => {
    try {
      const { data } = await supabase
        .from('live_bot_settings')
        .select('is_enabled')
        .eq('id', '00000000-0000-0000-0000-000000000001')
        .single();
      return (data as any)?.is_enabled ?? false;
    } catch {
      return false;
    }
  };

  const fetchMarkets = async (): Promise<boolean> => {
    try {
      const previousTokenCount = tokenToMarket.size;
      const previousTokenIds = new Set(tokenToMarket.keys());
      
      const marketsResponse = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await marketsResponse.json();
      if (data.success && data.markets) {
        const nowMs = Date.now();
        markets.clear();
        tokenToMarket.clear();
        const activeSlugs = new Set<string>();

        for (const market of data.markets) {
          // Only trade BTC 15-min markets for live
          if (market.marketType !== '15min') continue;
          if (market.asset !== 'BTC') continue;

          const startMs = new Date(market.eventStartTime).getTime();
          const endMs = new Date(market.eventEndTime).getTime();

          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          if (nowMs < startMs || nowMs >= endMs) continue;

          activeSlugs.add(market.slug);
          markets.set(market.slug, market);
          tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
          tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });

          if (!marketContexts.has(market.slug)) {
            marketContexts.set(market.slug, {
              slug: market.slug,
              remainingSeconds: 0,
              book: {
                up: { bid: null, ask: null, isFromRealBook: false },
                down: { bid: null, ask: null, isFromRealBook: false },
                updatedAtMs: 0,
              },
              position: { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 },
              lastTradeAtMs: 0,
              lastDecisionKey: null,
              inFlight: false,
              strikePrice: null,
              evidentSide: null,
            });
          }
        }

        // Prune old contexts
        for (const slug of Array.from(marketContexts.keys())) {
          if (!activeSlugs.has(slug)) marketContexts.delete(slug);
        }

        // Check if tokens changed - need to reconnect CLOB
        const newTokenIds = new Set(tokenToMarket.keys());
        const tokensChanged = newTokenIds.size !== previousTokenIds.size || 
          [...newTokenIds].some(id => !previousTokenIds.has(id));

        if (tokensChanged) {
          log(`📊 Markets changed: ${previousTokenCount} → ${tokenToMarket.size} tokens (${markets.size} BTC markets)`);
          return true; // Signal to reconnect
        } else {
          log(`📊 Markets unchanged: ${markets.size} BTC markets`);
          return false;
        }
      }
      return false;
    } catch (error) {
      log(`❌ Error fetching markets: ${error}`);
      return false;
    }
  };

  const fetchExistingTrades = async () => {
    try {
      const slugs = Array.from(markets.keys());
      if (slugs.length === 0) return;

      const { data } = await supabase
        .from('live_trades')
        .select('market_slug, outcome, shares, total, created_at')
        .in('market_slug', slugs);

      // Reset positions
      for (const ctx of marketContexts.values()) {
        ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
        ctx.lastTradeAtMs = 0;
      }

      if (data) {
        for (const trade of data) {
          const ctx = marketContexts.get(trade.market_slug);
          if (ctx) {
            if (trade.outcome === 'UP') {
              ctx.position.upShares += trade.shares;
              ctx.position.upInvested += trade.total;
            } else {
              ctx.position.downShares += trade.shares;
              ctx.position.downInvested += trade.total;
            }
            const tradeTime = new Date(trade.created_at).getTime();
            if (tradeTime > (ctx.lastTradeAtMs ?? 0)) {
              ctx.lastTradeAtMs = tradeTime;
            }
          }
        }
      }

      const totalTrades = data?.length ?? 0;
      log(`📋 Loaded ${totalTrades} existing trades`);
    } catch (error) {
      log(`❌ Error fetching trades: ${error}`);
    }
  };

  // Fetch strike prices for all active markets
  const fetchStrikePrices = async () => {
    try {
      const slugs = Array.from(markets.keys());
      if (slugs.length === 0) return;

      const { data } = await supabase
        .from('strike_prices')
        .select('market_slug, strike_price')
        .in('market_slug', slugs);

      if (data) {
        for (const sp of data) {
          const ctx = marketContexts.get(sp.market_slug);
          if (ctx) {
            ctx.strikePrice = sp.strike_price;
          }
        }
        log(`📍 Loaded ${data.length} strike prices`);
      }
    } catch (error) {
      log(`⚠️ Error fetching strike prices: ${error}`);
    }
  };

  // Fetch current Chainlink BTC price (cached)
  const fetchChainlinkPrice = async (): Promise<number | null> => {
    const nowMs = Date.now();
    if (chainlinkBtcPrice && nowMs - chainlinkLastFetchMs < CHAINLINK_CACHE_MS) {
      return chainlinkBtcPrice;
    }

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/chainlink-price-collector`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json();
      if (data.btc && isNum(data.btc)) {
        chainlinkBtcPrice = data.btc;
        chainlinkLastFetchMs = nowMs;
        return chainlinkBtcPrice;
      }
    } catch (error) {
      // Silent fail - use cached value
    }
    return chainlinkBtcPrice;
  };

  // Subscribe to order_queue changes for realtime order status tracking
  const subscribeToOrderQueue = () => {
    log('📡 Subscribing to order_queue realtime updates...');
    
    orderQueueChannel = supabase
      .channel('order-queue-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_queue'
        },
        (payload: any) => {
          const { eventType, new: newRow, old: oldRow } = payload;
          
          if (eventType === 'INSERT' && newRow) {
            // New order added - track it
            const slug = newRow.market_slug;
            if (!pendingOrdersByMarket.has(slug)) {
              pendingOrdersByMarket.set(slug, new Set());
            }
            if (newRow.status === 'pending' || newRow.status === 'processing') {
              pendingOrdersByMarket.get(slug)!.add(newRow.id);
              log(`📥 Order ${newRow.id.slice(0, 8)} added to ${slug.slice(-15)} (${newRow.outcome})`);
            }
          } else if (eventType === 'UPDATE' && newRow) {
            // Order status changed
            const slug = newRow.market_slug;
            const orderId = newRow.id;
            
            if (newRow.status === 'filled' || newRow.status === 'failed' || newRow.status === 'placed') {
              // Order completed - remove from pending
              if (pendingOrdersByMarket.has(slug)) {
                pendingOrdersByMarket.get(slug)!.delete(orderId);
                log(`✅ Order ${orderId.slice(0, 8)} ${newRow.status} on ${slug.slice(-15)} (${newRow.outcome})`);
              }
            } else if (newRow.status === 'processing') {
              // Still pending
              if (!pendingOrdersByMarket.has(slug)) {
                pendingOrdersByMarket.set(slug, new Set());
              }
              pendingOrdersByMarket.get(slug)!.add(orderId);
            }
          } else if (eventType === 'DELETE' && oldRow) {
            // Order deleted
            const slug = oldRow.market_slug;
            if (pendingOrdersByMarket.has(slug)) {
              pendingOrdersByMarket.get(slug)!.delete(oldRow.id);
            }
          }
        }
      )
      .subscribe((status: string) => {
        log(`📡 Order queue subscription: ${status}`);
      });
  };

  // Load initial pending orders
  const loadPendingOrders = async () => {
    try {
      const { data } = await supabase
        .from('order_queue')
        .select('id, market_slug')
        .in('status', ['pending', 'processing']);
      
      pendingOrdersByMarket.clear();
      if (data) {
        for (const order of data) {
          if (!pendingOrdersByMarket.has(order.market_slug)) {
            pendingOrdersByMarket.set(order.market_slug, new Set());
          }
          pendingOrdersByMarket.get(order.market_slug)!.add(order.id);
        }
        log(`📋 Loaded ${data.length} pending orders`);
      }
    } catch (error) {
      log(`⚠️ Error loading pending orders: ${error}`);
    }
  };

  // Check if market has pending orders (instant - no DB query)
  const hasPendingOrders = (slug: string): boolean => {
    const pending = pendingOrdersByMarket.get(slug);
    return pending ? pending.size > 0 : false;
  };

  const connectToClob = () => {
    const tokenIds = Array.from(tokenToMarket.keys());
    if (tokenIds.length === 0) {
      log('⚠️ No tokens to subscribe');
      return;
    }

    log(`🔌 Connecting to CLOB with ${tokenIds.length} tokens...`);
    clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

    clobSocket.onopen = () => {
      log('✅ Connected to Polymarket CLOB');
      clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
      sendStatus();
    };

    clobSocket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        await processMarketEvent(data);
      } catch {}
    };

    clobSocket.onerror = (error) => log(`❌ CLOB error: ${error}`);

    clobSocket.onclose = () => {
      log('🔌 CLOB disconnected, reconnecting...');
      setTimeout(() => {
        if (isEnabled) connectToClob();
      }, 5000);
    };
  };

  let bookEventCount = 0;
  
  const processMarketEvent = async (data: any) => {
    const eventType = data.event_type;
    const nowMs = Date.now();

    // Log first 3 raw events
    if (bookEventCount < 3) {
      log(`📨 RAW: type=${eventType}, keys=${Object.keys(data).join(',')}`);
    }

    if (eventType === 'book') {
      bookEventCount++;
      const assetId = data.asset_id;
      const marketInfo = tokenToMarket.get(assetId);

      // Log first 3 book events
      if (bookEventCount <= 3) {
        log(`📖 BOOK #${bookEventCount}: asset=${assetId?.slice(0,10)}..., matched=${!!marketInfo}, asks=${(data.asks||[]).length}, bids=${(data.bids||[]).length}`);
        if (data.asks?.length > 0) {
          log(`📖 Ask[0]: ${JSON.stringify(data.asks[0])}`);
        }
      }

      if (marketInfo) {
        const ctx = marketContexts.get(marketInfo.slug);
        if (ctx) {
          const asks = (data.asks || []) as [string, string][];
          const bids = (data.bids || []) as [string, string][];

          const topAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
          const topBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;

          if (marketInfo.side === 'up') {
            ctx.book.up.ask = topAsk;
            ctx.book.up.bid = topBid;
            if (topAsk !== null && !isNaN(topAsk)) ctx.book.up.isFromRealBook = true;
          } else {
            ctx.book.down.ask = topAsk;
            ctx.book.down.bid = topBid;
            if (topAsk !== null && !isNaN(topAsk)) ctx.book.down.isFromRealBook = true;
          }
          ctx.book.updatedAtMs = nowMs;

          await evaluateTradeOpportunity(marketInfo.slug, nowMs);
        }
      }
    } else if (eventType === 'price_change') {
      // Also handle price_change events as fallback
      const changes = data.changes || data.price_changes || [];
      
      // Log first price_change
      if (bookEventCount < 5) {
        log(`💰 PRICE_CHANGE: ${changes.length} changes`);
      }
      
      for (const change of changes) {
        const assetId = change.asset_id;
        const marketInfo = tokenToMarket.get(assetId);
        if (marketInfo) {
          const ctx = marketContexts.get(marketInfo.slug);
          if (ctx) {
            const price = parseFloat(change.price);
            if (!isNaN(price)) {
              if (marketInfo.side === 'up') {
                if (ctx.book.up.ask === null || isNaN(ctx.book.up.ask as number)) {
                  ctx.book.up.ask = price;
                  ctx.book.up.isFromRealBook = true;
                }
              } else {
                if (ctx.book.down.ask === null || isNaN(ctx.book.down.ask as number)) {
                  ctx.book.down.ask = price;
                  ctx.book.down.isFromRealBook = true;
                }
              }
              ctx.book.updatedAtMs = nowMs;
              await evaluateTradeOpportunity(marketInfo.slug, nowMs);
            }
          }
        }
      }
    }
  };

  const evaluateTradeOpportunity = async (slug: string, nowMs: number) => {
    if (!isEnabled) return;

    const market = markets.get(slug);
    const ctx = marketContexts.get(slug);
    if (!market || !ctx) return;

    // Lock check
    if (ctx.inFlight) return;
    ctx.inFlight = true;

    try {
      const startTime = new Date(market.eventStartTime).getTime();
      const endTime = new Date(market.eventEndTime).getTime();
      if (nowMs < startTime || nowMs >= endTime) {
        log(`⏭️ SKIP: Market not in active window`);
        return;
      }

      ctx.remainingSeconds = Math.floor((endTime - nowMs) / 1000);
      evaluationCount++;

      // GLOBAL cooldown - prevent spamming Polymarket across ALL markets
      if (lastGlobalOrderAtMs && nowMs - lastGlobalOrderAtMs < STRATEGY.globalCooldownMs) {
        return; // Silent skip - global cooldown active
      }

      // Per-market cooldown check (longer to respect rate limits)
      if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < STRATEGY.cooldownMs) return;

      // CHECK FOR PENDING ORDERS (realtime - no DB query needed!)
      if (hasPendingOrders(slug)) {
        if (evaluationCount % 10 === 0) log(`⏸️ WAIT: Pending order on ${slug.slice(-15)}, skipping evaluation`);
        return;
      }

      // REFRESH POSITION FROM DATABASE (not optimistic local state)
      const { data: confirmedTrades } = await supabase
        .from('live_trades')
        .select('outcome, shares, total')
        .eq('market_slug', slug);
      
      // Reset and recalculate from confirmed trades only
      ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
      if (confirmedTrades) {
        for (const trade of confirmedTrades) {
          if (trade.outcome === 'UP') {
            ctx.position.upShares += trade.shares;
            ctx.position.upInvested += trade.total;
          } else {
            ctx.position.downShares += trade.shares;
            ctx.position.downInvested += trade.total;
          }
        }
      }

      // Time check
      if (ctx.remainingSeconds < STRATEGY.entry.minSecondsRemaining) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Too close to expiry (${ctx.remainingSeconds}s)`);
        return;
      }

      // Book freshness
      if (nowMs - ctx.book.updatedAtMs > STRATEGY.entry.staleBookMs) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Stale book data`);
        return;
      }

      // Need real book data
      if (!ctx.book.up.isFromRealBook || !ctx.book.down.isFromRealBook) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: No real book data (up=${ctx.book.up.isFromRealBook}, down=${ctx.book.down.isFromRealBook})`);
        return;
      }

      const upAsk = ctx.book.up.ask;
      const downAsk = ctx.book.down.ask;
      if (!isNum(upAsk) || !isNum(downAsk)) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Missing prices (up=${upAsk}, down=${downAsk})`);
        return;
      }

      const combined = upAsk + downAsk;

      // Sanity checks
      if (combined < 0.90 || combined > 1.10) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: Combined out of range (${(combined*100).toFixed(0)}¢)`);
        return;
      }

      // Check for endgame mode: last 3 min + evident side = allow up to 97¢
      const currentBtcPrice = await fetchChainlinkPrice();
      const endgame = checkEndgameMode(
        ctx.remainingSeconds,
        currentBtcPrice,
        ctx.strikePrice ?? null,
        market.asset
      );
      
      // Cache evident side for logging
      ctx.evidentSide = endgame.evidentSide;
      
      // Dynamic max price based on mode
      const effectiveMaxPrice = endgame.isEndgame ? endgame.maxPrice : STRATEGY.entry.maxPrice;
      
      // Log endgame mode activation
      if (endgame.isEndgame && evaluationCount % 10 === 0) {
        log(`🎯 ENDGAME: ${ctx.remainingSeconds}s left, ${endgame.evidentSide} evident ($${Math.abs(endgame.distanceUsd).toFixed(0)} from strike), max price ${(effectiveMaxPrice*100).toFixed(0)}¢`);
      }

      // Price range check with dynamic max
      if (upAsk < STRATEGY.entry.minPrice || upAsk > effectiveMaxPrice) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: UP price out of range (${(upAsk*100).toFixed(0)}¢ > ${(effectiveMaxPrice*100).toFixed(0)}¢)`);
        return;
      }
      if (downAsk < STRATEGY.entry.minPrice || downAsk > effectiveMaxPrice) {
        if (evaluationCount % 20 === 0) log(`⏭️ SKIP: DOWN price out of range (${(downAsk*100).toFixed(0)}¢ > ${(effectiveMaxPrice*100).toFixed(0)}¢)`);
        return;
      }

      // Position limits
      const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
      if (totalInvested >= STRATEGY.limits.maxTotalInvested) return;

      // Dedupe
      const decisionKey = makeDecisionKey(slug, upAsk, downAsk, combined, nowMs);
      if (ctx.lastDecisionKey === decisionKey) return;
      ctx.lastDecisionKey = decisionKey;

      const pos = ctx.position;

      // Log every 10th evaluation with full info
      if (evaluationCount % 10 === 0) {
        log(`📊 ${slug.slice(-15)}: ${(upAsk*100).toFixed(0)}¢+${(downAsk*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | pos: ${pos.upShares}UP/${pos.downShares}DOWN | eval #${evaluationCount}`);
      }

      // ========== TRADING LOGIC ==========

      // PHASE 1: OPENING - No position yet
      if (pos.upShares === 0 && pos.downShares === 0) {
        const cheaperSide: Outcome = upAsk <= downAsk ? "UP" : "DOWN";
        const cheaperPrice = cheaperSide === "UP" ? upAsk : downAsk;

        log(`🎯 OPENING CHECK: ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢ (max: ${(STRATEGY.opening.maxPrice*100).toFixed(0)}¢)`);

        if (cheaperPrice <= STRATEGY.opening.maxPrice) {
          const shares = calcShares(STRATEGY.opening.notional, cheaperPrice);
          if (shares >= 1) {
            await executeTrade(market, ctx, cheaperSide, cheaperPrice, shares, 
              `Opening ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢`);
          }
        } else {
          log(`⏭️ SKIP OPENING: ${(cheaperPrice*100).toFixed(0)}¢ > max ${(STRATEGY.opening.maxPrice*100).toFixed(0)}¢`);
        }
        return;
      }

      // PHASE 2: HEDGE - One side filled, buy other at MARKETABLE price
      if (pos.upShares === 0 || pos.downShares === 0) {
        const missingSide: Outcome = pos.upShares === 0 ? "UP" : "DOWN";
        const missingPrice = missingSide === "UP" ? upAsk : downAsk;
        const existingShares = missingSide === "UP" ? pos.downShares : pos.upShares;
        const existingInvested = missingSide === "UP" ? pos.downInvested : pos.upInvested;
        const existingAvg = existingShares > 0 ? existingInvested / existingShares : 0;
        
        // MINIMUM SHARES: Polymarket rejects orders < ~$1-2 notional
        // Ensure we always order at least 5 shares (or use notional-based sizing)
        const minSharesForOrder = 5;
        const hedgeShares = Math.max(existingShares, minSharesForOrder);
        
        // MARKETABLE LIMIT: Add cushion ticks above ask for guaranteed fill
        const cushion = STRATEGY.hedge.cushionTicks * STRATEGY.hedge.tickSize;
        const marketablePrice = Math.min(
          missingPrice + cushion, 
          STRATEGY.hedge.maxPrice
        );
        const projectedCombined = existingAvg + marketablePrice;

        // Calculate time since opening trade for force-hedge timeout
        const timeSinceOpeningMs = ctx.lastTradeAtMs > 0 ? nowMs - ctx.lastTradeAtMs : 0;
        const timeSinceOpeningSec = timeSinceOpeningMs / 1000;
        const isForceHedge = timeSinceOpeningSec >= STRATEGY.hedge.forceTimeoutSec;

        // Log hedge evaluation details (include hedgeShares to show minimum enforcement)
        log(`🔍 HEDGE EVAL: ${missingSide} ask=${(missingPrice*100).toFixed(0)}¢ → marketable=${(marketablePrice*100).toFixed(0)}¢ | projected=${(projectedCombined*100).toFixed(0)}¢ | shares=${existingShares}→${hedgeShares} | timeSinceOpen=${timeSinceOpeningSec.toFixed(0)}s | force=${isForceHedge}`);

        // FORCE HEDGE: If timeout exceeded, hedge regardless of combined price
        if (isForceHedge) {
          log(`⚠️ FORCE HEDGE: ${timeSinceOpeningSec.toFixed(0)}s since opening > ${STRATEGY.hedge.forceTimeoutSec}s timeout (using ${hedgeShares} shares)`);
          await executeTrade(market, ctx, missingSide, marketablePrice, hedgeShares,
            `FORCE Hedge ${missingSide} @ ${(marketablePrice*100).toFixed(0)}¢ (timeout ${timeSinceOpeningSec.toFixed(0)}s)`);
          return;
        }

        // NORMAL HEDGE: Check if combined price is good
        if (projectedCombined < STRATEGY.hedge.triggerCombined && missingPrice <= STRATEGY.opening.maxPrice) {
          const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
          await executeTrade(market, ctx, missingSide, marketablePrice, hedgeShares,
            `Hedge ${missingSide} @ ${(marketablePrice*100).toFixed(0)}¢ (${edgePct}% edge, +${STRATEGY.hedge.cushionTicks} ticks)`);
        }
        return;
      }

      // PHASE 3: ACCUMULATE - Both sides filled, add equal shares if good combined
      if (combined < STRATEGY.accumulate.triggerCombined) {
        const priceSum = upAsk + downAsk;
        const sharesToAdd = Math.floor(STRATEGY.accumulate.notional / priceSum);
        
        if (sharesToAdd >= 1 && 
            pos.upShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide &&
            pos.downShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide) {
          const edgePct = ((1 - combined) * 100).toFixed(1);
          
          // Execute both sides
          await executeTrade(market, ctx, "UP", upAsk, sharesToAdd,
            `Accumulate UP @ ${(upAsk*100).toFixed(0)}¢ (${edgePct}% edge)`);
          await executeTrade(market, ctx, "DOWN", downAsk, sharesToAdd,
            `Accumulate DOWN @ ${(downAsk*100).toFixed(0)}¢ (${edgePct}% edge)`);
        }
      }
    } catch (err) {
      log(`❌ Evaluation error: ${err}`);
    } finally {
      ctx.inFlight = false;
    }
  };

  const executeTrade = async (
    market: MarketToken,
    ctx: MarketContext,
    outcome: Outcome,
    price: number,
    shares: number,
    reasoning: string
  ): Promise<boolean> => {
    try {
      const tokenId = outcome === "UP" ? market.upTokenId : market.downTokenId;
      const total = shares * price;

      log(`📋 QUEUING: ${outcome} ${shares} @ ${(price*100).toFixed(0)}¢ on ${market.slug.slice(-20)}`);

      // Queue order for local-runner to execute (edge functions get blocked by Cloudflare)
      const { error: queueError } = await supabase.from('order_queue').insert({
        market_slug: market.slug,
        asset: market.asset,
        outcome,
        token_id: tokenId,
        shares,
        price,
        reasoning,
        order_type: 'GTC',
        status: 'pending',
        event_start_time: market.eventStartTime,
        event_end_time: market.eventEndTime,
      });

      if (queueError) {
        log(`❌ Queue error: ${queueError.message}`);
        return false;
      }

      // NO optimistic update - we refresh from DB on next evaluation
      // This prevents race conditions and ensures decisions are based on confirmed fills
      ctx.lastTradeAtMs = Date.now();
      lastGlobalOrderAtMs = Date.now(); // Update global cooldown
      tradeCount++;
      const combined = (ctx.book.up.ask || 0) + (ctx.book.down.ask || 0);
      log(`✅ QUEUED #${tradeCount}: ${outcome} ${shares}@${(price*100).toFixed(0)}¢ | Combined: ${(combined*100).toFixed(0)}¢`);

      // Notify client
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'signal',
          market: market.slug,
          outcome,
          shares,
          price,
          status: 'queued',
          timestamp: Date.now(),
        }));
      }

      return true;
    } catch (err) {
      log(`❌ Queue error: ${err}`);
      return false;
    }
  };

  const startBot = async () => {
    log('🚀 Live trading bot starting...');

    isEnabled = await checkBotEnabled();
    log(isEnabled ? '✅ Bot is ENABLED' : '⏸️ Bot is DISABLED');

    // Always subscribe to order queue for realtime status tracking
    await loadPendingOrders();
    subscribeToOrderQueue();

    if (isEnabled) {
      await fetchMarkets();
      await fetchExistingTrades();
      await fetchStrikePrices();
      connectToClob();
    }

    sendStatus();

    // Periodic status check & market refresh
    statusLogInterval = setInterval(async () => {
      const wasEnabled = isEnabled;
      isEnabled = await checkBotEnabled();

      if (isEnabled !== wasEnabled) {
        log(isEnabled ? '✅ Bot ENABLED' : '⏸️ Bot DISABLED');

        if (isEnabled && !clobSocket) {
          const marketsChanged = await fetchMarkets();
          await fetchExistingTrades();
          await fetchStrikePrices();
          connectToClob();
        } else if (!isEnabled && clobSocket) {
          clobSocket.close();
          clobSocket = null;
        }
      }

      // Refresh markets every 15 seconds if enabled - reconnect if new markets found
      if (isEnabled) {
        const marketsChanged = await fetchMarkets();
        if (marketsChanged && clobSocket) {
          log('🔄 New markets detected - reconnecting CLOB...');
          clobSocket.close();
          clobSocket = null;
          await fetchExistingTrades();
          await fetchStrikePrices();
          connectToClob();
        }
      }

      sendStatus();
    }, 15000); // Check every 15 seconds for new markets
  };

  socket.onopen = () => {
    log('WebSocket client connected');
    startBot();
  };

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } else if (data.type === 'status') {
        sendStatus();
      }
    } catch {}
  };

  socket.onerror = (error) => {
    log(`WebSocket error: ${error}`);
  };

  socket.onclose = () => {
    log('WebSocket client disconnected');
    if (statusLogInterval) clearInterval(statusLogInterval);
    if (clobSocket) clobSocket.close();
    if (orderQueueChannel) {
      supabase.removeChannel(orderQueueChannel);
    }
  };

  return response;
});
