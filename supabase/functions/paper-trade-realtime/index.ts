import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// GABAGOOL-STYLE TRADING STRATEGY V3 (IMPROVED)
// Fixed: bid-based paper execution, both-side checks, dedup, per-side limits
// ============================================================================

type Outcome = "UP" | "DOWN";
type OrderSide = "BUY" | "SELL";

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
  priceToBeat?: number | null;
  lastTradeAtMs: number;
  // NEW: de-dupe state
  lastDecisionKey?: string | null;
  inFlight?: boolean;
}

interface TradeIntent {
  outcome: Outcome;
  side: OrderSide;
  limitPrice: number;
  notionalUsd: number;
  shares: number;
  type: "OPENING_DUAL" | "HEDGE_MISSING_SIDE" | "DCA_CHEAP_DUAL" | "DCA_BALANCE" | "ARB_DUAL" | "SKIP";
  reason: string;
}

interface StrategyConfig {
  tradeSize: { min: number; max: number; base: number };
  positionLimits: { maxPerSide: number; maxTotal: number };
  entry: {
    minSecondsRemaining: number;
    minPrice: number;
    maxPrice: number;
    cheapThreshold: number;
    imbalanceThresholdPct: number;
    staleBookMs: number;
  };
  arbitrage: { strongEdge: number; normalEdge: number; maxReasonable: number };
  multipliers: { strongArb: number; arb: number; neutral: number; pricey: number };
  hf: { 
    tickMinIntervalMs: number; 
    minNotionalToTrade: number;
    dedupeWindowMs: number;  // NEW: de-dupe window
  };
  split: { mode: "EQUAL" | "CHEAPER_BIAS"; cheaperBiasPct: number };
  execution: {
    mode: "PAPER_BID" | "LIVE_ASK";  // NEW: execution mode
    bidMissing: "FALLBACK_TO_ASK" | "SKIP";  // NEW: fallback behavior
  };
}

const DEFAULT_CONFIG: StrategyConfig = {
  tradeSize: { min: 5, max: 25, base: 10 },
  positionLimits: { maxPerSide: 200, maxTotal: 350 },
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    cheapThreshold: 0.25,
    imbalanceThresholdPct: 30,
    staleBookMs: 2000,
  },
  arbitrage: {
    strongEdge: 0.94,   // Combined < 94¢ = strong arb (6% edge)
    normalEdge: 0.97,   // Combined < 97¢ = normal arb (3% edge)
    maxReasonable: 0.995, // ONLY trade if combined < 99.5¢
  },
  multipliers: {
    strongArb: 2.5,
    arb: 1.5,
    neutral: 0.0,  // Disabled
    pricey: 0.0,   // Disabled
  },
  hf: {
    tickMinIntervalMs: 3000,
    minNotionalToTrade: 3.0,
    dedupeWindowMs: 950,  // NEW: prevent duplicate signals within ~1s
  },
  split: {
    mode: "CHEAPER_BIAS",
    cheaperBiasPct: 0.60,
  },
  execution: {
    mode: "PAPER_BID",        // NEW: simulate on bid prices
    bidMissing: "FALLBACK_TO_ASK",  // NEW: fallback if bid missing
  },
};

// ============================================================================
// STRATEGY LOGIC (IMPROVED)
// ============================================================================

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function skip(reason: string): { shouldTrade: false; reason: string; trades: TradeIntent[] } {
  return { shouldTrade: false, reason, trades: [] };
}

function commit(ctx: MarketContext, nowMs: number, reason: string, trades: TradeIntent[]): 
  { shouldTrade: true; reason: string; trades: TradeIntent[] } | { shouldTrade: false; reason: string; trades: TradeIntent[] } {
  if (!trades.length) return skip("BLOCKED");
  ctx.lastTradeAtMs = nowMs;
  return { shouldTrade: true, reason, trades };
}

// NEW: Make a decision key for de-duplication
function makeDecisionKey(slug: string, up: number, down: number, combined: number, nowMs: number, windowMs: number): string {
  const bucket = Math.floor(nowMs / windowMs);
  const r = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
  return `${slug}|${bucket}|u=${r(up)}|d=${r(down)}|c=${r(combined)}`;
}

