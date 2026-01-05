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

export const STRATEGY_VERSION = '7.1.0';
export const STRATEGY_NAME = 'GPT Strategy v7.1.0 – Low-Risk Test Mode (Polymarket 15m Bot)';

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
  // v6.1: Track trades per market for micro-sizing metrics
  tradesCount?: number;
  // v6.1: Track market open time for entry window discipline
  marketOpenTs?: number;
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
  // Trade size settings (in USDC) - v6.1: Micro-sizing (Gabagool-style)
  tradeSizeUsd: {
    base: 10,    // v6.1: Reduced from 25 to 10 for micro-sizing
    min: 5,      // v6.1: Reduced from 20 to 5 for micro-sizing
    max: 25,     // v6.1: Reduced from 50 to 25 (larger only for extreme edge)
  },
  
  // Edge thresholds - PDF Section
  edge: {
    baseBuffer: 0.015,        // 1.5¢ minimum mispricing required
    strongEdge: 0.04,         // 4¢+ = strong signal, scale up
    strongEdgeBuffer: 0.03,   // v6.1: For late entry, require combined ≤ 97¢
    allowOverpay: 0.01,       // Max 1¢ overpay allowed for fill
    feesBuffer: 0.002,        // 0.2¢ for Polymarket 2% fee
    slippageBuffer: 0.004,    // 0.4¢ for execution slippage
    deepDislocationThreshold: 0.96, // Combined ≤ $0.96 = DEEP mode
  },
  
  // Timing and lifecycle - v6.1: Gabagool-style entry window
  timing: {
    stopNewTradesSec: 30,     // No new positions < 30s remaining
    hedgeTimeoutSec: 12,      // Force hedge after 12s if one-sided
    hedgeMustBySec: 60,       // Must be hedged by 60s remaining
    unwindStartSec: 45,       // Optional: start unwind at 45s
    // v6.1: Entry Window Discipline (Gabagool-style)
    entryWindowStartSec: 10,  // Primary entry window start (after market open)
    entryWindowEndSec: 40,    // Primary entry window end
    // v6.1: Initial Hedge Discipline
    initHedgeTimeoutSec: 3,   // Place initial hedge within 3s of first fill
    initHedgeSizePercent: 0.15, // Initial hedge = 15% of opening shares (10-20%)
    // v6.1: Paired Quantity Target
    pairedTargetDeadlineSec: 60, // Must reach paired minimum within 60s
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
  
  // v6.1.1: Paired Quantity & Cost-Per-Paired Controls (HARD INVARIANTS)
  pairedControl: {
    minShares: 20,            // v6.1.1: PAIRED_MIN_SHARES - HARD MINIMUM after deadline
    costPerPairedStop: 1.05,  // v6.1.1: Stop ALL adds if cost_per_paired > 1.05
    costPerPairedEmergency: 1.10, // v6.1.1: Emergency unwind if > 1.10
    survivalWindowSec: 20,    // v6.1.1: Only exception to guardrails - near settlement
  },
  
  // v6.1.2: Micro-Hedge Execution (Gabagool-style pairing)
  microHedge: {
    fraction: 0.20,           // Hedge 20% of unpaired gap each time
    minShares: 5,             // Minimum micro-hedge size
    maxShares: 15,            // Maximum micro-hedge size per cycle
    triggerDelta: 8,          // Trigger micro-hedge if unpaired increases by >= 8 shares
    cooldownMs: 1500,         // Rate limit: 1 micro-hedge per 1.5s per market
    waitMs: 1200,             // Wait for maker fill before retry
    retryMax: 2,              // Max retry attempts before urgent mode
    urgentWindowSec: 20,      // Seconds before deadline = urgent mode (taker allowed)
    edgeLockBuffer: 0.005,    // 0.5¢ buffer - abort if would burn edge in normal mode
    urgentOverpayCap: 0.01,   // 1¢ max overpay in urgent mode
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
    minPrice: 0.35,           // v6.3.2: Never open below 35¢ - implies 65% against you
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
    // v7: Tail-Entry Prevention
    tailEntryBlockPrice: 0.20,   // Never ENTRY if min(upAsk, downAsk) < 20¢
    // v7: Direction Sanity
    directionEpsPct: 0.0002,     // 0.02% epsilon for neutral zone
    // v7: Pair-Edge Required
    requirePairEdge: true,       // Only ENTRY when combinedAsk < 1 - edgeBuffer
  },
  
  // Cooldown between trades - v6.1: Reduced for micro-sizing
  cooldownMs: 3000,           // v6.1: Reduced from 5s to 3s for more micro-trades
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
// V6.1: GABAGOOL ALIGNMENT METRICS
// ============================================================

/**
 * v6.1: Calculate paired quantity = min(UP, DOWN) shares
 */
export function pairedShares(inv: Inventory): number {
  return Math.min(inv.upShares, inv.downShares);
}

/**
 * v6.1: Calculate paired_ratio = min(up,down) / max(up,down)
 * Returns 1.0 for perfectly balanced, 0 for one-sided
 */
export function pairedRatio(inv: Inventory): number {
  const maxShares = Math.max(inv.upShares, inv.downShares);
  if (maxShares === 0) return 1.0;
  return pairedShares(inv) / maxShares;
}

/**
 * v6.1: Calculate cost_per_paired - CRITICAL for risk control
 * cost_per_paired = (total_cost_up + total_cost_down) / min(up_shares, down_shares)
 */
export function costPerPaired(inv: Inventory): number {
  const paired = pairedShares(inv);
  if (paired === 0) return Infinity;
  return (inv.upCost + inv.downCost) / paired;
}

/**
 * v6.1: Check if paired minimum is reached
 */
export function isPairedMinReached(inv: Inventory): boolean {
  return pairedShares(inv) >= STRATEGY.pairedControl.minShares;
}

/**
 * v6.1: Check if we're within the primary entry window (Gabagool-style)
 * Entry window: 10s - 40s after market open
 */
export function isInEntryWindow(marketOpenTs: number | undefined, nowMs: number): boolean {
  if (!marketOpenTs) return true; // If unknown, allow entry
  
  const elapsedSec = (nowMs - marketOpenTs) / 1000;
  return elapsedSec >= STRATEGY.timing.entryWindowStartSec && 
         elapsedSec <= STRATEGY.timing.entryWindowEndSec;
}

/**
 * v6.1: Calculate entry age in seconds (since market open)
 */
export function entryAgeSec(marketOpenTs: number | undefined, nowMs: number): number {
  if (!marketOpenTs) return 0;
  return (nowMs - marketOpenTs) / 1000;
}

/**
 * v6.1: Calculate hedge lag in seconds (since first fill)
 */
export function hedgeLagSecFromInventory(inv: Inventory, nowMs: number): number {
  if (!inv.firstFillTs) return 0;
  return (nowMs - inv.firstFillTs) / 1000;
}

/**
 * v6.1.1: Check if cost_per_paired exceeds thresholds
 * Returns action to take based on guardrail hierarchy
 */
export function checkCostPerPairedGuardrail(inv: Inventory): {
  action: 'NORMAL' | 'STOP_ACCUMULATE' | 'EMERGENCY_UNWIND';
  costPerPaired: number;
  reason: string;
} {
  const cpp = costPerPaired(inv);
  
  if (cpp >= STRATEGY.pairedControl.costPerPairedEmergency) {
    return {
      action: 'EMERGENCY_UNWIND',
      costPerPaired: cpp,
      reason: `cost_per_paired ${cpp.toFixed(3)} >= ${STRATEGY.pairedControl.costPerPairedEmergency} EMERGENCY`,
    };
  }
  
  if (cpp >= STRATEGY.pairedControl.costPerPairedStop) {
    return {
      action: 'STOP_ACCUMULATE',
      costPerPaired: cpp,
      reason: `cost_per_paired ${cpp.toFixed(3)} >= ${STRATEGY.pairedControl.costPerPairedStop} STOP`,
    };
  }
  
  return {
    action: 'NORMAL',
    costPerPaired: cpp,
    reason: 'cost_per_paired within limits',
  };
}

// ============================================================
// V6.1.1: HARD GUARDRAIL SYSTEM WITH PRECEDENCE
// Priority: 1=Survival > 2=CostPerPaired > 3=PairedMin > 4=Skew > 5=Accumulate
// ============================================================

export type GuardrailTrigger = 
  | 'NONE'
  | 'SURVIVAL_MODE'
  | 'COST_PER_PAIRED_EMERGENCY'
  | 'COST_PER_PAIRED_STOP'
  | 'PAIRED_MIN_BLOCK';

export interface V611GuardrailResult {
  // What's blocked
  blockEntry: boolean;
  blockAccumulate: boolean;
  blockDominantSideAdd: boolean;
  allowHedge: boolean;
  allowRebalance: boolean;
  forceUnwind: boolean;
  
  // Telemetry
  guardrailTriggered: GuardrailTrigger;
  pairedMinReached: boolean;
  costPerPaired: number;
  blockedAction: string | null;
  reason: string;
  
  // For logging
  inSurvivalWindow: boolean;
}

/**
 * v6.1.1: Master guardrail check with explicit precedence
 * Call this BEFORE state-based trading logic
 * 
 * Priority hierarchy:
 * 1. SURVIVAL (< 20s remaining) - allows all hedge/rebalance attempts
 * 2. COST_PER_PAIRED_EMERGENCY (>1.10) - force unwind
 * 3. COST_PER_PAIRED_STOP (>1.05) - block adds, allow hedge/rebalance
 * 4. PAIRED_MIN_BLOCK (paired < 20 after 60s) - block dominant side adds
 * 5. NORMAL - no restrictions
 */
export function checkV611Guardrails(
  inv: Inventory,
  remainingSeconds: number,
  nowMs: number,
  proposedAction?: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind',
  proposedSide?: Outcome
): V611GuardrailResult {
  const paired = pairedShares(inv);
  const pairedMinReached = paired >= STRATEGY.pairedControl.minShares;
  const cpp = costPerPaired(inv);
  const cppCheck = checkCostPerPairedGuardrail(inv);
  
  // Calculate elapsed since first fill
  const elapsedSec = inv.firstFillTs ? (nowMs - inv.firstFillTs) / 1000 : 0;
  const pastDeadline = elapsedSec >= STRATEGY.timing.pairedTargetDeadlineSec;
  
  // Priority 1: SURVIVAL MODE (near settlement)
  const survivalWindow = STRATEGY.pairedControl.survivalWindowSec ?? 20;
  const inSurvivalWindow = remainingSeconds < survivalWindow;
  
  if (inSurvivalWindow) {
    return {
      blockEntry: true, // No new entries in survival
      blockAccumulate: true, // No accumulation in survival
      blockDominantSideAdd: false, // Exception: allow any hedge/rebalance in survival
      allowHedge: true,
      allowRebalance: true,
      forceUnwind: false,
      guardrailTriggered: 'SURVIVAL_MODE',
      pairedMinReached,
      costPerPaired: cpp,
      blockedAction: proposedAction === 'opening' || proposedAction === 'accumulate' ? proposedAction : null,
      reason: `SURVIVAL MODE: ${remainingSeconds}s remaining < ${survivalWindow}s window`,
      inSurvivalWindow: true,
    };
  }
  
  // Priority 2: COST_PER_PAIRED EMERGENCY (>1.10)
  if (cppCheck.action === 'EMERGENCY_UNWIND') {
    return {
      blockEntry: true,
      blockAccumulate: true,
      blockDominantSideAdd: true,
      allowHedge: true, // Still try to hedge
      allowRebalance: true,
      forceUnwind: true, // Signal emergency
      guardrailTriggered: 'COST_PER_PAIRED_EMERGENCY',
      pairedMinReached,
      costPerPaired: cpp,
      blockedAction: 'ALL_ADDS',
      reason: cppCheck.reason,
      inSurvivalWindow: false,
    };
  }
  
  // Priority 3: COST_PER_PAIRED STOP (>1.05)
  if (cppCheck.action === 'STOP_ACCUMULATE') {
    return {
      blockEntry: true, // No new entries
      blockAccumulate: true, // No accumulation
      blockDominantSideAdd: true, // No dominant side adds
      allowHedge: true,
      allowRebalance: true,
      forceUnwind: false,
      guardrailTriggered: 'COST_PER_PAIRED_STOP',
      pairedMinReached,
      costPerPaired: cpp,
      blockedAction: proposedAction === 'opening' || proposedAction === 'accumulate' ? proposedAction : null,
      reason: cppCheck.reason,
      inSurvivalWindow: false,
    };
  }
  
  // Priority 4: PAIRED_MIN_BLOCK (after deadline, paired < min)
  // Only blocks dominant side ADDS, allows hedge/rebalance to minority side
  if (pastDeadline && !pairedMinReached) {
    // Determine dominant side
    const dominantSide: Outcome = inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
    const tryingDominant = proposedSide === dominantSide;
    const isAddAction = proposedAction === 'accumulate' || proposedAction === 'opening';
    
    return {
      blockEntry: false, // Allow entry on minority side
      blockAccumulate: tryingDominant && isAddAction, // Block accumulate on dominant only
      blockDominantSideAdd: true,
      allowHedge: true,
      allowRebalance: true,
      forceUnwind: false,
      guardrailTriggered: 'PAIRED_MIN_BLOCK',
      pairedMinReached,
      costPerPaired: cpp,
      blockedAction: tryingDominant && isAddAction ? `${proposedAction} on ${dominantSide}` : null,
      reason: `PAIRED_MIN_BLOCK: paired=${paired} < ${STRATEGY.pairedControl.minShares} min after ${elapsedSec.toFixed(0)}s > ${STRATEGY.timing.pairedTargetDeadlineSec}s deadline`,
      inSurvivalWindow: false,
    };
  }
  
  // Priority 5: NORMAL - no restrictions
  return {
    blockEntry: false,
    blockAccumulate: false,
    blockDominantSideAdd: false,
    allowHedge: true,
    allowRebalance: true,
    forceUnwind: false,
    guardrailTriggered: 'NONE',
    pairedMinReached,
    costPerPaired: cpp,
    blockedAction: null,
    reason: 'All guardrails passed',
    inSurvivalWindow: false,
  };
}

/**
 * v6.1.1: Log guardrail decision for telemetry
 */
export function logV611Guardrail(
  result: V611GuardrailResult,
  marketId: string,
  action: string
): void {
  if (result.guardrailTriggered === 'NONE') return;
  
  const emoji = result.forceUnwind ? '🚨' : 
                result.guardrailTriggered === 'SURVIVAL_MODE' ? '⏰' :
                result.blockedAction ? '🛑' : '⚠️';
  
  console.log(`[v6.1.1] ${emoji} GUARDRAIL: ${result.guardrailTriggered}`);
  console.log(`   Market: ${marketId}`);
  console.log(`   Action: ${action}`);
  console.log(`   paired_min_reached: ${result.pairedMinReached}`);
  console.log(`   cost_per_paired: ${result.costPerPaired.toFixed(3)}`);
  console.log(`   blocked_action: ${result.blockedAction || 'none'}`);
  console.log(`   reason: ${result.reason}`);
}

/**
 * v6.1: Check if dominant side should be blocked (paired target not met)
 */
export function shouldBlockDominantSide(
  inv: Inventory,
  proposedSide: Outcome,
  deadlineSec: number,
  elapsedSec: number
): { blocked: boolean; reason: string } {
  // Only applies after deadline
  if (elapsedSec < deadlineSec) {
    return { blocked: false, reason: 'Before paired deadline' };
  }
  
  // Check if paired minimum reached
  if (isPairedMinReached(inv)) {
    return { blocked: false, reason: 'Paired minimum reached' };
  }
  
  // Determine dominant side
  const dominantSide: Outcome = inv.upShares > inv.downShares ? 'UP' : 'DOWN';
  
  // Block if trying to add to dominant side
  if (proposedSide === dominantSide) {
    return {
      blocked: true,
      reason: `v6.1 BLOCK: Adding to dominant side ${dominantSide} while paired=${pairedShares(inv)} < ${STRATEGY.pairedControl.minShares} minimum`,
    };
  }
  
  return { blocked: false, reason: 'Adding to minority side allowed' };
}

/**
 * v6.1: Calculate initial hedge size (10-20% of opening shares)
 */
export function getInitHedgeSize(openingShares: number): number {
  const percent = STRATEGY.timing.initHedgeSizePercent;
  const size = Math.ceil(openingShares * percent);
  return Math.max(size, 2); // At least 2 shares
}

/**
 * v6.1: Check if initial hedge is needed (within 3s of first fill)
 */
export function needsInitHedge(inv: Inventory, nowMs: number): {
  needed: boolean;
  hedgeSide: Outcome | null;
  hedgeShares: number;
  reason: string;
} {
  // Only in ONE_SIDED state
  const hasUp = inv.upShares > 0;
  const hasDown = inv.downShares > 0;
  
  if (!hasUp && !hasDown) {
    return { needed: false, hedgeSide: null, hedgeShares: 0, reason: 'FLAT state' };
  }
  
  if (hasUp && hasDown) {
    return { needed: false, hedgeSide: null, hedgeShares: 0, reason: 'Already hedged' };
  }
  
  // One-sided - check timing
  const elapsedMs = inv.firstFillTs ? nowMs - inv.firstFillTs : 0;
  const elapsedSec = elapsedMs / 1000;
  const timeout = STRATEGY.timing.initHedgeTimeoutSec;
  
  if (elapsedSec > timeout) {
    // Past initial hedge window - use normal hedge logic
    return { needed: false, hedgeSide: null, hedgeShares: 0, reason: `Past init hedge window (${elapsedSec.toFixed(1)}s > ${timeout}s)` };
  }
  
  // Within initial hedge window - trigger small hedge
  const hedgeSide: Outcome = hasUp ? 'DOWN' : 'UP';
  const existingShares = hasUp ? inv.upShares : inv.downShares;
  const hedgeShares = getInitHedgeSize(existingShares);
  
  return {
    needed: true,
    hedgeSide,
    hedgeShares,
    reason: `v6.1 INIT HEDGE: ${hedgeSide} ${hedgeShares} shares within ${timeout}s window`,
  };
}

/**
 * v6.1: Log metrics for validation
 */
export interface V61Metrics {
  entry_age_sec: number;
  hedge_lag_sec: number;
  paired_ratio: number;
  cost_per_paired: number;
  paired_min_reached: boolean;
  trades_per_market: number;
  paired_shares: number;
  in_entry_window: boolean;
}

export function calculateV61Metrics(inv: Inventory, nowMs: number): V61Metrics {
  return {
    entry_age_sec: entryAgeSec(inv.marketOpenTs, nowMs),
    hedge_lag_sec: hedgeLagSecFromInventory(inv, nowMs),
    paired_ratio: pairedRatio(inv),
    cost_per_paired: costPerPaired(inv),
    paired_min_reached: isPairedMinReached(inv),
    trades_per_market: inv.tradesCount ?? 0,
    paired_shares: pairedShares(inv),
    in_entry_window: isInEntryWindow(inv.marketOpenTs, nowMs),
  };
}

// ============================================================
// V6.1.2: MICRO-HEDGE EXECUTION SYSTEM
// After each fill on dominant side, place small hedges to build pairing
// ============================================================

export type MicroHedgeMode = 'MAKER' | 'URGENT_TAKER';
export type MicroHedgeStatus = 'PLACED' | 'FILLED' | 'PARTIAL' | 'ABORTED';
export type MicroHedgeAbortReason = 
  | 'NO_DEPTH' 
  | 'FUNDS' 
  | 'PAIR_COST' 
  | 'COOLDOWN' 
  | 'RATE_LIMIT'
  | 'SURVIVAL_MODE'
  | 'GUARDRAIL_BLOCK';

export interface MicroHedgeIntent {
  marketId: string;
  side: Outcome;
  microQty: number;
  unpairedBefore: number;
  unpairedAfterTarget: number;
  mode: MicroHedgeMode;
  projectedPairCost: number;
  correlationId: string;
  timestamp: number;
}

export interface MicroHedgeResult {
  status: MicroHedgeStatus;
  abortReason?: MicroHedgeAbortReason;
  fillLatencyMs?: number;
  priceUsed?: number;
  filledQty?: number;
}

export interface MicroHedgeState {
  lastMicroHedgeTs: number;
  retryCount: number;
  pairedMinReachedTs?: number;
}

/**
 * v6.1.2: Calculate unpaired quantity = abs(up_shares - down_shares)
 */
export function unpairedShares(inv: Inventory): number {
  return Math.abs(inv.upShares - inv.downShares);
}

/**
 * v6.1.2: Determine which side is underweight (needs micro-hedge)
 */
export function getUnderweightSide(inv: Inventory): Outcome | null {
  if (inv.upShares === inv.downShares) return null;
  return inv.upShares < inv.downShares ? 'UP' : 'DOWN';
}

/**
 * v6.1.2: Calculate micro-hedge quantity
 * microQty = clamp(ceil(unpaired * MICRO_HEDGE_FRACTION), MIN, MAX)
 */
export function calculateMicroHedgeQty(inv: Inventory): number {
  const unpaired = unpairedShares(inv);
  if (unpaired === 0) return 0;
  
  const cfg = STRATEGY.microHedge;
  const rawQty = Math.ceil(unpaired * cfg.fraction);
  return Math.max(cfg.minShares, Math.min(cfg.maxShares, rawQty));
}

/**
 * v6.1.2: Check if micro-hedge should be triggered
 * Returns true if:
 * - After a fill that increased unpaired
 * - OR unpaired increased by >= MICRO_HEDGE_TRIGGER_DELTA
 */
export function shouldTriggerMicroHedge(
  inv: Inventory,
  previousUnpaired: number,
  remainingSeconds: number,
  lastMicroHedgeTs: number,
  nowMs: number,
  guardrails: V611GuardrailResult
): { trigger: boolean; reason: string; mode: MicroHedgeMode } {
  const cfg = STRATEGY.microHedge;
  const survivalWindow = STRATEGY.pairedControl.survivalWindowSec ?? 20;
  
  // Gate 1: Survival mode - let v6.1.1 survival logic handle
  if (remainingSeconds < survivalWindow) {
    return { trigger: false, reason: 'SURVIVAL_MODE', mode: 'MAKER' };
  }
  
  // Gate 2: Cooldown check
  if (nowMs - lastMicroHedgeTs < cfg.cooldownMs) {
    return { trigger: false, reason: 'COOLDOWN', mode: 'MAKER' };
  }
  
  // Gate 3: Cost-per-paired guardrail active
  if (guardrails.guardrailTriggered === 'COST_PER_PAIRED_STOP' || 
      guardrails.guardrailTriggered === 'COST_PER_PAIRED_EMERGENCY') {
    return { trigger: false, reason: 'GUARDRAIL_BLOCK', mode: 'MAKER' };
  }
  
  const currentUnpaired = unpairedShares(inv);
  
  // Already balanced
  if (currentUnpaired === 0) {
    return { trigger: false, reason: 'BALANCED', mode: 'MAKER' };
  }
  
  // Trigger conditions
  const deltaIncrease = currentUnpaired - previousUnpaired;
  const triggerByDelta = deltaIncrease >= cfg.triggerDelta;
  const triggerByFill = deltaIncrease > 0; // Any increase after fill
  
  if (!triggerByDelta && !triggerByFill) {
    return { trigger: false, reason: 'NO_TRIGGER', mode: 'MAKER' };
  }
  
  // Determine mode: urgent if near deadline
  const deadlineSec = STRATEGY.timing.pairedTargetDeadlineSec;
  const elapsedSec = inv.firstFillTs ? (nowMs - inv.firstFillTs) / 1000 : 0;
  const urgentWindow = cfg.urgentWindowSec;
  const isUrgent = (deadlineSec - elapsedSec) <= urgentWindow;
  
  return { 
    trigger: true, 
    reason: triggerByDelta ? 'DELTA_INCREASE' : 'FILL_INCREASE',
    mode: isUrgent ? 'URGENT_TAKER' : 'MAKER'
  };
}

/**
 * v6.1.2: Pair-cost gate for micro-hedges (DO NOT BURN EDGE)
 * Returns whether the micro-hedge should proceed based on projected pair cost
 */
export function checkMicroHedgePairCostGate(
  inv: Inventory,
  hedgeSide: Outcome,
  hedgePrice: number,
  mode: MicroHedgeMode
): { proceed: boolean; projectedPairCost: number; reason: string } {
  const cfg = STRATEGY.microHedge;
  
  // Get avg cost of OTHER side (the existing position)
  const otherSide: Outcome = hedgeSide === 'UP' ? 'DOWN' : 'UP';
  const otherShares = otherSide === 'UP' ? inv.upShares : inv.downShares;
  const otherCost = otherSide === 'UP' ? inv.upCost : inv.downCost;
  const avgCostOther = otherShares > 0 ? otherCost / otherShares : 0;
  
  // Projected pair cost = avg_cost_other_side + proposed_price
  const projectedPairCost = avgCostOther + hedgePrice;
  
  if (mode === 'MAKER') {
    // Normal mode: must lock profit (pair cost < 1.00 - buffer)
    const maxAllowed = 1.0 - cfg.edgeLockBuffer;
    if (projectedPairCost > maxAllowed) {
      return {
        proceed: false,
        projectedPairCost,
        reason: `PAIR_COST_BLOCK: ${projectedPairCost.toFixed(3)} > ${maxAllowed.toFixed(3)} (edge lock)`,
      };
    }
  } else {
    // Urgent mode: allow slight overpay
    const maxAllowed = 1.0 + cfg.urgentOverpayCap;
    if (projectedPairCost > maxAllowed) {
      return {
        proceed: false,
        projectedPairCost,
        reason: `URGENT_PAIR_COST_BLOCK: ${projectedPairCost.toFixed(3)} > ${maxAllowed.toFixed(3)} (urgent cap)`,
      };
    }
  }
  
  return {
    proceed: true,
    projectedPairCost,
    reason: `OK: projected pair cost ${projectedPairCost.toFixed(3)}`,
  };
}

/**
 * v6.1.2: Build micro-hedge trade signal
 * Returns null if micro-hedge should be aborted
 */
export function buildMicroHedge(
  inv: Inventory,
  book: TopOfBook,
  remainingSeconds: number,
  previousUnpaired: number,
  lastMicroHedgeTs: number,
  nowMs: number,
  guardrails: V611GuardrailResult,
  tick: number = STRATEGY.tick.fallback
): { signal: TradeSignal | null; intent: MicroHedgeIntent | null; abortReason?: MicroHedgeAbortReason } {
  const cfg = STRATEGY.microHedge;
  
  // Check trigger conditions
  const triggerCheck = shouldTriggerMicroHedge(
    inv, previousUnpaired, remainingSeconds, lastMicroHedgeTs, nowMs, guardrails
  );
  
  if (!triggerCheck.trigger) {
    return { 
      signal: null, 
      intent: null, 
      abortReason: triggerCheck.reason as MicroHedgeAbortReason 
    };
  }
  
  // Determine underweight side
  const hedgeSide = getUnderweightSide(inv);
  if (!hedgeSide) {
    return { signal: null, intent: null };
  }
  
  // Get ask price for hedge side
  const hedgeAsk = hedgeSide === 'UP' ? book.up.ask : book.down.ask;
  if (!hedgeAsk || !Number.isFinite(hedgeAsk)) {
    return { signal: null, intent: null, abortReason: 'NO_DEPTH' };
  }
  
  // Calculate micro-hedge quantity
  const microQty = calculateMicroHedgeQty(inv);
  if (microQty < cfg.minShares) {
    return { signal: null, intent: null };
  }
  
  // Determine price based on mode
  let hedgePrice: number;
  if (triggerCheck.mode === 'MAKER') {
    // Maker: post at ask (resting order)
    hedgePrice = roundDown(hedgeAsk, tick);
  } else {
    // Urgent taker: add cushion for immediate fill
    const cushion = STRATEGY.tick.hedgeCushion;
    hedgePrice = Math.min(
      roundUp(hedgeAsk + cushion * tick, tick),
      STRATEGY.hedge.maxPrice
    );
  }
  
  // Pair-cost gate check
  const pairCostCheck = checkMicroHedgePairCostGate(inv, hedgeSide, hedgePrice, triggerCheck.mode);
  if (!pairCostCheck.proceed) {
    console.log(`[v6.1.2] 🛑 MICRO-HEDGE ABORT: ${pairCostCheck.reason}`);
    return { signal: null, intent: null, abortReason: 'PAIR_COST' };
  }
  
  const currentUnpaired = unpairedShares(inv);
  const targetUnpaired = Math.max(0, currentUnpaired - microQty);
  
  // Build intent for logging
  const intent: MicroHedgeIntent = {
    marketId: '', // Will be set by caller
    side: hedgeSide,
    microQty,
    unpairedBefore: currentUnpaired,
    unpairedAfterTarget: targetUnpaired,
    mode: triggerCheck.mode,
    projectedPairCost: pairCostCheck.projectedPairCost,
    correlationId: crypto.randomUUID(),
    timestamp: nowMs,
  };
  
  // Build trade signal
  const signal: TradeSignal = {
    outcome: hedgeSide,
    price: hedgePrice,
    shares: microQty,
    reasoning: `v6.1.2 MICRO-HEDGE ${hedgeSide} ${microQty}sh @ ${(hedgePrice * 100).toFixed(1)}¢ (${triggerCheck.mode}, unpaired: ${currentUnpaired}→${targetUnpaired}, cpp: ${pairCostCheck.projectedPairCost.toFixed(3)})`,
    type: 'hedge',
    isMarketable: triggerCheck.mode === 'URGENT_TAKER',
    cushionTicks: triggerCheck.mode === 'URGENT_TAKER' ? STRATEGY.tick.hedgeCushion : 0,
  };
  
  console.log(`[v6.1.2] 🔄 MICRO-HEDGE INTENT: ${hedgeSide} ${microQty}sh @ ${(hedgePrice * 100).toFixed(1)}¢`);
  console.log(`   mode=${triggerCheck.mode}, unpaired=${currentUnpaired}→${targetUnpaired}, cpp=${pairCostCheck.projectedPairCost.toFixed(3)}`);
  
  return { signal, intent };
}

/**
 * v6.1.2: Log micro-hedge intent for telemetry
 */
export function logMicroHedgeIntent(intent: MicroHedgeIntent, marketId: string): void {
  console.log(`[v6.1.2] 📊 MICRO_HEDGE_INTENT`);
  console.log(`   market_id: ${marketId}`);
  console.log(`   side: ${intent.side}`);
  console.log(`   microQty: ${intent.microQty}`);
  console.log(`   unpaired: ${intent.unpairedBefore} → ${intent.unpairedAfterTarget}`);
  console.log(`   mode: ${intent.mode}`);
  console.log(`   projected_pair_cost: ${intent.projectedPairCost.toFixed(3)}`);
  console.log(`   correlation_id: ${intent.correlationId}`);
}

/**
 * v6.1.2: Log micro-hedge result for telemetry
 */
export function logMicroHedgeResult(
  result: MicroHedgeResult,
  marketId: string,
  correlationId: string
): void {
  const emoji = result.status === 'FILLED' ? '✅' : 
                result.status === 'PARTIAL' ? '⚠️' :
                result.status === 'ABORTED' ? '🛑' : '📤';
  
  console.log(`[v6.1.2] ${emoji} MICRO_HEDGE_RESULT`);
  console.log(`   market_id: ${marketId}`);
  console.log(`   status: ${result.status}`);
  if (result.abortReason) console.log(`   abort_reason: ${result.abortReason}`);
  if (result.fillLatencyMs) console.log(`   fill_latency_ms: ${result.fillLatencyMs}`);
  if (result.priceUsed) console.log(`   price_used: ${(result.priceUsed * 100).toFixed(1)}¢`);
  if (result.filledQty) console.log(`   filled_qty: ${result.filledQty}`);
  console.log(`   correlation_id: ${correlationId}`);
}

/**
 * v6.1.2: Calculate paired delay (time from first fill to paired_min reached)
 * Target: < 20s (gabagool-like)
 */
export function calculatePairedDelaySec(
  firstFillTs: number | undefined,
  pairedMinReachedTs: number | undefined
): number | null {
  if (!firstFillTs || !pairedMinReachedTs) return null;
  return (pairedMinReachedTs - firstFillTs) / 1000;
}

/**
 * v6.1.2: Enhanced metrics including micro-hedge data
 */
export interface V612Metrics extends V61Metrics {
  unpaired_shares: number;
  underweight_side: Outcome | null;
  micro_hedge_eligible: boolean;
  paired_delay_sec: number | null;
}

export function calculateV612Metrics(
  inv: Inventory, 
  nowMs: number,
  pairedMinReachedTs?: number
): V612Metrics {
  const base = calculateV61Metrics(inv, nowMs);
  return {
    ...base,
    unpaired_shares: unpairedShares(inv),
    underweight_side: getUnderweightSide(inv),
    micro_hedge_eligible: unpairedShares(inv) >= STRATEGY.microHedge.triggerDelta,
    paired_delay_sec: calculatePairedDelaySec(inv.firstFillTs, pairedMinReachedTs),
  };
}

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
// v7 ENTRY GUARD: Check all entry conditions
// ============================================================

export interface EntryGuardResult {
  allowed: boolean;
  reason?: 'TAIL_ENTRY_BLOCK' | 'NO_PAIR_EDGE' | 'CONTRA_ENTRY_BLOCK' | 'MIN_PRICE_BLOCK';
  details?: Record<string, any>;
}

export function checkEntryGuards(
  upAsk: number,
  downAsk: number,
  spotPrice?: number | null,
  strikePrice?: number | null
): EntryGuardResult {
  const minAsk = Math.min(upAsk, downAsk);
  const combinedAsk = upAsk + downAsk;
  const edge = 1 - combinedAsk;
  const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';

  // RULE A: Tail-Entry Block
  // If min(upAsk, downAsk) < tailEntryBlockPrice, ENTRY forbidden
  if (minAsk < STRATEGY.entry.tailEntryBlockPrice) {
    return {
      allowed: false,
      reason: 'TAIL_ENTRY_BLOCK',
      details: {
        minAsk,
        upAsk,
        downAsk,
        combinedAsk,
        threshold: STRATEGY.entry.tailEntryBlockPrice,
        message: `Min ask ${(minAsk * 100).toFixed(0)}¢ < ${(STRATEGY.entry.tailEntryBlockPrice * 100).toFixed(0)}¢ threshold`,
      },
    };
  }

  // RULE B: Pair-Edge Required
  // ENTRY only when combinedAsk < 1 - edgeBuffer
  if (STRATEGY.entry.requirePairEdge && combinedAsk >= 1 - STRATEGY.edge.baseBuffer) {
    return {
      allowed: false,
      reason: 'NO_PAIR_EDGE',
      details: {
        combinedAsk,
        edge,
        edgeBuffer: STRATEGY.edge.baseBuffer,
        message: `Combined ${(combinedAsk * 100).toFixed(0)}¢ >= ${((1 - STRATEGY.edge.baseBuffer) * 100).toFixed(0)}¢ (no pair edge)`,
      },
    };
  }

  // RULE C: Direction Sanity (No Contra Entry)
  // Only check if we have spot and strike prices
  if (spotPrice != null && strikePrice != null && strikePrice > 0) {
    const dirEps = STRATEGY.entry.directionEpsPct;
    const isUpLeading = spotPrice > strikePrice * (1 + dirEps);
    const isDownLeading = spotPrice < strikePrice * (1 - dirEps);

    // If spot > strike (UP-leading), do NOT allow ENTRY on DOWN
    if (isUpLeading && cheaperSide === 'DOWN') {
      return {
        allowed: false,
        reason: 'CONTRA_ENTRY_BLOCK',
        details: {
          cheaperSide,
          spotPrice,
          strikePrice,
          direction: 'UP_LEADING',
          message: `Spot $${spotPrice.toFixed(2)} > Strike $${strikePrice.toFixed(2)}, but cheaper side is DOWN`,
        },
      };
    }

    // If spot < strike (DOWN-leading), do NOT allow ENTRY on UP
    if (isDownLeading && cheaperSide === 'UP') {
      return {
        allowed: false,
        reason: 'CONTRA_ENTRY_BLOCK',
        details: {
          cheaperSide,
          spotPrice,
          strikePrice,
          direction: 'DOWN_LEADING',
          message: `Spot $${spotPrice.toFixed(2)} < Strike $${strikePrice.toFixed(2)}, but cheaper side is UP`,
        },
      };
    }
  }

  return { allowed: true };
}

// ============================================================
// ENTRY BUILDING (PDF: Opening Trade) - with v7 guards
// ============================================================

export function buildEntry(
  upAsk: number,
  downAsk: number,
  tradeSize: number = STRATEGY.tradeSizeUsd.base,
  spotPrice?: number | null,
  strikePrice?: number | null
): TradeSignal | null {
  // v7: Check all entry guards first
  const guardResult = checkEntryGuards(upAsk, downAsk, spotPrice, strikePrice);
  if (!guardResult.allowed) {
    const side: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
    console.log(`🛡️ [v7] ENTRY BLOCKED: ${guardResult.reason}`);
    console.log(`   → ${guardResult.details?.message}`);
    if (guardResult.details) {
      console.log(`   📊 UP: ${(upAsk * 100).toFixed(0)}¢ | DOWN: ${(downAsk * 100).toFixed(0)}¢ | Combined: ${((upAsk + downAsk) * 100).toFixed(0)}¢`);
    }
    return null;
  }

  const side: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
  const price = side === 'UP' ? upAsk : downAsk;
  const shares = Math.floor(tradeSize / price);
  
  if (shares < 1) return null;
  
  // v6.3.2: Block entries on prices that are too low (backup check)
  if (price < STRATEGY.opening.minPrice) {
    console.log(`🛡️ [v6.3.2] ENTRY BLOCKED: ${side} @ ${(price * 100).toFixed(0)}¢ < min ${(STRATEGY.opening.minPrice * 100).toFixed(0)}¢`);
    console.log(`   → Price too low, implies ${((1 - price) * 100).toFixed(0)}% probability against. Skipping.`);
    return null;
  }
  
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

export function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export function getMid(bid: number | null, ask: number | null): number {
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
  // v6.1: Market open time for entry window discipline
  marketOpenTs?: number;
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
    marketOpenTs,
    currentPrice: spotPrice,  // v7: For direction sanity check
    strikePrice,              // v7: For direction sanity check
  } = ctx;

  // v6.1: Set market open time in inventory if provided
  if (marketOpenTs && !inv.marketOpenTs) {
    inv.marketOpenTs = marketOpenTs;
  }

  // v6.1.1: Calculate metrics for logging
  const v61metrics = calculateV61Metrics(inv, nowMs);
  
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
  
  // ========== v6.1.1: GUARDRAIL CHECK WITH PRECEDENCE ==========
  // Priority: 1=Survival > 2=CostPerPaired > 3=PairedMin > 4=Skew > 5=Accumulate
  
  const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
  const guardrails = checkV611Guardrails(inv, remainingSeconds, nowMs, undefined, cheaperSide);
  
  // v6.6.0: Use throttled guardrail logging (state-change only or every 5s)
  // No more spam - only log on state change or interval
  // (The actual logging is now done via logGuardrailThrottled in inventory-risk.ts,
  // which is called from index.ts where we have access to the full context)
  
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
      // v6.1.1: Check guardrails FIRST
      if (guardrails.blockEntry) {
        console.log(`[v6.1.1] 🛑 BLOCK entry: ${guardrails.reason}`);
        return null;
      }
      
      // v6.1: Entry Window Discipline (Gabagool-style)
      const inEntryWindow = isInEntryWindow(inv.marketOpenTs, nowMs);
      const edgeCheck = executionAwareEdgeOk(upAsk, downAsk, upMid, downMid, buffer);
      
      // Opening trade can skip edge check if price near fair value (48-52¢)
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      const isOpeningPrice = cheaperPrice <= STRATEGY.opening.maxPrice;
      
      // v6.1: Outside entry window, require strong edge
      if (!inEntryWindow) {
        const strongEdgeRequired = 1.0 - STRATEGY.edge.strongEdgeBuffer;
        if (combined > strongEdgeRequired) {
          console.log(`[v6.1.1] 🚫 BLOCK entry: outside window, combined=${(combined * 100).toFixed(0)}¢ > ${(strongEdgeRequired * 100).toFixed(0)}¢ threshold`);
          return null;
        }
        console.log(`[v6.1.1] ✅ Late entry allowed: strong edge combined=${(combined * 100).toFixed(0)}¢`);
      }
      
      if (!edgeCheck.ok && !(STRATEGY.opening.skipEdgeCheck && isOpeningPrice)) {
        return null;
      }
      
      // Balance check
      if (availableBalance !== undefined) {
        const check = checkBalanceForOpening(availableBalance, STRATEGY.tradeSizeUsd.base);
        if (!check.canProceed) return null;
      }
      
      // v6.1: Micro-sizing - use smaller trade size
      const tradeSize = getTradeSize(remainingSeconds, edgePct, false);
      // v7: Pass spot/strike for direction sanity check
      const signal = buildEntry(upAsk, downAsk, tradeSize, spotPrice, strikePrice);
      if (signal) {
        console.log(`[v6.1.1] 🎯 Opening: ${signal.outcome} ${signal.shares} shares @ ${(signal.price * 100).toFixed(1)}¢`);
      }
      return signal;
    }
    
    case 'ONE_SIDED': {
      // v6.1.1: Hedging is ALWAYS allowed (guardrails.allowHedge = true for all triggers)
      // This is by design - we must get hedged to protect capital
      
      const initHedgeCheck = needsInitHedge(inv, nowMs);
      const missingSide: Outcome = inv.upShares === 0 ? 'UP' : 'DOWN';
      const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
      const existingShares = missingSide === 'UP' ? inv.downShares : inv.upShares;
      const existingCost = missingSide === 'UP' ? inv.downCost : inv.upCost;
      const existingAvg = existingShares > 0 ? existingCost / existingShares : 0;
      
      const projectedCombined = existingAvg + missingAsk;
      const maxAllowed = 1 + STRATEGY.edge.allowOverpay;
      
      console.log(`[v6.1.1] Hedge eval: ${missingSide} @ ${(missingAsk * 100).toFixed(0)}¢, existingAvg=${(existingAvg * 100).toFixed(0)}¢, combined=${(projectedCombined * 100).toFixed(0)}¢`);
      
      // v6.1: Check for initial hedge (within 3s, small size)
      if (initHedgeCheck.needed && initHedgeCheck.hedgeSide) {
        console.log(`[v6.1.1] ⚡ ${initHedgeCheck.reason}`);
        const initHedgeShares = initHedgeCheck.hedgeShares;
        if (projectedCombined <= maxAllowed) {
          return buildHedge(initHedgeCheck.hedgeSide, missingAsk, tick, initHedgeShares);
        }
        return buildForceHedge(initHedgeCheck.hedgeSide, missingAsk, tick, initHedgeShares, existingAvg);
      }
      
      // Normal hedge logic (after init hedge window)
      const hedgeShares = Math.max(existingShares, 5);
      const timeSinceFirstFill = inv.firstFillTs ? (nowMs - inv.firstFillTs) / 1000 : 0;
      const forceHedge = timeSinceFirstFill >= STRATEGY.timing.hedgeTimeoutSec;
      
      if (forceHedge) {
        console.log(`[v6.1.1] 🔴 FORCE hedge after ${timeSinceFirstFill.toFixed(0)}s timeout`);
        return buildForceHedge(missingSide, missingAsk, tick, hedgeShares, existingAvg);
      }
      
      // Normal hedge: check if profitable
      if (projectedCombined <= maxAllowed) {
        return buildHedge(missingSide, missingAsk, tick, hedgeShares);
      }
      
      // Must be hedged by hedgeMustBySec
      if (remainingSeconds <= STRATEGY.timing.hedgeMustBySec) {
        console.log(`[v6.1.1] 🔴 MUST hedge by ${STRATEGY.timing.hedgeMustBySec}s - forcing`);
        return buildForceHedge(missingSide, missingAsk, tick, hedgeShares, existingAvg);
      }
      
      console.log(`[v6.1.1] ⏳ Waiting for better hedge price...`);
      return null;
    }
    
    case 'DEEP_DISLOCATION': {
      // v6.1.1: Even in DEEP mode, guardrails take precedence
      // DEEP is still accumulation - check if blocked
      if (guardrails.blockAccumulate) {
        console.log(`[v6.1.1] 🛑 BLOCK DEEP accumulate: ${guardrails.reason}`);
        // In DEEP with block, try rebalancing to minority side instead
        if (guardrails.allowRebalance) {
          const dominantSide: Outcome = inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
          const minoritySide: Outcome = dominantSide === 'UP' ? 'DOWN' : 'UP';
          const minorityAsk = minoritySide === 'UP' ? upAsk : downAsk;
          const minorityShares = Math.floor(STRATEGY.tradeSizeUsd.base / minorityAsk);
          if (minorityShares >= 5) {
            return {
              outcome: minoritySide,
              price: roundDown(minorityAsk, tick),
              shares: minorityShares,
              reasoning: `v6.1.1 DEEP Rebalance ${minoritySide} @ ${(minorityAsk * 100).toFixed(0)}¢ (guardrail: build paired qty)`,
              type: 'rebalance',
            };
          }
        }
        return null;
      }
      
      console.log(`[v6.1.1] DEEP DISLOCATION: combined=${(combined * 100).toFixed(0)}¢, edge=${edgePct.toFixed(1)}%`);
      
      const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
      
      // Max size for deep dislocation
      const maxTradeSize = STRATEGY.tradeSizeUsd.max;
      const shares = Math.floor(maxTradeSize / cheaperPrice);
      
      if (shares < 5) return null;
      
      // v6.1.1: Check if adding to dominant side while paired min not reached
      if (guardrails.blockDominantSideAdd) {
        const dominantSide: Outcome = inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
        if (cheaperSide === dominantSide) {
          console.log(`[v6.1.1] 🛑 BLOCK DEEP on dominant ${dominantSide}: paired_min not reached`);
          // Buy OTHER side instead
          const otherSide: Outcome = cheaperSide === 'UP' ? 'DOWN' : 'UP';
          const otherAsk = otherSide === 'UP' ? upAsk : downAsk;
          const otherShares = Math.floor(maxTradeSize / otherAsk);
          if (otherShares >= 5) {
            return {
              outcome: otherSide,
              price: roundDown(otherAsk, tick),
              shares: otherShares,
              reasoning: `v6.1.1 DEEP Forced ${otherSide} @ ${(otherAsk * 100).toFixed(0)}¢ (paired_min guardrail)`,
              type: 'rebalance',
            };
          }
          return null;
        }
      }
      
      // Check skew cap
      if (exceedsSkewCap(inv, cheaperSide, shares)) {
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
      // v6.1.1: Rebalance is allowed in most guardrail states
      if (!guardrails.allowRebalance) {
        console.log(`[v6.1.1] 🛑 BLOCK rebalance: ${guardrails.reason}`);
        return null;
      }
      
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
            reasoning: `v6.1.1 Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(0)}¢ (partial skew correction)`,
            type: 'rebalance',
          };
        }
        return null;
      }
      
      return {
        outcome: rebalanceSide,
        price: roundDown(rebalanceAsk, tick),
        shares: sharesToBalance,
        reasoning: `v6.1.1 Rebalance ${rebalanceSide} @ ${(rebalanceAsk * 100).toFixed(0)}¢ (skew correction)`,
        type: 'rebalance',
      };
    }
    
    case 'HEDGED': {
      // v6.1.1: Hard guardrail check - blockAccumulate means NO adds at all
      if (guardrails.blockAccumulate) {
        console.log(`[v6.1.1] 🛑 BLOCK accumulate: ${guardrails.reason}`);
        
        // If paired min not reached and allowed to rebalance, force to minority side
        if (guardrails.allowRebalance && guardrails.blockDominantSideAdd && !guardrails.pairedMinReached) {
          const dominantSide: Outcome = inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
          const minoritySide: Outcome = dominantSide === 'UP' ? 'DOWN' : 'UP';
          const minorityAsk = minoritySide === 'UP' ? upAsk : downAsk;
          const minorityShares = Math.floor(STRATEGY.tradeSizeUsd.base / minorityAsk);
          if (minorityShares >= 2) {
            return {
              outcome: minoritySide,
              price: roundDown(minorityAsk, tick),
              shares: minorityShares,
              reasoning: `v6.1.1 Paired Target: force ${minoritySide} (paired=${pairedShares(inv)}/${STRATEGY.pairedControl.minShares})`,
              type: 'rebalance',
            };
          }
        }
        return null;
      }
      
      // PDF: Accumulation - expand position if good combined price
      if (!pairedLockOk(upAsk, downAsk, buffer)) {
        return null;
      }
      
      // Position limits
      if (inv.upShares >= STRATEGY.limits.maxSharesPerSide || 
          inv.downShares >= STRATEGY.limits.maxSharesPerSide) {
        return null;
      }
      
      // v6.1.1: Check if adding to dominant side while paired min not reached (after deadline)
      if (guardrails.blockDominantSideAdd) {
        const dominantSide: Outcome = inv.upShares >= inv.downShares ? 'UP' : 'DOWN';
        if (cheaperSide === dominantSide) {
          console.log(`[v6.1.1] 🛑 PAIRED_MIN_BLOCK: Cannot add to ${dominantSide} (paired=${pairedShares(inv)} < ${STRATEGY.pairedControl.minShares})`);
          // Force rebalance to minority side
          const minoritySide: Outcome = dominantSide === 'UP' ? 'DOWN' : 'UP';
          const minorityAsk = minoritySide === 'UP' ? upAsk : downAsk;
          const minorityShares = Math.floor(STRATEGY.tradeSizeUsd.base / minorityAsk);
          if (minorityShares >= 2) {
            return {
              outcome: minoritySide,
              price: roundDown(minorityAsk, tick),
              shares: minorityShares,
              reasoning: `v6.1.1 Paired Target: force ${minoritySide} (paired=${pairedShares(inv)}/${STRATEGY.pairedControl.minShares})`,
              type: 'rebalance',
            };
          }
          return null;
        }
      }
      
      // Only accumulate if shares are balanced (within 10%)
      const shareDiff = Math.abs(inv.upShares - inv.downShares);
      const avgShares = (inv.upShares + inv.downShares) / 2;
      if (avgShares > 0 && shareDiff / avgShares > 0.1) {
        console.log(`[v6.1.1] BLOCK accumulate: shares not balanced (diff=${shareDiff})`);
        return null;
      }
      
      // Check if accumulating would improve pair cost
      const currentPairCost = pairCost(inv);
      if (combined >= currentPairCost) {
        return null; // Only accumulate if new price is better
      }
      
      // v6.1: Micro-sizing for accumulation
      const tradeSize = getTradeSize(remainingSeconds, edgePct, false);
      const sharesToAdd = Math.floor(tradeSize / combined);
      
      if (sharesToAdd < 2) return null;
      
      // Buy the cheaper side
      const accumulatePrice = cheaperSide === 'UP' ? upAsk : downAsk;
      
      return {
        outcome: cheaperSide,
        price: roundDown(accumulatePrice, tick),
        shares: sharesToAdd,
        reasoning: `v6.1.1 Accumulate ${cheaperSide} @ ${(combined * 100).toFixed(0)}¢ (edge=${edgePct.toFixed(1)}%, cpp=${guardrails.costPerPaired.toFixed(3)})`,
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

// ============================================================
// v7.0.1 PATCH LAYER RE-EXPORTS
// ============================================================

export {
  V7_PATCH_VERSION,
  // Readiness Gate
  isMarketReady as v7IsMarketReady,
  checkReadinessGate as v7CheckReadinessGate,
  clearReadinessState as v7ClearReadinessState,
  getReadinessState,
  // Intent Slots
  getIntentSlots,
  setPendingEntry,
  setPendingHedge,
  clearEntrySlot,
  clearHedgeSlot,
  getPendingIntentCount,
  canAddIntent,
  clearIntentSlots,
  // Micro-hedge Accumulator
  getMicroHedgeAccumulator,
  accumulateHedgeNeeded,
  shouldPlaceMicroHedge,
  clearMicroHedgeAccumulator,
  resetMicroHedgeAccumulator,
  // Risk Score / Degraded Mode
  calculateRiskScore,
  isActionAllowedInDegradedMode,
  // Queue Stress
  updateGlobalPendingCount,
  isQueueStressed as v7IsQueueStressed,
  isActionAllowedInQueueStress,
  // Combined Gate
  checkV7Gates,
  // Stats
  getV7PatchStats,
  logV7PatchStatus,
  // Types
  type MarketBook as V7MarketBook,
  type ReadinessState,
  type PendingIntent as V7PendingIntent,
  type IntentType as V7IntentType,
  type MicroHedgeAccumulator,
  type RiskScoreResult,
  type V7GateResult,
  type V7PatchStats,
} from './v7-patch.js';
