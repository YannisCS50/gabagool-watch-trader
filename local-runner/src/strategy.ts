import { config } from './config.js';
import type { OrderbookDepth } from './polymarket.js';

// ============================================================
// TYPES & STATE MACHINE (PDF Section 3 & 12.1)
// ============================================================

export type Outcome = 'UP' | 'DOWN';
export type State = 'FLAT' | 'ONE_SIDED' | 'HEDGED' | 'SKEWED' | 'UNWIND';

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
  // Alias for backward compatibility
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
  isMarketable?: boolean; // True for hedge orders that cross the spread
  cushionTicks?: number;  // Extra ticks added for guaranteed fill
}

export interface MarketState {
  state: State;
  inventory: Inventory;
  pendingHedge: PendingHedge;
  noLiquidityStreak: number;
  lastDecisionTs: number;
}

// ============================================================
// STRATEGY CONFIGURATION (PDF Section 8 & 11)
// ============================================================

export const STRATEGY = {
  // Edge & Entry (PDF Section 4 & 11)
  edge: {
    buffer: 0.012,         // 1.2¢ edge buffer (range 0.6–2.0¢)
    minExecutableEdge: 0.008, // Minimum edge after fees
  },
  
  // Tick & Rounding (PDF Section 5)
  tick: {
    fallback: 0.01,
    validTicks: [0.01, 0.005, 0.002, 0.001],
    hedgeCushion: 2,       // 2 ticks cushion for hedge (range 1–6)
  },
  
  // Sizing (PDF Section 6)
  sizing: {
    baseClipUsd: 8,        // Base clip size
    minClipUsd: 3,
    maxClipUsd: 15,
  },
  
  // Skew Management (PDF Section 7)
  skew: {
    target: 0.5,           // 50/50 target
    rebalanceThreshold: 0.20, // ±20% triggers rebalance
    hardCap: 0.70,         // 70/30 max skew
  },
  
  // Risk Limits (PDF Section 8)
  limits: {
    maxTotalNotional: 250,
    maxPerSide: 150,
    hedgeTimeoutSec: 20,
    stopTradesSec: 30,     // Stop new trades in last 30 seconds
    unwindStartSec: 45,    // Start unwind at 45 seconds remaining
  },
  
  // Opening parameters
  opening: {
    notional: config.trading.maxNotionalPerTrade,
    maxPrice: 0.50,
  },
  
  // Entry conditions
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  
  // Cooldown
  cooldownMs: 15000,
};

// ============================================================
// TICK INFERENCE (PDF Section 12.2)
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
    
    // Snap to nearest valid tick
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
// ROUNDING HELPERS (PDF Section 5)
// ============================================================

export function roundDown(price: number, tick: number): number {
  return Math.floor(price / tick) * tick;
}

export function roundUp(price: number, tick: number): number {
  return Math.ceil(price / tick) * tick;
}

// ============================================================
// EDGE CALCULATIONS (PDF Section 12.3)
// ============================================================

/** Check if executable edge exists (NOT mid-based!) */
export function executableEdgeOk(
  cheapestAsk: number,
  otherMid: number,
  buffer: number = STRATEGY.edge.buffer
): boolean {
  return cheapestAsk + otherMid <= 1 - buffer;
}

/** Check if paired lock (both asks) provides edge */
export function pairedLockOk(
  upAsk: number,
  downAsk: number,
  buffer: number = STRATEGY.edge.buffer
): boolean {
  return upAsk + downAsk <= 1 - buffer;
}

// ============================================================
// SKEW CALCULATIONS (PDF Section 12.7)
// ============================================================

