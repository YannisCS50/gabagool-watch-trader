import { config } from './config.js';
import type { OrderbookDepth } from './polymarket.js';

// ============================================================
// STRATEGY VERSION - Log this on startup to verify deployment
// ============================================================
export const STRATEGY_VERSION = '2.1.0-strict-balance';
export const STRATEGY_NAME = 'Polymarket 15m Hedge & Arbitrage (PDF Spec)';

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
    buffer: 0.008,         // 0.8¢ edge buffer (was 1.2¢, range 0.6–2.0¢)
    minExecutableEdge: 0.006, // Minimum edge after fees (was 0.008)
  },
  
  // Tick & Rounding (PDF Section 5)
  tick: {
    fallback: 0.01,
    validTicks: [0.01, 0.005, 0.002, 0.001],
    hedgeCushion: 2,       // 2 ticks cushion for hedge (range 1–6)
  },
  
  // Sizing (PDF Section 6)
  sizing: {
    baseClipUsd: 12,       // Base clip size (was $8)
    minClipUsd: 5,         // (was $3)
    maxClipUsd: 25,        // (was $15)
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
    maxPrice: 0.52,           // Markt start altijd rond 48-52¢
    skipEdgeCheck: true,      // Bij opening: trade direct, skip edge buffer
    maxDelayMs: 5000,         // Max 5s wachten na market open
  },
  
  // Entry conditions
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  
  // Cooldown
  cooldownMs: 10000,      // Was 15000ms
  
  // ==========================================================
  // PROBABILITY BIAS - Skip hedge als winnaar duidelijk is
  // ==========================================================
  probabilityBias: {
    enabled: true,
    // Skip hedge wanneer huidige prijs X dollar van strike afwijkt
    skipHedgeThresholdUsd: 85,       // $85 verschil = skip losing hedge (was 120)
    highConfidenceUsd: 200,          // $200+ verschil = hoge zekerheid
    // Minimale tijd over voordat we hedge skippen (safety)
    minSecondsToSkip: 120,           // Alleen skippen als >2 min over
  },
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
// PROBABILITY BIAS FUNCTIONS
// ============================================================

export interface PriceBiasContext {
  currentPrice: number;      // Current crypto price (e.g., BTC price)
  strikePrice: number;       // Strike price for the market
  remainingSeconds: number;
}

/**
 * Calculate which side is likely to win based on current price vs strike
 * Returns: 'UP' if price > strike, 'DOWN' if price < strike, null if too close
 */
export function calculateLikelySide(ctx: PriceBiasContext): {
  likelySide: Outcome | null;
  losingSide: Outcome | null;
  distanceUsd: number;
  confidence: 'low' | 'medium' | 'high';
} {
  const { currentPrice, strikePrice, remainingSeconds } = ctx;
  
  if (!strikePrice || strikePrice <= 0) {
    return { likelySide: null, losingSide: null, distanceUsd: 0, confidence: 'low' };
  }
  
  const distanceUsd = currentPrice - strikePrice;
  const absDistance = Math.abs(distanceUsd);
  
  const skipThreshold = STRATEGY.probabilityBias.skipHedgeThresholdUsd;
  const highConfThreshold = STRATEGY.probabilityBias.highConfidenceUsd;
  
  if (absDistance < skipThreshold) {
    return { likelySide: null, losingSide: null, distanceUsd, confidence: 'low' };
  }
  
  const likelySide: Outcome = distanceUsd > 0 ? 'UP' : 'DOWN';
  const losingSide: Outcome = likelySide === 'UP' ? 'DOWN' : 'UP';
  const confidence = absDistance >= highConfThreshold ? 'high' : 'medium';
  
  return { likelySide, losingSide, distanceUsd, confidence };
}

/**
 * Determine if we should skip hedging the losing side
 */
