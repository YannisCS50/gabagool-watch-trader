import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// GABAGOOL REPLICATION STRATEGY V4
// Coverage trades without edge, Accumulate only with edge, fast HF cooldown
// ============================================================================

type Outcome = "UP" | "DOWN";
type OrderSide = "BUY" | "SELL";
type TradeType = "OPENING_DUAL" | "HEDGE" | "REBALANCE" | "ARB_DUAL";

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
  lastRebalanceAtMs: number;  // Separate cooldown for rebalance trades
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
  tradeSize: { min: number; max: number; base: number };
  positionLimits: { 
    maxPerSide: number; 
    maxTotal: number;
    maxSharesRatio: number;       // NIEUW: max ratio tussen UP/DOWN shares (bijv. 3 = max 3:1)
    maxSharesPerSide: number;     // NIEUW: absolute max shares per side
  };
  entry: {
    minSecondsRemaining: number;
    minPrice: number;
    maxPrice: number;
    investmentImbalanceThresholdPct: number;  // RENAMED: investment-based, not value-based
    staleBookMs: number;
  };
  edge: {
    arbMaxEntry: number;    // accumulate-only gate: 99.5¢
    strongArb: number;      // strong arb zone: 94¢
  };
  hf: { 
    tickMinIntervalMs: number; 
    dedupeWindowMs: number;
    minNotionalToTrade: number;
    rebalanceCooldownMs: number;
    postTradeCooldownMs: number;  // NIEUW: langere cooldown na trade
  };
  coverage: {
    openingNotional: number;
    hedgeNotional: number;
    rebalanceNotional: number;
    maxCombinedForCoverage: number;
    minSharesForRebalance: number;
  };
  split: { 
    mode: "EQUAL" | "VALUE_NEUTRAL";  // CHANGED: altijd 50/50 USD split
  };
  execution: {
    mode: "PAPER_BID" | "LIVE_ASK";
    bidMissing: "FALLBACK_TO_ASK" | "SKIP";
  };
}

const DEFAULT_CONFIG: StrategyConfig = {
  // V5: Realistische 15-min bets met share-balancering
  tradeSize: { min: 2, max: 10, base: 5 },   // Kleinere trades
  positionLimits: { 
    maxPerSide: 100,          // Max $100 invested per side (was 200)
    maxTotal: 180,            // Max $180 total (was 350)
    maxSharesRatio: 2.5,      // Max 2.5:1 shares ratio (voorkomt 11:1)
    maxSharesPerSide: 300,    // Max 300 shares per side (voorkomt 4435)
  },
  entry: {
    minSecondsRemaining: 45,  // Meer marge (was 30)
    minPrice: 0.03,           // Iets hoger (was 0.02)
    maxPrice: 0.92,           // Iets lager (was 0.95)
    investmentImbalanceThresholdPct: 25,  // 25% investment imbalance voor rebalance
    staleBookMs: 1500,
  },
  edge: {
    arbMaxEntry: 0.98,        // Strengere gate: 98¢ (was 99.5¢)
    strongArb: 0.92,          // Strong arb zone: 92¢ (was 94¢)
  },
  hf: {
    tickMinIntervalMs: 2000,  // Langere cooldown: 2s (was 900ms)
    dedupeWindowMs: 2500,     // Langere dedupe: 2.5s (was 950ms)
    minNotionalToTrade: 1.5,
    rebalanceCooldownMs: 60000,  // 60 sec rebalance cooldown (was 30s)
    postTradeCooldownMs: 3000,   // 3 sec na elke trade
  },
  coverage: {
    openingNotional: 4,       // Iets groter opening (was 3)
    hedgeNotional: 3,
    rebalanceNotional: 3,     // Kleiner rebalance (was 4)
    maxCombinedForCoverage: 1.01,  // Strenger (was 1.02)
    minSharesForRebalance: 15,     // Meer shares nodig (was 10)
  },
  split: {
    mode: "VALUE_NEUTRAL",    // ALTIJD 50/50 USD split
  },
  execution: {
    mode: "PAPER_BID",
    bidMissing: "FALLBACK_TO_ASK",
  },
};

