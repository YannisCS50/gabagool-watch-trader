import { config } from './config.js';
import type { OrderbookDepth } from './polymarket.js';

// ============================================================
// GPT STRATEGY VERSION 6.0 – ADAPTIVE HEDGER
// Polymarket 15m Bot
// ============================================================
// 
// Core principle: Buy YES + NO asymmetrically when combined < $1.00
// Guaranteed profit = min(QtyYES, QtyNO) - (CostYES + CostNO)
// 
// States: FLAT → ONE_SIDED → HEDGED (winst) / SKEWED / DEEP_DISLOCATION
// ============================================================

export const STRATEGY_VERSION = '6.0.0';
export const STRATEGY_NAME = 'GPT Strategy v6.0 – Adaptive Hedger (Polymarket 15m Bot)';

// ============================================================
// TYPES & STATE MACHINE (PDF Section: Implementatie & Logica)
// ============================================================

export type Outcome = 'UP' | 'DOWN';
export type State = 'FLAT' | 'ONE_SIDED' | 'HEDGED' | 'SKEWED' | 'DEEP_DISLOCATION' | 'UNWIND';

export interface TopOfBook {
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
  updatedAtMs: number;
}

export interface Inventory {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  firstFillTs?: number;
  lastFillTs?: number;
}

export interface MarketPosition extends Inventory {
  upInvested: number;
  downInvested: number;
}

export interface PendingHedge {
  up: number;
  down: number;
}

export interface TradeSignal {
  outcome: Outcome;
  price: number;
  shares: number;
  reasoning: string;
  type: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind';
  isMarketable?: boolean;
  cushionTicks?: number;
}

export interface MarketState {
  state: State;
  inventory: Inventory;
  pendingHedge: PendingHedge;
  noLiquidityStreak: number;
  adverseStreak: number;
  lastDecisionTs: number;
}

// ============================================================
// STRATEGY CONFIGURATION v6.0 (PDF: Configuratie Parameters)
// ============================================================

export const STRATEGY = {
  // Trade size settings (in USDC) - PDF Section
  tradeSizeUsd: {
    base: 25,    // Base trade size
    min: 20,     // Minimum trade size
    max: 50,     // Maximum trade size (for strong edges)
  },
  
  // Edge thresholds - PDF Section
  edge: {
    baseBuffer: 0.015,        // 1.5¢ minimum mispricing required
    strongEdge: 0.04,         // 4¢+ = strong signal, scale up
    allowOverpay: 0.01,       // Max 1¢ overpay allowed for fill
    feesBuffer: 0.002,        // 0.2¢ for Polymarket 2% fee
    slippageBuffer: 0.004,    // 0.4¢ for execution slippage
    deepDislocationThreshold: 0.96, // Combined ≤ $0.96 = DEEP mode
  },
  
  // Timing and lifecycle - PDF Section
  timing: {
    stopNewTradesSec: 30,     // No new positions < 30s remaining
    hedgeTimeoutSec: 12,      // Force hedge after 12s if one-sided
    hedgeMustBySec: 60,       // Must be hedged by 60s remaining
    unwindStartSec: 45,       // Optional: start unwind at 45s
  },
  
  // Position skew management - PDF Section
  skew: {
    target: 0.50,             // Target 50/50 distribution
    rebalanceThreshold: 0.20, // >20% deviation triggers rebalance
    hardCap: 0.70,            // Never >70% of shares on one side
  },
  
  // Risk limits
  limits: {
    maxTotalNotional: 500,    // Max total investment
    maxPerSide: 300,          // Max per side
    maxSharesPerSide: 500,    // Max shares per side
  },
  
  // Tick & Rounding
  tick: {
    fallback: 0.01,
    validTicks: [0.01, 0.005, 0.002, 0.001],
    hedgeCushion: 3,          // 3 ticks cushion for hedge
  },
  
  // Opening parameters
  opening: {
    maxPrice: 0.52,           // Markets start ~48-52¢
    skipEdgeCheck: true,      // At open, trade directly
    maxDelayMs: 5000,         // Max wait after market open
  },
  
  // Hedge parameters
  hedge: {
    maxPrice: 0.75,           // Never pay >75¢ for hedge
    cushionTicks: 3,          // Extra ticks for fill
  },
  
  // Entry conditions
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  
  // Cooldown between trades
  cooldownMs: 5000,           // 5s cooldown
};

// ============================================================
// TICK INFERENCE
// ============================================================

export class TickInferer {
  constructor(private fallback = 0.01) {}

