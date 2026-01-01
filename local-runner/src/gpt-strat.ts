/**
 * polymarket_15m_bot.ts
 * --------------------------------------------------------------------------
 * Polymarket 15m Hedge/Arbitrage Bot v4.5 — Mode-Switch Edition
 *
 * v4.5 Changes (CRITICAL MODE-SWITCH FIX):
 * - HIGH_DELTA_CRITICAL MODE: IF delta > 0.8% AND secondsRemaining < 120:
 *   → ignore edge, ignore pairCost, hedge immediately at best available price
 *   → This is the #1 cause of unredeemed positions
 * - SURVIVAL MODE: IF min(UP,DOWN) == 0 AND secondsRemaining < 60:
 *   → place MARKETABLE hedge even if price > 0.95
 *   → 5% edge loss ≪ 100% capital loss
 * - Mode switch priority: SURVIVAL > HIGH_DELTA_CRITICAL > PANIC > NORMAL
 *
 * v4.4 Changes (GABAGOOL-PROOF):
 * - PANIC HEDGE: If secondsRemaining < 90 AND min(UP,DOWN) == 0 → force hedge AT ANY PRICE
 * - SETTLEMENT GUARD: Every tick checks upShares > 0 AND downShares > 0, else panic
 * - SETTLEMENT FAILURE LOG: Track unredeemed positions as separate failure metric
 * - Optimize on settlement_failures = 0, not on PnL
 *
 * v4.3 Changes:
 * - FORBID PAIRCOST-INCREASING HEDGES: Block normal hedges where
 *   hedge_price + avg_other_cost > current_pairCost (RISK mode exempt)
 * - ASYMMETRIC SETTLEMENT: If pairCost ≤ 0.97, no more hedges needed,
 *   settlement with skew is OK - profit is already locked
 * - OPTIMIZE ON PAIRCOST: Focus on pairCost at settlement as THE key metric
 *   Target: pairCost < 1.00 in >80-85% of markets = PnL follows
 *
 * v4.2.1 Changes:
 * - CONSTANT delta regimes: LOW <0.30%, MID 0.30-0.70%, HIGH >0.70%
 * - Time-scaled parameters (NOT regime thresholds):
 *   - hedgeTimeout ↓ as expiry approaches
 *   - maxSkew ↓ as expiry approaches  
 *   - bufferAdd ↑ as expiry approaches
 * - DEEP mode stricter conditions:
 *   - Only if secondsRemaining > 180s
 *   - Only if cheapestAsk + otherMid < 0.95
 *   - Only if delta < 0.40%
 *
 * v3.2.1 Changes (Big Hedger):
 * - Opening trade: 50 shares (was 25)
 * - Max position: 300 shares per side (was 150)
 * - Accumulate: max 50 shares per trade
 * - Accumulate only when hedged (skew < 10%)
 * - Exposure protection: no accumulate when one-sided
 */

export type Side = "UP" | "DOWN";
export type BotState = "FLAT" | "ONE_SIDED" | "HEDGED" | "SKEWED" | "UNWIND" | "DEEP_DISLOCATION";
export type RegimeTag = "NORMAL" | "DEEP" | "UNWIND";
export type DeltaRegime = "LOW" | "MID" | "HIGH";

export interface PriceLevel { price: number; size: number; }
export interface OrderBook { bids: PriceLevel[]; asks: PriceLevel[]; }

export interface BookTop {
  bid: number; bidSize: number;
  ask: number; askSize: number;
  mid: number;
}

export interface MarketSnapshot {
  marketId: string;
  ts: number;
  secondsRemaining: number;
  spotPrice?: number;      // v4.2.1: Chainlink price for delta calculation
  strikePrice?: number;    // v4.2.1: Market strike price
  upTop: BookTop;
  downTop: BookTop;
  upBook: OrderBook;
  downBook: OrderBook;
}

export interface Inventory {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  firstFillTs?: number;
  lastFillTs?: number;
}

export interface OpenOrder {
  id: string;
  side: Side;
  price: number;
  qty: number;
  qtyRemaining: number;
  createdTs: number;
  tag: "ENTRY" | "HEDGE" | "REBAL";
}

export interface FillEvent {
  marketId: string;
  orderId: string;
  side: Side;
  fillQty: number;
  fillPrice: number;
  ts: number;
}

export interface OrderIntent {
  side: Side;
  qty: number;
  limitPrice: number;
  tag: OpenOrder["tag"];
  reason: string;
}

export interface BotMetrics {
  decisions: number;
  ordersPlaced: number;
  ordersCanceled: number;
  fills: number;
  fillQty: number;

  noLiquidityStreakMax: number;
  adverseStreakMax: number;

  realizedPairCostMin: number;
  realizedPairCostLast: number;

  // v3.1 additions
  expectedExecutedPairCost: number;
  executedPairCost: number;
  hedgeLagSeconds: number;
  maxSkewDuringTrade: number;
  regimeTag: RegimeTag;
  // v4.2.1 additions
  deltaRegime: DeltaRegime;
  deltaPct: number;
  timeFactor: number;
  // v4.4 additions - Settlement safety
  panicHedgeTriggered: boolean;
  settlementFailure: boolean;
  settlementFailureLoss: number;
  // v4.5 additions - Mode switch tracking
  hedgeMode: "NORMAL" | "HIGH_DELTA_CRITICAL" | "SURVIVAL" | "PANIC";
  highDeltaCriticalModeCount: number;
  survivalModeCount: number;
}

// v4.4: Settlement failure event for logging
export interface SettlementFailureEvent {
  marketId: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  lostSide: Side;
  lostCost: number;
  secondsRemaining: number;
  reason: string;
}

export interface StrategyConfig {
  tradeSizeUsd: { base: number; min: number; max: number };

  edge: {
    baseBuffer: number;     // e.g. 0.012 = 1.2c
    strongEdge: number;     // e.g. 0.05 = 5c
    allowOverpay: number;   // e.g. 0.02 => hedge allowed up to 1.02 combined (risk-first)
    feesBuffer: number;
    slippageBuffer: number;
    deepDislocationThreshold: number; // 0.95 - triggers DEEP regime
  };

  // v4.2.1: Constant delta regime thresholds
  delta: {
    lowThreshold: number;      // 0.0030 = 0.30%
    midThreshold: number;      // 0.0070 = 0.70%
    deepMaxDelta: number;      // 0.0040 = 0.40% - max delta for DEEP mode
  };

  // v4.2.1: Time-scaled parameter bases
  timeScaled: {
    hedgeTimeoutBaseSec: number;  // Base hedge timeout, scaled by timeFactor
    maxSkewBase: number;          // Base max skew, scales toward 0.50
    bufferAddBase: number;        // Base buffer addition, increases as time decreases
  };

  // v4.2.1: DEEP mode conditions
  deep: {
    minTimeSec: number;           // 180 - only allow DEEP if > this
    maxCombinedAsk: number;       // 0.95 - only if combined < this
    maxDeltaPct: number;          // 0.0040 - only if delta < this
  };

  timing: {
    stopNewTradesSec: number;
    hedgeMustBySec: number;
    unwindStartSec: number;
    panicHedgeSec: number;     // v4.4: Panic hedge threshold (90s)
  };

  // v4.4: Settlement safety
  settlement: {
    panicHedgeThresholdSec: number;  // 90s - force hedge at any price
    maxPriceForPanicHedge: number;   // 0.99 - max price for panic hedge
  };

  // v4.5: Mode-switch thresholds
  modeSwitch: {
    highDeltaCriticalThreshold: number;     // 0.008 = 0.8% - delta above this triggers critical mode
    highDeltaCriticalTimeSec: number;       // 120s - only trigger if time remaining < this
    survivalModeDeltaThreshold: number;     // 0.008 = 0.8% - delta for survival mode
    survivalModeTimeSec: number;            // 60s - trigger survival mode below this time
    survivalMaxPrice: number;               // 0.95 - max price for survival hedge
  };

  skew: {
    target: number;              // 0.50
    rebalanceThreshold: number;  // 0.20
    hardCap: number;             // 0.70
  };

  limits: {
    maxTotalUsd: number;
    maxPerSideUsd: number;
    minTopDepthShares: number;
    maxPendingOrders: number;
    sideCooldownMs: number;
  };

  execution: {
    tickFallback: number;
    tickNiceSet: number[];
    hedgeCushionTicks: number;     // Normal: 0-1
    riskHedgeCushionTicks: number; // Unwind: 2-4
    entryImproveTicks: number;
  };

