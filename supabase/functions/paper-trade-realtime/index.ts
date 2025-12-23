import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// DIRECTIONAL + OPPORTUNISTIC HEDGE STRATEGY V7
// Share-based balancing: Start directional, hedge when combined < threshold
// ============================================================================

type Outcome = "UP" | "DOWN";
type OrderSide = "BUY" | "SELL";
type TradeType = "OPENING" | "HEDGE" | "REBALANCE" | "ACCUMULATE";

interface TopOfBook {
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
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
  cryptoPrice?: number | null;
  strikePrice?: number | null;
  lastTradeAtMs: number;
  lastDecisionKey?: string | null;
  inFlight?: boolean;
}

interface TradeIntent {
  outcome: Outcome;
  side: OrderSide;
  limitPrice: number;
  notionalUsd: number;
  shares: number;
  type: TradeType;
  reason: string;
}

interface StrategyConfig {
  opening: {
    notional: number;           // Initial trade size
    preferCheaper: boolean;     // Start with cheaper side (more shares)
  };
  hedge: {
    triggerCombined: number;    // Hedge when combined < this (e.g., 0.98)
    notional: number;           // Per hedge trade
  };
  accumulate: {
    triggerCombined: number;    // Accumulate when combined < this (e.g., 0.95)
    notional: number;           // Per accumulate trade
  };
  positionLimits: {
    maxSharesPerSide: number;
    maxTotalInvested: number;
    minSharesDiffToRebalance: number;  // Min diff to trigger rebalance
  };
  entry: {
    minSecondsRemaining: number;
    minPrice: number;
    maxPrice: number;
    staleBookMs: number;
  };
  hf: {
    tickMinIntervalMs: number;
    dedupeWindowMs: number;
    minNotionalToTrade: number;
  };
  execution: {
    mode: "PAPER_BID" | "LIVE_ASK";
    bidMissing: "FALLBACK_TO_ASK" | "SKIP";
  };
}

const DEFAULT_CONFIG: StrategyConfig = {
  // V7: Directional + Opportunistic Hedge with Share Balancing
  opening: {
    notional: 5,              // $5 initial trade
    preferCheaper: true,      // Buy cheaper side first (more shares)
  },
  hedge: {
    triggerCombined: 0.98,    // Hedge when combined < 98¢
    notional: 5,              // $5 per hedge trade
  },
  accumulate: {
    triggerCombined: 0.95,    // Accumulate when combined < 95¢ (strong arb)
    notional: 5,              // $5 per accumulate trade
  },
  positionLimits: {
    maxSharesPerSide: 500,    // Max 500 shares per side
    maxTotalInvested: 200,    // Max $200 total
    minSharesDiffToRebalance: 5,  // Min 5 shares diff to rebalance
  },
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 1500,
  },
  hf: {
    tickMinIntervalMs: 2000,  // 2s cooldown
    dedupeWindowMs: 2500,
    minNotionalToTrade: 1.5,
  },
  execution: {
    mode: "PAPER_BID",
    bidMissing: "FALLBACK_TO_ASK",
  },
};

// ============================================================================
// STRATEGY LOGIC V7: DIRECTIONAL + OPPORTUNISTIC HEDGE
// Core principle: Equal shares on both sides = guaranteed profit
// ============================================================================

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function skip(reason: string): { shouldTrade: false; reason: string; trades: TradeIntent[] } {
  return { shouldTrade: false, reason, trades: [] };
}

function commit(
  ctx: MarketContext, 
  nowMs: number, 
  reason: string, 
  trades: TradeIntent[],
  cfg: StrategyConfig
): { shouldTrade: boolean; reason: string; trades: TradeIntent[] } {
  const filtered = trades.filter(t => t.notionalUsd >= cfg.hf.minNotionalToTrade && t.shares >= 1);
  if (!filtered.length) return { shouldTrade: false, reason: "DUST_OR_LIMIT", trades: [] };
  ctx.lastTradeAtMs = nowMs;
  return { shouldTrade: true, reason, trades: filtered };
}