  infer(bookLevels: number[]): number {
    if (bookLevels.length < 2) return this.fallback;
    
    const diffs: number[] = [];
    for (let i = 1; i < bookLevels.length; i++) {
      const d = bookLevels[i] - bookLevels[i - 1];
      if (d > 0) diffs.push(d);
    }
    
    if (diffs.length === 0) return this.fallback;
    
    const min = Math.min(...diffs);
    if (!Number.isFinite(min) || min <= 0) return this.fallback;
    if (min > 0.05) return 0.01;
    if (min < 0.0005) return 0.001;
    
    const validTicks = STRATEGY.tick.validTicks;
    let closest = this.fallback;
    let closestDiff = Math.abs(min - this.fallback);
    
    for (const tick of validTicks) {
      const diff = Math.abs(min - tick);
      if (diff < closestDiff) {
        closest = tick;
        closestDiff = diff;
      }
    }
    
    return closest;
  }
}

export const tickInferer = new TickInferer(STRATEGY.tick.fallback);

// ============================================================
// ROUNDING HELPERS
// ============================================================

export function roundDown(price: number, tick: number): number {
  return Math.floor(price / tick) * tick;
}

export function roundUp(price: number, tick: number): number {
  return Math.ceil(price / tick) * tick;
}

// ============================================================
// DYNAMIC EDGE BUFFER (PDF: dynamicEdgeBuffer)
// Adapts based on liquidity and adverse conditions
// ============================================================

export function dynamicEdgeBuffer(
  noLiquidityStreak: number,
  adverseStreak: number
): number {
  let buffer = STRATEGY.edge.baseBuffer + STRATEGY.edge.feesBuffer + STRATEGY.edge.slippageBuffer;
  
  // Low liquidity: relax buffer slightly to get fills
  if (noLiquidityStreak > 3) {
    buffer -= 0.005; // -0.5¢ to increase fill chance
  }
  
  // Adverse price movement: tighten buffer
  if (adverseStreak > 2) {
    buffer += 0.005; // +0.5¢ to avoid chasing losses
  }
  
  // Clamp to reasonable range
  return Math.max(0.01, Math.min(0.03, buffer));
}

// ============================================================
// EXECUTION-AWARE EDGE CHECK (PDF: executionAwareEdgeOk)
// Uses cheapest ask + other mid to estimate actual execution cost
// ============================================================

export interface EdgeCheckResult {
  ok: boolean;
  entrySide: Outcome | null;
  expectedPairCost: number;
  edge: number;
}

export function executionAwareEdgeOk(
  upAsk: number,
  downAsk: number,
  upMid: number,
  downMid: number,
  buffer: number
): EdgeCheckResult {
  // Check both combinations: UP ask + DOWN mid, DOWN ask + UP mid
  const upEntryPairCost = upAsk + downMid;
  const downEntryPairCost = downAsk + upMid;
  
  const upEdge = 1 - upEntryPairCost;
  const downEdge = 1 - downEntryPairCost;
  
  // Choose the better edge
  if (upEdge > downEdge && upEdge >= buffer) {
    return { ok: true, entrySide: 'UP', expectedPairCost: upEntryPairCost, edge: upEdge };
  }
  if (downEdge >= buffer) {
    return { ok: true, entrySide: 'DOWN', expectedPairCost: downEntryPairCost, edge: downEdge };
  }
  
  return { ok: false, entrySide: null, expectedPairCost: Math.min(upEntryPairCost, downEntryPairCost), edge: Math.max(upEdge, downEdge) };
}

/** Simple paired lock check */
export function pairedLockOk(
  upAsk: number,
  downAsk: number,
  buffer: number = STRATEGY.edge.baseBuffer
): boolean {
  return upAsk + downAsk <= 1 - buffer;
}

/** Calculate edge percentage */
export function calculateEdge(upAsk: number, downAsk: number): number {
  return (1 - (upAsk + downAsk)) * 100;
}

// ============================================================
// SKEW CALCULATIONS (PDF: Skew management)
// ============================================================

export function calculateSkew(inv: Inventory): number {
  const total = inv.upShares + inv.downShares;
  if (total === 0) return 0;
  return (inv.upShares - inv.downShares) / total;
}

export function getSkewRatio(inv: Inventory): { upRatio: number; downRatio: number } {
  const total = inv.upShares + inv.downShares;
  if (total === 0) return { upRatio: 0.5, downRatio: 0.5 };
  return {
    upRatio: inv.upShares / total,
    downRatio: inv.downShares / total,
  };
}

