import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// GABAGOOL-STYLE TRADING STRATEGY (execution-ready)
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
  lastTradeAtMs?: number;
}

interface TradeIntent {
  outcome: Outcome;
  side: OrderSide;
  limitPrice: number;
  notionalUsd: number;
  shares: number;
  type: "OPENING_DUAL" | "HEDGE_MISSING_SIDE" | "DCA_CHEAP_DUAL" | "DCA_BALANCE" | "ARB_DUAL" | "NEUTRAL_DUAL" | "SKIP";
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
  hf: { tickMinIntervalMs: number; minNotionalToTrade: number };
  split: { mode: "EQUAL" | "CHEAPER_BIAS"; cheaperBiasPct: number };
}

const DEFAULT_CONFIG: StrategyConfig = {
  tradeSize: { min: 3, max: 15, base: 8 },
  positionLimits: { maxPerSide: 150, maxTotal: 250 },
  entry: {
    minSecondsRemaining: 30,
    minPrice: 0.02,
    maxPrice: 0.95,
    cheapThreshold: 0.2,
    imbalanceThresholdPct: 20,
    staleBookMs: 1500,
  },
  arbitrage: {
    strongEdge: 0.95,
    normalEdge: 0.98,
    maxReasonable: 1.02,
  },
  multipliers: {
    strongArb: 2.0,
    arb: 1.5,
    neutral: 1.0,
    pricey: 0.25,
  },
  hf: {
    tickMinIntervalMs: 800,
    minNotionalToTrade: 1.5,
  },
  split: {
    mode: "CHEAPER_BIAS",
    cheaperBiasPct: 0.55,
  },
};

// ============================================================================
// STRATEGY LOGIC
// ============================================================================

type Zone = "STRONG_ARB" | "ARB" | "NEUTRAL" | "PRICEY" | "TOO_EXPENSIVE";

function classifyZone(combined: number, cfg: StrategyConfig): Zone {
  if (combined < cfg.arbitrage.strongEdge) return "STRONG_ARB";
  if (combined < cfg.arbitrage.normalEdge) return "ARB";
  if (combined <= 1.0) return "NEUTRAL";
  if (combined <= cfg.arbitrage.maxReasonable) return "PRICEY";
  return "TOO_EXPENSIVE";
}

function computeBaseNotional(remainingSeconds: number, combined: number, cfg: StrategyConfig): number {
  const zone = classifyZone(combined, cfg);
  let notional = cfg.tradeSize.base;

  if (zone === "STRONG_ARB") notional *= cfg.multipliers.strongArb;
  else if (zone === "ARB") notional *= cfg.multipliers.arb;
  else if (zone === "NEUTRAL") notional *= cfg.multipliers.neutral;
  else if (zone === "PRICEY") notional *= cfg.multipliers.pricey;

  if (remainingSeconds < 60) notional *= 0.5;
  return clamp(notional, cfg.tradeSize.min, cfg.tradeSize.max);
}

function splitNotionalDual(notional: number, upAsk: number, downAsk: number, cfg: StrategyConfig): [number, number] {
  if (cfg.split.mode === "EQUAL") return [notional * 0.5, notional * 0.5];
  const bias = clamp(cfg.split.cheaperBiasPct, 0.5, 0.75);
  if (upAsk <= downAsk) return [notional * bias, notional * (1 - bias)];
  return [notional * (1 - bias), notional * bias];
}

function getValueImbalancePct(
  pos: MarketPosition,
  prices: { upBid: number | null; downBid: number | null; upAsk: number; downAsk: number }
): number {
  const upPx = isFiniteNum(prices.upBid) ? prices.upBid : prices.upAsk;
  const downPx = isFiniteNum(prices.downBid) ? prices.downBid : prices.downAsk;
  const upVal = pos.upShares * upPx;
  const downVal = pos.downShares * downPx;
  const total = upVal + downVal;
  if (total <= 0) return 0;
  return ((upVal - downVal) / total) * 100;
}

function mkBuy(outcome: Outcome, limitPrice: number, notionalUsd: number, type: TradeIntent["type"], reason: string): TradeIntent {
  const shares = Math.floor(notionalUsd / limitPrice);
  return { outcome, side: "BUY", limitPrice, notionalUsd, shares, type, reason };
}