// Decision key for de-duplication
function makeDecisionKey(slug: string, up: number, down: number, combined: number, nowMs: number, windowMs: number): string {
  const bucket = Math.floor(nowMs / windowMs);
  const r = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
  return `${slug}|${bucket}|u=${r(up)}|d=${r(down)}|c=${r(combined)}`;
}

// Get execution prices based on mode (paper = bid, live = ask)
function getExecutionPrices(ctx: MarketContext, cfg: StrategyConfig): 
  { upExec: number; downExec: number } | null {
  const upBid = ctx.book.up.bid;
  const downBid = ctx.book.down.bid;
  const upAsk = ctx.book.up.ask;
  const downAsk = ctx.book.down.ask;

  const wantBid = cfg.execution.mode === "PAPER_BID";

  if (wantBid) {
    if (isNum(upBid) && isNum(downBid)) {
      return { upExec: upBid, downExec: downBid };
    }
    if (cfg.execution.bidMissing === "FALLBACK_TO_ASK" && isNum(upAsk) && isNum(downAsk)) {
      return { upExec: upAsk, downExec: downAsk };
    }
    return null;
  } else {
    if (!isNum(upAsk) || !isNum(downAsk)) return null;
    return { upExec: upAsk, downExec: downAsk };
  }
}

// Create a single trade intent
function mkTrade(outcome: Outcome, price: number, shares: number, type: TradeType, reason: string): TradeIntent {
  const notionalUsd = shares * price;
  return { outcome, side: "BUY", limitPrice: price, notionalUsd, shares, type, reason };
}

// Calculate how many equal shares we can buy with a given notional
function calcEqualShares(notional: number, upPrice: number, downPrice: number): number {
  const priceSum = upPrice + downPrice;
  if (priceSum <= 0) return 0;
  return Math.floor(notional / priceSum);
}

/**
 * MAIN ENTRY: Directional + Opportunistic Hedge Strategy V7
 * 
 * Phase 1: OPENING - Start with one side (cheaper = more shares)
 * Phase 2: HEDGE - When combined < 0.98, buy other side to match shares
 * Phase 3: REBALANCE - If shares imbalanced, buy undersized side
 * Phase 4: ACCUMULATE - If balanced and combined < 0.95, buy equal shares both sides
 */