export function needsRebalance(
  inv: Inventory,
  threshold: number = STRATEGY.skew.rebalanceThreshold
): Outcome | null {
  const s = calculateSkew(inv);
  if (s > threshold) return 'DOWN';   // Too much UP, buy DOWN
  if (s < -threshold) return 'UP';    // Too much DOWN, buy UP
  return null;
}

export function exceedsSkewCap(
  inv: Inventory,
  proposedSide: Outcome,
  proposedShares: number,
  cap: number = STRATEGY.skew.hardCap
): boolean {
  const newUp = inv.upShares + (proposedSide === 'UP' ? proposedShares : 0);
  const newDown = inv.downShares + (proposedSide === 'DOWN' ? proposedShares : 0);
  const total = newUp + newDown;
  if (total === 0) return false;
  
  const upRatio = newUp / total;
  return upRatio > cap || upRatio < (1 - cap);
}

// ============================================================
// FILL-DRIVEN HEDGING (PDF: onFill updates inventory)
// ============================================================

export function onFill(
  side: Outcome,
  qty: number,
  price: number,
  inv: Inventory,
  pendingHedge: PendingHedge
): void {
  const now = Date.now();
  inv.lastFillTs = now;
  inv.firstFillTs ??= now;

  if (side === 'UP') {
    inv.upShares += qty;
    inv.upCost += qty * price;
    pendingHedge.down += qty;
  } else {
    inv.downShares += qty;
    inv.downCost += qty * price;
    pendingHedge.up += qty;
  }
}

// ============================================================
// PAIR COST & PROFIT CALCULATIONS (PDF: Winstformule)
// ============================================================

export function pairCost(inv: Inventory): number {
  const upAvg = inv.upShares > 0 ? inv.upCost / inv.upShares : 0;
  const downAvg = inv.downShares > 0 ? inv.downCost / inv.downShares : 0;
  return upAvg + downAvg;
}

export function avgPrice(side: Outcome, inv: Inventory): number {
  if (side === 'UP') {
    return inv.upShares > 0 ? inv.upCost / inv.upShares : 0;
  }
  return inv.downShares > 0 ? inv.downCost / inv.downShares : 0;
}

export function lockedProfit(inv: Inventory, fees: number = 0.02): boolean {
  const cost = pairCost(inv);
  return cost < 1 - fees; // Must beat 2% Polymarket fee
}

export function calculateProfit(inv: Inventory): number {
  const minQty = Math.min(inv.upShares, inv.downShares);
  const totalCost = inv.upCost + inv.downCost;
  return minQty - totalCost; // Profit = min(Qty) - total costs
}

export function calculateProfitPercent(inv: Inventory): number {
  const totalCost = inv.upCost + inv.downCost;
  if (totalCost === 0) return 0;
  const profit = calculateProfit(inv);
  return (profit / totalCost) * 100;
}

// ============================================================
// STATE MACHINE (PDF: Bot States)
// FLAT → ONE_SIDED → HEDGED / SKEWED / DEEP_DISLOCATION → UNWIND
// ============================================================

export function determineState(
  inv: Inventory,
  pendingHedge: PendingHedge,
  upAsk?: number,
  downAsk?: number
): State {
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  
  if (!hasUp && !hasDown) {
    return 'FLAT';
  }
  
  if ((hasUp && !hasDown) || (!hasUp && hasDown)) {
    return 'ONE_SIDED';
  }
  
  // Both sides have shares - check for DEEP_DISLOCATION first
  if (upAsk !== undefined && downAsk !== undefined) {
    const combined = upAsk + downAsk;
    if (combined <= STRATEGY.edge.deepDislocationThreshold) {
      return 'DEEP_DISLOCATION';
    }
  }
  
  // Check skew level
  const skew = Math.abs(calculateSkew(inv));
  if (skew > STRATEGY.skew.rebalanceThreshold) {
    return 'SKEWED';
  }
  
  return 'HEDGED';
}

// ============================================================
// UNWIND TRIGGERS
// ============================================================

export function shouldUnwind(
  secondsRemaining: number,
  hedgeLagSec: number,
  noLiquidityStreak: number
): { unwind: boolean; reason: string } {
  if (secondsRemaining < STRATEGY.timing.unwindStartSec) {
    return { unwind: true, reason: `Time critical: ${secondsRemaining}s remaining` };
  }
  if (hedgeLagSec > STRATEGY.timing.hedgeTimeoutSec) {
    return { unwind: true, reason: `Hedge timeout: ${hedgeLagSec}s lag` };
  }
  if (noLiquidityStreak >= 6) {
    return { unwind: true, reason: `No liquidity streak: ${noLiquidityStreak}` };
  }
  return { unwind: false, reason: '' };
}