  adapt: {
    maxNoLiquidityStreak: number;
    maxAdverseStreak: number;
    bufferLiquidityPenaltyPerTick: number;
    bufferAdversePenaltyPerTick: number;
    clipDownscaleNoLiquidity: number;
  };

  profit: {
    lockPairCost: number; // 0.99 - stop trading if locked
    asymmetricSettlementThreshold: number; // 0.97 - allow asymmetric settlement below this
  };

  sizing: {
    edgeMultiplierHigh: number;   // >= 5c edge -> 2.0x
    edgeMultiplierMedium: number; // 2-5c edge -> 1.5x
    edgeMultiplierLow: number;    // < 2c edge -> 1.0x
    lowLiquidityMultiplier: number; // thin book -> 0.5x
    nearExpiryMultiplier: number;   // < 60s -> 0.5x
    deepDislocMultiplier: number;   // DEEP regime -> 2.0-3.0x
  };

  loop: {
    decisionIntervalMs: number;
    maxIntentsPerTick: number;
  };
}

export const DEFAULT_CONFIG: StrategyConfig = {
  // v4.2.1: Opening 50 shares, accumulate max 50, max position 300
  tradeSizeUsd: { base: 25, min: 20, max: 50 }, // ~50 shares at 50¢

  edge: {
    baseBuffer: 0.01,        // v5.1.0: 1% opening edge (was 1.2%)
    strongEdge: 0.04,        // 4c is strong edge
    allowOverpay: 0.02,      // Allow 2c overpay for better hedge fills
    feesBuffer: 0.002,
    slippageBuffer: 0.004,
    deepDislocationThreshold: 0.96,
    relaxedHedgeEdge: 0.045, // v5.1.0: Only hedge when combined < 95.5¢ (4.5% edge)
  },

  // v4.2.1: CONSTANT delta regime thresholds
  delta: {
    lowThreshold: 0.0030,     // LOW: delta < 0.30%
    midThreshold: 0.0070,     // MID: 0.30% - 0.70%, HIGH: > 0.70%
    deepMaxDelta: 0.0040,     // DEEP only if delta < 0.40%
  },

  // v4.2.1: Time-scaled parameter bases
  timeScaled: {
    hedgeTimeoutBaseSec: 20,  // At t=900s: 20s, at t=60s: ~1.3s (min 5s) - more aggressive hedging
    maxSkewBase: 0.70,        // At t=900s: 70/30, shrinks toward 50/50
    bufferAddBase: 0.008,     // At t=900s: +0%, at t=60s: +0.74%
  },

  // v4.2.1: Stricter DEEP mode conditions
  deep: {
    minTimeSec: 180,          // Only if > 180s remaining
    maxCombinedAsk: 0.95,     // Only if cheapestAsk + otherMid < 0.95
    maxDeltaPct: 0.0040,      // Only if delta < 0.40%
  },

  timing: {
    stopNewTradesSec: 30,
    hedgeMustBySec: 60,     // Must hedge by 60s remaining
    unwindStartSec: 45,
    panicHedgeSec: 90,      // v5.1.1: Panic hedge at 90s for 15-min markets
  },

  // v5.1.1: Settlement safety for 15-min markets
  settlement: {
    panicHedgeThresholdSec: 90,  // v5.1.1: 90s - force hedge at any price if one-sided
    maxPriceForPanicHedge: 0.95, // v5.1.1: Accept 5% loss to avoid 100% loss
    relaxedHedgeTimeSec: 180,    // v5.1.1: Before 3 min remaining, only hedge at 4.5% edge
  },

  // v5.1.1: Mode-switch thresholds for 15-min markets
  modeSwitch: {
    highDeltaCriticalThreshold: 0.008,  // 0.8% delta - above this, ignore edge when time low
    highDeltaCriticalTimeSec: 60,       // v5.1.1: Below 1 min + high delta = ignore edge
    survivalModeDeltaThreshold: 0.008,  // 0.8% delta for survival mode
    survivalModeTimeSec: 45,            // v5.1.1: Below 45s + one-sided = survival mode
    survivalMaxPrice: 0.95,             // Accept up to 5% loss to avoid 100% loss
  },

  skew: {
    target: 0.50,
    rebalanceThreshold: 0.20,
    hardCap: 0.70,
  },

  limits: {
    maxTotalUsd: 500,       // Increased for 300 shares (was 250)
    maxPerSideUsd: 300,     // 300 shares max per side (was 150)
    minTopDepthShares: 50,
    maxPendingOrders: 3,
    sideCooldownMs: 0,      // NO cooldown for hedge
  },

  execution: {
    tickFallback: 0.01,
    tickNiceSet: [0.01, 0.005, 0.002, 0.001],
    hedgeCushionTicks: 2,      // 2 ticks above ask
    riskHedgeCushionTicks: 3,  // Risk/Unwind hedge: aggressive
    entryImproveTicks: 0,
  },

  adapt: {
    maxNoLiquidityStreak: 6,
    maxAdverseStreak: 6,
    bufferLiquidityPenaltyPerTick: 0.001,
    bufferAdversePenaltyPerTick: 0.0015,
    clipDownscaleNoLiquidity: 0.6,
  },

  profit: {
    lockPairCost: 0.99,
    asymmetricSettlementThreshold: 0.97, // v4.3: Allow asymmetric settlement if pairCost <= 0.97
  },

  sizing: {
    edgeMultiplierHigh: 2.0,    // >= 5c
    edgeMultiplierMedium: 1.5,  // 2-5c
    edgeMultiplierLow: 1.0,     // < 2c (or skip)
    lowLiquidityMultiplier: 0.5,
    nearExpiryMultiplier: 0.5,
    deepDislocMultiplier: 2.5,  // DEEP regime boost
  },

  loop: {
    decisionIntervalMs: 500,
    maxIntentsPerTick: 2,
  },
};

// ---------- v4.2.1: Delta regime helpers ----------

/**
 * Compute delta percentage from spot vs strike
 */
function computeDeltaPct(spotPrice: number | undefined, strikePrice: number | undefined): number {
  if (!spotPrice || !strikePrice || strikePrice <= 0) return 0;
  return Math.abs(spotPrice - strikePrice) / strikePrice;
}

/**
 * v4.2.1: CONSTANT regime thresholds (no time-shrinking)
 */
function getDeltaRegime(deltaPct: number, cfg: StrategyConfig): DeltaRegime {
  if (deltaPct < cfg.delta.lowThreshold) return "LOW";   // < 0.30%
  if (deltaPct < cfg.delta.midThreshold) return "MID";   // 0.30% - 0.70%
  return "HIGH";                                          // > 0.70%
}

/**
 * v4.2.1: timeFactor for parameter scaling (NOT regime thresholds)
 */
function getTimeFactor(secondsRemaining: number): number {
  return Math.max(secondsRemaining, 60) / 900;  // 1.0 at 900s, 0.07 at 60s
}

/**
 * v4.2.1: Time-scaled hedge timeout
 */
function getScaledHedgeTimeout(timeFactor: number, baseSec: number): number {
  return Math.max(8, Math.floor(baseSec * timeFactor));  // Min 8s
}

/**
 * v4.2.1: Time-scaled max skew (shrinks toward 50/50)
 */
function getScaledMaxSkew(timeFactor: number, baseSkew: number): number {
  return 0.50 + (baseSkew - 0.50) * timeFactor;
}

/**
 * v4.2.1: Time-scaled buffer addition (increases as time decreases)
 */
function getScaledBufferAdd(timeFactor: number, baseBuffer: number): number {
  return baseBuffer * (1 - timeFactor);
}

/**
 * v4.2.1: Check if DEEP mode is allowed based on stricter conditions
 */
function isDeepModeAllowed(
  snap: MarketSnapshot, 
  deltaPct: number, 
  cfg: StrategyConfig
): boolean {
  // Must have enough time
  if (snap.secondsRemaining <= cfg.deep.minTimeSec) return false;
  
  // Delta must be low enough
  if (deltaPct >= cfg.deep.maxDeltaPct) return false;
  
  // Combined price must show strong dislocation
  const cheaperSide = cheapestSideByAsk(snap);
  const cheapestAsk = cheaperSide === "UP" ? snap.upTop.ask : snap.downTop.ask;
  const otherMid = cheaperSide === "UP" ? snap.downTop.mid : snap.upTop.mid;
  if ((cheapestAsk + otherMid) >= cfg.deep.maxCombinedAsk) return false;
  
  return true;
}

