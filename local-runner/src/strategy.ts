/**
 * strategy.ts - Active Strategy Wrapper (v6.3.0)
 * ===============================================
 * GPT Strategy v6.0 – Adaptive Hedger
 * 
 * v6.3.0 UPDATE: Config Unification
 * ---------------------------------
 * This module now uses ResolvedConfig as the single source of truth.
 * All configuration is resolved at startup from:
 *   1. Database (bot_config) ← SOURCE OF TRUTH
 *   2. ENV overrides (config.ts)
 *   3. Code defaults (loveable-strat.ts)
 * 
 * Core Principle:
 * Buy YES + NO asymmetrically when combined < $1.00
 * Guaranteed profit = min(QtyYES, QtyNO) - (CostYES + CostNO)
 * 
 * Key Features:
 * - Dynamic edge buffer adapts to liquidity/adverse conditions
 * - Execution-aware edge calculation (ask + mid, not mid + mid)
 * - Force hedge after 12s timeout (never stay one-sided)
 * - Deep Dislocation mode for extreme mispricings (≤96¢)
 * - Skew management targets 50/50, max 70/30
 * - Trade sizing from ResolvedConfig (no hardcoded values)
 * 
 * States: FLAT → ONE_SIDED → HEDGED / SKEWED / DEEP_DISLOCATION
 */

import type { OrderbookDepth } from './polymarket.js';
import { getCurrentConfig, toStrategyObject, type ResolvedConfig } from './resolved-config.js';

// Re-export types from loveable-strat
export type { 
  Outcome, 
  State, 
  TopOfBook, 
  Inventory, 
  MarketPosition, 
  PendingHedge, 
  TradeSignal, 
  MarketState,
  EdgeCheckResult,
  EvaluationContext,
  PriceBiasContext,
} from './loveable-strat.js';

// Re-export pure functions (no config dependency)
export {
  calculateSkew,
  getSkewRatio,
  needsRebalance,
  exceedsSkewCap,
  onFill,
  pairCost,
  avgPrice,
  lockedProfit,
  calculateProfit,
  calculateProfitPercent,
  determineState,
  calculateEdge,
  TickInferer,
  tickInferer,
  roundDown,
  roundUp,
} from './loveable-strat.js';

// Import everything we need to wrap
import {
  STRATEGY as HARDCODED_STRATEGY,
  STRATEGY_VERSION as HARDCODED_VERSION,
  STRATEGY_NAME as HARDCODED_NAME,
  dynamicEdgeBuffer as _dynamicEdgeBuffer,
  executionAwareEdgeOk as _executionAwareEdgeOk,
  pairedLockOk as _pairedLockOk,
  buildEntry as _buildEntry,
  buildHedge as _buildHedge,
  buildForceHedge as _buildForceHedge,
  shouldUnwind as _shouldUnwind,
  evaluateOpportunity as _evaluateOpportunity,
  evaluateWithContext as _evaluateWithContext,
  checkBalanceForOpening as _checkBalanceForOpening,
  checkLiquidityForAccumulate as _checkLiquidityForAccumulate,
  calculatePreHedgePrice as _calculatePreHedgePrice,
  checkHardSkewStop as _checkHardSkewStop,
  calculateLikelySide,
  shouldSkipLosingHedge,
  type TopOfBook,
  type MarketPosition,
  type Outcome,
  type TradeSignal,
  type EvaluationContext,
} from './loveable-strat.js';

// Export legacy trade signal type for compatibility
export interface LegacyTradeSignal {
  outcome: Outcome;
  price: number;
  shares: number;
  reasoning: string;
  type: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind';
  isMarketable?: boolean;
  cushionTicks?: number;
}

// ============================================================
// VERSION & NAME
// ============================================================

export const STRATEGY_VERSION = '6.3.0';  // Updated for config unification
export const STRATEGY_NAME = 'GPT Strategy v6.3 – Adaptive Hedger (Config Unified)';

// ============================================================
// DYNAMIC STRATEGY OBJECT
// ============================================================

/**
 * Returns the effective STRATEGY object.
 * Uses ResolvedConfig if available, otherwise falls back to hardcoded.
 */
export function getStrategy(): ReturnType<typeof toStrategyObject> {
  const cfg = getCurrentConfig();
  if (cfg) {
    return toStrategyObject(cfg);
  }
  // Fallback to hardcoded if config not yet built
  return HARDCODED_STRATEGY as any;
}

/**
 * STRATEGY object for backwards compatibility.
 * Uses Proxy to dynamically return current config values.
 */
export const STRATEGY = new Proxy({} as ReturnType<typeof toStrategyObject>, {
  get(_target, prop: string) {
    const strategy = getStrategy();
    return (strategy as any)[prop];
  },
});

// ============================================================
// WRAPPED FUNCTIONS - Use ResolvedConfig
// ============================================================

/**
 * Dynamic edge buffer with config from ResolvedConfig
 */