// ============================================================
// TRADE SIZE CALCULATION (PDF: batched order sizing)
// ============================================================

function getTradeSize(
  remainingSeconds: number,
  edgePercent: number,
  isDeepDislocation: boolean
): number {
  let size = STRATEGY.tradeSizeUsd.base;
  
  // Strong edge: scale up
  if (edgePercent >= STRATEGY.edge.strongEdge * 100) {
    size = STRATEGY.tradeSizeUsd.max;
  }
  
  // Deep dislocation: maximum size
  if (isDeepDislocation) {
    size = STRATEGY.tradeSizeUsd.max;
  }
  
  // Time-based reduction near expiry
  if (remainingSeconds < 120) {
    size = Math.max(size * 0.5, STRATEGY.tradeSizeUsd.min);
  }
  
  return Math.max(STRATEGY.tradeSizeUsd.min, Math.min(size, STRATEGY.tradeSizeUsd.max));
}

// ============================================================
// ENTRY BUILDING (PDF: Opening Trade)
// ============================================================

export function buildEntry(
  upAsk: number,
  downAsk: number,
  tradeSize: number = STRATEGY.tradeSizeUsd.base
): TradeSignal | null {
  const side: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
  const price = side === 'UP' ? upAsk : downAsk;
  const shares = Math.floor(tradeSize / price);
  
  if (shares < 1) return null;
  
  const combined = upAsk + downAsk;
  const edge = ((1 - combined) * 100).toFixed(1);
  
  return {
    outcome: side,
    price,
    shares,
    reasoning: `Opening ${side} @ ${(price * 100).toFixed(1)}¢ (combined=${(combined * 100).toFixed(0)}¢, edge=${edge}%)`,
    type: 'opening',
  };
}

// ============================================================
// HEDGE BUILDING (PDF: Anticipatory hedge)
// ============================================================

export function buildHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number
): TradeSignal {
  const cushion = STRATEGY.tick.hedgeCushion;
  const limit = roundUp(ask + cushion * tick, tick);
  
  // Cap at max hedge price
  const cappedLimit = Math.min(limit, STRATEGY.hedge.maxPrice);
  
  return {
    outcome: side,
    price: cappedLimit,
    shares: qty,
    reasoning: `Hedge ${side} @ ${(cappedLimit * 100).toFixed(1)}¢ (ask=${(ask * 100).toFixed(0)}¢ +${cushion}t)`,
    type: 'hedge',
    isMarketable: true,
    cushionTicks: cushion,
  };
}

// ============================================================
// FORCE HEDGE (PDF: Force Hedge after timeout)
// ============================================================

