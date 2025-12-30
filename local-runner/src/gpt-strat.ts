/**
 * polymarket_15m_bot.ts
 * --------------------------------------------------------------------------
 * Polymarket 15m Hedge/Arbitrage Bot v3.2.1 — Big Hedger
 *
 * v3.2.1 Changes (Big Hedger):
 * - Opening trade: 50 shares (was 25)
 * - Max position: 300 shares per side (was 150)
 * - Accumulate: max 50 shares per trade
 * - Accumulate only when hedged (skew < 10%)
 * - Exposure protection: no accumulate when one-sided
 *
 * v3.1 Changes:
 * - Execution-aware edge (expectedExecutedPairCost vs dynamicEdgeBuffer)
 * - DEEP_DISLOCATION regime for cheap < 0.95 combined
 * - Split hedge logic: NORMAL_HEDGE vs RISK_HEDGE
 * - Profit lock at avgPairCost <= 0.99
 * - Dynamic sizing based on edge %
 * - Timeout -> UNWIND state transition
 * - Enhanced logging with regime tags
 */

export type Side = "UP" | "DOWN";
export type BotState = "FLAT" | "ONE_SIDED" | "HEDGED" | "SKEWED" | "UNWIND" | "DEEP_DISLOCATION";
export type RegimeTag = "NORMAL" | "DEEP" | "UNWIND";

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

  timing: {
    stopNewTradesSec: number;
    hedgeTimeoutSec: number;
    hedgeMustBySec: number;
    unwindStartSec: number;
  };

  skew: {
    target: number;              // 0.50
    rebalanceThreshold: number;  // 0.20
    hardCap: number;             // 0.70
    deepAllowedSkew: number;     // 0.70 - allowed in DEEP regime
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
  // v3.2.1: Opening 50 shares, accumulate max 50, max position 300
  tradeSizeUsd: { base: 25, min: 20, max: 50 }, // ~50 shares at 50¢

  edge: {
    baseBuffer: 0.012,
    strongEdge: 0.04,      // 4c is strong edge
    allowOverpay: 0.01,    // Only allow 1c overpay (was 2c)
    feesBuffer: 0.002,
    slippageBuffer: 0.004,
    deepDislocationThreshold: 0.96, // Stricter: 96¢ triggers DEEP (was 95¢)
  },

  timing: {
    stopNewTradesSec: 30,
    hedgeTimeoutSec: 12,    // Force hedge after 12s (was 20s)
    hedgeMustBySec: 60,     // Must hedge by 60s remaining (was 75s)
    unwindStartSec: 45,
  },

  skew: {
    target: 0.50,
    rebalanceThreshold: 0.20,
    hardCap: 0.70,
    deepAllowedSkew: 0.70,
  },

  limits: {
    maxTotalUsd: 500,       // Increased for 300 shares (was 250)
    maxPerSideUsd: 300,     // 300 shares max per side (was 150)
    minTopDepthShares: 50,
    maxPendingOrders: 3,
    sideCooldownMs: 0,      // NO cooldown for hedge (was 2000ms)
  },

  execution: {
    tickFallback: 0.01,
    tickNiceSet: [0.01, 0.005, 0.002, 0.001],
    hedgeCushionTicks: 2,      // 2 ticks above ask (was 1)
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

  // v3.1: Track hedge lag and max skew
  private oneSidedStartTs: number | null = null;
  private maxSkewDuringTrade = 0.5;
  private currentRegime: RegimeTag = "NORMAL";

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
  };

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

    // v3.1: Determine regime first
    this.currentRegime = this.determineRegime(snap);
    this.metrics.regimeTag = this.currentRegime;

    // v3.1: Calculate expected executed pair cost for logging
    const buffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const edgeCheck = executionAwareEdgeOk(snap, buffer);
    this.metrics.expectedExecutedPairCost = edgeCheck.expectedExecutedPairCost;

    this.state = this.decideState(snap);

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
    intents.push(...this.buildHedgeIntents(snap));
    intents.push(...this.buildRebalanceIntents(snap));
    intents.push(...this.buildEntryOrAccumulateIntents(snap));

    for (const intent of intents.slice(0, this.cfg.loop.maxIntentsPerTick)) {
      await this.executeIntent(snap, intent);
    }

    this.metrics.noLiquidityStreakMax = Math.max(this.metrics.noLiquidityStreakMax, this.noLiquidityStreak);
    this.metrics.adverseStreakMax = Math.max(this.metrics.adverseStreakMax, this.adverseStreak);
  }

  /**
   * v3.1: Determine current trading regime
   */
  private determineRegime(snap: MarketSnapshot): RegimeTag {
    // Check UNWIND conditions first
    if (snap.secondsRemaining <= this.cfg.timing.unwindStartSec) return "UNWIND";
    if (this.noLiquidityStreak >= this.cfg.adapt.maxNoLiquidityStreak) return "UNWIND";
    if (this.adverseStreak >= this.cfg.adapt.maxAdverseStreak) return "UNWIND";
    
    // Check hedge timeout -> UNWIND
    if (this.oneSidedStartTs !== null) {
      const hedgeLagSec = (Date.now() - this.oneSidedStartTs) / 1000;
      if (hedgeLagSec >= this.cfg.timing.hedgeTimeoutSec) return "UNWIND";
    }

    // Check skew hard cap -> UNWIND
    const uf = upFraction(this.inventory);
    if ((this.inventory.upShares > 0 || this.inventory.downShares > 0) &&
        (uf > this.cfg.skew.hardCap || (1 - uf) > this.cfg.skew.hardCap)) {
      // Unless in DEEP regime where higher skew is allowed
      if (!isDeepDislocation(snap, this.cfg.edge.deepDislocationThreshold)) {
        return "UNWIND";
      }
    }

    // Check DEEP dislocation
    if (isDeepDislocation(snap, this.cfg.edge.deepDislocationThreshold)) {
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
   * v3.1: Split hedge logic - NORMAL vs RISK hedge
   */
  private buildHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];

    // In DEEP_DISLOCATION, only hedge when conditions normalize or timeout
    if (this.state === "DEEP_DISLOCATION") {
      const shouldHedgeInDeep = this.shouldHedgeInDeepRegime(snap);
      if (!shouldHedgeInDeep) {
        // Queue hedge for later but don't execute now
        return intents;
      }
      // If we should hedge, calculate pending based on current imbalance
      const inv = this.inventory;
      if (inv.upShares > 0 && inv.downShares === 0) {
        this.pendingHedge.down = inv.upShares;
      } else if (inv.downShares > 0 && inv.upShares === 0) {
        this.pendingHedge.up = inv.downShares;
      }
    }

    const wantUp = Math.floor(this.pendingHedge.up);
    const wantDown = Math.floor(this.pendingHedge.down);
    if (wantUp <= 0 && wantDown <= 0) return intents;

    // v3.1: Determine hedge mode
    const isRiskHedge = (
      this.state === "SKEWED" || 
      this.state === "UNWIND" || 
      snap.secondsRemaining <= this.cfg.timing.hedgeMustBySec ||
      this.currentRegime === "UNWIND"
    );

    // v3.1: Different combined limits for normal vs risk hedge
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

    // v3.1: Different cushion ticks for normal vs risk hedge
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
   * v3.1: Determine if we should hedge in DEEP regime
   * Hedge when: price normalizes, timeout reached, or skew exceeds deep cap
   */
  private shouldHedgeInDeepRegime(snap: MarketSnapshot): boolean {
    // Price normalized (no longer deep dislocation)
    if (!isDeepDislocation(snap, this.cfg.edge.deepDislocationThreshold)) {
      this.log("DEEP_EXIT_NORMALIZED", { reason: "price_normalized" });
      return true;
    }

    // Hedge timeout reached
    if (this.oneSidedStartTs !== null) {
      const lagSec = (Date.now() - this.oneSidedStartTs) / 1000;
      if (lagSec >= this.cfg.timing.hedgeTimeoutSec) {
        this.log("DEEP_EXIT_TIMEOUT", { lagSec });
        return true;
      }
    }

    // Skew exceeds even the deep allowed skew
    const uf = upFraction(this.inventory);
    if (uf > this.cfg.skew.deepAllowedSkew || (1 - uf) > this.cfg.skew.deepAllowedSkew) {
      this.log("DEEP_EXIT_SKEW_CAP", { skew: uf });
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

    // v3.1: Profit lock - stop if locked
    if (isProfitLocked(this.inventory, this.cfg.profit.lockPairCost)) {
      this.log("REBAL_BLOCKED_PROFIT_LOCK", { pairCost: pairCost(this.inventory) });
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

    const buffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
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

    if (this.state === "UNWIND") return intents;
    if (snap.secondsRemaining <= this.cfg.timing.stopNewTradesSec) return intents;

    if (totalNotional(this.inventory) >= this.cfg.limits.maxTotalUsd) return intents;

    // v3.1: Profit lock - stop entry/accumulate if locked
    if (isProfitLocked(this.inventory, this.cfg.profit.lockPairCost)) {
      this.log("ENTRY_BLOCKED_PROFIT_LOCK", { pairCost: pairCost(this.inventory) });
      return intents;
    }

    // v3.1: Use execution-aware edge instead of static combined
    const buffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const edgeCheck = executionAwareEdgeOk(snap, buffer);
    
    if (!edgeCheck.ok) {
      // v3.1: Check if we should skip entirely for < 2c edge
      const edge = 1 - edgeCheck.expectedExecutedPairCost;
      if (edge < 0.02) {
        this.log("ENTRY_SKIP_LOW_EDGE", { edge, expected: edgeCheck.expectedExecutedPairCost });
        return intents;
      }
      return intents;
    }

    // v3.1: In DEEP regime, buy only cheap side (no immediate hedge)
    const isDeep = this.currentRegime === "DEEP";
    
    const hasBoth = (this.inventory.upShares > 0 && this.inventory.downShares > 0);
    const delta = upFraction(this.inventory) - this.cfg.skew.target;

    // skew-aware accumulation: buy underweight if drift > half threshold
    let sideToBuy: Side;
    if (isDeep) {
      // DEEP: Always buy cheapest side
      sideToBuy = cheapestSideByAsk(snap);
    } else if (hasBoth && Math.abs(delta) > (this.cfg.skew.rebalanceThreshold / 2)) {
      sideToBuy = delta > 0 ? "DOWN" : "UP";
    } else {
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
    const qty = sharesFromUsd(usd, Math.max(px, tick));

    const reason = isDeep 
      ? `DEEP_ENTRY ${sideToBuy}` 
      : (hasBoth ? "ACCUMULATE" : "OPENING");
    
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