// ---------- Tick inference & rounding ----------

interface TickCacheEntry { tick: number; updatedTs: number; }

class TickInferer {
  private cache: Map<string, TickCacheEntry> = new Map();

  constructor(
    private fallbackTick: number,
    private niceTicks: number[],
    private maxAgeMs: number = 60_000
  ) {}

  getTick(marketId: string, side: Side, book: OrderBook, now: number): number {
    const key = marketId + ":" + side;
    const cached = this.cache.get(key);
    if (cached && (now - cached.updatedTs) < this.maxAgeMs) return cached.tick;

    const inferred = this.inferFromBook(book);
    const tick = this.sanitize(inferred);
    this.cache.set(key, { tick, updatedTs: now });
    return tick;
  }

  private inferFromBook(book: OrderBook): number {
    const N = 25;
    const prices: number[] = []
      .concat(book.bids.slice(0, N).map(x => x.price))
      .concat(book.asks.slice(0, N).map(x => x.price))
      .filter(p => p > 0 && p < 1)
      .sort((a, b) => a - b);

    const uniq: number[] = [];
    for (const p of prices) {
      if (uniq.length === 0 || Math.abs(p - uniq[uniq.length - 1]) > 1e-9) uniq.push(p);
    }

    let minDiff = Number.POSITIVE_INFINITY;
    for (let i = 1; i < uniq.length; i++) {
      const d = uniq[i] - uniq[i - 1];
      if (d > 1e-9 && d < minDiff) minDiff = d;
    }
    return Number.isFinite(minDiff) ? minDiff : this.fallbackTick;
  }

  private sanitize(t: number): number {
    if (!Number.isFinite(t) || t <= 0) return this.fallbackTick;
    if (t > 0.05) return 0.01;
    if (t < 0.0005) return 0.001;

    let best = this.niceTicks[0];
    let bestErr = Math.abs(t - best);
    for (const n of this.niceTicks) {
      const err = Math.abs(t - n);
      if (err < bestErr) { best = n; bestErr = err; }
    }
    return best;
  }
}

function roundDownToTick(price: number, tick: number): number {
  return Math.max(0, Math.floor(price / tick) * tick);
}

function roundUpToTick(price: number, tick: number): number {
  return Math.min(0.999, Math.ceil(price / tick) * tick);
}

function addTicks(price: number, tick: number, ticks: number): number {
  return Math.min(0.999, price + ticks * tick);
}

// ---------- Inventory helpers ----------

function totalNotional(inv: Inventory): number {
  return inv.upCost + inv.downCost;
}

function sideNotional(inv: Inventory, side: Side): number {
  return side === "UP" ? inv.upCost : inv.downCost;
}

function avgCost(inv: Inventory, side: Side): number {
  const q = side === "UP" ? inv.upShares : inv.downShares;
  const c = side === "UP" ? inv.upCost : inv.downCost;
  return q > 0 ? c / q : 0;
}

function pairCost(inv: Inventory): number {
  if (inv.upShares === 0 || inv.downShares === 0) return Number.POSITIVE_INFINITY;
  return avgCost(inv, "UP") + avgCost(inv, "DOWN");
}