export function dynamicEdgeBuffer(
  noLiquidityStreak: number,
  adverseStreak: number
): number {
  const cfg = getCurrentConfig();
  if (!cfg) return _dynamicEdgeBuffer(noLiquidityStreak, adverseStreak);

  let buffer = cfg.edge.baseBuffer + cfg.edge.feesBuffer + cfg.edge.slippageBuffer;
  
  if (noLiquidityStreak > 3) buffer -= 0.005;
  if (adverseStreak > 2) buffer += 0.005;
  
  return Math.max(0.01, Math.min(0.03, buffer));
}

/**
 * Execution-aware edge check
 */
export function executionAwareEdgeOk(
  upAsk: number,
  downAsk: number,
  upMid: number,
  downMid: number,
  buffer?: number
): ReturnType<typeof _executionAwareEdgeOk> {
  const cfg = getCurrentConfig();
  const effectiveBuffer = buffer ?? (cfg?.edge.baseBuffer ?? 0.015);
  return _executionAwareEdgeOk(upAsk, downAsk, upMid, downMid, effectiveBuffer);
}

/**
 * Paired lock check
 */
export function pairedLockOk(
  upAsk: number,
  downAsk: number,
  buffer?: number
): boolean {
  const cfg = getCurrentConfig();
  const effectiveBuffer = buffer ?? (cfg?.edge.baseBuffer ?? 0.015);
  return _pairedLockOk(upAsk, downAsk, effectiveBuffer);
}

/**
 * Build entry signal with ResolvedConfig sizing
 */
export function buildEntry(
  upAsk: number,
  downAsk: number,
  tradeSize?: number
): TradeSignal | null {
  const cfg = getCurrentConfig();
  const effectiveSize = tradeSize ?? (cfg?.tradeSizing.base ?? 25);
  return _buildEntry(upAsk, downAsk, effectiveSize);
}

/**
 * Build hedge signal
 */
export function buildHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number
): TradeSignal {
  return _buildHedge(side, ask, tick, qty);
}

/**
 * Build force hedge signal
 */
export function buildForceHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number,
  existingAvg: number
): TradeSignal | null {
  return _buildForceHedge(side, ask, tick, qty, existingAvg);
}

/**
 * Should unwind check with ResolvedConfig timing
 */
export function shouldUnwind(
  secondsRemaining: number,
  hedgeLagSec: number,
  noLiquidityStreak: number
): { unwind: boolean; reason: string } {
  const cfg = getCurrentConfig();
  if (!cfg) return _shouldUnwind(secondsRemaining, hedgeLagSec, noLiquidityStreak);

  if (secondsRemaining < cfg.timing.unwindStartSec) {
    return { unwind: true, reason: `Time critical: ${secondsRemaining}s remaining` };
  }
  if (hedgeLagSec > cfg.timing.hedgeTimeoutSec) {
    return { unwind: true, reason: `Hedge timeout: ${hedgeLagSec}s lag` };
  }
  if (noLiquidityStreak >= 6) {
    return { unwind: true, reason: `No liquidity streak: ${noLiquidityStreak}` };
  }
  return { unwind: false, reason: '' };
}

/**
 * Main evaluation function
 */
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
  return _evaluateOpportunity(
    book, position, remainingSeconds, lastTradeAtMs, nowMs,
    availableBalance, currentPrice, strikePrice
  );
}

/**
 * Evaluation with full context
 */
export function evaluateWithContext(ctx: EvaluationContext): TradeSignal | null {
  return _evaluateWithContext(ctx);
}

/**
 * Balance check for opening
 */
export function checkBalanceForOpening(
  availableBalance: number,
  requiredNotional?: number
): { canProceed: boolean; reason?: string } {
  const cfg = getCurrentConfig();
  const effectiveNotional = requiredNotional ?? (cfg?.tradeSizing.base ?? 25);
  return _checkBalanceForOpening(availableBalance, effectiveNotional);
}

/**
 * Liquidity check for accumulate
 */
export function checkLiquidityForAccumulate(
  upDepth: OrderbookDepth,
  downDepth: OrderbookDepth,
  requiredShares: number
): { canProceed: boolean; reason?: string } {
  return _checkLiquidityForAccumulate(upDepth, downDepth, requiredShares);
}

/**
 * Pre-hedge price calculation
 */
export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: Outcome,
  hedgeAsk?: number,
  tick?: number
): ReturnType<typeof _calculatePreHedgePrice> {
  const cfg = getCurrentConfig();
  const effectiveTick = tick ?? (cfg?.tick.fallback ?? 0.01);
  return _calculatePreHedgePrice(openingPrice, openingSide, hedgeAsk, effectiveTick);
}

/**
 * Hard skew stop check
 */
export function checkHardSkewStop(position: MarketPosition): { blocked: boolean; reason?: string } {
  return _checkHardSkewStop(position);
}

// Re-export probability functions
export { calculateLikelySide, shouldSkipLosingHedge };
