/**
 * cpp-quality.ts - Rev D CPP-First Entry & Hedge Guards
 * =========================================================
 * 
 * PURPOSE: Prevent structurally unprofitable trades by enforcing CPP quality
 *          BEFORE entry and DURING pairing.
 * 
 * KEY INSIGHT: Losses are caused by paying too much for one side,
 *              resulting in CPP > $1.00 that can never recover.
 * 
 * PRIORITY 1: Pre-entry CPP feasibility check
 * PRIORITY 2: Combination-based price guard (not hard caps)
 * PRIORITY 3: CPP activity state machine (NORMAL/HEDGE_ONLY/HOLD_ONLY)
 * PRIORITY 4: Entry & hedge sizing (supportive, not aggressive)
 * PRIORITY 5: Observability metrics
 * 
 * NON-GOALS:
 * - No SELL for skew correction
 * - No forced pairing via taker orders
 * - No absolute leg price caps
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION - Rev D
// ============================================================

export const CPP_QUALITY_CONFIG = {
  // PRIORITY 1: Pre-entry CPP feasibility
  maxProjectedCpp: 0.98,       // Soft feasibility threshold for entry
  
  // PRIORITY 2: Combination-based price guard
  maxCombinedPrice: 0.98,      // entryAvgPrice + hedgeAsk must be <= this
  
  // PRIORITY 3: CPP activity state thresholds
  cppNormalMax: 1.00,          // cpp < 1.00 = NORMAL
  cppHedgeOnlyMax: 1.02,       // 1.00 <= cpp < 1.02 = HEDGE_ONLY
                               // cpp >= 1.02 = HOLD_ONLY
  
  // PRIORITY 4: Entry & hedge sizing
  initialEntryShares: { min: 5, max: 10 },
  hedgeChunkShares: { min: 1, max: 5 },
  maxCppForAdds: 0.98,         // Only allow adds if cpp < this
  
  // Logging
  logThrottleMs: 5000,
};

// ============================================================
// TYPES
// ============================================================

export type CppActivityState = 'NORMAL' | 'HEDGE_ONLY' | 'HOLD_ONLY';

export interface CppFeasibilityResult {
  allowed: boolean;
  projectedCpp: number;
  entryPrice: number;
  oppositeSideAsk: number;
  reason: string;
}

export interface CombinationGuardResult {
  allowed: boolean;
  combinedPrice: number;
  reason: string;
}

export interface CppActivityStateResult {
  state: CppActivityState;
  cpp: number | null;
  reason: string;
}

export interface CppMetrics {
  projectedCpp: number | null;       // At entry
  actualCpp: number | null;          // Paired-only
  cppDrift: number | null;           // actual - projected
  timeToFirstPairMs: number | null;
  maxLegPriceSeen: number;
  activityState: CppActivityState;
  skippedReason: string | null;
}

// Per-market CPP tracking state
interface MarketCppState {
  projectedCppAtEntry: number | null;
  entryTs: number | null;
  firstPairTs: number | null;
  maxUpPriceSeen: number;
  maxDownPriceSeen: number;
  lastActivityState: CppActivityState;
}

const marketCppStates = new Map<string, MarketCppState>();

// Throttle logging
const logThrottles = new Map<string, number>();

// ============================================================
// PRIORITY 1: PRE-ENTRY CPP FEASIBILITY CHECK
// ============================================================

/**
 * Check if entry is allowed based on projected CPP.
 * 
 * projectedCPP = entryPrice + oppositeSideBestAsk
 * 
 * Entry allowed only if projectedCPP <= MAX_PROJECTED_CPP (0.98)
 */