function decideTrades(
  ctx: MarketContext,
  cfg: StrategyConfig = DEFAULT_CONFIG,
  nowMs: number = Date.now()
): { shouldTrade: boolean; reason: string; trades: TradeIntent[] } {
  // NOTE: inFlight lock is managed by evaluateTradeOpportunity, not here
  
  const pos = ctx.position;
    
    // 1) COOLDOWN
    if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < cfg.hf.tickMinIntervalMs) {
      return skip(`COOLDOWN: ${cfg.hf.tickMinIntervalMs}ms`);
    }

    // 2) EXPIRY CHECK
    if (ctx.remainingSeconds < cfg.entry.minSecondsRemaining) {
      return skip(`TOO_CLOSE_TO_EXPIRY: ${ctx.remainingSeconds}s`);
    }

    // 3) BOOK FRESHNESS
    if (nowMs - ctx.book.updatedAtMs > cfg.entry.staleBookMs) {
      return skip(`STALE_BOOK: ${nowMs - ctx.book.updatedAtMs}ms`);
    }

    // 4) Get execution prices
    const px = getExecutionPrices(ctx, cfg);
    if (!px) return skip("MISSING_PRICES");

    const { upExec, downExec } = px;
    const combined = upExec + downExec;

    // 5) PRICE SANITY
    if (upExec < cfg.entry.minPrice || upExec > cfg.entry.maxPrice) {
      return skip(`UP_OUT_OF_RANGE: ${(upExec*100).toFixed(0)}¢`);
    }
    if (downExec < cfg.entry.minPrice || downExec > cfg.entry.maxPrice) {
      return skip(`DOWN_OUT_OF_RANGE: ${(downExec*100).toFixed(0)}¢`);
    }

    // 6) POSITION LIMITS
    const totalInvested = pos.upInvested + pos.downInvested;
    if (totalInvested >= cfg.positionLimits.maxTotalInvested) {
      return skip(`LIMIT_TOTAL: $${totalInvested.toFixed(0)}`);
    }
    if (pos.upShares >= cfg.positionLimits.maxSharesPerSide) {
      return skip(`UP_SHARES_LIMIT: ${pos.upShares}`);
    }
    if (pos.downShares >= cfg.positionLimits.maxSharesPerSide) {
      return skip(`DOWN_SHARES_LIMIT: ${pos.downShares}`);
    }

    // ---- DECISION KEY (dedupe) ----
    const decisionKey = makeDecisionKey(ctx.slug, upExec, downExec, combined, nowMs, cfg.hf.dedupeWindowMs);
    if (ctx.lastDecisionKey === decisionKey) return skip("DEDUPED");
    ctx.lastDecisionKey = decisionKey;

    const sharesDiff = pos.upShares - pos.downShares;  // Positive = more UP, negative = more DOWN

    // ========================================================================
    // PHASE 1: OPENING - No position yet
    // Buy ONE side early at a good price (47-52¢)
    // ========================================================================
    if (pos.upShares === 0 && pos.downShares === 0) {
      // Find the cheaper side
      const cheaperSide: Outcome = upExec <= downExec ? "UP" : "DOWN";
      const cheaperPrice = cheaperSide === "UP" ? upExec : downExec;
      
      // Only enter if price is good (47-52¢ range = 0.47-0.52)
      const maxEntryPrice = 0.52;
      if (cheaperPrice > maxEntryPrice) {
        return skip(`WAITING_FOR_ENTRY: ${cheaperSide}=${(cheaperPrice*100).toFixed(0)}¢ > ${(maxEntryPrice*100).toFixed(0)}¢`);
      }
      
      const shares = Math.floor(cfg.opening.notional / cheaperPrice);
      if (shares < 1) return skip("OPENING_SHARES_TOO_LOW");
      
      const trade = mkTrade(
        cheaperSide, 
        cheaperPrice, 
        shares, 
        "OPENING", 
        `Opening ${cheaperSide} @ ${(cheaperPrice*100).toFixed(0)}¢ (${shares} shares)`
      );
      
      return commit(ctx, nowMs, "OPENING", [trade], cfg);
    }

    // ========================================================================
    // PHASE 2: HEDGE - One side filled, wait for other side at good price
    // Combined must be < $1 for guaranteed profit
    // ========================================================================
    if (pos.upShares === 0 || pos.downShares === 0) {
      const missingSide: Outcome = pos.upShares === 0 ? "UP" : "DOWN";
      const missingPrice = missingSide === "UP" ? upExec : downExec;
      const existingShares = missingSide === "UP" ? pos.downShares : pos.upShares;
      const existingInvested = missingSide === "UP" ? pos.downInvested : pos.upInvested;
      const existingAvg = existingShares > 0 ? existingInvested / existingShares : 0;
      
      // Calculate what combined would be if we hedge now
      const projectedCombined = existingAvg + missingPrice;
      
      // Only hedge if combined < $1 (guaranteed profit)
      if (projectedCombined >= cfg.hedge.triggerCombined) {
        return skip(`WAITING_FOR_HEDGE: projected_combined=${(projectedCombined*100).toFixed(0)}¢ >= ${(cfg.hedge.triggerCombined*100).toFixed(0)}¢`);
      }
      
      // Also check if missing side price is reasonable (< 52¢)
      const maxHedgePrice = 0.52;
      if (missingPrice > maxHedgePrice) {
        return skip(`WAITING_FOR_HEDGE: ${missingSide}=${(missingPrice*100).toFixed(0)}¢ > ${(maxHedgePrice*100).toFixed(0)}¢`);
      }
      
      // Match existing shares to balance position
      const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
      
      const trade = mkTrade(
        missingSide, 
        missingPrice, 
        existingShares,  // Buy EXACT same amount to balance
        "HEDGE", 
        `Hedge ${missingSide} @ ${(missingPrice*100).toFixed(0)}¢ (combined=${(projectedCombined*100).toFixed(0)}¢, ${edgePct}% edge)`
      );
      
      return commit(ctx, nowMs, "HEDGE", [trade], cfg);
    }

    // ========================================================================
    // PHASE 3: REBALANCE - Shares are imbalanced, buy the undersized side
    // ========================================================================
    if (Math.abs(sharesDiff) > cfg.positionLimits.minSharesDiffToRebalance) {
      // Only rebalance if combined is favorable
      if (combined < cfg.hedge.triggerCombined) {
        const underSide: Outcome = sharesDiff > 0 ? "DOWN" : "UP";  // Buy side with fewer shares
        const price = underSide === "UP" ? upExec : downExec;
        
        // Buy exactly the difference to balance shares
        const sharesToBuy = Math.abs(sharesDiff);
        const maxAffordable = Math.floor(cfg.hedge.notional / price);
        const actualShares = Math.min(sharesToBuy, maxAffordable);
        
        if (actualShares < 1) return skip("REBALANCE_SHARES_TOO_LOW");
        
        const trade = mkTrade(
          underSide, 
          price, 
          actualShares, 
          "REBALANCE", 
          `Rebalance ${underSide} @ ${(price*100).toFixed(0)}¢ (${actualShares} shares, diff was ${sharesDiff})`
        );
        
        return commit(ctx, nowMs, "REBALANCE", [trade], cfg);
      }
      
      return skip(`WAITING_FOR_REBALANCE: combined=${(combined*100).toFixed(0)}¢`);
    }

    // ========================================================================
    // PHASE 4: ACCUMULATE - Shares balanced, add more at very good combined
    // ========================================================================
    if (combined < cfg.accumulate.triggerCombined) {
      // Calculate equal shares to add on both sides
      const sharesToAdd = calcEqualShares(cfg.accumulate.notional, upExec, downExec);
      
      if (sharesToAdd < 1) return skip("ACCUMULATE_SHARES_TOO_LOW");
      
      // Check limits after accumulate
      if (pos.upShares + sharesToAdd > cfg.positionLimits.maxSharesPerSide) {
        return skip(`ACCUMULATE_WOULD_EXCEED_UP_LIMIT`);
      }
      if (pos.downShares + sharesToAdd > cfg.positionLimits.maxSharesPerSide) {
        return skip(`ACCUMULATE_WOULD_EXCEED_DOWN_LIMIT`);
      }
      
      const edgePct = ((1 - combined) * 100).toFixed(1);
      
      const trades: TradeIntent[] = [
        mkTrade("UP", upExec, sharesToAdd, "ACCUMULATE", `Accumulate UP @ ${(upExec*100).toFixed(0)}¢ (${edgePct}% edge)`),
        mkTrade("DOWN", downExec, sharesToAdd, "ACCUMULATE", `Accumulate DOWN @ ${(downExec*100).toFixed(0)}¢ (${edgePct}% edge)`),
      ];
    
    return commit(ctx, nowMs, "ACCUMULATE", trades, cfg);
  }

  return skip(`NO_SIGNAL: combined=${(combined*100).toFixed(0)}¢`);
}