export function buildForceHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number,
  existingAvg: number
): TradeSignal | null {
  const cushion = STRATEGY.tick.hedgeCushion;
  const limit = roundUp(ask + cushion * tick, tick);
  const cappedLimit = Math.min(limit, STRATEGY.hedge.maxPrice);
  
  // Calculate projected combined cost
  const projectedCombined = existingAvg + cappedLimit;
  
  // Accept up to allowOverpay above break-even
  const maxAllowed = 1 + STRATEGY.edge.allowOverpay;
  
  if (projectedCombined > maxAllowed) {
    console.log(`[ForceHedge] SKIP: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(maxAllowed * 100).toFixed(0)}¢ max`);
    return null;
  }
  
  const profitPct = ((1 - projectedCombined) * 100).toFixed(1);
  
  return {
    outcome: side,
    price: cappedLimit,
    shares: qty,
    reasoning: `FORCE Hedge ${side} @ ${(cappedLimit * 100).toFixed(0)}¢ (combined=${(projectedCombined * 100).toFixed(0)}¢, ${profitPct}% ${projectedCombined <= 1 ? 'profit' : 'loss'})`,
    type: 'hedge',
    isMarketable: true,
    cushionTicks: cushion,
  };
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function getMid(bid: number | null, ask: number | null): number {
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  if (bid !== null) return bid;
  if (ask !== null) return ask;
  return 0.5;
}

// ============================================================
// BALANCE CHECK
// ============================================================

export function checkBalanceForOpening(
  availableBalance: number,
  requiredNotional: number
): { canProceed: boolean; reason?: string } {
  const minRequired = requiredNotional * 2;
  
  if (availableBalance < minRequired) {
    return {
      canProceed: false,
      reason: `Insufficient balance: $${availableBalance.toFixed(2)} < $${minRequired.toFixed(2)}`,
    };
  }
  
  return { canProceed: true };
}

// ============================================================
// MAIN EVALUATION FUNCTION (PDF: evaluateEntry/evaluateOpportunity)
// ============================================================

export interface EvaluationContext {
  book: TopOfBook;
  inventory: Inventory;
  pendingHedge: PendingHedge;
  remainingSeconds: number;
  lastTradeAtMs: number;
  nowMs: number;
  availableBalance?: number;
  noLiquidityStreak?: number;
  adverseStreak?: number;
  tick?: number;
  currentPrice?: number;
  strikePrice?: number;
}

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number,
  availableBalance?: number,
  currentPrice?: number,
  strikePrice?: number
): TradeSignal | null {
  const inventory: Inventory = {
    upShares: position.upShares,
    downShares: position.downShares,
    upCost: position.upInvested ?? position.upCost ?? 0,
    downCost: position.downInvested ?? position.downCost ?? 0,
    firstFillTs: undefined,
    lastFillTs: undefined,
  };
  
  const pendingHedge: PendingHedge = { up: 0, down: 0 };
  
  return evaluateWithContext({
    book,
    inventory,
    pendingHedge,
    remainingSeconds,
    lastTradeAtMs,
    nowMs,
    availableBalance,
    noLiquidityStreak: 0,
    adverseStreak: 0,
    tick: STRATEGY.tick.fallback,
    currentPrice,
    strikePrice,
  });
}