// ============================================================================
// STRATEGY LOGIC (GABAGOOL REPLICATION V4)
// ============================================================================

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

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
  { upExec: number; downExec: number; upRef: number; downRef: number } | null {
  const upBid = ctx.book.up.bid;
  const downBid = ctx.book.down.bid;
  const upAsk = ctx.book.up.ask;
  const downAsk = ctx.book.down.ask;

  const wantBid = cfg.execution.mode === "PAPER_BID";

  if (wantBid) {
    if (isNum(upBid) && isNum(downBid)) {
      return { upExec: upBid, downExec: downBid, upRef: upBid, downRef: downBid };
    }
    if (cfg.execution.bidMissing === "FALLBACK_TO_ASK" && isNum(upAsk) && isNum(downAsk)) {
      return { upExec: upAsk, downExec: downAsk, upRef: upAsk, downRef: downAsk };
    }
    return null;
  } else {
    if (!isNum(upAsk) || !isNum(downAsk)) return null;
    return { upExec: upAsk, downExec: downAsk, upRef: upAsk, downRef: downAsk };
  }
}

// ============================================================================
// INVESTMENT-BASED BALANCING (niet value-based!)
// Dit is cruciaal voor 15-min bets waar shares €1 of €0 waard worden
// ============================================================================

// INVESTMENT imbalance (hoeveel USD geïnvesteerd per kant)
function investmentImbalancePct(pos: MarketPosition): number {
  const total = pos.upInvested + pos.downInvested;
  if (total <= 0) return 0;
  return ((pos.upInvested - pos.downInvested) / total) * 100;
}

// SHARES ratio check (voorkomt 4435 UP vs 380 DOWN situaties)
function sharesRatio(pos: MarketPosition): number {
  if (pos.upShares === 0 && pos.downShares === 0) return 1;
  if (pos.upShares === 0 || pos.downShares === 0) return Infinity;
  return Math.max(pos.upShares / pos.downShares, pos.downShares / pos.upShares);
}

function mkBuy(outcome: Outcome, price: number, notionalUsd: number, type: TradeType, reason: string): TradeIntent {
  const shares = Math.floor(notionalUsd / price);
  return { outcome, side: "BUY", limitPrice: price, notionalUsd, shares, type, reason };
}

// VALUE_NEUTRAL split: altijd 50/50 USD (elke kant krijgt gelijke investering)
// Dit is de sleutel voor arbitrage: gelijke investment = gegarandeerde winst bij combined < $1
function splitNotionalValueNeutral(notional: number): [number, number] {
  return [notional * 0.5, notional * 0.5];
}

function dualTrades(
  notional: number, 
  up: number, 
  down: number, 
  canUp: boolean, 
  canDown: boolean, 
  cfg: StrategyConfig, 
  type: TradeType, 
  reasonPrefix: string
): TradeIntent[] {
  // ALTIJD 50/50 split (value neutral)
  const [uN, dN] = splitNotionalValueNeutral(notional);
  const out: TradeIntent[] = [];
  
  // Alleen toevoegen als BEIDE kanten mogelijk zijn voor dual trades
  // Dit voorkomt onevenwichtige posities
  if (canUp && canDown) {
    out.push(mkBuy("UP", up, uN, type, `${reasonPrefix} (UP @ ${(up*100).toFixed(0)}¢)`));
    out.push(mkBuy("DOWN", down, dN, type, `${reasonPrefix} (DOWN @ ${(down*100).toFixed(0)}¢)`));
  }
  return out;
}

function singleTrade(
  outcome: Outcome, 
  price: number, 
  notional: number, 
  canUp: boolean, 
  canDown: boolean, 
  type: TradeType, 
  reason: string
): TradeIntent[] {
  if (outcome === "UP" && !canUp) return [];
  if (outcome === "DOWN" && !canDown) return [];
  return [mkBuy(outcome, price, notional, type, reason)];
}