export function shouldSkipLosingHedge(
  ctx: PriceBiasContext,
  hedgeSide: Outcome
): { skip: boolean; reason: string } {
  if (!STRATEGY.probabilityBias.enabled) {
    return { skip: false, reason: 'Probability bias disabled' };
  }
  
  if (ctx.remainingSeconds < STRATEGY.probabilityBias.minSecondsToSkip) {
    return { skip: false, reason: `Too close to expiry (${ctx.remainingSeconds}s < ${STRATEGY.probabilityBias.minSecondsToSkip}s)` };
  }
  
  const bias = calculateLikelySide(ctx);
  
  if (!bias.losingSide) {
    return { skip: false, reason: `Price too close to strike ($${Math.abs(bias.distanceUsd).toFixed(0)} < $${STRATEGY.probabilityBias.skipHedgeThresholdUsd})` };
  }
  
  if (hedgeSide === bias.losingSide) {
    return { 
      skip: true, 
      reason: `Skip ${hedgeSide} hedge: price $${Math.abs(bias.distanceUsd).toFixed(0)} ${bias.distanceUsd > 0 ? 'above' : 'below'} strike (${bias.confidence} confidence)` 
    };
  }
  
  return { skip: false, reason: `${hedgeSide} is likely winning side` };
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
  // NEW: Price bias context
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
  // FIX: Added optional price bias parameters
  currentPrice?: number,
  strikePrice?: number
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
    // FIX: Pass through price bias context
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
    tick = STRATEGY.tick.fallback,
    currentPrice,
    strikePrice,
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
      const existingShares = missingSide === 'UP' ? inv.downShares : inv.upShares;
      
      // MINIMUM SHARES: Polymarket rejects orders < ~$1-2 notional
      const minSharesForOrder = 5;
      const hedgeShares = Math.max(existingShares, minSharesForOrder);
      
      return buildHedge(missingSide, missingAsk, tick, hedgeShares);
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
      // FLAT: Buy cheapest side if edge exists OR opening conditions met
      // ========== STRICT SINGLE OPENING ==========
      // Only allow ONE opening trade per market, then wait for hedge
      const totalShares = inv.upShares + inv.downShares;
      if (totalShares > 0) {
        console.log(`[Strategy] BLOCK opening: already have ${totalShares} shares, waiting for hedge`);
        return null; // Already have shares, must hedge first
      }
      
      const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      
      // NEW: Opening trade can skip edge check if price is near fair value (48-52¢)
      const isOpeningPrice = cheaperPrice <= STRATEGY.opening.maxPrice;
      const hasEdge = pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer);
      
      if (STRATEGY.opening.skipEdgeCheck && isOpeningPrice) {
        // Opening: trade direct bij markt start, skip edge buffer
        console.log(`[Strategy] Opening trade @ ${(cheaperPrice * 100).toFixed(1)}¢ (skipEdgeCheck enabled)`);
      } else if (!hasEdge) {
        return null; // No edge and not opening price
      }
      
      // Balance check
      if (availableBalance !== undefined) {
        const check = checkBalanceForOpening(availableBalance, STRATEGY.opening.notional);
        if (!check.canProceed) return null;
      }
      
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
      
      // MINIMUM SHARES: Polymarket rejects orders < ~$1-2 notional
      // Ensure we always order at least 5 shares
      const minSharesForOrder = 5;
      const hedgeShares = Math.max(existingShares, minSharesForOrder);
      
      // ========== PROBABILITY BIAS CHECK ==========
      // Als prijs ver van strike is, kunnen we hedge skippen
      if (currentPrice !== undefined && strikePrice !== undefined) {
        const biasCheck = shouldSkipLosingHedge(
          { currentPrice, strikePrice, remainingSeconds },
          missingSide
        );
        
        if (biasCheck.skip) {
          console.log(`[Strategy] ${biasCheck.reason} - holding ${inv.upShares > 0 ? 'UP' : 'DOWN'} position only`);
          return null; // Skip hedge, we're betting the winning side holds
        }
      }
      
      // Check if hedge would lock in profit
      const projectedCombined = existingAvg + missingAsk;
      
      // ========== CONSERVATIVE EXPENSIVE SIDE BUYING ==========
      // If the missing (hedge) side is EXPENSIVE (>50¢), only buy if:
      // 1. Combined still locks profit (safe hedge)
      // 2. OR price is ≥85¢ (market is 85%+ confident = high certainty)
      // 3. OR time is running out (<2 min)
      // Otherwise we take too much risk on the expensive side
      
      const isExpensiveSide = missingAsk > 0.50;
      const isHighCertainty = missingAsk >= 0.85; // Market is 85%+ confident
      const isTimeCritical = remainingSeconds < 120; // Less than 2 minutes
      const locksProfit = projectedCombined < 1 - STRATEGY.edge.minExecutableEdge;
      
      console.log(`[Strategy] Hedge eval: ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢, shares ${existingShares}→${hedgeShares}, combined=${(projectedCombined * 100).toFixed(0)}¢`);
      
      if (isExpensiveSide) {
        // Expensive side: only proceed if one of the safe conditions is met
        if (locksProfit) {
          // Safe: we still lock in profit even with expensive hedge
          return buildHedge(missingSide, missingAsk, tick, hedgeShares);
        }
        
        if (isHighCertainty) {
          // High certainty: market is 85%+ confident, likely to win
          console.log(`[Strategy] Buying expensive ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢ (high certainty ≥85%)`);
          return buildHedge(missingSide, missingAsk, tick, hedgeShares);
        }
        
        if (isTimeCritical && projectedCombined < 1.02) {
          // Time critical: must hedge, but only if not a huge loss
          console.log(`[Strategy] Time-critical hedge ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢ (${remainingSeconds}s left)`);
          return buildHedge(missingSide, missingAsk, tick, hedgeShares);
        }
        
        // Otherwise skip: too risky to buy expensive side without certainty
        console.log(`[Strategy] SKIP expensive ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢ - waiting for certainty or cheaper price`);
        return null;
      }
      
      // Cheap side (<50¢): always hedge if it's profitable or break-even
      // FIX: Include exact break-even (≤1.0) instead of just <1.0
      if (projectedCombined <= 1.0) {
        return buildHedge(missingSide, missingAsk, tick, hedgeShares);
      }
      
      // FIX: Fallback hedge when waiting too long (prevents stuck ONE_SIDED)
      // If >30 seconds stuck one-sided and combined < 1.05, just hedge
      const firstFillMs = inv.firstFillTs ?? nowMs;
      const timeSinceFirstFill = (nowMs - firstFillMs) / 1000;
      if (timeSinceFirstFill > 30 && projectedCombined < 1.05) {
        console.log(`[Strategy] FALLBACK hedge ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢ - stuck one-sided for ${timeSinceFirstFill.toFixed(0)}s`);
        return buildHedge(missingSide, missingAsk, tick, hedgeShares);
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
      
      // === AGGRESSIVE ACCUMULATE MODE ===
      // If the underweight side is EXTREMELY cheap (< 10¢), accumulate aggressively
      // This captures arbitrage opportunities where we can buy shares at 5¢ that pay $1
      if (rebalanceAsk <= 0.10) {
        // Check combined price for edge
        const otherAsk = rebalanceSide === 'UP' ? downAsk : upAsk;
        const combinedForArb = rebalanceAsk + otherAsk;
        
        // Even if combined > 1, at 5¢ we should still buy to create huge hedge potential
        // Max out the clip size for cheap shares
        const aggressiveClip = STRATEGY.sizing.maxClipUsd;
        const sharesToBuy = Math.min(
          Math.floor(aggressiveClip / rebalanceAsk),
          otherShares - currentShares // Don't exceed what we need to balance
        );
        
        if (sharesToBuy >= 5) {
          const edgePct = ((1 - combinedForArb) * 100).toFixed(1);
          return {
            outcome: rebalanceSide,
            price: roundDown(rebalanceAsk, tick),
            shares: sharesToBuy,
            reasoning: `AGGRESSIVE Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(0)}¢ (${edgePct}% edge, huge hedge opportunity)`,
            type: 'accumulate',
          };
        }
      }
      
      // Normal rebalance: buy enough to approach balance
      const sharesToBalance = Math.floor((otherShares - currentShares) / 2);
      if (sharesToBalance < 1) return null;
      
      // Check skew cap - but allow larger rebalances if price is good
      if (exceedsSkewCap(inv, rebalanceSide, sharesToBalance)) {
        // Try a smaller amount that won't exceed cap
        const smallerAmount = Math.floor(sharesToBalance / 2);
        if (smallerAmount >= 5 && !exceedsSkewCap(inv, rebalanceSide, smallerAmount)) {
          return {
            outcome: rebalanceSide,
            price: roundDown(rebalanceAsk, tick),
            shares: smallerAmount,
            reasoning: `Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(1)}¢ (partial skew correction)`,
            type: 'rebalance',
          };
        }
        return null;
      }
      
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
      
      // ========== STRICT 1:1 BALANCE REQUIREMENT ==========
      // ONLY accumulate if shares are EXACTLY balanced
      // This prevents the ratio from getting out of sync
      const shareDiff = Math.abs(inv.upShares - inv.downShares);
      if (shareDiff > 5) {
        console.log(`[Strategy] BLOCK accumulate: shares not balanced (UP=${inv.upShares}, DOWN=${inv.downShares}, diff=${shareDiff})`);
        return null; // Must be within 5 shares of balanced
      }
      
      const edgePct = (1 - combined) * 100;
      const clipSize = getClipSize(remainingSeconds, edgePct);
      const sharesToAdd = Math.floor(clipSize / combined);
      
      if (sharesToAdd < 1) return null;
      
      // FIX: Return the CHEAPER side first for atomic accumulate
      // Caller should handle both sides atomically, so we return whichever is cheaper
      const accumulateSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
      const accumulatePrice = accumulateSide === 'UP' ? upAsk : downAsk;
      
      return {
        outcome: accumulateSide,
        price: roundDown(accumulatePrice, tick),
        shares: sharesToAdd,
        reasoning: `Accumulate ${accumulateSide} @ ${(combined * 100).toFixed(1)}¢ combined (${edgePct.toFixed(1)}% edge) - caller must also buy ${accumulateSide === 'UP' ? 'DOWN' : 'UP'}`,
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
// PRE-HEDGE CALCULATION - Uses actual ask price from orderbook
// ============================================================

// Maximum we're willing to pay for a hedge side
// This prevents buying at crazy prices like 95¢
const MAX_HEDGE_PRICE = 0.75; // Never pay more than 75¢ for a hedge

// FIX: Maximum combined cost aligned with ONE_SIDED check (was 1.05, now 1.0)
// Combined ≤1.0 = break-even or profit, >1.0 = guaranteed loss
const MAX_COMBINED_COST = 1.0;

export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: Outcome,
  hedgeAsk?: number,  // Actual ask price from orderbook
  tick: number = 0.01
): { hedgeSide: Outcome; hedgePrice: number; reasoning: string } | null {
  const hedgeSide: Outcome = openingSide === 'UP' ? 'DOWN' : 'UP';
  
  let hedgePrice: number;
  let reasoning: string;
  
  if (hedgeAsk !== undefined && hedgeAsk > 0) {
    // NEW: Use actual orderbook ask + cushion ticks for guaranteed fill
    const cushion = STRATEGY.tick.hedgeCushion;
    const rawHedgePrice = roundUp(hedgeAsk + cushion * tick, tick);
    
    // Cap the hedge price to prevent overpaying
    hedgePrice = Math.min(rawHedgePrice, MAX_HEDGE_PRICE);
    
    const projectedCombined = openingPrice + hedgePrice;
    const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
    
    // Risk check: don't hedge if combined cost is too high (limits loss)
    if (projectedCombined > MAX_COMBINED_COST) {
      console.log(`[PreHedge] RISK LIMIT: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(MAX_COMBINED_COST * 100).toFixed(0)}¢ max`);
      console.log(`   Opening: ${openingSide} @ ${(openingPrice * 100).toFixed(0)}¢`);
      console.log(`   Hedge ask: ${(hedgeAsk * 100).toFixed(0)}¢ → capped at ${(hedgePrice * 100).toFixed(0)}¢`);
      console.log(`   ⚠️ Will remain EXPOSED - hedge too expensive!`);
      return null;
    }
    
    // Log if we capped the price
    if (rawHedgePrice > MAX_HEDGE_PRICE) {
      console.log(`[PreHedge] Price capped: ${(rawHedgePrice * 100).toFixed(0)}¢ → ${(hedgePrice * 100).toFixed(0)}¢`);
    }
    
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (ask=${(hedgeAsk * 100).toFixed(0)}¢ +${cushion}t, combined=${(projectedCombined * 100).toFixed(0)}¢)`;
  } else {
    // LEGACY: Calculate theoretical price (may be rejected by Polymarket)
    const targetCombined = 1 - STRATEGY.edge.buffer;
    const targetHedgePrice = targetCombined - openingPrice;
    hedgePrice = Math.round(targetHedgePrice * 100) / 100;
    
    // Also apply max hedge price cap to legacy
    hedgePrice = Math.min(hedgePrice, MAX_HEDGE_PRICE);
    
    const edgePct = (STRATEGY.edge.buffer * 100).toFixed(1);
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (theoretical, target ${edgePct}% edge)`;
  }
  
  // Validate price bounds
  if (hedgePrice < STRATEGY.entry.minPrice) {
    console.log(`[PreHedge] Skip: price ${(hedgePrice * 100).toFixed(0)}¢ below minimum ${(STRATEGY.entry.minPrice * 100).toFixed(0)}¢`);
    return null;
  }
  
  return {
    hedgeSide,
    hedgePrice,
    reasoning,
  };
}