export function evaluateWithContext(ctx: EvaluationContext): TradeSignal | null {
  const {
    book,
    inventory: inv,
    pendingHedge,
    remainingSeconds,
    lastTradeAtMs,
    nowMs,
    availableBalance,
    noLiquidityStreak = 0,
    adverseStreak = 0,
    tick = STRATEGY.tick.fallback,
  } = ctx;

  // ========== PRE-CHECKS ==========
  
  // Cooldown check
  if (lastTradeAtMs && nowMs - lastTradeAtMs < STRATEGY.cooldownMs) {
    return null;
  }

  // Book freshness
  if (nowMs - book.updatedAtMs > STRATEGY.entry.staleBookMs) {
    return null;
  }

  const upAsk = book.up.ask;
  const downAsk = book.down.ask;
  const upBid = book.up.bid;
  const downBid = book.down.bid;

  if (!isNum(upAsk) || !isNum(downAsk)) {
    return null;
  }

  const combined = upAsk + downAsk;
  const upMid = getMid(upBid, upAsk);
  const downMid = getMid(downBid, downAsk);

  // Sanity checks
  if (combined < 0.85 || combined > 1.10) return null;
  if (upAsk < STRATEGY.entry.minPrice || upAsk > STRATEGY.entry.maxPrice) return null;
  if (downAsk < STRATEGY.entry.minPrice || downAsk > STRATEGY.entry.maxPrice) return null;

  // Calculate dynamic buffer
  const buffer = dynamicEdgeBuffer(noLiquidityStreak, adverseStreak);
  
  // ========== DETERMINE STATE ==========
  
  const state = determineState(inv, pendingHedge, upAsk, downAsk);
  const edgePct = calculateEdge(upAsk, downAsk);
  const isDeep = state === 'DEEP_DISLOCATION';
  
  // ========== UNWIND CHECK ==========
  
  const hedgeLagSec = inv.firstFillTs 
    ? (nowMs - inv.firstFillTs) / 1000 
    : 0;
  
  const unwindCheck = shouldUnwind(remainingSeconds, hedgeLagSec, noLiquidityStreak);
  
  // In UNWIND: only allow hedge attempts
  if (unwindCheck.unwind && state === 'ONE_SIDED') {
    const missingSide: Outcome = inv.upShares === 0 ? 'UP' : 'DOWN';
    const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
    const existingShares = missingSide === 'UP' ? inv.downShares : inv.upShares;
    const existingCost = missingSide === 'UP' ? inv.downCost : inv.upCost;
    const existingAvg = existingShares > 0 ? existingCost / existingShares : 0;
    
    const hedgeShares = Math.max(existingShares, 5);
    return buildForceHedge(missingSide, missingAsk, tick, hedgeShares, existingAvg);
  }
  
  if (unwindCheck.unwind) {
    return null;
  }

  // Position limits
  const totalInvested = inv.upCost + inv.downCost;
  if (totalInvested >= STRATEGY.limits.maxTotalNotional) return null;

  // Time check - no new positions in final seconds
  if (remainingSeconds < STRATEGY.timing.stopNewTradesSec && state === 'FLAT') {
    return null;
  }

  // ========== STATE-BASED TRADING LOGIC ==========

  switch (state) {
    case 'FLAT': {
      // PDF: Opening Trade - buy cheapest side if edge exists
      const edgeCheck = executionAwareEdgeOk(upAsk, downAsk, upMid, downMid, buffer);
      
      // Opening trade can skip edge check if price near fair value (48-52¢)
      const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      const isOpeningPrice = cheaperPrice <= STRATEGY.opening.maxPrice;
      
      if (!edgeCheck.ok && !(STRATEGY.opening.skipEdgeCheck && isOpeningPrice)) {
        return null;
      }
      
      // Balance check
      if (availableBalance !== undefined) {
        const check = checkBalanceForOpening(availableBalance, STRATEGY.tradeSizeUsd.base);
        if (!check.canProceed) return null;
      }
      
      const tradeSize = getTradeSize(remainingSeconds, edgePct, false);
      return buildEntry(upAsk, downAsk, tradeSize);
    }
    
    case 'ONE_SIDED': {
      // PDF: Hedge Trade - MUST hedge to secure position
      const missingSide: Outcome = inv.upShares === 0 ? 'UP' : 'DOWN';
      const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
      const existingShares = missingSide === 'UP' ? inv.downShares : inv.upShares;
      const existingCost = missingSide === 'UP' ? inv.downCost : inv.upCost;
      const existingAvg = existingShares > 0 ? existingCost / existingShares : 0;
      
      const hedgeShares = Math.max(existingShares, 5);
      const projectedCombined = existingAvg + missingAsk;
      const maxAllowed = 1 + STRATEGY.edge.allowOverpay;
      
      console.log(`[Strategy v6.0] Hedge eval: ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢, existingAvg=${(existingAvg * 100).toFixed(0)}¢, combined=${(projectedCombined * 100).toFixed(0)}¢`);
      
      // Check hedge timeout - force hedge after 12s
      const timeSinceFirstFill = inv.firstFillTs ? (nowMs - inv.firstFillTs) / 1000 : 0;
      const forceHedge = timeSinceFirstFill >= STRATEGY.timing.hedgeTimeoutSec;
      
      if (forceHedge) {
        console.log(`[Strategy v6.0] FORCE hedge after ${timeSinceFirstFill.toFixed(0)}s timeout`);
        return buildForceHedge(missingSide, missingAsk, tick, hedgeShares, existingAvg);
      }
      
      // Normal hedge: check if profitable
      if (projectedCombined <= maxAllowed) {
        return buildHedge(missingSide, missingAsk, tick, hedgeShares);
      }
      
      // Must be hedged by hedgeMustBySec
      if (remainingSeconds <= STRATEGY.timing.hedgeMustBySec) {
        console.log(`[Strategy v6.0] MUST hedge by ${STRATEGY.timing.hedgeMustBySec}s - forcing`);
        return buildForceHedge(missingSide, missingAsk, tick, hedgeShares, existingAvg);
      }
      
      console.log(`[Strategy v6.0] Waiting for better hedge price...`);
      return null;
    }
    
    case 'DEEP_DISLOCATION': {
      // PDF: Deep Dislocation Mode - aggressive accumulation
      console.log(`[Strategy v6.0] DEEP DISLOCATION: combined=${(combined * 100).toFixed(0)}¢, edge=${edgePct.toFixed(1)}%`);
      
      const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      
      // Max size for deep dislocation
      const maxTradeSize = STRATEGY.tradeSizeUsd.max;
      const shares = Math.floor(maxTradeSize / cheaperPrice);
      
      if (shares < 5) return null;
      
      // Check skew cap
      if (exceedsSkewCap(inv, cheaperSide, shares)) {
        // Buy the OTHER side instead to balance
        const otherSide: Outcome = cheaperSide === 'UP' ? 'DOWN' : 'UP';
        const otherAsk = otherSide === 'UP' ? upAsk : downAsk;
        const otherShares = Math.floor(maxTradeSize / otherAsk);
        
        if (otherShares >= 5 && !exceedsSkewCap(inv, otherSide, otherShares)) {
          return {
            outcome: otherSide,
            price: roundDown(otherAsk, tick),
            shares: otherShares,
            reasoning: `DEEP Accumulate ${otherSide} @ ${(otherAsk * 100).toFixed(0)}¢ (rebalancing, ${edgePct.toFixed(1)}% edge)`,
            type: 'accumulate',
          };
        }
        return null;
      }
      
      return {
        outcome: cheaperSide,
        price: roundDown(cheaperPrice, tick),
        shares,
        reasoning: `DEEP Accumulate ${cheaperSide} @ ${(cheaperPrice * 100).toFixed(0)}¢ (${edgePct.toFixed(1)}% edge!)`,
        type: 'accumulate',
      };
    }
    
    case 'SKEWED': {
      // PDF: Skew management - rebalance towards 50/50
      const rebalanceSide = needsRebalance(inv);
      if (!rebalanceSide) return null;
      
      const rebalanceAsk = rebalanceSide === 'UP' ? upAsk : downAsk;
      const currentShares = rebalanceSide === 'UP' ? inv.upShares : inv.downShares;
      const otherShares = rebalanceSide === 'UP' ? inv.downShares : inv.upShares;
      
      // Buy enough to approach balance
      const sharesToBalance = Math.floor((otherShares - currentShares) / 2);
      if (sharesToBalance < 5) return null;
      
      // Check if this would exceed skew cap
      if (exceedsSkewCap(inv, rebalanceSide, sharesToBalance)) {
        const smallerAmount = Math.floor(sharesToBalance / 2);
        if (smallerAmount >= 5 && !exceedsSkewCap(inv, rebalanceSide, smallerAmount)) {
          return {
            outcome: rebalanceSide,
            price: roundDown(rebalanceAsk, tick),
            shares: smallerAmount,
            reasoning: `Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(0)}¢ (partial skew correction)`,
            type: 'rebalance',
          };
        }
        return null;
      }
      
      return {
        outcome: rebalanceSide,
        price: roundDown(rebalanceAsk, tick),
        shares: sharesToBalance,
        reasoning: `Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(0)}¢ (skew correction to 50/50)`,
        type: 'rebalance',
      };
    }
    
    case 'HEDGED': {
      // PDF: Accumulation - expand position if good combined price
      if (!pairedLockOk(upAsk, downAsk, buffer)) {
        return null;
      }
      
      // Position limits
      if (inv.upShares >= STRATEGY.limits.maxSharesPerSide || 
          inv.downShares >= STRATEGY.limits.maxSharesPerSide) {
        return null;
      }
      
      // Only accumulate if shares are balanced (within 10%)
      const shareDiff = Math.abs(inv.upShares - inv.downShares);
      const avgShares = (inv.upShares + inv.downShares) / 2;
      if (avgShares > 0 && shareDiff / avgShares > 0.1) {
        console.log(`[Strategy v6.0] BLOCK accumulate: shares not balanced (diff=${shareDiff})`);
        return null;
      }
      
      // Check if accumulating would improve pair cost
      const currentPairCost = pairCost(inv);
      if (combined >= currentPairCost) {
        return null; // Only accumulate if new price is better
      }
      
      const tradeSize = getTradeSize(remainingSeconds, edgePct, false);
      const sharesToAdd = Math.floor(tradeSize / combined);
      
      if (sharesToAdd < 5) return null;
      
      // Buy the cheaper side
      const accumulateSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const accumulatePrice = accumulateSide === 'UP' ? upAsk : downAsk;
      
      return {
        outcome: accumulateSide,
        price: roundDown(accumulatePrice, tick),
        shares: sharesToAdd,
        reasoning: `Accumulate ${accumulateSide} @ ${(combined * 100).toFixed(0)}¢ combined (${edgePct.toFixed(1)}% edge) - also buy ${accumulateSide === 'UP' ? 'DOWN' : 'UP'}`,
        type: 'accumulate',
      };
    }
    
    default:
      return null;
  }
}