// NEW: Get execution prices based on mode (paper = bid, live = ask)
function getExecutionPrices(ctx: MarketContext, cfg: StrategyConfig): 
  { upExec: number; downExec: number; upRef: number; downRef: number } | null {
  const upBid = ctx.book.up.bid;
  const downBid = ctx.book.down.bid;
  const upAsk = ctx.book.up.ask;
  const downAsk = ctx.book.down.ask;

  const wantBid = cfg.execution.mode === "PAPER_BID";

  if (wantBid) {
    if (isFiniteNum(upBid) && isFiniteNum(downBid)) {
      return { upExec: upBid, downExec: downBid, upRef: upBid, downRef: downBid };
    }
    if (cfg.execution.bidMissing === "FALLBACK_TO_ASK" && isFiniteNum(upAsk) && isFiniteNum(downAsk)) {
      return { upExec: upAsk, downExec: downAsk, upRef: upAsk, downRef: downAsk };
    }
    return null;
  } else {
    if (!isFiniteNum(upAsk) || !isFiniteNum(downAsk)) return null;
    return { upExec: upAsk, downExec: downAsk, upRef: upAsk, downRef: downAsk };
  }
}

// VALUE imbalance (better than shares)
function valueImbalancePct(pos: MarketPosition, upPx: number, downPx: number): number {
  const upVal = pos.upShares * upPx;
  const downVal = pos.downShares * downPx;
  const total = upVal + downVal;
  if (total <= 0) return 0;
  return ((upVal - downVal) / total) * 100;
}

function mkBuy(outcome: Outcome, price: number, notionalUsd: number, type: TradeIntent["type"], reason: string): TradeIntent {
  const shares = Math.floor(notionalUsd / price);
  return { outcome, side: "BUY", limitPrice: price, notionalUsd, shares, type, reason };
}

function splitNotional(notional: number, up: number, down: number, cfg: StrategyConfig): [number, number] {
  if (cfg.split.mode === "EQUAL") return [notional * 0.5, notional * 0.5];
  const bias = clamp(cfg.split.cheaperBiasPct, 0.5, 0.75);
  return up <= down ? [notional * bias, notional * (1 - bias)] : [notional * (1 - bias), notional * bias];
}

function dualTrades(notional: number, up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig, type: TradeIntent["type"], reasonPrefix: string): TradeIntent[] {
  const [uN, dN] = splitNotional(notional, up, down, cfg);
  const out: TradeIntent[] = [];
  if (canUp) out.push(mkBuy("UP", up, uN, type, `${reasonPrefix} (UP @ ${(up*100).toFixed(0)}¢)`));
  if (canDown) out.push(mkBuy("DOWN", down, dN, type, `${reasonPrefix} (DOWN @ ${(down*100).toFixed(0)}¢)`));
  return out.filter(t => t.notionalUsd >= cfg.hf.minNotionalToTrade && t.shares >= 1);
}

function buildOpeningDual(up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig): TradeIntent[] {
  const notional = clamp(cfg.tradeSize.base, cfg.tradeSize.min, cfg.tradeSize.max);
  return dualTrades(notional, up, down, canUp, canDown, cfg, "OPENING_DUAL", "Opening dual-side baseline");
}

function buildHedgeMissing(up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig, pos: MarketPosition): TradeIntent[] {
  const notional = clamp(cfg.tradeSize.base, cfg.tradeSize.min, cfg.tradeSize.max);
  if (pos.upShares === 0 && canUp) return [mkBuy("UP", up, notional, "HEDGE_MISSING_SIDE", `Hedge missing UP @ ${(up*100).toFixed(0)}¢`)];
  if (pos.downShares === 0 && canDown) return [mkBuy("DOWN", down, notional, "HEDGE_MISSING_SIDE", `Hedge missing DOWN @ ${(down*100).toFixed(0)}¢`)];
  return [];
}

function buildCheapDual(up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig, combined: number): TradeIntent[] {
  const notional = clamp(cfg.tradeSize.base * cfg.multipliers.arb, cfg.tradeSize.min, cfg.tradeSize.max);
  const edgePct = ((1 - combined) * 100).toFixed(1);
  return dualTrades(notional, up, down, canUp, canDown, cfg, "DCA_CHEAP_DUAL", `Cheap DCA: ${edgePct}% edge`);
}

function buildRebalance(up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig, imbalancePct: number, combined: number): TradeIntent[] {
  const notional = clamp(cfg.tradeSize.base, cfg.tradeSize.min, cfg.tradeSize.max);
  const edgePct = ((1 - combined) * 100).toFixed(1);
  const underweight: Outcome = imbalancePct > 0 ? "DOWN" : "UP";
  if (underweight === "UP" && canUp) return [mkBuy("UP", up, notional, "DCA_BALANCE", `Rebalance: UP underweight (imbalance ${imbalancePct.toFixed(0)}%, edge ${edgePct}%)`)];
  if (underweight === "DOWN" && canDown) return [mkBuy("DOWN", down, notional, "DCA_BALANCE", `Rebalance: DOWN underweight (imbalance ${imbalancePct.toFixed(0)}%, edge ${edgePct}%)`)];
  return [];
}