export function checkCppFeasibility(params: {
  marketId: string;
  asset: string;
  entrySide: 'UP' | 'DOWN';
  entryPrice: number;
  upAsk: number;
  downAsk: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): CppFeasibilityResult {
  const { marketId, asset, entrySide, entryPrice, upAsk, downAsk, runId, cfg = CPP_QUALITY_CONFIG } = params;
  
  const oppositeSideAsk = entrySide === 'UP' ? downAsk : upAsk;
  const projectedCpp = entryPrice + oppositeSideAsk;
  
  const key = `${marketId}:${asset}`;
  const now = Date.now();
  
  if (projectedCpp > cfg.maxProjectedCpp) {
    // Log (throttled)
    const lastLog = logThrottles.get(`feasibility_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`feasibility_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] PROJECTED_CPP_TOO_HIGH: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   projectedCpp=${projectedCpp.toFixed(4)} > max=${cfg.maxProjectedCpp}`);
      console.log(`   entryPrice=${entryPrice.toFixed(4)}, oppAsk=${oppositeSideAsk.toFixed(4)}`);
      
      saveBotEvent({
        event_type: 'PROJECTED_CPP_TOO_HIGH',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'CPP_FEASIBILITY_BLOCKED',
        data: {
          entrySide,
          entryPrice,
          oppositeSideAsk,
          projectedCpp,
          maxProjectedCpp: cfg.maxProjectedCpp,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      projectedCpp,
      entryPrice,
      oppositeSideAsk,
      reason: `PROJECTED_CPP_TOO_HIGH: ${projectedCpp.toFixed(4)} > ${cfg.maxProjectedCpp}`,
    };
  }
  
  // Store projected CPP for drift tracking
  let state = marketCppStates.get(key);
  if (!state) {
    state = {
      projectedCppAtEntry: null,
      entryTs: null,
      firstPairTs: null,
      maxUpPriceSeen: 0,
      maxDownPriceSeen: 0,
      lastActivityState: 'NORMAL',
    };
    marketCppStates.set(key, state);
  }
  
  // Only set projected if this is first entry
  if (state.projectedCppAtEntry === null) {
    state.projectedCppAtEntry = projectedCpp;
    state.entryTs = now;
  }
  
  return {
    allowed: true,
    projectedCpp,
    entryPrice,
    oppositeSideAsk,
    reason: `CPP_FEASIBLE: ${projectedCpp.toFixed(4)} <= ${cfg.maxProjectedCpp}`,
  };
}

// ============================================================
// PRIORITY 2: COMBINATION-BASED PRICE GUARD
// ============================================================

/**
 * Check if order is allowed based on combination price.
 * 
 * Entry or hedge is valid ONLY if:
 *   currentAvgPrice + hedgeAsk <= MAX_COMBINED_PRICE (0.98)
 * 
 * This replaces absolute single-side price caps.
 * A $0.65 leg is acceptable if the other side is $0.30.
 */
export function checkCombinationGuard(params: {
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  currentAvgPrice: number;  // Avg price of the side we're adding to
  oppositeSideAsk: number;  // Best ask of the opposite side (for hedge)
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): CombinationGuardResult {
  const { marketId, asset, side, currentAvgPrice, oppositeSideAsk, runId, cfg = CPP_QUALITY_CONFIG } = params;
  
  const combinedPrice = currentAvgPrice + oppositeSideAsk;
  
  if (combinedPrice > cfg.maxCombinedPrice) {
    const key = `${marketId}:${asset}`;
    const now = Date.now();
    
    const lastLog = logThrottles.get(`combination_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`combination_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] COMBINATION_GUARD_BLOCKED: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   combinedPrice=${combinedPrice.toFixed(4)} > max=${cfg.maxCombinedPrice}`);
      console.log(`   avgPrice=${currentAvgPrice.toFixed(4)}, oppAsk=${oppositeSideAsk.toFixed(4)}`);
      
      saveBotEvent({
        event_type: 'COMBINATION_GUARD_BLOCKED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'COMBINATION_PRICE_TOO_HIGH',
        data: {
          side,
          currentAvgPrice,
          oppositeSideAsk,
          combinedPrice,
          maxCombinedPrice: cfg.maxCombinedPrice,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      combinedPrice,
      reason: `COMBINATION_BLOCKED: ${combinedPrice.toFixed(4)} > ${cfg.maxCombinedPrice}`,
    };
  }
  
  return {
    allowed: true,
    combinedPrice,
    reason: `COMBINATION_OK: ${combinedPrice.toFixed(4)} <= ${cfg.maxCombinedPrice}`,
  };
}

// ============================================================
// PRIORITY 3: CPP ACTIVITY STATE MACHINE
// ============================================================

/**
 * Determine CPP activity state based on current paired-only CPP.
 * 
 * States:
 * - NORMAL (cpp < 1.00): entries allowed, hedges allowed
 * - HEDGE_ONLY (1.00 <= cpp < 1.02): no new entries, only passive hedges
 * - HOLD_ONLY (cpp >= 1.02): freeze market, no new orders, wait for expiry
 */
export function getCppActivityState(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): CppActivityStateResult {
  const { marketId, asset, upShares, downShares, upCost, downCost, cfg = CPP_QUALITY_CONFIG } = params;
  
  const key = `${marketId}:${asset}`;
  let state = marketCppStates.get(key);
  if (!state) {
    state = {
      projectedCppAtEntry: null,
      entryTs: null,
      firstPairTs: null,
      maxUpPriceSeen: 0,
      maxDownPriceSeen: 0,
      lastActivityState: 'NORMAL',
    };
    marketCppStates.set(key, state);
  }
  
  // Cannot calculate CPP if not paired
  if (upShares <= 0 || downShares <= 0) {
    return {
      state: 'NORMAL',  // Default to NORMAL when not paired
      cpp: null,
      reason: 'CPP_UNAVAILABLE: not paired',
    };
  }
  
  // Record first pair time
  if (state.firstPairTs === null) {
    state.firstPairTs = Date.now();
  }
  
  const avgUp = upCost / upShares;
  const avgDown = downCost / downShares;
  const cpp = avgUp + avgDown;
  
  let activityState: CppActivityState;
  let reason: string;
  
  if (cpp < cfg.cppNormalMax) {
    activityState = 'NORMAL';
    reason = `NORMAL: cpp=${cpp.toFixed(4)} < ${cfg.cppNormalMax}`;
  } else if (cpp < cfg.cppHedgeOnlyMax) {
    activityState = 'HEDGE_ONLY';
    reason = `HEDGE_ONLY: ${cfg.cppNormalMax} <= cpp=${cpp.toFixed(4)} < ${cfg.cppHedgeOnlyMax}`;
  } else {
    activityState = 'HOLD_ONLY';
    reason = `HOLD_ONLY: cpp=${cpp.toFixed(4)} >= ${cfg.cppHedgeOnlyMax}`;
  }
  
  state.lastActivityState = activityState;
  
  return { state: activityState, cpp, reason };
}

/**
 * Check if entry is allowed based on CPP activity state.
 */
export function isEntryAllowedByActivityState(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): { allowed: boolean; state: CppActivityState; reason: string } {
  const { runId, ...stateParams } = params;
  const result = getCppActivityState(stateParams);
  
  if (result.state === 'NORMAL') {
    return { allowed: true, state: result.state, reason: result.reason };
  }
  
  const { marketId, asset } = params;
  const now = Date.now();
  const key = `${marketId}:${asset}`;
  
  const lastLog = logThrottles.get(`activity_${key}`) ?? 0;
  if (now - lastLog > (params.cfg ?? CPP_QUALITY_CONFIG).logThrottleMs) {
    logThrottles.set(`activity_${key}`, now);
    console.log(`🚫 [CPP_QUALITY] ENTRY_BLOCKED_BY_STATE: ${asset} ${marketId.slice(0, 8)}`);
    console.log(`   state=${result.state}, cpp=${result.cpp?.toFixed(4)}`);
    
    saveBotEvent({
      event_type: 'ENTRY_BLOCKED_BY_CPP_STATE',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      reason_code: result.state,
      data: {
        cpp: result.cpp,
        state: result.state,
      },
    }).catch(() => {});
  }
  
  return {
    allowed: false,
    state: result.state,
    reason: `ENTRY_BLOCKED: ${result.state}`,
  };
}

/**
 * Check if hedge is allowed based on CPP activity state.
 */
export function isHedgeAllowedByActivityState(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): { allowed: boolean; state: CppActivityState; reason: string } {
  const { runId, ...stateParams } = params;
  const result = getCppActivityState(stateParams);
  
  // NORMAL and HEDGE_ONLY allow hedging
  if (result.state === 'NORMAL' || result.state === 'HEDGE_ONLY') {
    return { allowed: true, state: result.state, reason: result.reason };
  }
  
  // HOLD_ONLY blocks everything
  const { marketId, asset } = params;
  const now = Date.now();
  const key = `${marketId}:${asset}`;
  
  const lastLog = logThrottles.get(`hedge_hold_${key}`) ?? 0;
  if (now - lastLog > (params.cfg ?? CPP_QUALITY_CONFIG).logThrottleMs) {
    logThrottles.set(`hedge_hold_${key}`, now);
    console.log(`🚫 [CPP_QUALITY] HEDGE_BLOCKED_HOLD_ONLY: ${asset} ${marketId.slice(0, 8)}`);
    console.log(`   cpp=${result.cpp?.toFixed(4)} - waiting for expiry`);
    
    saveBotEvent({
      event_type: 'HEDGE_BLOCKED_HOLD_ONLY',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      reason_code: 'HOLD_ONLY',
      data: {
        cpp: result.cpp,
      },
    }).catch(() => {});
  }
  
  return {
    allowed: false,
    state: result.state,
    reason: `HEDGE_BLOCKED: HOLD_ONLY (cpp=${result.cpp?.toFixed(4)})`,
  };
}

// ============================================================
// PRIORITY 4: ENTRY & HEDGE SIZING
// ============================================================

/**
 * Calculate initial entry size (5-10 shares).
 */
export function getInitialEntrySize(cfg?: typeof CPP_QUALITY_CONFIG): number {
  const { min, max } = (cfg ?? CPP_QUALITY_CONFIG).initialEntryShares;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Calculate hedge chunk size (1-5 shares).
 */
export function getHedgeChunkSize(cfg?: typeof CPP_QUALITY_CONFIG): number {
  const { min, max } = (cfg ?? CPP_QUALITY_CONFIG).hedgeChunkShares;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Check if adding to position is allowed based on current CPP.
 * Adds only allowed if cpp < 0.98 AND projected CPP still <= 0.98.
 */
export function isAddAllowed(params: {
  marketId: string;
  asset: string;
  addSide: 'UP' | 'DOWN';
  addPrice: number;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  oppositeSideAsk: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): { allowed: boolean; reason: string } {
  const cfg = params.cfg ?? CPP_QUALITY_CONFIG;
  
  // First check activity state
  const activityResult = getCppActivityState({
    marketId: params.marketId,
    asset: params.asset,
    upShares: params.upShares,
    downShares: params.downShares,
    upCost: params.upCost,
    downCost: params.downCost,
    cfg,
  });
  
  if (activityResult.cpp !== null && activityResult.cpp >= cfg.maxCppForAdds) {
    return {
      allowed: false,
      reason: `ADD_BLOCKED: cpp=${activityResult.cpp.toFixed(4)} >= ${cfg.maxCppForAdds}`,
    };
  }
  
  // Check if add would push projected CPP too high
  const currentShares = params.addSide === 'UP' ? params.upShares : params.downShares;
  const currentCost = params.addSide === 'UP' ? params.upCost : params.downCost;
  
  if (currentShares > 0) {
    // Estimate new avg price after add
    const newShares = currentShares + 5; // Assume 5 share add
    const newCost = currentCost + (5 * params.addPrice);
    const newAvg = newCost / newShares;
    const projectedCpp = newAvg + params.oppositeSideAsk;
    
    if (projectedCpp > cfg.maxProjectedCpp) {
      return {
        allowed: false,
        reason: `ADD_BLOCKED: projectedCpp=${projectedCpp.toFixed(4)} > ${cfg.maxProjectedCpp}`,
      };
    }
  }
  
  return { allowed: true, reason: 'ADD_ALLOWED' };
}

// ============================================================
// PRIORITY 5: OBSERVABILITY METRICS
// ============================================================

/**
 * Get CPP metrics for a market.
 */
export function getCppMetrics(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
}): CppMetrics {
  const { marketId, asset, upShares, downShares, upCost, downCost } = params;
  const key = `${marketId}:${asset}`;
  const state = marketCppStates.get(key);
  
  let actualCpp: number | null = null;
  if (upShares > 0 && downShares > 0) {
    actualCpp = (upCost / upShares) + (downCost / downShares);
  }
  
  const cppDrift = (state?.projectedCppAtEntry !== null && actualCpp !== null)
    ? actualCpp - state.projectedCppAtEntry
    : null;
  
  const timeToFirstPairMs = (state?.entryTs !== null && state?.firstPairTs !== null)
    ? state.firstPairTs - state.entryTs
    : null;
  
  return {
    projectedCpp: state?.projectedCppAtEntry ?? null,
    actualCpp,
    cppDrift,
    timeToFirstPairMs,
    maxLegPriceSeen: Math.max(state?.maxUpPriceSeen ?? 0, state?.maxDownPriceSeen ?? 0),
    activityState: state?.lastActivityState ?? 'NORMAL',
    skippedReason: null,
  };
}

/**
 * Update max leg price seen (for observability).
 */
export function updateMaxLegPrice(params: {
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  price: number;
}): void {
  const key = `${params.marketId}:${params.asset}`;
  let state = marketCppStates.get(key);
  
  if (!state) {
    state = {
      projectedCppAtEntry: null,
      entryTs: null,
      firstPairTs: null,
      maxUpPriceSeen: 0,
      maxDownPriceSeen: 0,
      lastActivityState: 'NORMAL',
    };
    marketCppStates.set(key, state);
  }
  
  if (params.side === 'UP') {
    state.maxUpPriceSeen = Math.max(state.maxUpPriceSeen, params.price);
  } else {
    state.maxDownPriceSeen = Math.max(state.maxDownPriceSeen, params.price);
  }
}

/**
 * Clear CPP state for a market (on expiry/reset).
 */
export function clearCppState(marketId: string, asset: string): void {
  const key = `${marketId}:${asset}`;
  marketCppStates.delete(key);
}

/**
 * Log CPP metrics snapshot to backend.
 */
export async function logCppMetricsSnapshot(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
}): Promise<void> {
  const metrics = getCppMetrics(params);
  
  await saveBotEvent({
    event_type: 'CPP_METRICS_SNAPSHOT',
    asset: params.asset,
    market_id: params.marketId,
    ts: Date.now(),
    run_id: params.runId,
    data: metrics,
  }).catch(() => {});
}

// ============================================================
// EXPORT ALL FOR INTEGRATION
// ============================================================

export const CppQuality = {
  // Config
  config: CPP_QUALITY_CONFIG,
  
  // Priority 1: Feasibility
  checkFeasibility: checkCppFeasibility,
  
  // Priority 2: Combination guard
  checkCombination: checkCombinationGuard,
  
  // Priority 3: Activity state
  getActivityState: getCppActivityState,
  isEntryAllowed: isEntryAllowedByActivityState,
  isHedgeAllowed: isHedgeAllowedByActivityState,
  
  // Priority 4: Sizing
  getInitialEntrySize,
  getHedgeChunkSize,
  isAddAllowed,
  
  // Priority 5: Observability
  getMetrics: getCppMetrics,
  updateMaxLegPrice,
  clearState: clearCppState,
  logMetricsSnapshot: logCppMetricsSnapshot,
};