// ============================================================
// LIQUIDITY CHECK
// ============================================================

export function checkLiquidityForAccumulate(
  upDepth: OrderbookDepth,
  downDepth: OrderbookDepth,
  requiredShares: number
): { canProceed: boolean; reason?: string } {
  const minLiquidity = Math.max(requiredShares, 10);
  
  if (!upDepth.hasLiquidity) {
    return { canProceed: false, reason: `UP side has no liquidity` };
  }
  
  if (!downDepth.hasLiquidity) {
    return { canProceed: false, reason: `DOWN side has no liquidity` };
  }
  
  if (upDepth.askVolume < minLiquidity) {
    return { canProceed: false, reason: `UP side insufficient liquidity` };
  }
  
  if (downDepth.askVolume < minLiquidity) {
    return { canProceed: false, reason: `DOWN side insufficient liquidity` };
  }
  
  return { canProceed: true };
}

// ============================================================
// PRE-HEDGE CALCULATION
// ============================================================

export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: Outcome,
  hedgeAsk?: number,
  tick: number = 0.01
): { hedgeSide: Outcome; hedgePrice: number; reasoning: string } | null {
  const hedgeSide: Outcome = openingSide === 'UP' ? 'DOWN' : 'UP';
  
  let hedgePrice: number;
  let reasoning: string;
  
  if (hedgeAsk !== undefined && hedgeAsk > 0) {
    const cushion = STRATEGY.tick.hedgeCushion;
    const rawHedgePrice = roundUp(hedgeAsk + cushion * tick, tick);
    hedgePrice = Math.min(rawHedgePrice, STRATEGY.hedge.maxPrice);
    
    const projectedCombined = openingPrice + hedgePrice;
    const maxAllowed = 1 + STRATEGY.edge.allowOverpay;
    
    if (projectedCombined > maxAllowed) {
      console.log(`[PreHedge] RISK: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(maxAllowed * 100).toFixed(0)}¢ max`);
      return null;
    }
    
    const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (combined=${(projectedCombined * 100).toFixed(0)}¢, ${edgePct}% edge)`;
  } else {
    const targetCombined = 1 - STRATEGY.edge.baseBuffer;
    hedgePrice = Math.min(targetCombined - openingPrice, STRATEGY.hedge.maxPrice);
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (theoretical)`;
  }
  
  if (hedgePrice < STRATEGY.entry.minPrice) {
    return null;
  }
  
  return { hedgeSide, hedgePrice, reasoning };
}