export function calculateSkew(inv: Inventory): number {
  const total = inv.upShares + inv.downShares;
  if (total === 0) return 0;
  return (inv.upShares - inv.downShares) / total;
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
// FILL-DRIVEN HEDGING (PDF Section 12.4) - CRITICAL!
// ============================================================

/**
 * Called when a fill is received. Updates inventory and enqueues hedge.
 * THIS IS THE HEART OF THE STRATEGY: hedge by ACTUAL fills, not order intent!
 */
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
    pendingHedge.down += qty; // Enqueue hedge for opposite side
  } else {
    inv.downShares += qty;
    inv.downCost += qty * price;
    pendingHedge.up += qty;   // Enqueue hedge for opposite side
  }
}

// ============================================================
// PAIR COST & PROFIT CHECK (PDF Section 12.9)
// ============================================================

export function pairCost(inv: Inventory): number {
  const upAvg = inv.upShares > 0 ? inv.upCost / inv.upShares : 0;
  const downAvg = inv.downShares > 0 ? inv.downCost / inv.downShares : 0;
  return upAvg + downAvg;
}

export function lockedProfit(inv: Inventory, fees: number = 0.002): boolean {
  return pairCost(inv) < 1 - fees;
}

// ============================================================
// UNWIND TRIGGERS (PDF Section 12.8)
// ============================================================

export function shouldUnwind(
  secondsRemaining: number,
  hedgeLagSec: number,
  noLiquidityStreak: number
): { unwind: boolean; reason: string } {
  if (secondsRemaining < STRATEGY.limits.unwindStartSec) {
    return { unwind: true, reason: `Time critical: ${secondsRemaining}s remaining` };
  }
  if (hedgeLagSec > STRATEGY.limits.hedgeTimeoutSec) {
    return { unwind: true, reason: `Hedge timeout: ${hedgeLagSec}s lag` };
  }
  if (noLiquidityStreak >= 6) {
    return { unwind: true, reason: `No liquidity streak: ${noLiquidityStreak}` };
  }
  return { unwind: false, reason: '' };
}

// ============================================================
// STATE MACHINE LOGIC (PDF Section 3)
// ============================================================

export function determineState(inv: Inventory, pendingHedge: PendingHedge): State {
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  const hasPendingHedge = pendingHedge.up > 0 || pendingHedge.down > 0;
  
  if (!hasUp && !hasDown) {
    return 'FLAT';
  }
  
  if ((hasUp && !hasDown) || (!hasUp && hasDown)) {
    return 'ONE_SIDED';
  }
  
  // Both sides have shares
  const skew = Math.abs(calculateSkew(inv));
  if (skew > STRATEGY.skew.rebalanceThreshold) {
    return 'SKEWED';
  }
  
  return 'HEDGED';
}

// ============================================================
// ENTRY BUILDING (PDF Section 12.5)
// ============================================================

export function buildEntry(
  upAsk: number,
  downAsk: number,
  clipUsd: number = STRATEGY.sizing.baseClipUsd
): TradeSignal | null {
  const side: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
  const price = side === 'UP' ? upAsk : downAsk;
  const shares = Math.floor(clipUsd / price);
  
  if (shares < 1) return null;
  
  return {
    outcome: side,
    price,
    shares,
    reasoning: `Entry ${side} @ ${(price * 100).toFixed(1)}¢ (cheapest-first)`,
    type: 'opening',
  };
}

// ============================================================
// HEDGE BUILDING (PDF Section 12.6)
// ============================================================

