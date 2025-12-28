/**
 * polymarket_15m_bot.ts
 * --------------------------------------------------------------------------
 * Polymarket 15m Hedge/Arbitrage Bot (Gabagool-Grade) — Single File Reference
 *
 * Highlights:
 * - Fill-driven hedging (partial-fill safe): hedges are scheduled ONLY from fills.
 * - Execution-aware edge: uses executable prices + dynamic buffer.
 * - Skew control: rebalance and hard caps.
 * - UNWIND: stop adding risk near expiry / failures; prioritize hedging.
 * - Tick inference from orderbook (fallback 0.01) + safe rounding.
 *
 * Wire your own Polymarket CLOB client by implementing PolymarketClobApi at bottom.
 */

export type Side = "UP" | "DOWN";
export type BotState = "FLAT" | "ONE_SIDED" | "HEDGED" | "SKEWED" | "UNWIND";

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
}

export interface StrategyConfig {
  tradeSizeUsd: { base: number; min: number; max: number };

  edge: {
    baseBuffer: number;     // e.g. 0.012 = 1.2c
    strongEdge: number;     // e.g. 0.05 = 5c
    allowOverpay: number;   // e.g. 0.02 => hedge allowed up to 1.02 combined (risk-first)
    feesBuffer: number;
    slippageBuffer: number;
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
    hedgeCushionTicks: number;
    entryImproveTicks: number;   // 0=ask, 1=1 tick better
  };

  adapt: {
    maxNoLiquidityStreak: number;
    maxAdverseStreak: number;
    bufferLiquidityPenaltyPerTick: number;
    bufferAdversePenaltyPerTick: number;
    clipDownscaleNoLiquidity: number;
  };

  profit: {
    lockPairCost: number; // e.g. 0.99
  };

  loop: {
    decisionIntervalMs: number;
    maxIntentsPerTick: number;
  };
}