// ============================================================
// HARD SKEW STOP
// ============================================================

export function checkHardSkewStop(position: MarketPosition): { blocked: boolean; reason?: string } {
  const upShares = position.upShares || 0;
  const downShares = position.downShares || 0;
  const total = upShares + downShares;
  
  if (total === 0) {
    return { blocked: false };
  }
  
  const upRatio = upShares / total;
  const downRatio = downShares / total;
  
  if (upRatio > STRATEGY.skew.hardCap) {
    return { blocked: true, reason: `UP ratio ${(upRatio * 100).toFixed(0)}% exceeds ${(STRATEGY.skew.hardCap * 100).toFixed(0)}% cap` };
  }
  
  if (downRatio > STRATEGY.skew.hardCap) {
    return { blocked: true, reason: `DOWN ratio ${(downRatio * 100).toFixed(0)}% exceeds ${(STRATEGY.skew.hardCap * 100).toFixed(0)}% cap` };
  }
  
  return { blocked: false };
}

// ============================================================
// PROBABILITY BIAS (kept for backward compatibility)
// ============================================================

export interface PriceBiasContext {
  currentPrice: number;
  strikePrice: number;
  remainingSeconds: number;
}

export function calculateLikelySide(ctx: PriceBiasContext): {
  likelySide: Outcome | null;
  losingSide: Outcome | null;
  distanceUsd: number;
  confidence: 'low' | 'medium' | 'high';
} {
  const { currentPrice, strikePrice } = ctx;
  
  if (!strikePrice || strikePrice <= 0) {
    return { likelySide: null, losingSide: null, distanceUsd: 0, confidence: 'low' };
  }
  
  const distanceUsd = currentPrice - strikePrice;
  const absDistance = Math.abs(distanceUsd);
  
  // Thresholds for confidence levels
  if (absDistance < 50) {
    return { likelySide: null, losingSide: null, distanceUsd, confidence: 'low' };
  }
  
  const likelySide: Outcome = distanceUsd > 0 ? 'UP' : 'DOWN';
  const losingSide: Outcome = likelySide === 'UP' ? 'DOWN' : 'UP';
  const confidence = absDistance >= 150 ? 'high' : 'medium';
  
  return { likelySide, losingSide, distanceUsd, confidence };
}

export function shouldSkipLosingHedge(
  ctx: PriceBiasContext,
  hedgeSide: Outcome
): { skip: boolean; reason: string } {
  // v6.0: ALWAYS hedge - never skip based on probability
  // Unhedged positions are 100% loss risk, which is always worse than overpaying
  return { skip: false, reason: 'v6.0: Always hedge (no probability skip)' };
}