/**
 * MAIN ENTRY: Gabagool Replication V4
 * 
 * COVERAGE trades (always allowed, even without edge):
 * - OPENING_DUAL: both sides missing → buy small on both
 * - HEDGE: one side missing → fill missing side
 * - REBALANCE: imbalanced position → rebalance to ~50/50
 * 
 * ACCUMULATE trades (only with edge):
 * - ARB_DUAL: combined < 99.5¢ → profit engine
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
    // 1) COOLDOWN (verhoogd naar 2s)
    if (ctx.lastTradeAtMs && nowMs - ctx.lastTradeAtMs < cfg.hf.tickMinIntervalMs) {
      return skip(`COOLDOWN: ${cfg.hf.tickMinIntervalMs}ms`);
    }

    // 2) EXPIRY (verhoogd naar 45s)
    if (ctx.remainingSeconds < cfg.entry.minSecondsRemaining) {
      return skip(`TOO_CLOSE_TO_EXPIRY: ${ctx.remainingSeconds}s`);
    }

    // 3) BOOK FRESHNESS
    if (nowMs - ctx.book.updatedAtMs > cfg.entry.staleBookMs) {
      return skip(`STALE_BOOK: ${nowMs - ctx.book.updatedAtMs}ms`);
    }

    // 4) Determine execution prices (paper = bid, live = ask)
    const px = getExecutionPrices(ctx, cfg);
    if (!px) return skip("MISSING_PRICES");

    const { upExec, downExec } = px;

    // 5) PRICE SANITY (check BOTH sides - strenger: 3¢-92¢)
    if (upExec < cfg.entry.minPrice || upExec > cfg.entry.maxPrice) {
      return skip(`UP_OUT_OF_RANGE: ${(upExec*100).toFixed(0)}¢`);
    }
    if (downExec < cfg.entry.minPrice || downExec > cfg.entry.maxPrice) {
      return skip(`DOWN_OUT_OF_RANGE: ${(downExec*100).toFixed(0)}¢`);
    }

    // 6) INVESTMENT LIMITS (per-side + total)
    const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
    if (totalInvested >= cfg.positionLimits.maxTotal) {
      return skip(`LIMIT_TOTAL: $${totalInvested.toFixed(0)}`);
    }

    const canUp = ctx.position.upInvested < cfg.positionLimits.maxPerSide;
    const canDown = ctx.position.downInvested < cfg.positionLimits.maxPerSide;

    // 7) SHARES LIMITS (NIEUW - voorkomt extreme share imbalances)
    const currentRatio = sharesRatio(ctx.position);
    if (currentRatio > cfg.positionLimits.maxSharesRatio) {
      return skip(`SHARES_RATIO_EXCEEDED: ${currentRatio.toFixed(1)}:1`);
    }
    if (ctx.position.upShares >= cfg.positionLimits.maxSharesPerSide) {
      return skip(`UP_SHARES_LIMIT: ${ctx.position.upShares}`);
    }
    if (ctx.position.downShares >= cfg.positionLimits.maxSharesPerSide) {
      return skip(`DOWN_SHARES_LIMIT: ${ctx.position.downShares}`);
    }

    const combined = upExec + downExec;

    // ---- DECISION KEY (dedupe identical signals) ----
    const decisionKey = makeDecisionKey(ctx.slug, upExec, downExec, combined, nowMs, cfg.hf.dedupeWindowMs);
    if (ctx.lastDecisionKey === decisionKey) return skip("DEDUPED");
    ctx.lastDecisionKey = decisionKey;

    // ============================================================
    // COVERAGE TRADES (allowed even without arb edge)
    // ============================================================
    
    // Skip coverage only if combined is really absurd (> 101¢)
    if (combined <= cfg.coverage.maxCombinedForCoverage) {
      
      // A) OPENING_DUAL: both sides missing - start met 50/50
      if (ctx.position.upShares === 0 && ctx.position.downShares === 0) {
        const trades = dualTrades(
          cfg.coverage.openingNotional, 
          upExec, downExec, 
          canUp, canDown, 
          cfg, 
          "OPENING_DUAL", 
          "Opening 50/50 coverage"
        );
        if (trades.length === 2) {
          return commit(ctx, nowMs, "OPENING_DUAL", trades, cfg);
        }
        // Als we geen dual kunnen doen, skip (voorkomt onevenwichtige start)
        return skip("CANNOT_OPEN_DUAL");
      }

      // B) HEDGE: one side missing - vul ontbrekende kant
      if (ctx.position.upShares === 0 || ctx.position.downShares === 0) {
        const missing: Outcome = ctx.position.upShares === 0 ? "UP" : "DOWN";
        const price = missing === "UP" ? upExec : downExec;
        const trades = singleTrade(
          missing, price, 
          cfg.coverage.hedgeNotional, 
          canUp, canDown, 
          "HEDGE", 
          `Hedge missing ${missing} @ ${(price*100).toFixed(0)}¢`
        );
        return commit(ctx, nowMs, "HEDGE", trades, cfg);
      }

      // C) REBALANCE: based on INVESTMENT imbalance (niet value!)
      const totalShares = ctx.position.upShares + ctx.position.downShares;
      const rebalanceCooldownOk = !ctx.lastRebalanceAtMs || (nowMs - ctx.lastRebalanceAtMs >= cfg.hf.rebalanceCooldownMs);
      
      if (totalShares >= cfg.coverage.minSharesForRebalance && rebalanceCooldownOk) {
        const invImbalance = investmentImbalancePct(ctx.position);
        
        if (Math.abs(invImbalance) > cfg.entry.investmentImbalanceThresholdPct) {
          // Investeer in de kant met MINDER investment
          const under: Outcome = invImbalance > 0 ? "DOWN" : "UP";
          const price = under === "UP" ? upExec : downExec;
          
          // Extra check: voorkomt dat rebalance de shares ratio verslechtert
          const newSharesUp = under === "UP" ? ctx.position.upShares + Math.floor(cfg.coverage.rebalanceNotional / upExec) : ctx.position.upShares;
          const newSharesDown = under === "DOWN" ? ctx.position.downShares + Math.floor(cfg.coverage.rebalanceNotional / downExec) : ctx.position.downShares;
          const newRatio = Math.max(newSharesUp / newSharesDown, newSharesDown / newSharesUp);
          
          if (newRatio <= cfg.positionLimits.maxSharesRatio) {
            const trades = singleTrade(
              under, price, 
              cfg.coverage.rebalanceNotional, 
              canUp, canDown, 
              "REBALANCE", 
              `Rebalance inv ${invImbalance.toFixed(0)}% → ${under} @ ${(price*100).toFixed(0)}¢`
            );
            if (trades.length > 0) {
              ctx.lastRebalanceAtMs = nowMs;
            }
            return commit(ctx, nowMs, "REBALANCE", trades, cfg);
          } else {
            return skip(`REBALANCE_WOULD_WORSEN_RATIO: ${newRatio.toFixed(1)}`);
          }
        }
      }
    }

    // ============================================================
    // ACCUMULATE TRADES (only with edge: combined < 98¢)
    // Dit is waar de winst zit - 50/50 split garandeert profit
    // ============================================================
    
    if (combined < cfg.edge.arbMaxEntry) {
      // Extra check: alleen ARB als shares ratio OK is
      const upSharesAfter = ctx.position.upShares + Math.floor((cfg.tradeSize.base / 2) / upExec);
      const downSharesAfter = ctx.position.downShares + Math.floor((cfg.tradeSize.base / 2) / downExec);
      const ratioAfter = Math.max(upSharesAfter / downSharesAfter, downSharesAfter / upSharesAfter);
      
      if (ratioAfter > cfg.positionLimits.maxSharesRatio) {
        return skip(`ARB_WOULD_EXCEED_RATIO: ${ratioAfter.toFixed(1)}`);
      }
      
      // Scale notional by edge zone: strong < 92¢ = 1.5x, normal = 1x
      const mult = combined < cfg.edge.strongArb ? 1.5 : 1.0;
      const notional = clamp(cfg.tradeSize.base * mult, cfg.tradeSize.min, cfg.tradeSize.max);
      
      const edgePct = ((1 - combined) * 100).toFixed(1);
      const zone = combined < cfg.edge.strongArb ? "STRONG" : "NORMAL";
      
      const trades = dualTrades(
        notional, 
        upExec, downExec, 
        canUp, canDown, 
        cfg, 
        "ARB_DUAL", 
        `ARB ${zone} ${edgePct}% edge (${(combined*100).toFixed(0)}¢)`
      );
      
      // ARB moet ALTIJD dual zijn
      if (trades.length === 2) {
        return commit(ctx, nowMs, "ARB_DUAL", trades, cfg);
      }
      return skip("ARB_NOT_DUAL_POSSIBLE");
    }

    return skip("NO_SIGNAL");
    
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
                lastRebalanceAtMs: 0,
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
        ctx.lastRebalanceAtMs = 0;
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
    
    // Log every 100th evaluation or when trading
    if (evaluationCount % 100 === 0 || result.shouldTrade) {
      const px = getExecutionPrices(ctx, DEFAULT_CONFIG);
      if (px) {
        const combined = px.upExec + px.downExec;
        log(`📊 ${slug.slice(-20)}: ${(px.upExec*100).toFixed(0)}¢+${(px.downExec*100).toFixed(0)}¢=${(combined*100).toFixed(0)}¢ | ${result.shouldTrade ? '🚀' : '⏸️'} ${result.reason.slice(0, 50)}`);
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