function buildArbDual(up: number, down: number, canUp: boolean, canDown: boolean, cfg: StrategyConfig, combined: number): TradeIntent[] {
  const mult = combined < cfg.arbitrage.strongEdge ? cfg.multipliers.strongArb : cfg.multipliers.arb;
  const notional = clamp(cfg.tradeSize.base * mult, cfg.tradeSize.min, cfg.tradeSize.max);
  const edgePct = ((1 - combined) * 100).toFixed(1);
  const zone = combined < cfg.arbitrage.strongEdge ? "STRONG" : "NORMAL";
  return dualTrades(notional, up, down, canUp, canDown, cfg, "ARB_DUAL", `ARB ${zone}: ${edgePct}% edge (${(up*100).toFixed(0)}¢+${(down*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢)`);
}

/**
 * MAIN ENTRY: Decide trades for a single market tick.
 * FIXED: bid-based execution, both-side checks, inFlight lock, decisionKey de-dupe, per-side limits
 */
function decideTrades(
  ctx: MarketContext,
  cfg: StrategyConfig = DEFAULT_CONFIG,
  nowMs: number = Date.now()
): { shouldTrade: boolean; reason: string; trades: TradeIntent[] } {
  
  // ---- SINGLE-FLIGHT LOCK (race condition fix) ----
  if (ctx.inFlight) return skip("IN_FLIGHT");
  ctx.inFlight = true;

  try {
    // 1) COOLDOWN
    if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < cfg.hf.tickMinIntervalMs) {
      return skip(`COOLDOWN: ${cfg.hf.tickMinIntervalMs}ms not elapsed`);
    }

    // 2) EXPIRY
    if (ctx.remainingSeconds < cfg.entry.minSecondsRemaining) {
      return skip(`TOO_CLOSE_TO_EXPIRY: ${ctx.remainingSeconds}s < ${cfg.entry.minSecondsRemaining}s`);
    }

    // 3) BOOK FRESHNESS
    if (nowMs - ctx.book.updatedAtMs > cfg.entry.staleBookMs) {
      return skip(`STALE_BOOK: ${nowMs - ctx.book.updatedAtMs}ms`);
    }

    // 4) Determine execution prices (paper = bid, live = ask)
    const px = getExecutionPrices(ctx, cfg);
    if (!px) return skip("MISSING_PRICES");

    const { upExec, downExec, upRef, downRef } = px;

    // 5) PRICE SANITY (check BOTH sides) - FIXED
    if (upExec < cfg.entry.minPrice || upExec > cfg.entry.maxPrice) {
      return skip(`UP_PRICE_OUT_OF_RANGE: ${(upExec*100).toFixed(0)}¢`);
    }
    if (downExec < cfg.entry.minPrice || downExec > cfg.entry.maxPrice) {
      return skip(`DOWN_PRICE_OUT_OF_RANGE: ${(downExec*100).toFixed(0)}¢`);
    }

    // 6) LIMITS (total + per-side) - FIXED: check per-side
    const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
    if (totalInvested >= cfg.positionLimits.maxTotal) {
      return skip(`POSITION_LIMIT_TOTAL: $${totalInvested.toFixed(0)} >= $${cfg.positionLimits.maxTotal}`);
    }

    const canBuyUp = ctx.position.upInvested < cfg.positionLimits.maxPerSide;
    const canBuyDown = ctx.position.downInvested < cfg.positionLimits.maxPerSide;

    // 7) EDGE REQUIREMENT: combined must be < maxReasonable (99.5¢)
    const combined = upExec + downExec;

    // ---- DECISION KEY (dedupe identical signals) ----
    const decisionKey = makeDecisionKey(ctx.slug, upExec, downExec, combined, nowMs, cfg.hf.dedupeWindowMs);
    if (ctx.lastDecisionKey === decisionKey) return skip("DEDUPED");
    ctx.lastDecisionKey = decisionKey;

    if (combined >= cfg.arbitrage.maxReasonable) {
      return skip(`NO_EDGE: combined ${(combined*100).toFixed(1)}¢ >= ${(cfg.arbitrage.maxReasonable*100).toFixed(1)}¢`);
    }

    // ---- TRADE TYPES PRIORITY ----

    // A) OPENING_DUAL: both sides missing
    if (ctx.position.upShares === 0 && ctx.position.downShares === 0) {
      const trades = buildOpeningDual(upExec, downExec, canBuyUp, canBuyDown, cfg);
      return commit(ctx, nowMs, "OPENING_DUAL", trades);
    }

    // B) HEDGE_MISSING_SIDE: one side missing
    if (ctx.position.upShares === 0 || ctx.position.downShares === 0) {
      const trades = buildHedgeMissing(upExec, downExec, canBuyUp, canBuyDown, cfg, ctx.position);
      return commit(ctx, nowMs, "HEDGE_MISSING_SIDE", trades);
    }

    // C) DCA_CHEAP_DUAL (≤25¢) - still requires edge gate already passed
    if (upExec <= cfg.entry.cheapThreshold || downExec <= cfg.entry.cheapThreshold) {
      const trades = buildCheapDual(upExec, downExec, canBuyUp, canBuyDown, cfg, combined);
      return commit(ctx, nowMs, "DCA_CHEAP_DUAL", trades);
    }

    // D) DCA_BALANCE (>30% skew) - by VALUE, not shares
    const imbalancePct = valueImbalancePct(ctx.position, upRef, downRef);
    if (Math.abs(imbalancePct) > cfg.entry.imbalanceThresholdPct) {
      const trades = buildRebalance(upExec, downExec, canBuyUp, canBuyDown, cfg, imbalancePct, combined);
      return commit(ctx, nowMs, "DCA_BALANCE", trades);
    }

    // E) ARB_DUAL (Combined < 97¢) - accumulate both sides
    if (combined < cfg.arbitrage.normalEdge) {
      const trades = buildArbDual(upExec, downExec, canBuyUp, canBuyDown, cfg, combined);
      return commit(ctx, nowMs, "ARB_DUAL", trades);
    }

    // Neutral is disabled in config
    return skip("SKIP: no trade type matched");
    
  } finally {
    ctx.inFlight = false;
  }
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
    console.log(`[PaperBot] ${msg}`);
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
      log(`📋 Loaded ${totalTrades} trades across ${marketsWithPositions} markets with positions`);
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

  const evaluateTradeOpportunity = async (slug: string, nowMs: number) => {
    if (!isEnabled) return;
    
    const market = markets.get(slug);
    const ctx = marketContexts.get(slug);
    if (!market || !ctx) return;
    
    // inFlight check is now inside decideTrades, but we skip if already processing
    if (ctx.inFlight) return;
    
    // Update remaining seconds
    const endTime = new Date(market.eventEndTime).getTime();
    ctx.remainingSeconds = Math.floor((endTime - nowMs) / 1000);
    
    evaluationCount++;
    
    // Call the improved strategy
    const result = decideTrades(ctx, DEFAULT_CONFIG, nowMs);
    
    // Log every 50th evaluation or when trading
    if (evaluationCount % 50 === 0 || result.shouldTrade) {
      // Use execution prices for logging
      const px = getExecutionPrices(ctx, DEFAULT_CONFIG);
      if (px) {
        const combined = px.upExec + px.downExec;
        log(`📊 ${slug.slice(-20)}: ${(px.upExec*100).toFixed(0)}¢+${(px.downExec*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | ${result.shouldTrade ? '🚀' : '⏸️'} ${result.reason.slice(0, 60)}`);
      }
    }
    
    if (!result.shouldTrade || result.trades.length === 0) return;
    
    try {
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
        } else {
          tradeCount += trades.length;
          
          // Update local position state
          for (const trade of trades) {
            if (trade.outcome === 'UP') {
              ctx.position.upShares += trade.shares;
              ctx.position.upInvested += trade.total;
            } else {
              ctx.position.downShares += trade.shares;
              ctx.position.downInvested += trade.total;
            }
          }
          ctx.lastTradeAtMs = nowMs;
          
          log(`🚀 TRADED #${tradeCount}: ${slug} | ${result.reason} | ${trades.map(t => `${t.outcome}:${t.shares}`).join(' + ')}`);
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
    
    log('🟢 Bot ENABLED - Gabagool HF strategy V3 (bid-based paper trading)');
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
      strategy: 'GABAGOOL_HF_V3',
      config: DEFAULT_CONFIG,
      recentTrades: recentTrades || [],
      message: isEnabled 
        ? '🟢 Gabagool HF V3 paper trading bot is ACTIVE (bid-based execution)'
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