export function buildHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number
): TradeSignal {
  const cushion = STRATEGY.tick.hedgeCushion;
  const limit = roundUp(ask + cushion * tick, tick);
  
  return {
    outcome: side,
    price: limit,
    shares: qty,
    reasoning: `Hedge ${side} @ ${(limit * 100).toFixed(1)}¢ (marketable-limit +${cushion} ticks)`,
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

function calcShares(notional: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(notional / price);
}

/** Calculate clip size based on context (PDF Section 6) */
function getClipSize(
  remainingSeconds: number,
  edgePercent: number
): number {
  let clip = STRATEGY.sizing.baseClipUsd;
  
  // Time-based adjustment
  if (remainingSeconds < 120) {
    clip = Math.max(clip * 0.5, STRATEGY.sizing.minClipUsd);
  }
  
  // Edge-based adjustment
  if (edgePercent > 5) {
    clip = Math.min(clip * 1.5, STRATEGY.sizing.maxClipUsd);
  }
  
  return clip;
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
// MAIN EVALUATION FUNCTION (REFACTORED WITH STATE MACHINE)
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
  tick?: number;
}

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number,
  availableBalance?: number
): TradeSignal | null {
  // Convert MarketPosition to Inventory for compatibility
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
    tick: STRATEGY.tick.fallback,
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

  if (!isNum(upAsk) || !isNum(downAsk)) {
    return null;
  }

  const combined = upAsk + downAsk;

  // Sanity checks
  if (combined < 0.90 || combined > 1.10) return null;
  if (upAsk < STRATEGY.entry.minPrice || upAsk > STRATEGY.entry.maxPrice) return null;
  if (downAsk < STRATEGY.entry.minPrice || downAsk > STRATEGY.entry.maxPrice) return null;

  // ========== UNWIND CHECK (PDF Section 12.8) ==========
  
  const hedgeLagSec = inv.firstFillTs 
    ? (nowMs - inv.firstFillTs) / 1000 
    : 0;
  
  const unwindCheck = shouldUnwind(remainingSeconds, hedgeLagSec, noLiquidityStreak);
  
  // ========== STATE MACHINE (PDF Section 3) ==========
  
  const state = determineState(inv, pendingHedge);
  
  // UNWIND STATE: Only allow hedge attempts, no new positions
  if (unwindCheck.unwind && state !== 'HEDGED') {
    // If one-sided, try one last hedge
    if (state === 'ONE_SIDED') {
      const missingSide: Outcome = inv.upShares === 0 ? 'UP' : 'DOWN';
      const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
      
      return buildHedge(missingSide, missingAsk, tick, 
        missingSide === 'UP' ? inv.downShares : inv.upShares);
    }
    return null; // In UNWIND, don't take new risk
  }

  // Position limits
  const totalInvested = inv.upCost + inv.downCost;
  if (totalInvested >= STRATEGY.limits.maxTotalNotional) return null;

  // Time check - stop new trades in final seconds
  if (remainingSeconds < STRATEGY.limits.stopTradesSec) {
    return null;
  }

  // ========== STATE-BASED TRADING LOGIC ==========

  switch (state) {
    case 'FLAT': {
      // FLAT: Check for executable edge, buy cheapest side
      if (!pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer)) {
        return null; // No edge
      }
      
      // Balance check
      if (availableBalance !== undefined) {
        const check = checkBalanceForOpening(availableBalance, STRATEGY.opening.notional);
        if (!check.canProceed) return null;
      }
      
      const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      
      if (cheaperPrice > STRATEGY.opening.maxPrice) return null;
      
      const edgePct = (1 - combined) * 100;
      const clipSize = getClipSize(remainingSeconds, edgePct);
      
      return buildEntry(upAsk, downAsk, clipSize);
    }
    
    case 'ONE_SIDED': {
      // ONE_SIDED: Must hedge! Use marketable-limit order
      const missingSide: Outcome = inv.upShares === 0 ? 'UP' : 'DOWN';
      const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
      const existingShares = missingSide === 'UP' ? inv.downShares : inv.upShares;
      const existingCost = missingSide === 'UP' ? inv.downCost : inv.upCost;
      const existingAvg = existingShares > 0 ? existingCost / existingShares : 0;
      
      // Check if hedge would lock in profit
      const projectedCombined = existingAvg + missingAsk;
      
      if (projectedCombined < 1 - STRATEGY.edge.minExecutableEdge) {
        return buildHedge(missingSide, missingAsk, tick, existingShares);
      }
      
      // Even if edge is thin, we MUST hedge to reduce risk
      // Only skip if it would be a guaranteed loss
      if (projectedCombined < 1.0) {
        return buildHedge(missingSide, missingAsk, tick, existingShares);
      }
      
      return null;
    }
    
    case 'SKEWED': {
      // SKEWED: Rebalance by buying underweight side
      const rebalanceSide = needsRebalance(inv);
      if (!rebalanceSide) return null;
      
      const rebalanceAsk = rebalanceSide === 'UP' ? upAsk : downAsk;
      const currentShares = rebalanceSide === 'UP' ? inv.upShares : inv.downShares;
      const otherShares = rebalanceSide === 'UP' ? inv.downShares : inv.upShares;
      
      // Buy enough to balance
      const sharesToBalance = Math.floor((otherShares - currentShares) / 2);
      if (sharesToBalance < 1) return null;
      
      // Check skew cap
      if (exceedsSkewCap(inv, rebalanceSide, sharesToBalance)) return null;
      
      return {
        outcome: rebalanceSide,
        price: roundDown(rebalanceAsk, tick),
        shares: sharesToBalance,
        reasoning: `Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(1)}¢ (skew correction)`,
        type: 'rebalance',
      };
    }
    
    case 'HEDGED': {
      // HEDGED: Can accumulate if good combined price
      if (!pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer)) {
        return null;
      }
      
      // Check position limits
      if (inv.upShares >= STRATEGY.limits.maxPerSide || 
          inv.downShares >= STRATEGY.limits.maxPerSide) {
        return null;
      }
      
      // Only accumulate if balanced (skew near 0)
      const currentSkew = Math.abs(calculateSkew(inv));
      if (currentSkew > 0.1) return null; // Must be within 10% of balanced
      
      const edgePct = (1 - combined) * 100;
      const clipSize = getClipSize(remainingSeconds, edgePct);
      const sharesToAdd = Math.floor(clipSize / combined);
      
      if (sharesToAdd < 1) return null;
      
      // Return UP first (caller should also do DOWN atomically)
      return {
        outcome: 'UP',
        price: roundDown(upAsk, tick),
        shares: sharesToAdd,
        reasoning: `Accumulate @ ${(combined * 100).toFixed(1)}¢ combined (${edgePct.toFixed(1)}% edge)`,
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
    return { 
      canProceed: false, 
      reason: `UP side has no liquidity (${upDepth.askVolume.toFixed(0)} shares)` 
    };
  }
  
  if (!downDepth.hasLiquidity) {
    return { 
      canProceed: false, 
      reason: `DOWN side has no liquidity (${downDepth.askVolume.toFixed(0)} shares)` 
    };
  }
  
  if (upDepth.askVolume < minLiquidity) {
    return { 
      canProceed: false, 
      reason: `UP side insufficient (${upDepth.askVolume.toFixed(0)} < ${minLiquidity} needed)` 
    };
  }
  
  if (downDepth.askVolume < minLiquidity) {
    return { 
      canProceed: false, 
      reason: `DOWN side insufficient (${downDepth.askVolume.toFixed(0)} < ${minLiquidity} needed)` 
    };
  }
  
  return { canProceed: true };
}

// ============================================================
// PRE-HEDGE CALCULATION (LEGACY - kept for compatibility)
// ============================================================

export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: Outcome
): { hedgeSide: Outcome; hedgePrice: number; reasoning: string } | null {
  const hedgeSide: Outcome = openingSide === 'UP' ? 'DOWN' : 'UP';
  const targetCombined = 1 - STRATEGY.edge.buffer;
  const targetHedgePrice = targetCombined - openingPrice;
  
  const hedgePrice = Math.round(targetHedgePrice * 100) / 100;
  
  if (hedgePrice < STRATEGY.entry.minPrice || hedgePrice > STRATEGY.opening.maxPrice) {
    return null;
  }
  
  const edgePct = (STRATEGY.edge.buffer * 100).toFixed(1);
  
  return {
    hedgeSide,
    hedgePrice,
    reasoning: `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (target ${edgePct}% edge)`,
  };
}