function upFraction(inv: Inventory): number {
  const tot = inv.upShares + inv.downShares;
  return tot === 0 ? 0.5 : (inv.upShares / tot);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sharesFromUsd(usd: number, price: number): number {
  if (price <= 0) return 0;
  return Math.max(1, Math.floor(usd / price));
}

function cheapestSideByAsk(snap: MarketSnapshot): Side {
  return snap.upTop.ask <= snap.downTop.ask ? "UP" : "DOWN";
}

// ---------- Edge (execution-aware) v3.1 ----------

/**
 * Calculate dynamic edge buffer with penalties
 */
function dynamicEdgeBuffer(cfg: StrategyConfig, noLiquidityStreak: number, adverseStreak: number): number {
  const liquidityPenalty = Math.min(0.01, noLiquidityStreak * cfg.adapt.bufferLiquidityPenaltyPerTick);
  const adversePenalty = Math.min(0.01, adverseStreak * cfg.adapt.bufferAdversePenaltyPerTick);
  return cfg.edge.baseBuffer + cfg.edge.feesBuffer + cfg.edge.slippageBuffer + liquidityPenalty + adversePenalty;
}

/**
 * v3.1: Execution-aware edge calculation
 * expectedExecutedPairCost = cheapestSide.ask + otherSide.mid
 * Entry allowed if: expectedExecutedPairCost <= 1 - dynamicEdgeBuffer
 */
function executionAwareEdgeOk(
  snap: MarketSnapshot, 
  buffer: number
): { ok: boolean; entrySide: Side; expectedExecutedPairCost: number } {
  const entrySide = cheapestSideByAsk(snap);
  const cheapestAsk = entrySide === "UP" ? snap.upTop.ask : snap.downTop.ask;
  const otherMid = entrySide === "UP" ? snap.downTop.mid : snap.upTop.mid;
  
  const expectedExecutedPairCost = cheapestAsk + otherMid;
  const ok = expectedExecutedPairCost <= (1 - buffer);
  
  return { ok, entrySide, expectedExecutedPairCost };
}

/**
 * v3.1: Check if in DEEP_DISLOCATION regime
 * Triggers when cheapestAsk + otherMid < 0.95
 */
function isDeepDislocation(snap: MarketSnapshot, threshold: number): boolean {
  const cheaperSide = cheapestSideByAsk(snap);
  const cheapestAsk = cheaperSide === "UP" ? snap.upTop.ask : snap.downTop.ask;
  const otherMid = cheaperSide === "UP" ? snap.downTop.mid : snap.upTop.mid;
  return (cheapestAsk + otherMid) < threshold;
}

/**
 * v3.1: Check if profit is locked (avg pair cost <= lockThreshold)
 */
function isProfitLocked(inv: Inventory, lockThreshold: number): boolean {
  const pc = pairCost(inv);
  return Number.isFinite(pc) && pc <= lockThreshold;
}

// Legacy pairedLockOk for backward compatibility
function pairedLockOk(snap: MarketSnapshot, buffer: number): boolean {
  return (snap.upTop.ask + snap.downTop.ask) <= (1 - buffer);
}

// ---------- Polymarket API you implement ----------

export interface PlaceOrderResult { orderId: string; }

export interface PolymarketClobApi {
  getMarketSnapshot(marketId: string): Promise<MarketSnapshot>;

  placeLimitOrder(params: {
    marketId: string;
    side: Side;
    price: number; // tick-valid
    qty: number;   // shares
    clientTag?: string;
  }): Promise<PlaceOrderResult>;

  cancelOrder(params: { marketId: string; orderId: string }): Promise<void>;

  getOpenOrdersForMarket?(marketId: string): Promise<Array<{
    orderId: string; side: Side; price: number; qtyRemaining: number; createdTs: number;
    clientTag?: string;
  }>>;
}

// ---------- Bot implementation v3.1 ----------

export class Polymarket15mArbBot {
  private tickInferer: TickInferer;

  private state: BotState = "FLAT";
  private inventory: Inventory = { upShares: 0, downShares: 0, upCost: 0, downCost: 0 };
  private openOrders: Map<string, OpenOrder> = new Map();

  // fill-driven hedge queue: shares to buy on each side
  private pendingHedge = { up: 0, down: 0 };

  // throttles
  private cooldownUntilBySide: Record<Side, number> = { UP: 0, DOWN: 0 };
  private lastDecisionTs = 0;

  // execution state
  private noLiquidityStreak = 0;
  private adverseStreak = 0;

  // v4.2.1: Track delta regime and time factor
  private oneSidedStartTs: number | null = null;
  private maxSkewDuringTrade = 0.5;
  private currentRegime: RegimeTag = "NORMAL";
  private currentDeltaRegime: DeltaRegime = "LOW";
  private currentTimeFactor = 1.0;
  private currentDeltaPct = 0;

  // metrics
  private metrics: BotMetrics = {
    decisions: 0,
    ordersPlaced: 0,
    ordersCanceled: 0,
    fills: 0,
    fillQty: 0,
    noLiquidityStreakMax: 0,
    adverseStreakMax: 0,
    realizedPairCostMin: Number.POSITIVE_INFINITY,
    realizedPairCostLast: Number.POSITIVE_INFINITY,
    // v3.1 additions
    expectedExecutedPairCost: 0,
    executedPairCost: 0,
    hedgeLagSeconds: 0,
    maxSkewDuringTrade: 0.5,
    regimeTag: "NORMAL",
    // v4.2.1 additions
    deltaRegime: "LOW",
    deltaPct: 0,
    timeFactor: 1.0,
    // v4.4 additions
    panicHedgeTriggered: false,
    settlementFailure: false,
    settlementFailureLoss: 0,
    // v4.5 additions
    hedgeMode: "NORMAL",
    highDeltaCriticalModeCount: 0,
    survivalModeCount: 0,
  };

  // v4.4: Settlement failure callback
  private onSettlementFailure?: (event: SettlementFailureEvent) => void;

  constructor(
    private api: PolymarketClobApi,
    private marketId: string,
    private cfg: StrategyConfig = DEFAULT_CONFIG,
    private log: (msg: string, obj?: any) => void = (m, o) => console.log(m, o ?? "")
  ) {
    this.tickInferer = new TickInferer(cfg.execution.tickFallback, cfg.execution.tickNiceSet);
  }

  getMetrics(): BotMetrics { return { ...this.metrics }; }
  getState(): BotState { return this.state; }
  getInventory(): Inventory { return { ...this.inventory }; }
  
  // v4.4: Set settlement failure callback
  setSettlementFailureCallback(cb: (event: SettlementFailureEvent) => void): void {
    this.onSettlementFailure = cb;
  }

  /**
   * v4.4: Check if we're in PANIC state - one-sided and running out of time
   */
  private isPanicState(snap: MarketSnapshot): boolean {
    const inv = this.inventory;
    const hasPosition = inv.upShares > 0 || inv.downShares > 0;
    if (!hasPosition) return false;
    
    const isOneSided = inv.upShares === 0 || inv.downShares === 0;
    const nearExpiry = snap.secondsRemaining <= this.cfg.settlement.panicHedgeThresholdSec;
    
    return isOneSided && nearExpiry;
  }

  /**
   * v4.4: Log settlement failure - this is the CRITICAL metric to optimize on
   */
  private logSettlementFailure(snap: MarketSnapshot, reason: string): void {
    const inv = this.inventory;
    const lostSide: Side = inv.upShares === 0 ? "DOWN" : "UP";
    const lostCost = lostSide === "UP" ? inv.upCost : inv.downCost;
    
    this.metrics.settlementFailure = true;
    this.metrics.settlementFailureLoss = lostCost;
    
    const event: SettlementFailureEvent = {
      marketId: this.marketId,
      upShares: inv.upShares,
      downShares: inv.downShares,
      upCost: inv.upCost,
      downCost: inv.downCost,
      lostSide,
      lostCost,
      secondsRemaining: snap.secondsRemaining,
      reason,
    };
    
    this.log("🚨 SETTLEMENT_FAILURE", event);
    
    if (this.onSettlementFailure) {
      this.onSettlementFailure(event);
    }
  }

  /**
   * Feed ALL fills here. Hedging correctness depends on this.
   */
  onFill(fill: FillEvent) {
    if (fill.marketId !== this.marketId) return;

    this.metrics.fills += 1;
    this.metrics.fillQty += fill.fillQty;

    this.inventory.lastFillTs = fill.ts;
    if (this.inventory.firstFillTs === undefined) this.inventory.firstFillTs = fill.ts;

    if (fill.side === "UP") {
      this.inventory.upShares += fill.fillQty;
      this.inventory.upCost += fill.fillQty * fill.fillPrice;
      // v3.1: Only queue hedge if NOT in DEEP regime (delayed hedge)
      if (this.currentRegime !== "DEEP") {
        this.pendingHedge.down += fill.fillQty;
      }
    } else {
      this.inventory.downShares += fill.fillQty;
      this.inventory.downCost += fill.fillQty * fill.fillPrice;
      if (this.currentRegime !== "DEEP") {
        this.pendingHedge.up += fill.fillQty;
      }
    }

    const local = this.openOrders.get(fill.orderId);
    if (local) {
      local.qtyRemaining = Math.max(0, local.qtyRemaining - fill.fillQty);
      if (local.qtyRemaining === 0) this.openOrders.delete(fill.orderId);
    }

    const pc = pairCost(this.inventory);
    if (Number.isFinite(pc)) {
      this.metrics.realizedPairCostLast = pc;
      this.metrics.realizedPairCostMin = Math.min(this.metrics.realizedPairCostMin, pc);
      this.metrics.executedPairCost = pc;
    }

    // Track max skew
    const uf = upFraction(this.inventory);
    const skew = Math.max(uf, 1 - uf);
    this.maxSkewDuringTrade = Math.max(this.maxSkewDuringTrade, skew);
    this.metrics.maxSkewDuringTrade = this.maxSkewDuringTrade;
  }

  /**
   * Call periodically (setInterval). This method is idempotent-ish.
   */
  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDecisionTs < this.cfg.loop.decisionIntervalMs) return;
    this.lastDecisionTs = now;

    const snap = await this.api.getMarketSnapshot(this.marketId);
    this.metrics.decisions += 1;

    if (this.api.getOpenOrdersForMarket && (this.metrics.decisions % 30 === 0)) {
      await this.reconcileOpenOrders();
    }

    // v4.2.1: Compute delta regime and time factor FIRST
    this.currentDeltaPct = computeDeltaPct(snap.spotPrice, snap.strikePrice);
    this.currentDeltaRegime = getDeltaRegime(this.currentDeltaPct, this.cfg);
    this.currentTimeFactor = getTimeFactor(snap.secondsRemaining);
    
    this.metrics.deltaPct = this.currentDeltaPct;
    this.metrics.deltaRegime = this.currentDeltaRegime;
    this.metrics.timeFactor = this.currentTimeFactor;

    // v4.2.1: Determine regime with new DEEP conditions
    this.currentRegime = this.determineRegime(snap);
    this.metrics.regimeTag = this.currentRegime;

    // v4.2.1: Calculate time-scaled buffer
    const baseBuffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const bufferAdd = getScaledBufferAdd(this.currentTimeFactor, this.cfg.timeScaled.bufferAddBase);
    const buffer = baseBuffer + bufferAdd;
    
    const edgeCheck = executionAwareEdgeOk(snap, buffer);
    this.metrics.expectedExecutedPairCost = edgeCheck.expectedExecutedPairCost;

    this.state = this.decideState(snap);

    // ========================================================================
    // v4.5: MODE-SWITCH DETECTION - Priority: SURVIVAL > HIGH_DELTA_CRITICAL > PANIC > NORMAL
    // This is THE critical fix to prevent 100% losses from unredeemed positions
    // ========================================================================
    const hedgeMode = this.determineHedgeMode(snap);
    this.metrics.hedgeMode = hedgeMode;

    // v3.1: Track hedge lag
    if (this.state === "ONE_SIDED") {
      if (this.oneSidedStartTs === null) {
        this.oneSidedStartTs = now;
      }
      this.metrics.hedgeLagSeconds = (now - this.oneSidedStartTs) / 1000;
    } else {
      this.oneSidedStartTs = null;
      if (this.state !== "UNWIND") {
        this.metrics.hedgeLagSeconds = 0;
      }
    }

    // In UNWIND or near expiry: cancel ENTRY/REBAL orders, keep HEDGE
    if (this.state === "UNWIND" || snap.secondsRemaining <= this.cfg.timing.unwindStartSec) {
      await this.cancelNonEssentialOrders("UNWIND");
    }

    const intents: OrderIntent[] = [];
    
    // v4.5: MODE-SWITCH HEDGE LOGIC - Priority order
    // SURVIVAL and HIGH_DELTA_CRITICAL modes IGNORE edge and pairCost
    if (hedgeMode === "SURVIVAL") {
      intents.push(...this.buildSurvivalHedgeIntents(snap));
    } else if (hedgeMode === "HIGH_DELTA_CRITICAL") {
      intents.push(...this.buildHighDeltaCriticalHedgeIntents(snap));
    } else if (hedgeMode === "PANIC") {
      intents.push(...this.buildPanicHedgeIntents(snap));
    } else {
      intents.push(...this.buildHedgeIntents(snap));
    }
    
    intents.push(...this.buildRebalanceIntents(snap));
    intents.push(...this.buildEntryOrAccumulateIntents(snap));

    for (const intent of intents.slice(0, this.cfg.loop.maxIntentsPerTick)) {
      await this.executeIntent(snap, intent);
    }

    // v4.4: Check for impending settlement failure - log it!
    if (snap.secondsRemaining <= 10 && this.isPanicState(snap)) {
      this.logSettlementFailure(snap, "FAILED_TO_HEDGE_IN_TIME");
    }

    this.metrics.noLiquidityStreakMax = Math.max(this.metrics.noLiquidityStreakMax, this.noLiquidityStreak);
    this.metrics.adverseStreakMax = Math.max(this.metrics.adverseStreakMax, this.adverseStreak);
  }

  /**
   * v4.5: Determine hedge mode - THE CRITICAL MODE-SWITCH
   * Priority: SURVIVAL > HIGH_DELTA_CRITICAL > PANIC > NORMAL
   */
  private determineHedgeMode(snap: MarketSnapshot): "NORMAL" | "HIGH_DELTA_CRITICAL" | "SURVIVAL" | "PANIC" {
    const inv = this.inventory;
    const hasPosition = inv.upShares > 0 || inv.downShares > 0;
    if (!hasPosition) return "NORMAL";
    
    const isOneSided = inv.upShares === 0 || inv.downShares === 0;
    const deltaPct = this.currentDeltaPct;
    
    // SURVIVAL MODE: min(UP,DOWN) == 0 AND secondsRemaining < 60
    // → MARKETABLE hedge even at price > 0.95
    // This is the LAST LINE OF DEFENSE
    if (isOneSided && snap.secondsRemaining < this.cfg.modeSwitch.survivalModeTimeSec) {
      this.metrics.survivalModeCount++;
      this.log("🚨 SURVIVAL_MODE_ACTIVE", {
        secondsRemaining: snap.secondsRemaining,
        deltaPct: (deltaPct * 100).toFixed(2) + '%',
        upShares: inv.upShares,
        downShares: inv.downShares,
        reason: "ONE_SIDED_AND_RUNNING_OUT_OF_TIME"
      });
      return "SURVIVAL";
    }
    
    // HIGH_DELTA_CRITICAL MODE: delta > 0.8% AND secondsRemaining < 120
    // → ignore edge, ignore pairCost, hedge IMMEDIATELY
    // This is the #1 cause of unredeemed positions
    if (deltaPct > this.cfg.modeSwitch.highDeltaCriticalThreshold && 
        snap.secondsRemaining < this.cfg.modeSwitch.highDeltaCriticalTimeSec &&
        isOneSided) {
      this.metrics.highDeltaCriticalModeCount++;
      this.log("⚠️ HIGH_DELTA_CRITICAL_MODE_ACTIVE", {
        secondsRemaining: snap.secondsRemaining,
        deltaPct: (deltaPct * 100).toFixed(2) + '%',
        threshold: (this.cfg.modeSwitch.highDeltaCriticalThreshold * 100).toFixed(1) + '%',
        upShares: inv.upShares,
        downShares: inv.downShares,
        reason: "HIGH_DELTA_NEAR_EXPIRY"
      });
      return "HIGH_DELTA_CRITICAL";
    }
    
    // PANIC MODE: one-sided AND < 90s (from v4.4)
    if (isOneSided && snap.secondsRemaining <= this.cfg.settlement.panicHedgeThresholdSec) {
      this.metrics.panicHedgeTriggered = true;
      this.log("🚨 PANIC_MODE_ACTIVE", { 
        secondsRemaining: snap.secondsRemaining,
        upShares: inv.upShares,
        downShares: inv.downShares,
        threshold: this.cfg.settlement.panicHedgeThresholdSec
      });
      return "PANIC";
    }
    
    return "NORMAL";
  }

  /**
   * v4.5: SURVIVAL MODE HEDGE - buy at ANY price up to survivalMaxPrice (0.95)
   * This is the absolute last line of defense against 100% loss
   * 
   * Rule: 5% edge loss ≪ 100% capital loss
   */
  private buildSurvivalHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const inv = this.inventory;
    
    // Determine which side needs hedging
    let sideToBuy: Side;
    let qty: number;
    
    if (inv.upShares > 0 && inv.downShares === 0) {
      sideToBuy = "DOWN";
      qty = inv.upShares;
    } else if (inv.downShares > 0 && inv.upShares === 0) {
      sideToBuy = "UP";
      qty = inv.downShares;
    } else {
      return intents;
    }
    
    const top = sideToBuy === "UP" ? snap.upTop : snap.downTop;
    const book = sideToBuy === "UP" ? snap.upBook : snap.downBook;
    const tick = this.tickInferer.getTick(snap.marketId, sideToBuy, book, snap.ts);
    
    // SURVIVAL: Accept ANY price up to survivalMaxPrice (0.95)
    // This is a MARKETABLE order - we WILL get filled
    const maxPx = this.cfg.modeSwitch.survivalMaxPrice;
    const survivalPx = Math.min(maxPx, addTicks(top.ask, tick, 10));  // 10 ticks above ask
    const px = roundUpToTick(survivalPx, tick);
    
    this.log("🆘 SURVIVAL_HEDGE_ORDER", {
      sideToBuy,
      qty,
      price: px,
      ask: top.ask,
      secondsRemaining: snap.secondsRemaining,
      deltaPct: (this.currentDeltaPct * 100).toFixed(2) + '%',
      existingUp: inv.upShares,
      existingDown: inv.downShares,
      message: "ACCEPTING 5% LOSS TO AVOID 100% LOSS"
    });
    
    intents.push({
      side: sideToBuy,
      qty,
      limitPrice: px,
      tag: "HEDGE",
      reason: `🆘 SURVIVAL_HEDGE @ ${(px * 100).toFixed(0)}¢ (${snap.secondsRemaining}s left, delta=${(this.currentDeltaPct * 100).toFixed(1)}%)`
    });
    
    return intents;
  }

  /**
   * v4.5: HIGH_DELTA_CRITICAL MODE HEDGE - ignore edge, ignore pairCost
   * 
   * Rule: IF delta > 0.8% AND secondsRemaining < 120
   *       → hedge immediately at best available price
   */
  private buildHighDeltaCriticalHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const inv = this.inventory;
    
    // Determine which side needs hedging
    let sideToBuy: Side;
    let qty: number;
    
    if (inv.upShares > 0 && inv.downShares === 0) {
      sideToBuy = "DOWN";
      qty = inv.upShares;
    } else if (inv.downShares > 0 && inv.upShares === 0) {
      sideToBuy = "UP";
      qty = inv.downShares;
    } else {
      return intents;
    }
    
    const top = sideToBuy === "UP" ? snap.upTop : snap.downTop;
    const book = sideToBuy === "UP" ? snap.upBook : snap.downBook;
    const tick = this.tickInferer.getTick(snap.marketId, sideToBuy, book, snap.ts);
    
    // HIGH_DELTA_CRITICAL: Ignore edge, use aggressive pricing
    // Up to 3 ticks above ask, max price 0.90 (still some edge protection)
    const criticalMaxPx = 0.90;  // More aggressive than SURVIVAL but still protective
    const criticalPx = Math.min(criticalMaxPx, addTicks(top.ask, tick, 3));
    const px = roundUpToTick(criticalPx, tick);
    
    this.log("⚡ HIGH_DELTA_CRITICAL_HEDGE_ORDER", {
      sideToBuy,
      qty,
      price: px,
      ask: top.ask,
      secondsRemaining: snap.secondsRemaining,
      deltaPct: (this.currentDeltaPct * 100).toFixed(2) + '%',
      existingUp: inv.upShares,
      existingDown: inv.downShares,
      message: "IGNORING EDGE - HIGH DELTA NEAR EXPIRY"
    });
    
    intents.push({
      side: sideToBuy,
      qty,
      limitPrice: px,
      tag: "HEDGE",
      reason: `⚡ CRITICAL_HEDGE @ ${(px * 100).toFixed(0)}¢ (${snap.secondsRemaining}s, delta=${(this.currentDeltaPct * 100).toFixed(1)}%)`
    });
    
    return intents;
  }

  /**
   * v4.4: PANIC HEDGE - force hedge AT ANY PRICE when one-sided near expiry
   * This is the most critical function to prevent unredeemed positions
   */
  private buildPanicHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const inv = this.inventory;
    
    // Determine which side needs hedging
    let sideToBuy: Side;
    let qty: number;
    
    if (inv.upShares > 0 && inv.downShares === 0) {
      sideToBuy = "DOWN";
      qty = inv.upShares;  // Match the existing UP shares
    } else if (inv.downShares > 0 && inv.upShares === 0) {
      sideToBuy = "UP";
      qty = inv.downShares;  // Match the existing DOWN shares
    } else {
      return intents;  // Already hedged
    }
    
    const top = sideToBuy === "UP" ? snap.upTop : snap.downTop;
    const book = sideToBuy === "UP" ? snap.upBook : snap.downBook;
    
    // v4.4: PANIC - buy at ANY price up to max (0.99)
    const tick = this.tickInferer.getTick(snap.marketId, sideToBuy, book, snap.ts);
    const maxPx = this.cfg.settlement.maxPriceForPanicHedge;
    
    // Use the ask + generous cushion, capped at max price
    const panicPx = Math.min(maxPx, addTicks(top.ask, tick, 5));  // 5 ticks above ask
    const px = roundUpToTick(panicPx, tick);
    
    this.log("🚨 PANIC_HEDGE_ORDER", {
      sideToBuy,
      qty,
      price: px,
      ask: top.ask,
      secondsRemaining: snap.secondsRemaining,
      existingUp: inv.upShares,
      existingDown: inv.downShares,
    });
    
    intents.push({
      side: sideToBuy,
      qty,
      limitPrice: px,
      tag: "HEDGE",
      reason: `🚨 PANIC_HEDGE @ ${(px * 100).toFixed(0)}¢ (${snap.secondsRemaining}s left)`
    });
    
    return intents;
  }

  /**
   * v4.2.1: Determine current trading regime with stricter DEEP conditions
   */
  private determineRegime(snap: MarketSnapshot): RegimeTag {
    // Check UNWIND conditions first
    if (snap.secondsRemaining <= this.cfg.timing.unwindStartSec) return "UNWIND";
    if (this.noLiquidityStreak >= this.cfg.adapt.maxNoLiquidityStreak) return "UNWIND";
    if (this.adverseStreak >= this.cfg.adapt.maxAdverseStreak) return "UNWIND";
    
    // v4.2.1: Time-scaled hedge timeout
    const hedgeTimeout = getScaledHedgeTimeout(this.currentTimeFactor, this.cfg.timeScaled.hedgeTimeoutBaseSec);
    if (this.oneSidedStartTs !== null) {
      const hedgeLagSec = (Date.now() - this.oneSidedStartTs) / 1000;
      if (hedgeLagSec >= hedgeTimeout) return "UNWIND";
    }

    // v4.2.1: Time-scaled max skew
    const maxSkew = getScaledMaxSkew(this.currentTimeFactor, this.cfg.timeScaled.maxSkewBase);
    const uf = upFraction(this.inventory);
    if ((this.inventory.upShares > 0 || this.inventory.downShares > 0) &&
        (uf > maxSkew || (1 - uf) > maxSkew)) {
      // Check if DEEP mode could save us
      if (!isDeepModeAllowed(snap, this.currentDeltaPct, this.cfg)) {
        return "UNWIND";
      }
    }

    // v4.2.1: Stricter DEEP mode conditions
    if (isDeepModeAllowed(snap, this.currentDeltaPct, this.cfg) &&
        isDeepDislocation(snap, this.cfg.edge.deepDislocationThreshold)) {
      return "DEEP";
    }

    return "NORMAL";
  }

  private decideState(snap: MarketSnapshot): BotState {
    const inv = this.inventory;

    // v3.1: Regime-based state transitions
    if (this.currentRegime === "UNWIND") return "UNWIND";
    if (this.currentRegime === "DEEP") {
      // In DEEP, we might be deliberately one-sided
      const tot = inv.upShares + inv.downShares;
      if (tot === 0) return "FLAT";
      if (inv.upShares === 0 || inv.downShares === 0) return "DEEP_DISLOCATION";
      return "HEDGED"; // Even skewed is ok in DEEP
    }

    const tot = inv.upShares + inv.downShares;
    if (tot === 0) return "FLAT";
    if (inv.upShares === 0 || inv.downShares === 0) {
      return "ONE_SIDED";
    }

    const uf = upFraction(inv);
    if (uf > this.cfg.skew.hardCap || (1 - uf) > this.cfg.skew.hardCap) return "SKEWED";

    return "HEDGED";
  }

  /**
   * v4.3: Enhanced hedge logic with pairCost protection
   * - Forbid hedges that would increase pairCost (unless RISK mode)
   * - Allow asymmetric settlement if pairCost <= 0.97
   */
  private buildHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const inv = this.inventory;
    const currentPairCost = pairCost(inv);

    // v4.3: ASYMMETRIC SETTLEMENT - if pairCost is locked below threshold, no more hedges needed
    if (Number.isFinite(currentPairCost) && currentPairCost <= this.cfg.profit.asymmetricSettlementThreshold) {
      this.log("HEDGE_SKIP_ASYMMETRIC_OK", { 
        pairCost: currentPairCost, 
        threshold: this.cfg.profit.asymmetricSettlementThreshold,
        upShares: inv.upShares,
        downShares: inv.downShares
      });
      // Clear pending hedges - we don't need symmetry
      this.pendingHedge.up = 0;
      this.pendingHedge.down = 0;
      return intents;
    }

    // In DEEP_DISLOCATION, only hedge when conditions normalize or timeout
    if (this.state === "DEEP_DISLOCATION") {
      const shouldHedgeInDeep = this.shouldHedgeInDeepRegime(snap);
      if (!shouldHedgeInDeep) {
        // Queue hedge for later but don't execute now
        return intents;
      }
      // If we should hedge, calculate pending based on current imbalance
      if (inv.upShares > 0 && inv.downShares === 0) {
        this.pendingHedge.down = inv.upShares;
      } else if (inv.downShares > 0 && inv.upShares === 0) {
        this.pendingHedge.up = inv.downShares;
      }
    }

    const wantUp = Math.floor(this.pendingHedge.up);
    const wantDown = Math.floor(this.pendingHedge.down);
    if (wantUp <= 0 && wantDown <= 0) return intents;

    // v4.3: Determine hedge mode - RISK allows overpay
    const isRiskHedge = (
      this.state === "SKEWED" || 
      this.state === "UNWIND" || 
      snap.secondsRemaining <= this.cfg.timing.hedgeMustBySec ||
      this.currentRegime === "UNWIND"
    );

    // v4.3: Different combined limits for normal vs risk hedge
    const maxCombined = isRiskHedge 
      ? (1 + this.cfg.edge.allowOverpay) // 1.02 for risk
      : 1.00; // 1.00 for normal

    const combinedAsk = snap.upTop.ask + snap.downTop.ask;
    const canHedge = combinedAsk <= maxCombined;

    if (!canHedge && !isRiskHedge) {
      this.adverseStreak = Math.min(this.cfg.adapt.maxAdverseStreak, this.adverseStreak + 1);
      this.log("HEDGE_SKIPPED_OVERPAY", { combinedAsk, maxCombined, hedgeMode: "NORMAL" });
      return intents;
    }

    // v4.3: Different cushion ticks for normal vs risk hedge
    const cushionTicks = isRiskHedge 
      ? this.cfg.execution.riskHedgeCushionTicks  // 2-4 for risk
      : this.cfg.execution.hedgeCushionTicks;     // 0-1 for normal

    const mk = (side: Side, qty: number): OrderIntent | null => {
      if (qty <= 0) return null;

      const top = side === "UP" ? snap.upTop : snap.downTop;
      const book = side === "UP" ? snap.upBook : snap.downBook;

      if (top.askSize < this.cfg.limits.minTopDepthShares) {
        this.noLiquidityStreak = Math.min(this.cfg.adapt.maxNoLiquidityStreak, this.noLiquidityStreak + 1);
        return null;
      }

      const tick = this.tickInferer.getTick(snap.marketId, side, book, snap.ts);
      const base = addTicks(top.ask, tick, cushionTicks);
      const px = roundUpToTick(base, tick);

      // v4.3: PAIRCOST PROTECTION - block hedges that would increase pairCost
      // Only enforce in NORMAL mode, RISK mode can overpay to reduce risk
      if (!isRiskHedge && Number.isFinite(currentPairCost)) {
        const otherSide: Side = side === "UP" ? "DOWN" : "UP";
        const avgOtherCost = avgCost(inv, otherSide);
        const projectedPairCost = px + avgOtherCost;
        
        if (projectedPairCost > currentPairCost) {
          this.log("HEDGE_SKIP_PAIRCOST_INCREASE", {
            side,
            hedgePrice: px,
            avgOtherCost,
            projectedPairCost,
            currentPairCost,
            delta: projectedPairCost - currentPairCost
          });
          return null;
        }
      }

      const hedgeType = isRiskHedge ? "RISK_HEDGE" : "NORMAL_HEDGE";
      return { 
        side, 
        qty, 
        limitPrice: px, 
        tag: "HEDGE", 
        reason: `${hedgeType} +${cushionTicks}t` 
      };
    };

    const i1 = mk("UP", wantUp);
    if (i1) intents.push(i1);
    const i2 = mk("DOWN", wantDown);
    if (i2) intents.push(i2);

    return intents;
  }

  /**
   * v4.2.1: Determine if we should hedge in DEEP regime
   * Uses stricter conditions from v4.2.1
   */
  private shouldHedgeInDeepRegime(snap: MarketSnapshot): boolean {
    // DEEP mode no longer allowed (time/delta/price conditions changed)
    if (!isDeepModeAllowed(snap, this.currentDeltaPct, this.cfg)) {
      this.log("DEEP_EXIT_CONDITIONS", { 
        secondsRemaining: snap.secondsRemaining,
        deltaPct: this.currentDeltaPct,
        minTime: this.cfg.deep.minTimeSec,
        maxDelta: this.cfg.deep.maxDeltaPct
      });
      return true;
    }

    // Price normalized (no longer deep dislocation)
    if (!isDeepDislocation(snap, this.cfg.edge.deepDislocationThreshold)) {
      this.log("DEEP_EXIT_NORMALIZED", { reason: "price_normalized" });
      return true;
    }

    // v4.2.1: Time-scaled hedge timeout
    const hedgeTimeout = getScaledHedgeTimeout(this.currentTimeFactor, this.cfg.timeScaled.hedgeTimeoutBaseSec);
    if (this.oneSidedStartTs !== null) {
      const lagSec = (Date.now() - this.oneSidedStartTs) / 1000;
      if (lagSec >= hedgeTimeout) {
        this.log("DEEP_EXIT_TIMEOUT", { lagSec, hedgeTimeout });
        return true;
      }
    }

    // v4.2.1: Time-scaled max skew
    const maxSkew = getScaledMaxSkew(this.currentTimeFactor, this.cfg.timeScaled.maxSkewBase);
    const uf = upFraction(this.inventory);
    if (uf > maxSkew || (1 - uf) > maxSkew) {
      this.log("DEEP_EXIT_SKEW_CAP", { skew: uf, maxSkew });
      return true;
    }

    // Time running out
    if (snap.secondsRemaining <= this.cfg.timing.unwindStartSec) {
      return true;
    }

    return false;
  }

  private buildRebalanceIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    if (this.state !== "HEDGED" && this.state !== "SKEWED") return intents;

    // v4.3: Asymmetric settlement - skip rebalance if pairCost is locked
    const currentPairCost = pairCost(this.inventory);
    if (Number.isFinite(currentPairCost) && currentPairCost <= this.cfg.profit.asymmetricSettlementThreshold) {
      this.log("REBAL_SKIP_ASYMMETRIC_OK", { 
        pairCost: currentPairCost, 
        threshold: this.cfg.profit.asymmetricSettlementThreshold 
      });
      return intents;
    }

    // v3.1: Profit lock - stop if locked
    if (isProfitLocked(this.inventory, this.cfg.profit.lockPairCost)) {
      this.log("REBAL_BLOCKED_PROFIT_LOCK", { pairCost: currentPairCost });
      return intents;
    }

    const delta = upFraction(this.inventory) - this.cfg.skew.target;
    if (Math.abs(delta) < this.cfg.skew.rebalanceThreshold) return intents;

    const sideToBuy: Side = delta > 0 ? "DOWN" : "UP";
    const top = sideToBuy === "UP" ? snap.upTop : snap.downTop;
    const book = sideToBuy === "UP" ? snap.upBook : snap.downBook;

    if (top.askSize < this.cfg.limits.minTopDepthShares) {
      this.noLiquidityStreak = Math.min(this.cfg.adapt.maxNoLiquidityStreak, this.noLiquidityStreak + 1);
      return intents;
    }

    // v4.2.1: Time-scaled buffer
    const baseBuffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const bufferAdd = getScaledBufferAdd(this.currentTimeFactor, this.cfg.timeScaled.bufferAddBase);
    const buffer = baseBuffer + bufferAdd;
    
    const ok = (this.state === "SKEWED") || pairedLockOk(snap, buffer);
    if (!ok) return intents;

    const tick = this.tickInferer.getTick(snap.marketId, sideToBuy, book, snap.ts);
    const px = roundDownToTick(top.ask, tick);

    const usd = this.computeClipUsd(snap);
    const qty = sharesFromUsd(usd, Math.max(px, tick));

    intents.push({ side: sideToBuy, qty, limitPrice: px, tag: "REBAL", reason: "REBALANCE" });
    return intents;
  }

  private buildEntryOrAccumulateIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    const maxEntryShares = 50; // cap ENTRY sizing to avoid extreme low-price share counts

    if (this.state === "UNWIND") return intents;
    if (snap.secondsRemaining <= this.cfg.timing.stopNewTradesSec) return intents;

    // v4.2.1: HIGH delta regime blocks new risk
    if (this.currentDeltaRegime === "HIGH") {
      this.log("ENTRY_BLOCKED_HIGH_DELTA", { deltaPct: this.currentDeltaPct, regime: this.currentDeltaRegime });
      return intents;
    }

    if (totalNotional(this.inventory) >= this.cfg.limits.maxTotalUsd) return intents;

    // v3.1: Profit lock - stop entry/accumulate if locked
    if (isProfitLocked(this.inventory, this.cfg.profit.lockPairCost)) {
      this.log("ENTRY_BLOCKED_PROFIT_LOCK", { pairCost: pairCost(this.inventory) });
      return intents;
    }

    // v4.2.1: Time-scaled buffer
    const baseBuffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const bufferAdd = getScaledBufferAdd(this.currentTimeFactor, this.cfg.timeScaled.bufferAddBase);
    const buffer = baseBuffer + bufferAdd;
    
    const edgeCheck = executionAwareEdgeOk(snap, buffer);
    
    if (!edgeCheck.ok) {
      const edge = 1 - edgeCheck.expectedExecutedPairCost;
      if (edge < 0.02) {
        this.log("ENTRY_SKIP_LOW_EDGE", { edge, expected: edgeCheck.expectedExecutedPairCost, buffer });
        return intents;
      }
      return intents;
    }

    // v4.2.1: DEEP mode with stricter conditions
    const isDeep = this.currentRegime === "DEEP" && isDeepModeAllowed(snap, this.currentDeltaPct, this.cfg);
    
    const hasBoth = (this.inventory.upShares > 0 && this.inventory.downShares > 0);
    const delta = upFraction(this.inventory) - this.cfg.skew.target;

    // v4.2.2: ATOMIC PAIR ACCUMULATE - buy both sides together for better balance
    // Only do single-side buys in DEEP mode or for rebalancing
    const shouldBuyPair = hasBoth && !isDeep && Math.abs(delta) <= (this.cfg.skew.rebalanceThreshold / 2);

    if (shouldBuyPair) {
      // ATOMIC PAIR: Buy both UP and DOWN at the same time
      const upTop = snap.upTop;
      const downTop = snap.downTop;

      // Check liquidity on both sides
      if (upTop.askSize < this.cfg.limits.minTopDepthShares || downTop.askSize < this.cfg.limits.minTopDepthShares) {
        this.noLiquidityStreak = Math.min(this.cfg.adapt.maxNoLiquidityStreak, this.noLiquidityStreak + 1);
        return intents;
      }

      // Check position limits for both sides
      if (sideNotional(this.inventory, "UP") >= this.cfg.limits.maxPerSideUsd ||
          sideNotional(this.inventory, "DOWN") >= this.cfg.limits.maxPerSideUsd) {
        return intents;
      }

      const upTick = this.tickInferer.getTick(snap.marketId, "UP", snap.upBook, snap.ts);
      const downTick = this.tickInferer.getTick(snap.marketId, "DOWN", snap.downBook, snap.ts);

      const upRawPx = this.cfg.execution.entryImproveTicks > 0
        ? addTicks(upTop.ask, upTick, -this.cfg.execution.entryImproveTicks)
        : upTop.ask;
      const downRawPx = this.cfg.execution.entryImproveTicks > 0
        ? addTicks(downTop.ask, downTick, -this.cfg.execution.entryImproveTicks)
        : downTop.ask;

      const upPx = roundDownToTick(upRawPx, upTick);
      const downPx = roundDownToTick(downRawPx, downTick);

      // Combined cost check - pair must still be profitable
      const combinedCost = upPx + downPx;
      if (combinedCost > 0.98) {
        this.log("PAIR_SKIP_EXPENSIVE", { combinedCost, upPx, downPx });
        return intents;
      }

      const usd = this.computeClipUsd(snap);

      // v4.2.2 fix: balance by SHARES (not USD) and cap size.
      // Splitting USD can create huge share imbalance when one side is very cheap.
      const pairQtyRaw = combinedCost > 0 ? Math.floor(usd / combinedCost) : 0;
      const pairQty = clamp(Math.max(1, pairQtyRaw), 1, maxEntryShares);

      this.log("PAIR_ACCUMULATE", { upPx, downPx, combinedCost, pairQty });

      intents.push({ side: "UP", qty: pairQty, limitPrice: upPx, tag: "ENTRY", reason: "PAIR_ACCUM_UP" });
      intents.push({ side: "DOWN", qty: pairQty, limitPrice: downPx, tag: "ENTRY", reason: "PAIR_ACCUM_DOWN" });
      return intents;
    }

    // SINGLE-SIDE: For DEEP mode, opening, or rebalancing
    let sideToBuy: Side;
    if (isDeep) {
      // DEEP: Always buy cheapest side
      sideToBuy = cheapestSideByAsk(snap);
    } else if (hasBoth && Math.abs(delta) > (this.cfg.skew.rebalanceThreshold / 2)) {
      // Rebalance: buy underweight side
      sideToBuy = delta > 0 ? "DOWN" : "UP";
    } else {
      // Opening: buy cheapest side first
      sideToBuy = cheapestSideByAsk(snap);
    }

    if (sideNotional(this.inventory, sideToBuy) >= this.cfg.limits.maxPerSideUsd) return intents;

    const top = sideToBuy === "UP" ? snap.upTop : snap.downTop;
    const book = sideToBuy === "UP" ? snap.upBook : snap.downBook;

    if (top.askSize < this.cfg.limits.minTopDepthShares) {
      this.noLiquidityStreak = Math.min(this.cfg.adapt.maxNoLiquidityStreak, this.noLiquidityStreak + 1);
      return intents;
    }

    const tick = this.tickInferer.getTick(snap.marketId, sideToBuy, book, snap.ts);
    const rawPx = this.cfg.execution.entryImproveTicks > 0
      ? addTicks(top.ask, tick, -this.cfg.execution.entryImproveTicks)
      : top.ask;
    const px = roundDownToTick(rawPx, tick);

    const usd = this.computeClipUsd(snap);
    const qty = Math.min(sharesFromUsd(usd, Math.max(px, tick)), maxEntryShares);

    const reason = isDeep 
      ? `DEEP_ENTRY ${sideToBuy}` 
      : (hasBoth ? "REBALANCE" : "OPENING");
    
    intents.push({ side: sideToBuy, qty, limitPrice: px, tag: "ENTRY", reason });
    return intents;
  }

  private async executeIntent(snap: MarketSnapshot, intent: OrderIntent): Promise<void> {
    if (this.openOrders.size >= this.cfg.limits.maxPendingOrders) return;

    const now = Date.now();
    if (now < this.cooldownUntilBySide[intent.side]) return;

    if (intent.qty <= 0 || intent.limitPrice <= 0 || intent.limitPrice >= 1) return;

    const res = await this.api.placeLimitOrder({
      marketId: this.marketId,
      side: intent.side,
      price: intent.limitPrice,
      qty: intent.qty,
      clientTag: intent.tag,
    });

    this.metrics.ordersPlaced += 1;
    this.cooldownUntilBySide[intent.side] = now + this.cfg.limits.sideCooldownMs;

    this.openOrders.set(res.orderId, {
      id: res.orderId,
      side: intent.side,
      price: intent.limitPrice,
      qty: intent.qty,
      qtyRemaining: intent.qty,
      createdTs: now,
      tag: intent.tag,
    });

    if (intent.tag === "HEDGE") {
      if (intent.side === "UP") this.pendingHedge.up = Math.max(0, this.pendingHedge.up - intent.qty);
      else this.pendingHedge.down = Math.max(0, this.pendingHedge.down - intent.qty);
    }

    this.noLiquidityStreak = 0;

    this.log("ORDER_PLACED", {
      marketId: this.marketId,
      state: this.state,
      regime: this.currentRegime,
      intent: intent,
      inventory: this.inventory,
      pendingHedge: this.pendingHedge,
      t: snap.secondsRemaining,
      expectedPairCost: this.metrics.expectedExecutedPairCost,
      hedgeLagSec: this.metrics.hedgeLagSeconds,
      deltaRegime: this.currentDeltaRegime,
      deltaPct: (this.currentDeltaPct * 100).toFixed(3) + '%',
      timeFactor: this.currentTimeFactor.toFixed(2),
    });
  }

  private async cancelNonEssentialOrders(reason: string): Promise<void> {
    const toCancel: string[] = [];
    for (const [id, ord] of this.openOrders.entries()) {
      if (ord.tag === "HEDGE") continue;
      toCancel.push(id);
    }

    for (const id of toCancel) {
      await this.api.cancelOrder({ marketId: this.marketId, orderId: id });
      this.openOrders.delete(id);
      this.metrics.ordersCanceled += 1;
      this.log("ORDER_CANCELED", { marketId: this.marketId, orderId: id, reason });
    }
  }

  private async reconcileOpenOrders(): Promise<void> {
    if (!this.api.getOpenOrdersForMarket) return;
    const remote = await this.api.getOpenOrdersForMarket(this.marketId);

    const remoteIds = new Set(remote.map(o => o.orderId));
    for (const id of Array.from(this.openOrders.keys())) {
      if (!remoteIds.has(id)) this.openOrders.delete(id);
    }

    for (const o of remote) {
      const tag = (o.clientTag as any) as OpenOrder["tag"] | undefined;
      this.openOrders.set(o.orderId, {
        id: o.orderId,
        side: o.side,
        price: o.price,
        qty: o.qtyRemaining,
        qtyRemaining: o.qtyRemaining,
        createdTs: o.createdTs,
        tag: tag || "ENTRY",
      });
    }
  }

  /**
   * v3.1: Dynamic sizing based on edge %
   */
  private computeClipUsd(snap: MarketSnapshot): number {
    const cheaperSide = cheapestSideByAsk(snap);
    const cheapestAsk = cheaperSide === "UP" ? snap.upTop.ask : snap.downTop.ask;
    const otherMid = cheaperSide === "UP" ? snap.downTop.mid : snap.upTop.mid;
    const expectedPairCost = cheapestAsk + otherMid;
    const edge = Math.max(0, 1 - expectedPairCost);

    let mult = 1.0;

    // v3.1: Edge-based multipliers
    if (edge >= this.cfg.edge.strongEdge) {
      mult = this.cfg.sizing.edgeMultiplierHigh;      // >= 5c -> 2.0x
    } else if (edge >= 0.02) {
      mult = this.cfg.sizing.edgeMultiplierMedium;    // 2-5c -> 1.5x
    } else {
      mult = this.cfg.sizing.edgeMultiplierLow;       // < 2c -> 1.0x
    }

    // v3.1: DEEP regime boost
    if (this.currentRegime === "DEEP") {
      mult *= this.cfg.sizing.deepDislocMultiplier;
    }

    // Penalties
    if (snap.secondsRemaining < 60) {
      mult *= this.cfg.sizing.nearExpiryMultiplier;
    }
    if (this.noLiquidityStreak >= 3) {
      mult *= this.cfg.sizing.lowLiquidityMultiplier;
    }

    const usd = this.cfg.tradeSizeUsd.base * mult;
    return clamp(usd, this.cfg.tradeSizeUsd.min, this.cfg.tradeSizeUsd.max);
  }
}

/**
 * Optional runner helper:
 * const bot = new Polymarket15mArbBot(api, marketId);
 * setInterval(() => bot.tick().catch(console.error), DEFAULT_CONFIG.loop.decisionIntervalMs);
 * fillsStream.on('fill', f => bot.onFill(f));
 */
export function startBotLoop(bot: Polymarket15mArbBot, intervalMs?: number) {
  const ms = intervalMs ?? DEFAULT_CONFIG.loop.decisionIntervalMs;
  return setInterval(() => { void bot.tick(); }, ms);
}