function filterTradeDust(trades: TradeIntent[], cfg: StrategyConfig): TradeIntent[] {
  return trades
    .filter(t => t.notionalUsd >= cfg.hf.minNotionalToTrade)
    .filter(t => t.shares >= 1)
    .filter(t => t.limitPrice >= cfg.entry.minPrice && t.limitPrice <= cfg.entry.maxPrice);
}

function skip(nextState: MarketContext, code: string, why: string) {
  return { shouldTrade: false, reason: `${code}: ${why}`, trades: [] as TradeIntent[], nextState };
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * MAIN ENTRY: Decide trades for a single market tick.
 */
function decideTrades(
  ctx: MarketContext,
  cfg: StrategyConfig = DEFAULT_CONFIG,
  nowMs: number = Date.now()
): { shouldTrade: boolean; reason: string; trades: TradeIntent[]; nextState: MarketContext } {
  const nextState: MarketContext = { ...ctx, lastTradeAtMs: ctx.lastTradeAtMs };

  // HF throttle
  if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < cfg.hf.tickMinIntervalMs) {
    return skip(nextState, "COOLDOWN", `Cooldown ${cfg.hf.tickMinIntervalMs}ms not elapsed`);
  }

  // Expiry guard
  if (ctx.remainingSeconds < cfg.entry.minSecondsRemaining) {
    return skip(nextState, "TOO_CLOSE_TO_EXPIRY", `Remaining ${ctx.remainingSeconds}s < ${cfg.entry.minSecondsRemaining}s`);
  }

  // Book freshness
  if (nowMs - ctx.book.updatedAtMs > cfg.entry.staleBookMs) {
    return skip(nextState, "STALE_BOOK", `Book stale: ${nowMs - ctx.book.updatedAtMs}ms`);
  }

  const upAsk = ctx.book.up.ask;
  const downAsk = ctx.book.down.ask;
  const upBid = ctx.book.up.bid;
  const downBid = ctx.book.down.bid;

  if (!isFiniteNum(upAsk) || !isFiniteNum(downAsk)) {
    return skip(nextState, "MISSING_ASK", "Missing top-of-book ask(s)");
  }

  // Price sanity
  if (upAsk < cfg.entry.minPrice || downAsk < cfg.entry.minPrice) {
    return skip(nextState, "PRICE_TOO_LOW", `Ask too low (upAsk=${upAsk}, downAsk=${downAsk})`);
  }
  if (upAsk > cfg.entry.maxPrice || downAsk > cfg.entry.maxPrice) {
    return skip(nextState, "PRICE_TOO_HIGH", `Ask too high (upAsk=${upAsk}, downAsk=${downAsk})`);
  }

  // Limits
  const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
  if (totalInvested >= cfg.positionLimits.maxTotal) {
    return skip(nextState, "POSITION_LIMIT_TOTAL", `Total invested ${totalInvested} >= ${cfg.positionLimits.maxTotal}`);
  }

  const combined = upAsk + downAsk;
  const zone = classifyZone(combined, cfg);

  // If combined is wildly expensive, skip
  if (zone === "TOO_EXPENSIVE") {
    return skip(nextState, "TOO_EXPENSIVE", `Combined ${(combined * 100).toFixed(2)}¢ > ${(cfg.arbitrage.maxReasonable * 100).toFixed(2)}¢`);
  }

  // Compute base notional and multiplier by zone + time scaling
  const baseNotional = computeBaseNotional(ctx.remainingSeconds, combined, cfg);

  // Always enforce per-side limits
  const canBuyUp = ctx.position.upInvested < cfg.positionLimits.maxPerSide;
  const canBuyDown = ctx.position.downInvested < cfg.positionLimits.maxPerSide;

  // If one side missing, hedge immediately (dual-side always)
  const missingUp = ctx.position.upShares <= 0;
  const missingDown = ctx.position.downShares <= 0;

  if (missingUp || missingDown) {
    const trades: TradeIntent[] = [];

    // Opening: if both missing, do dual opening
    if (missingUp && missingDown) {
      const [uNotional, dNotional] = splitNotionalDual(baseNotional, upAsk, downAsk, cfg);
      if (canBuyUp) trades.push(mkBuy("UP", upAsk, uNotional, "OPENING_DUAL", "Opening dual-side baseline (UP leg)"));
      if (canBuyDown) trades.push(mkBuy("DOWN", downAsk, dNotional, "OPENING_DUAL", "Opening dual-side baseline (DOWN leg)"));

      const filtered = filterTradeDust(trades, cfg);
      if (filtered.length === 0) return skip(nextState, "OPENING_BLOCKED", "Opening blocked by limits or dust");

      nextState.lastTradeAtMs = nowMs;
      return { shouldTrade: true, reason: "OPENING_DUAL", trades: filtered, nextState };
    }

    // Hedge: buy only the missing side
    const outcome: Outcome = missingUp ? "UP" : "DOWN";
    const price = outcome === "UP" ? upAsk : downAsk;

    if ((outcome === "UP" && !canBuyUp) || (outcome === "DOWN" && !canBuyDown)) {
      return skip(nextState, "HEDGE_BLOCKED", `Missing side ${outcome} but per-side limit reached`);
    }

    const trade = mkBuy(outcome, price, baseNotional, "HEDGE_MISSING_SIDE", `Hedge missing side: ${outcome}`);
    const filtered = filterTradeDust([trade], cfg);
    if (filtered.length === 0) return skip(nextState, "HEDGE_DUST", "Hedge notional too small");

    nextState.lastTradeAtMs = nowMs;
    return { shouldTrade: true, reason: "HEDGE_MISSING_SIDE", trades: filtered, nextState };
  }

  // If prices are cheap, we can do a slightly larger dual buy
  if (upAsk <= cfg.entry.cheapThreshold || downAsk <= cfg.entry.cheapThreshold) {
    const cheapBoost = 1.5;
    const notional = clamp(baseNotional * cheapBoost, cfg.tradeSize.min, cfg.tradeSize.max);

    const [uNotional, dNotional] = splitNotionalDual(notional, upAsk, downAsk, cfg);

    const trades: TradeIntent[] = [];
    if (canBuyUp) trades.push(mkBuy("UP", upAsk, uNotional, "DCA_CHEAP_DUAL", `Cheap DCA dual (UP @ ${(upAsk * 100).toFixed(1)}¢)`));
    if (canBuyDown) trades.push(mkBuy("DOWN", downAsk, dNotional, "DCA_CHEAP_DUAL", `Cheap DCA dual (DOWN @ ${(downAsk * 100).toFixed(1)}¢)`));

    const filtered = filterTradeDust(trades, cfg);
    if (filtered.length === 0) return skip(nextState, "CHEAP_BLOCKED", "Cheap DCA blocked by limits/dust");

    nextState.lastTradeAtMs = nowMs;
    return { shouldTrade: true, reason: "DCA_CHEAP_DUAL", trades: filtered, nextState };
  }

  // Rebalance if value skew too large
  const imbalancePct = getValueImbalancePct(ctx.position, { upBid, downBid, upAsk, downAsk });
  if (Math.abs(imbalancePct) > cfg.entry.imbalanceThresholdPct) {
    const outcome: Outcome = imbalancePct > 0 ? "DOWN" : "UP";
    const price = outcome === "UP" ? upAsk : downAsk;

    if ((outcome === "UP" && !canBuyUp) || (outcome === "DOWN" && !canBuyDown)) {
      return skip(nextState, "REBAL_BLOCKED", `Rebalance wants ${outcome} but per-side limit reached`);
    }

    const trade = mkBuy(outcome, price, baseNotional, "DCA_BALANCE", `Rebalance by value: ${outcome} underweight (imbalance ${imbalancePct.toFixed(1)}%)`);
    const filtered = filterTradeDust([trade], cfg);
    if (filtered.length === 0) return skip(nextState, "REBAL_DUST", "Rebalance trade too small");

    nextState.lastTradeAtMs = nowMs;
    return { shouldTrade: true, reason: "DCA_BALANCE", trades: filtered, nextState };
  }

  // Accumulate: dual-leg trading most of the time
  if (zone === "STRONG_ARB" || zone === "ARB") {
    const [uNotional, dNotional] = splitNotionalDual(baseNotional, upAsk, downAsk, cfg);
    const trades: TradeIntent[] = [];

    if (canBuyUp) trades.push(mkBuy("UP", upAsk, uNotional, "ARB_DUAL", `ARB dual (combined ${(combined * 100).toFixed(1)}¢)`));
    if (canBuyDown) trades.push(mkBuy("DOWN", downAsk, dNotional, "ARB_DUAL", `ARB dual (combined ${(combined * 100).toFixed(1)}¢)`));

    const filtered = filterTradeDust(trades, cfg);
    if (filtered.length === 0) return skip(nextState, "ARB_BLOCKED", "ARB blocked by limits/dust");

    nextState.lastTradeAtMs = nowMs;
    return { shouldTrade: true, reason: "ARB_DUAL", trades: filtered, nextState };
  }

  // NEUTRAL zone: still do small dual buys
  if (zone === "NEUTRAL") {
    const neutralNotional = clamp(baseNotional * cfg.multipliers.neutral, cfg.tradeSize.min, cfg.tradeSize.max);
    const [uNotional, dNotional] = splitNotionalDual(neutralNotional, upAsk, downAsk, cfg);

    const trades: TradeIntent[] = [];
    if (canBuyUp) trades.push(mkBuy("UP", upAsk, uNotional, "NEUTRAL_DUAL", `Neutral dual (combined ${(combined * 100).toFixed(1)}¢)`));
    if (canBuyDown) trades.push(mkBuy("DOWN", downAsk, dNotional, "NEUTRAL_DUAL", `Neutral dual (combined ${(combined * 100).toFixed(1)}¢)`));

    const filtered = filterTradeDust(trades, cfg);
    if (filtered.length === 0) return skip(nextState, "NEUTRAL_BLOCKED", "Neutral blocked by limits/dust");

    nextState.lastTradeAtMs = nowMs;
    return { shouldTrade: true, reason: "NEUTRAL_DUAL", trades: filtered, nextState };
  }

  return skip(nextState, "NO_SIGNAL", "No trade signal");
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
  let processingTrades: Set<string> = new Set();
  
  // NEW: Store per-market context for the new strategy
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
    if (processingTrades.has(slug)) return;
    
    const market = markets.get(slug);
    const ctx = marketContexts.get(slug);
    if (!market || !ctx) return;
    
    // Update remaining seconds
    const endTime = new Date(market.eventEndTime).getTime();
    ctx.remainingSeconds = Math.floor((endTime - nowMs) / 1000);
    
    evaluationCount++;
    
    // Call the new strategy
    const result = decideTrades(ctx, DEFAULT_CONFIG, nowMs);
    
    // Log every 50th evaluation or when trading
    if (evaluationCount % 50 === 0 || result.shouldTrade) {
      const upAsk = ctx.book.up.ask ?? 0.5;
      const downAsk = ctx.book.down.ask ?? 0.5;
      const combined = upAsk + downAsk;
      log(`📊 ${slug.slice(-20)}: ${(upAsk*100).toFixed(0)}¢+${(downAsk*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | ${result.shouldTrade ? '🚀' : '⏸️'} ${result.reason.slice(0, 60)}`);
    }
    
    if (!result.shouldTrade || result.trades.length === 0) return;
    
    processingTrades.add(slug);
    
    try {
      const trades: PaperTrade[] = [];
      const upAsk = ctx.book.up.ask ?? 0.5;
      const downAsk = ctx.book.down.ask ?? 0.5;
      const combinedPrice = upAsk + downAsk;
      const arbitrageEdge = (1 - combinedPrice) * 100;
      
      const cryptoPrice = market.asset === 'BTC' ? cryptoPrices.btc : cryptoPrices.eth;
      const priceDelta = cryptoPrice && market.openPrice ? cryptoPrice - market.openPrice : null;
      const priceDeltaPercent = priceDelta && market.openPrice ? (priceDelta / market.openPrice) * 100 : null;
      
      for (const intent of result.trades) {
        const bestAsk = intent.outcome === 'UP' ? upAsk : downAsk;
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
    } finally {
      processingTrades.delete(slug);
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
    
    log('🟢 Bot ENABLED - New Gabagool HF strategy active');
    socket.send(JSON.stringify({ type: 'enabled' }));
    
    await fetchMarkets();
    await fetchExistingTrades();
    
    connectToClob();
    connectToRtds();
    startStatusLogging();
    
    const refreshInterval = setInterval(async () => {
      isEnabled = await checkBotEnabled();
      if (!isEnabled) {
        log('🔴 Bot disabled, stopping');
        clobSocket?.close();
        clearInterval(refreshInterval);
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
      strategy: 'GABAGOOL_HF_V2',
      config: DEFAULT_CONFIG,
      recentTrades: recentTrades || [],
      message: isEnabled 
        ? '🟢 Gabagool HF paper trading bot is ACTIVE'
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