// ============================================================================
// EDGE FUNCTION INTEGRATION
// ============================================================================

interface MarketToken {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  openPrice: number | null;
}

interface PaperTrade {
  market_slug: string;
  asset: string;
  outcome: string;
  price: number;
  shares: number;
  total: number;
  trade_type: string;
  reasoning: string;
  crypto_price: number | null;
  open_price: number | null;
  combined_price: number;
  arbitrage_edge: number;
  event_start_time: string;
  event_end_time: string;
  remaining_seconds: number;
  price_delta: number | null;
  price_delta_percent: number | null;
  best_bid: number | null;
  best_ask: number | null;
  estimated_slippage: number | null;
  available_liquidity: number | null;
  avg_fill_price: number | null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  if (upgradeHeader.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  return handleHttpRequest(req);
});

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(req);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  let clobSocket: WebSocket | null = null;
  let markets: Map<string, MarketToken> = new Map();
  let tokenToMarket: Map<string, { slug: string; side: 'up' | 'down' }> = new Map();
  let cryptoPrices: { btc: number | null; eth: number | null } = { btc: null, eth: null };
  
  // Store per-market context for strategy
  let marketContexts: Map<string, MarketContext> = new Map();
  
  let isEnabled = false;
  let statusLogInterval: ReturnType<typeof setInterval> | null = null;
  let evaluationCount = 0;
  let tradeCount = 0;

  const log = (msg: string) => {
    console.log(`[PaperBot V4] ${msg}`);
    try {
      socket.send(JSON.stringify({ type: 'log', message: msg, timestamp: Date.now() }));
    } catch {}
  };

  const fetchMarkets = async () => {
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
        },
      });
      
      const data = await response.json();
      if (data.success && data.markets) {
        markets.clear();
        tokenToMarket.clear();
        
        for (const market of data.markets) {
          if (market.marketType === '15min') {
            markets.set(market.slug, market);
            tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
            tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });
            
            // Initialize market context with default book
            if (!marketContexts.has(market.slug)) {
              marketContexts.set(market.slug, {
                slug: market.slug,
                remainingSeconds: 0,
                book: {
                  up: { bid: null, ask: null },
                  down: { bid: null, ask: null },
                  updatedAtMs: 0,
                },
                position: {
                  upShares: 0,
                  downShares: 0,
                  upInvested: 0,
                  downInvested: 0,
                },
                lastTradeAtMs: 0,
                lastDecisionKey: null,
                inFlight: false,
              });
            }
          }
        }
        log(`📊 Loaded ${markets.size} markets`);
      }
    } catch (error) {
      log(`❌ Error fetching markets: ${error}`);
    }
  };

  const fetchExistingTrades = async () => {
    try {
      const slugs = Array.from(markets.keys());
      if (slugs.length === 0) return;
      
      const { data } = await supabase
        .from('paper_trades')
        .select('market_slug, outcome, shares, total, created_at')
        .in('market_slug', slugs);
      
      // Reset positions for all markets
      for (const ctx of marketContexts.values()) {
        ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
        ctx.lastTradeAtMs = 0;
      }
      
      if (data) {
        // Aggregate by market
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
      const marketsWithPositions = [...marketContexts.values()].filter(c => c.position.upShares > 0 || c.position.downShares > 0).length;
      log(`📋 Loaded ${totalTrades} trades across ${marketsWithPositions} markets`);
    } catch (error) {
      log(`❌ Error fetching trades: ${error}`);
    }
  };

  const checkBotEnabled = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();
    return data?.is_enabled ?? false;
  };

  const connectToClob = () => {
    const tokenIds = Array.from(tokenToMarket.keys());
    if (tokenIds.length === 0) {
      log('⚠️ No tokens to subscribe');
      return;
    }

    log(`🔌 Connecting to CLOB...`);
    clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
    
    clobSocket.onopen = () => {
      log('✅ Connected to Polymarket CLOB');
      clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
      socket.send(JSON.stringify({ type: 'connected', markets: markets.size, tokens: tokenIds.length }));
    };

    clobSocket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        await processMarketEvent(data);
      } catch {}
    };

    clobSocket.onerror = (error) => log(`❌ CLOB error: ${error}`);

    clobSocket.onclose = () => {
      log('🔌 CLOB disconnected');
      socket.send(JSON.stringify({ type: 'disconnected' }));
      setTimeout(() => { if (isEnabled) connectToClob(); }, 5000);
    };
  };

  const processMarketEvent = async (data: any) => {
    const eventType = data.event_type;
    const nowMs = Date.now();
    
    if (eventType === 'book') {
      const assetId = data.asset_id;
      const marketInfo = tokenToMarket.get(assetId);
      
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
          } else {
            ctx.book.down.ask = topAsk;
            ctx.book.down.bid = topBid;
          }
          ctx.book.updatedAtMs = nowMs;
          
          await evaluateTradeOpportunity(marketInfo.slug, nowMs);
        }
      }
    } else if (eventType === 'price_change') {
      const changes = data.changes || data.price_changes || [];
      const affectedSlugs = new Set<string>();
      
      for (const change of changes) {
        const assetId = change.asset_id;
        const marketInfo = tokenToMarket.get(assetId);
        if (marketInfo) {
          const ctx = marketContexts.get(marketInfo.slug);
          if (ctx) {
            const price = parseFloat(change.price);
            if (marketInfo.side === 'up') {
              ctx.book.up.ask = price;
            } else {
              ctx.book.down.ask = price;
            }
            ctx.book.updatedAtMs = nowMs;
            affectedSlugs.add(marketInfo.slug);
          }
        }
      }
      
      for (const slug of affectedSlugs) {
        await evaluateTradeOpportunity(slug, nowMs);
      }
    }
  };

  // Lock is now managed via ctx.inFlight

  const evaluateTradeOpportunity = async (slug: string, nowMs: number) => {
    if (!isEnabled) return;
    
    const market = markets.get(slug);
    const ctx = marketContexts.get(slug);
    if (!market || !ctx) return;
    
    // LOCK CHECK: Use ctx.inFlight which persists across calls
    if (ctx.inFlight) return;
    ctx.inFlight = true;
    
    try {
      // Only trade the CURRENT 15-min market (must be in its active window)
      const startTime = new Date(market.eventStartTime).getTime();
      const endTime = new Date(market.eventEndTime).getTime();
      if (nowMs < startTime || nowMs >= endTime) {
        return; // finally will release lock
      }

      // Update remaining seconds
      ctx.remainingSeconds = Math.floor((endTime - nowMs) / 1000);

      evaluationCount++;
      
      // Call the strategy (without internal inFlight - we handle it here)
      const result = decideTrades(ctx, DEFAULT_CONFIG, nowMs);
      
      // Log every 100th evaluation or when trading
      if (evaluationCount % 100 === 0 || result.shouldTrade) {
        const px = getExecutionPrices(ctx, DEFAULT_CONFIG);
        if (px) {
          const combined = px.upExec + px.downExec;
          log(`📊 ${slug.slice(-20)}: ${(px.upExec*100).toFixed(0)}¢+${(px.downExec*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | pos: ${ctx.position.upShares}UP/${ctx.position.downShares}DOWN | ${result.shouldTrade ? '🚀' : '⏸️'} ${result.reason.slice(0, 40)}`);
        }
      }
      
      if (!result.shouldTrade || result.trades.length === 0) {
        return; // finally will release lock
      }
      
      // DATABASE DUPLICATE CHECK: Before inserting, verify no trades exist for this market yet
      // This prevents race conditions across multiple WebSocket connections
      const tradeType = result.trades[0]?.type;
      if (tradeType === 'OPENING') {
        const { data: existingTrades } = await supabase
          .from('paper_trades')
          .select('id')
          .eq('market_slug', slug)
          .limit(1);
        
        if (existingTrades && existingTrades.length > 0) {
          log(`⚠️ DUPLICATE BLOCKED: ${slug} already has trades`);
          return; // Don't insert, already have trades for this market
        }
      } else if (tradeType === 'HEDGE') {
        // Check if we already have this outcome for this market
        const hedgeOutcome = result.trades[0]?.outcome;
        const { data: existingHedge } = await supabase
          .from('paper_trades')
          .select('id')
          .eq('market_slug', slug)
          .eq('outcome', hedgeOutcome)
          .limit(1);
        
        if (existingHedge && existingHedge.length > 0) {
          log(`⚠️ HEDGE DUPLICATE BLOCKED: ${slug} ${hedgeOutcome} already exists`);
          return;
        }
      }
      
      // IMPORTANT: Update position BEFORE inserting to DB (prevents duplicate trades)
      for (const intent of result.trades) {
        if (intent.outcome === 'UP') {
          ctx.position.upShares += intent.shares;
          ctx.position.upInvested += intent.notionalUsd;
        } else {
          ctx.position.downShares += intent.shares;
          ctx.position.downInvested += intent.notionalUsd;
        }
      }
      ctx.lastTradeAtMs = nowMs;
      
      // Now insert to database
      const trades: PaperTrade[] = [];
      const px = getExecutionPrices(ctx, DEFAULT_CONFIG);
      if (!px) return;
      
      const combinedPrice = px.upExec + px.downExec;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      
      const cryptoPrice = market.asset === 'BTC' ? cryptoPrices.btc : cryptoPrices.eth;
      const priceDelta = cryptoPrice && market.openPrice ? cryptoPrice - market.openPrice : null;
      const priceDeltaPercent = priceDelta && market.openPrice ? (priceDelta / market.openPrice) * 100 : null;
      
      for (const intent of result.trades) {
        const bestAsk = intent.outcome === 'UP' ? ctx.book.up.ask : ctx.book.down.ask;
        const bestBid = intent.outcome === 'UP' ? ctx.book.up.bid : ctx.book.down.bid;
        
        trades.push({
          market_slug: slug,
          asset: market.asset,
          outcome: intent.outcome,
          price: intent.limitPrice,
          shares: intent.shares,
          total: intent.notionalUsd,
          trade_type: intent.type,
          reasoning: intent.reason,
          crypto_price: cryptoPrice,
          open_price: market.openPrice,
          combined_price: combinedPrice,
          arbitrage_edge: arbitrageEdge,
          event_start_time: market.eventStartTime,
          event_end_time: market.eventEndTime,
          remaining_seconds: ctx.remainingSeconds,
          price_delta: priceDelta,
          price_delta_percent: priceDeltaPercent,
          best_bid: bestBid,
          best_ask: bestAsk,
          estimated_slippage: null,
          available_liquidity: null,
          avg_fill_price: intent.limitPrice,
        });
      }
      
      if (trades.length > 0) {
        const { error } = await supabase.from('paper_trades').insert(trades);
        
        if (error) {
          log(`❌ Insert error: ${error.message}`);
          // Rollback position on error
          for (const intent of result.trades) {
            if (intent.outcome === 'UP') {
              ctx.position.upShares -= intent.shares;
              ctx.position.upInvested -= intent.notionalUsd;
            } else {
              ctx.position.downShares -= intent.shares;
              ctx.position.downInvested -= intent.notionalUsd;
            }
          }
        } else {
          tradeCount += trades.length;
          
          // Verbeterde logging met shares balans info
          const ratio = ctx.position.upShares > 0 && ctx.position.downShares > 0 
            ? Math.max(ctx.position.upShares / ctx.position.downShares, ctx.position.downShares / ctx.position.upShares).toFixed(1)
            : 'N/A';
          log(`🚀 TRADE #${tradeCount}: ${slug.slice(-15)} | ${result.reason} | ${trades.map(t => `${t.outcome}:${t.shares}@${(t.price*100).toFixed(0)}¢`).join(' + ')} | Bal: UP=${ctx.position.upShares}/$${ctx.position.upInvested.toFixed(0)} DOWN=${ctx.position.downShares}/$${ctx.position.downInvested.toFixed(0)} Ratio:${ratio}`);
          socket.send(JSON.stringify({ 
            type: 'trade', 
            trades: trades.map(t => ({
              slug: t.market_slug,
              outcome: t.outcome,
              price: t.price,
              shares: t.shares,
              reasoning: t.reasoning,
              type: t.trade_type,
            })),
            timestamp: nowMs 
          }));
        }
      }
    } catch (err) {
      log(`❌ Trade error: ${err}`);
    } finally {
      // Always release the lock
      ctx.inFlight = false;
    }
  };

  const connectToRtds = () => {
    const rtdsSocket = new WebSocket(`${supabaseUrl.replace('https', 'wss')}/functions/v1/rtds-proxy`);
    
    rtdsSocket.onopen = () => {
      log('✅ Connected to Chainlink RTDS');
      rtdsSocket.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }]
      }));
    };
    
    rtdsSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        if (data.payload?.symbol === 'btc/usd') cryptoPrices.btc = data.payload.value;
        else if (data.payload?.symbol === 'eth/usd') cryptoPrices.eth = data.payload.value;
      } catch {}
    };
    
    rtdsSocket.onerror = () => log('⚠️ RTDS error');
    rtdsSocket.onclose = () => {
      log('🔌 RTDS disconnected');
      setTimeout(connectToRtds, 5000);
    };
  };

  const startStatusLogging = () => {
    statusLogInterval = setInterval(() => {
      const marketsWithBook = [...marketContexts.values()].filter(
        c => c.book.up.ask !== null || c.book.down.ask !== null
      ).length;
      const totalInvested = [...marketContexts.values()].reduce(
        (sum, c) => sum + c.position.upInvested + c.position.downInvested, 0
      );
      log(`📈 Status: ${marketsWithBook}/${markets.size} markets | BTC:$${cryptoPrices.btc?.toFixed(0) ?? 'N/A'} ETH:$${cryptoPrices.eth?.toFixed(0) ?? 'N/A'} | Invested:$${totalInvested.toFixed(0)} | Evals:${evaluationCount} Trades:${tradeCount}`);
    }, 30000);
  };

  socket.onopen = async () => {
    log('👋 Client connected');
    
    isEnabled = await checkBotEnabled();
    if (!isEnabled) {
      log('⚠️ Bot is disabled');
      socket.send(JSON.stringify({ type: 'disabled' }));
      return;
    }
    
    log('🟢 Bot ENABLED - V5 Investment-Balanced (50/50 split, 2s cooldown, max 2.5:1 ratio)');
    socket.send(JSON.stringify({ type: 'enabled' }));
    
    await fetchMarkets();
    await fetchExistingTrades();
    
    connectToClob();
    connectToRtds();
    startStatusLogging();
    
    // Auto-settle expired markets every 30 seconds
    const settleInterval = setInterval(async () => {
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/settle-paper-trades`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (response.ok) {
          const result = await response.json();
          if (result.settled > 0) {
            log(`💰 Auto-settled ${result.settled} markets`);
          }
        }
      } catch (err) {
        // Silent fail - settlement will retry
      }
    }, 30000);
    
    const refreshInterval = setInterval(async () => {
      isEnabled = await checkBotEnabled();
      if (!isEnabled) {
        log('🔴 Bot disabled, stopping');
        clobSocket?.close();
        clearInterval(refreshInterval);
        clearInterval(settleInterval);
        if (statusLogInterval) clearInterval(statusLogInterval);
        return;
      }
      await fetchMarkets();
      await fetchExistingTrades();
    }, 60000);
  };

  socket.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data.toString());
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    } catch {}
  };

  socket.onclose = () => {
    log('👋 Client disconnected');
    clobSocket?.close();
    if (statusLogInterval) clearInterval(statusLogInterval);
  };

  return response;
}

async function handleHttpRequest(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { data: settings } = await supabase
      .from('paper_bot_settings')
      .select('is_enabled')
      .limit(1)
      .maybeSingle();

    const isEnabled = settings?.is_enabled ?? false;

    const { data: recentTrades } = await supabase
      .from('paper_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    return new Response(JSON.stringify({
      success: true,
      isEnabled,
      strategy: 'INVESTMENT_BALANCED_V5',
      config: DEFAULT_CONFIG,
      recentTrades: recentTrades || [],
      message: isEnabled 
        ? '🟢 V5 Investment-Balanced is ACTIVE (50/50 split, max 2.5:1 ratio)'
        : '🔴 Bot is disabled',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