export const DEFAULT_CONFIG: StrategyConfig = {
  tradeSizeUsd: { base: 8, min: 3, max: 15 },

  edge: {
    baseBuffer: 0.012,
    strongEdge: 0.05,
    allowOverpay: 0.02,
    feesBuffer: 0.002,
    slippageBuffer: 0.004,
  },

  timing: {
    stopNewTradesSec: 30,
    hedgeTimeoutSec: 20,
    hedgeMustBySec: 75,
    unwindStartSec: 45,
  },

  skew: {
    target: 0.50,
    rebalanceThreshold: 0.20,
    hardCap: 0.70,
  },

  limits: {
    maxTotalUsd: 250,
    maxPerSideUsd: 150,
    minTopDepthShares: 50,
    maxPendingOrders: 3,
    sideCooldownMs: 2000,
  },

  execution: {
    tickFallback: 0.01,
    tickNiceSet: [0.01, 0.005, 0.002, 0.001],
    hedgeCushionTicks: 2,
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

// ---------- Edge (executable-aware) ----------

function dynamicEdgeBuffer(cfg: StrategyConfig, noLiquidityStreak: number, adverseStreak: number): number {
  const liquidityPenalty = Math.min(0.01, noLiquidityStreak * cfg.adapt.bufferLiquidityPenaltyPerTick);
  const adversePenalty = Math.min(0.01, adverseStreak * cfg.adapt.bufferAdversePenaltyPerTick);
  return cfg.edge.baseBuffer + cfg.edge.feesBuffer + cfg.edge.slippageBuffer + liquidityPenalty + adversePenalty;
}

function pairedLockOk(snap: MarketSnapshot, buffer: number): boolean {
  return (snap.upTop.ask + snap.downTop.ask) <= (1 - buffer);
}

function asymmetricEdgeOk(cfg: StrategyConfig, snap: MarketSnapshot, buffer: number): { ok: boolean; entrySide: Side } {
  const entrySide = cheapestSideByAsk(snap);
  const cheapestAsk = entrySide === "UP" ? snap.upTop.ask : snap.downTop.ask;
  const otherMid = entrySide === "UP" ? snap.downTop.mid : snap.upTop.mid;
  const otherAsk = entrySide === "UP" ? snap.downTop.ask : snap.upTop.ask;

  const combinedProxy = cheapestAsk + otherMid;
  const okEdge = combinedProxy <= (1 - buffer);

  const okHedgeFeasible = (cheapestAsk + otherAsk) <= (1 + cfg.edge.allowOverpay);

  return { ok: okEdge && okHedgeFeasible, entrySide };
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

// ---------- Bot implementation ----------

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
      this.pendingHedge.down += fill.fillQty;
    } else {
      this.inventory.downShares += fill.fillQty;
      this.inventory.downCost += fill.fillQty * fill.fillPrice;
      this.pendingHedge.up += fill.fillQty;
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
    }
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

    this.state = this.decideState(snap);

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

  private decideState(snap: MarketSnapshot): BotState {
    const inv = this.inventory;

    if (snap.secondsRemaining <= this.cfg.timing.unwindStartSec) return "UNWIND";
    if (this.noLiquidityStreak >= this.cfg.adapt.maxNoLiquidityStreak) return "UNWIND";
    if (this.adverseStreak >= this.cfg.adapt.maxAdverseStreak) return "UNWIND";

    const tot = inv.upShares + inv.downShares;
    if (tot === 0) return "FLAT";
    if (inv.upShares === 0 || inv.downShares === 0) {
      if (inv.firstFillTs !== undefined) {
        const ageSec = (snap.ts - inv.firstFillTs) / 1000;
        if (ageSec >= this.cfg.timing.hedgeTimeoutSec) return "UNWIND";
      }
      return "ONE_SIDED";
    }

    const uf = upFraction(inv);
    if (uf > this.cfg.skew.hardCap || (1 - uf) > this.cfg.skew.hardCap) return "SKEWED";

    return "HEDGED";
  }

  private buildHedgeIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];

    const wantUp = Math.floor(this.pendingHedge.up);
    const wantDown = Math.floor(this.pendingHedge.down);
    if (wantUp <= 0 && wantDown <= 0) return intents;

    const mustHedge = (this.state === "SKEWED" || this.state === "UNWIND" || snap.secondsRemaining <= this.cfg.timing.hedgeMustBySec);

    const combinedAsk = snap.upTop.ask + snap.downTop.ask;
    const canHedge = combinedAsk <= (1 + this.cfg.edge.allowOverpay);

    if (!canHedge && this.state !== "UNWIND") {
      this.adverseStreak = Math.min(this.cfg.adapt.maxAdverseStreak, this.adverseStreak + 1);
      this.log("HEDGE_SKIPPED_OVERPAY", { combinedAsk });
      return intents;
    }

    const mk = (side: Side, qty: number): OrderIntent | null => {
      if (qty <= 0) return null;

      const top = side === "UP" ? snap.upTop : snap.downTop;
      const book = side === "UP" ? snap.upBook : snap.downBook;

      if (top.askSize < this.cfg.limits.minTopDepthShares) {
        this.noLiquidityStreak = Math.min(this.cfg.adapt.maxNoLiquidityStreak, this.noLiquidityStreak + 1);
        return null;
      }

      const tick = this.tickInferer.getTick(snap.marketId, side, book, snap.ts);
      const base = mustHedge ? addTicks(top.ask, tick, this.cfg.execution.hedgeCushionTicks) : top.ask;
      const px = roundUpToTick(base, tick);

      return { side, qty, limitPrice: px, tag: "HEDGE", reason: mustHedge ? "HEDGE_MUST" : "HEDGE" };
    };

    const i1 = mk("UP", wantUp);
    if (i1) intents.push(i1);
    const i2 = mk("DOWN", wantDown);
    if (i2) intents.push(i2);

    return intents;
  }

  private buildRebalanceIntents(snap: MarketSnapshot): OrderIntent[] {
    const intents: OrderIntent[] = [];
    if (this.state !== "HEDGED" && this.state !== "SKEWED") return intents;

    const pc = pairCost(this.inventory);
    if (Number.isFinite(pc) && pc <= this.cfg.profit.lockPairCost) return intents;

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

    const pc = pairCost(this.inventory);
    if (Number.isFinite(pc) && pc <= this.cfg.profit.lockPairCost) return intents;

    const buffer = dynamicEdgeBuffer(this.cfg, this.noLiquidityStreak, this.adverseStreak);
    const asym = asymmetricEdgeOk(this.cfg, snap, buffer);
    if (!asym.ok) return intents;

    const hasBoth = (this.inventory.upShares > 0 && this.inventory.downShares > 0);
    const delta = upFraction(this.inventory) - this.cfg.skew.target;

    // skew-aware accumulation: buy underweight if drift > half threshold
    let sideToBuy: Side;
    if (hasBoth && Math.abs(delta) > (this.cfg.skew.rebalanceThreshold / 2)) {
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

    intents.push({ side: sideToBuy, qty, limitPrice: px, tag: "ENTRY", reason: hasBoth ? "ACCUMULATE" : "OPENING" });
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
      intent: intent,
      inventory: this.inventory,
      pendingHedge: this.pendingHedge,
      t: snap.secondsRemaining,
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

  private computeClipUsd(snap: MarketSnapshot): number {
    const combinedMid = snap.upTop.mid + snap.downTop.mid;
    const edge = Math.max(0, 1 - combinedMid);

    let mult = 1.0;
    if (edge >= this.cfg.edge.strongEdge) mult = 2.0;
    else if (edge > 0) mult = 1.5;

    if (snap.secondsRemaining < 60) mult *= 0.5;
    if (this.noLiquidityStreak >= 3) mult *= this.cfg.adapt.clipDownscaleNoLiquidity;

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
