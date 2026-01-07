/**
 * cpp-quality.ts - Rev D.2 SENIOR STRATEGY DIRECTIVE — CPP-FIRST INVARIANTS
 * ==========================================================================
 * 
 * CORE PRINCIPLE: Eliminate structural loss ("CPP leakage") by enforcing hard 
 * economic invariants. The bot must NEVER:
 * - Buy guaranteed-negative-EV pairs (CPP ≥ 0.99)
 * - "Fix" skew by worsening CPP
 * - Take actions based on unreliable inventory state
 * - Trade just to appear active
 * 
 * The strategy must converge toward:
 * - Gabagool22-style patience
 * - Maker-first accumulation
 * - Hedge quality over hedge speed
 * - CPP < 0.99 as the PRIMARY success metric
 * 
 * NON-NEGOTIABLE INVARIANTS:
 * 1. CPP DOMINANCE: If projected CPP ≥ 0.99 → DO NOTHING
 * 2. NO EXPENSIVE MINORITY BUYS: Never buy expensive side to reduce skew
 * 3. STATE TRUST GATE: Freeze market if inventory state is untrusted
 * 
 * This is a STRATEGIC correction, not a tuning exercise.
 * 
 * PRIORITIES:
 * 1. Pre-entry CPP feasibility (maker-based)
 * 2. Combination-based price guards
 * 3. CPP activity state machine
 * 4. Hedge & accumulate logic (minority side only)
 * 5. Entry sizing
 * 6. Observability metrics
 * 
 * NON-GOALS:
 * - No SELL for skew correction (default = HOLD)
 * - No forced pairing via taker orders
 * - No trading just to appear active
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION - Rev D.1
// ============================================================

export const CPP_QUALITY_CONFIG = {
  // ==========================================================================
  // REV D.2 SENIOR STRATEGY DIRECTIVE — CPP-FIRST INVARIANTS
  // ==========================================================================
  // CORE PRINCIPLE: If projected CPP ≥ 0.99, DO NOTHING. No exceptions.
  // Holding imperfect skew is ALWAYS preferable to locking in negative EV.
  // ==========================================================================
  
  // INVARIANT 1 — CPP DOMINANCE (HARD GATE)
  // If projected CPP (gross, incl. worst-case fees) ≥ 0.99 → DO NOTHING
  entryCppMax: 0.99,             // projectedCPP_maker must be < this (was 0.98)
  
  // PRIORITY 2: Combination-based price guard
  maxCombinedCppSoft: 0.97,      // soft limit - allow only micro sizing (tightened)
  maxCombinedCppHard: 0.99,      // hard limit - block completely (was 1.00)
  
  // PRIORITY 3: CPP activity state thresholds
  cppNormalMax: 0.99,            // cpp < 0.99 = NORMAL (was 1.00)
  cppHedgeOnlyMax: 1.01,         // 0.99 <= cpp < 1.01 = HEDGE_ONLY (was 1.02)
                                 // cpp >= 1.01 = HOLD_ONLY (no trading, wait expiry)
  
  // PRIORITY 4: Hedge & accumulate (Gabagool-style patience)
  hedgeChunkShares: { min: 3, max: 5 },      // Maker-first hedge chunks
  hedgeRestTimeMs: { min: 30000, max: 60000 }, // Orders may rest 30-60 seconds
  
  // PRIORITY 5: Entry sizing (micro-accumulation)
  initialEntryShares: { min: 5, max: 10 },
  maxCppForAdds: 0.97,           // Only allow adds if cpp < this (tightened from 0.98)
  
  // Maker price estimation (spread offset from mid)
  makerSpreadOffset: 0.01,       // Assume maker can get 1¢ better than ask
  
  // INVARIANT 2 — NO EXPENSIVE MINORITY BUYS
  // Bot must NEVER buy the more expensive side solely to reduce skew
  blockExpensiveMinorityBuys: true,
  expensiveSideThreshold: 0.55,  // If minority side ask > 55¢, block buying it
  
  // INVARIANT 3 — STATE TRUST GATE (placeholder for inventory sync checks)
  requireTrustedState: true,
  
  // Logging
  logThrottleMs: 5000,
};

// ============================================================
// TYPES
// ============================================================

export type CppActivityState = 'NORMAL' | 'HEDGE_ONLY' | 'HOLD_ONLY';

export type Side = 'UP' | 'DOWN';

export interface SideAnalysis {
  dominantSide: Side;
  minoritySide: Side;
  dominantShares: number;
  minorityShares: number;
  skew: number;  // dominantShares - minorityShares
}

export interface CppFeasibilityResult {
  allowed: boolean;
  projectedCppMaker: number;
  projectedCppTaker: number;  // For logging only
  entryPrice: number;
  projectedMakerHedgePrice: number;
  bestAskHedgePrice: number;
  reason: string;
}

export interface CombinationGuardResult {
  allowed: boolean;
  combinedPrice: number;
  microSizingOnly: boolean;  // True if in soft-to-hard zone
  reason: string;
}

export interface CppActivityStateResult {
  state: CppActivityState;
  cpp: number | null;
  reason: string;
}

export interface AccumulateResult {
  allowed: boolean;
  reason: string;
  newCpp: number | null;
  currentCpp: number | null;
}

export interface CppMetrics {
  // Projected CPP at entry
  projectedCppMaker: number | null;
  projectedCppTaker: number | null;
  
  // Actual paired CPP
  actualCpp: number | null;
  
  // Drift tracking
  cppDrift: number | null;           // actual - projectedMaker
  
  // Timing
  timeToFirstPairMs: number | null;
  
  // Side analysis
  dominantSide: Side | null;
  minoritySide: Side | null;
  
  // State
  activityState: CppActivityState;
  
  // Price tracking
  maxUpPriceSeen: number;
  maxDownPriceSeen: number;
  
  // Observational only
  pairingRate: number | null;        // pairedShares / totalShares
  skippedReason: string | null;
}

// Per-market CPP tracking state
interface MarketCppState {
  projectedCppMakerAtEntry: number | null;
  projectedCppTakerAtEntry: number | null;
  entryTs: number | null;
  firstPairTs: number | null;
  maxUpPriceSeen: number;
  maxDownPriceSeen: number;
  lastActivityState: CppActivityState;
  totalEntries: number;
  totalPairs: number;
}

const marketCppStates = new Map<string, MarketCppState>();

// Throttle logging
const logThrottles = new Map<string, number>();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Analyze dominant vs minority side.
 */
export function analyzeSides(upShares: number, downShares: number): SideAnalysis {
  if (upShares >= downShares) {
    return {
      dominantSide: 'UP',
      minoritySide: 'DOWN',
      dominantShares: upShares,
      minorityShares: downShares,
      skew: upShares - downShares,
    };
  }
  return {
    dominantSide: 'DOWN',
    minoritySide: 'UP',
    dominantShares: downShares,
    minorityShares: upShares,
    skew: downShares - upShares,
  };
}

/**
 * Estimate maker price from ask (assume 1¢ improvement).
 */
export function estimateMakerPrice(
  bestAsk: number,
  cfg: typeof CPP_QUALITY_CONFIG = CPP_QUALITY_CONFIG
): number {
  return Math.max(0.01, bestAsk - cfg.makerSpreadOffset);
}

/**
 * Calculate paired-only CPP.
 */
export function calculateCpp(
  upShares: number,
  downShares: number,
  upCost: number,
  downCost: number
): number | null {
  if (upShares <= 0 || downShares <= 0) return null;
  const avgUp = upCost / upShares;
  const avgDown = downCost / downShares;
  return avgUp + avgDown;
}

function getOrCreateState(key: string): MarketCppState {
  let state = marketCppStates.get(key);
  if (!state) {
    state = {
      projectedCppMakerAtEntry: null,
      projectedCppTakerAtEntry: null,
      entryTs: null,
      firstPairTs: null,
      maxUpPriceSeen: 0,
      maxDownPriceSeen: 0,
      lastActivityState: 'NORMAL',
      totalEntries: 0,
      totalPairs: 0,
    };
    marketCppStates.set(key, state);
  }
  return state;
}

// ============================================================
// PRIORITY 1: PRE-ENTRY CPP FEASIBILITY (MAKER-BASED)
// ============================================================

/**
 * Check if entry is allowed based on projected CPP using MAKER assumption.
 * 
 * projectedCPP_maker = entryPrice + projectedMakerHedgePrice
 * projectedCPP_taker = entryPrice + bestAskHedgePrice (for logging only)
 * 
 * Entry allowed only if projectedCPP_maker <= ENTRY_CPP_MAX (0.98)
 */
export function checkCppFeasibility(params: {
  marketId: string;
  asset: string;
  entrySide: Side;
  entryPrice: number;
  upAsk: number;
  downAsk: number;
  upBid?: number;
  downBid?: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): CppFeasibilityResult {
  const { marketId, asset, entrySide, entryPrice, upAsk, downAsk, runId, cfg = CPP_QUALITY_CONFIG } = params;
  
  // Opposite side prices
  const bestAskHedge = entrySide === 'UP' ? downAsk : upAsk;
  const projectedMakerHedge = estimateMakerPrice(bestAskHedge, cfg);
  
  // Both projections
  const projectedCppMaker = entryPrice + projectedMakerHedge;
  const projectedCppTaker = entryPrice + bestAskHedge;
  
  const key = `${marketId}:${asset}`;
  const now = Date.now();
  
  if (projectedCppMaker > cfg.entryCppMax) {
    // Log (throttled)
    const lastLog = logThrottles.get(`feasibility_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`feasibility_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] PROJECTED_CPP_TOO_HIGH: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   projectedCPP_maker=${projectedCppMaker.toFixed(4)} > max=${cfg.entryCppMax}`);
      console.log(`   projectedCPP_taker=${projectedCppTaker.toFixed(4)} (for reference)`);
      console.log(`   entryPrice=${entryPrice.toFixed(4)}, makerHedge=${projectedMakerHedge.toFixed(4)}, takerHedge=${bestAskHedge.toFixed(4)}`);
      
      // V73 Event: Entry skip due to projected CPP too high
      saveBotEvent({
        event_type: 'V73_ENTRY_SKIP',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'PROJECTED_CPP_TOO_HIGH',
        data: {
          entrySide,
          entryPrice,
          projected_cpp_maker: projectedCppMaker,
          projected_cpp_taker: projectedCppTaker,
          projected_maker_hedge: projectedMakerHedge,
          best_ask_hedge: bestAskHedge,
          entry_cpp_max: cfg.entryCppMax,
          skip_reason: 'CPP_FEASIBILITY_BLOCKED',
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      projectedCppMaker,
      projectedCppTaker,
      entryPrice,
      projectedMakerHedgePrice: projectedMakerHedge,
      bestAskHedgePrice: bestAskHedge,
      reason: `PROJECTED_CPP_TOO_HIGH: maker=${projectedCppMaker.toFixed(4)} > ${cfg.entryCppMax}`,
    };
  }
  
  // Store projected CPP for drift tracking
  const state = getOrCreateState(key);
  
  // Only set projected if this is first entry
  if (state.projectedCppMakerAtEntry === null) {
    state.projectedCppMakerAtEntry = projectedCppMaker;
    state.projectedCppTakerAtEntry = projectedCppTaker;
    state.entryTs = now;
  }
  state.totalEntries++;
  
  return {
    allowed: true,
    projectedCppMaker,
    projectedCppTaker,
    entryPrice,
    projectedMakerHedgePrice: projectedMakerHedge,
    bestAskHedgePrice: bestAskHedge,
    reason: `CPP_FEASIBLE: maker=${projectedCppMaker.toFixed(4)} <= ${cfg.entryCppMax}`,
  };
}

// ============================================================
// PRIORITY 2: COMBINATION-BASED PRICE GUARDS
// ============================================================

/**
 * Check if order is allowed based on combination price.
 * 
 * Entry or hedge is valid ONLY if:
 *   entryAvgPrice + hedgePrice <= MAX_COMBINED_CPP
 * 
 * Two thresholds:
 * - Soft (0.98): allow only micro sizing
 * - Hard (1.00): block completely
 */
export function checkCombinationGuard(params: {
  marketId: string;
  asset: string;
  side: Side;
  currentAvgPrice: number;    // Avg price of the side we're adding to
  hedgePrice: number;         // Price of the hedge (maker-estimated or actual)
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): CombinationGuardResult {
  const { marketId, asset, side, currentAvgPrice, hedgePrice, runId, cfg = CPP_QUALITY_CONFIG } = params;
  
  const combinedPrice = currentAvgPrice + hedgePrice;
  
  // Hard block
  if (combinedPrice > cfg.maxCombinedCppHard) {
    const key = `${marketId}:${asset}`;
    const now = Date.now();
    
    const lastLog = logThrottles.get(`combination_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`combination_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] COMBINATION_GUARD_HARD_BLOCK: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   combinedPrice=${combinedPrice.toFixed(4)} > hardMax=${cfg.maxCombinedCppHard}`);
      
      saveBotEvent({
        event_type: 'COMBINATION_GUARD_BLOCKED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'COMBINATION_HARD_BLOCK',
        data: {
          side,
          currentAvgPrice,
          hedgePrice,
          combinedPrice,
          maxCombinedCppHard: cfg.maxCombinedCppHard,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      combinedPrice,
      microSizingOnly: false,
      reason: `COMBINATION_HARD_BLOCK: ${combinedPrice.toFixed(4)} > ${cfg.maxCombinedCppHard}`,
    };
  }
  
  // Soft zone - micro sizing only
  if (combinedPrice > cfg.maxCombinedCppSoft) {
    return {
      allowed: true,
      combinedPrice,
      microSizingOnly: true,
      reason: `COMBINATION_MICRO_ONLY: ${cfg.maxCombinedCppSoft} < ${combinedPrice.toFixed(4)} <= ${cfg.maxCombinedCppHard}`,
    };
  }
  
  return {
    allowed: true,
    combinedPrice,
    microSizingOnly: false,
    reason: `COMBINATION_OK: ${combinedPrice.toFixed(4)} <= ${cfg.maxCombinedCppSoft}`,
  };
}

// ============================================================
// PRIORITY 3: CPP ACTIVITY STATE MACHINE
// ============================================================

/**
 * Determine CPP activity state based on current paired-only CPP.
 * 
 * States:
 * - NORMAL (cpp < 1.00): entries, hedges, accumulate allowed
 * - HEDGE_ONLY (1.00 <= cpp < 1.02): no entries, only maker hedges on minority
 * - HOLD_ONLY (cpp >= 1.02): freeze market, wait for expiry
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
  const state = getOrCreateState(key);
  
  // Cannot calculate CPP if not paired
  const cpp = calculateCpp(upShares, downShares, upCost, downCost);
  if (cpp === null) {
    return {
      state: 'NORMAL',  // Default to NORMAL when not paired
      cpp: null,
      reason: 'CPP_UNAVAILABLE: not paired',
    };
  }
  
  // Record first pair time
  if (state.firstPairTs === null) {
    state.firstPairTs = Date.now();
    state.totalPairs++;
  }
  
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
  
  // V73 Event: Log state changes
  const previousState = state.lastActivityState;
  if (previousState !== activityState) {
    const now = Date.now();
    console.log(`📊 [CPP_QUALITY] CPP_STATE_CHANGE: ${asset} ${marketId.slice(0, 8)} ${previousState} → ${activityState}`);
    
    saveBotEvent({
      event_type: 'CPP_STATE_CHANGE',
      asset,
      market_id: marketId,
      ts: now,
      data: {
        previous_state: previousState,
        new_state: activityState,
        cpp,
        up_shares: upShares,
        down_shares: downShares,
        cpp_normal_max: cfg.cppNormalMax,
        cpp_hedge_only_max: cfg.cppHedgeOnlyMax,
      },
    }).catch(() => {});
  }
  
  state.lastActivityState = activityState;
  
  return { state: activityState, cpp, reason };
}

/**
 * Check if entry is allowed based on CPP activity state.
 * Entries only allowed in NORMAL state.
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
 * Hedges allowed in NORMAL and HEDGE_ONLY (on minority side only).
 */
export function isHedgeAllowedByActivityState(params: {
  marketId: string;
  asset: string;
  hedgeSide: Side;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): { allowed: boolean; state: CppActivityState; reason: string } {
  const { runId, hedgeSide, ...stateParams } = params;
  const result = getCppActivityState(stateParams);
  
  const sideAnalysis = analyzeSides(params.upShares, params.downShares);
  const { marketId, asset } = params;
  const now = Date.now();
  
  // NORMAL: all hedges allowed
  if (result.state === 'NORMAL') {
    // V73 Event: Log hedge decision
    saveBotEvent({
      event_type: 'V73_HEDGE_DECISION',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        decision: 'ALLOWED',
        activity_state: result.state,
        cpp: result.cpp,
        hedge_side: hedgeSide,
        dominant_side: sideAnalysis.dominantSide,
        minority_side: sideAnalysis.minoritySide,
      },
    }).catch(() => {});
    
    return { allowed: true, state: result.state, reason: result.reason };
  }
  
  // HEDGE_ONLY: only minority side allowed
  if (result.state === 'HEDGE_ONLY') {
    if (hedgeSide === sideAnalysis.minoritySide) {
      // V73 Event: Log hedge decision (allowed on minority)
      saveBotEvent({
        event_type: 'V73_HEDGE_DECISION',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        data: {
          decision: 'ALLOWED_MINORITY',
          activity_state: result.state,
          cpp: result.cpp,
          hedge_side: hedgeSide,
          dominant_side: sideAnalysis.dominantSide,
          minority_side: sideAnalysis.minoritySide,
        },
      }).catch(() => {});
      
      return { allowed: true, state: result.state, reason: `HEDGE_ALLOWED: minority side in HEDGE_ONLY` };
    }
    
    // Dominant side not allowed in HEDGE_ONLY - log blocked
    saveBotEvent({
      event_type: 'V73_HEDGE_DECISION',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        decision: 'BLOCKED_DOMINANT_IN_HEDGE_ONLY',
        activity_state: result.state,
        cpp: result.cpp,
        hedge_side: hedgeSide,
        dominant_side: sideAnalysis.dominantSide,
        minority_side: sideAnalysis.minoritySide,
      },
    }).catch(() => {});
    
    return {
      allowed: false,
      state: result.state,
      reason: `HEDGE_BLOCKED: dominant side not allowed in HEDGE_ONLY`,
    };
  }
  
  // HOLD_ONLY: nothing allowed
  const key = `${marketId}:${asset}`;
  
  const lastLog = logThrottles.get(`hedge_hold_${key}`) ?? 0;
  if (now - lastLog > (params.cfg ?? CPP_QUALITY_CONFIG).logThrottleMs) {
    logThrottles.set(`hedge_hold_${key}`, now);
    console.log(`🚫 [CPP_QUALITY] HEDGE_BLOCKED_HOLD_ONLY: ${asset} ${marketId.slice(0, 8)}`);
    console.log(`   cpp=${result.cpp?.toFixed(4)} - waiting for expiry`);
    
    // V73 Event: Log hedge decision (blocked in HOLD_ONLY)
    saveBotEvent({
      event_type: 'V73_HEDGE_DECISION',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        decision: 'BLOCKED_HOLD_ONLY',
        activity_state: result.state,
        cpp: result.cpp,
        hedge_side: hedgeSide,
        dominant_side: sideAnalysis.dominantSide,
        minority_side: sideAnalysis.minoritySide,
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
// PRIORITY 4: HEDGE & ACCUMULATE LOGIC
// ============================================================

/**
 * Get the minority side for hedging.
 * Hedges should ALWAYS target the minority side.
 */
export function getHedgeTarget(upShares: number, downShares: number): Side {
  const analysis = analyzeSides(upShares, downShares);
  return analysis.minoritySide;
}

/**
 * Calculate hedge chunk size (3-5 shares).
 */
export function getHedgeChunkSize(cfg: typeof CPP_QUALITY_CONFIG = CPP_QUALITY_CONFIG): number {
  const { min, max } = cfg.hedgeChunkShares;
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Check if accumulate is allowed.
 * 
 * Accumulate rules:
 * - Only allowed if newCPP < currentCPP
 * - Always on minority side
 * - Never on dominant side
 * - Never based on "cheapest side" logic
 */
export function isAccumulateAllowed(params: {
  marketId: string;
  asset: string;
  accumulateSide: Side;
  accumulatePrice: number;
  accumulateShares: number;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): AccumulateResult {
  const { 
    marketId, asset, accumulateSide, accumulatePrice, accumulateShares,
    upShares, downShares, upCost, downCost, runId, cfg = CPP_QUALITY_CONFIG 
  } = params;
  
  const key = `${marketId}:${asset}`;
  const now = Date.now();
  
  // Check side - must be minority side
  const sideAnalysis = analyzeSides(upShares, downShares);
  if (accumulateSide === sideAnalysis.dominantSide) {
    const lastLog = logThrottles.get(`acc_dom_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`acc_dom_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] ACCUMULATE_BLOCKED_DOMINANT: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   Cannot accumulate on dominant side (${accumulateSide})`);
      
      // V73 Event: Accumulate blocked - dominant side
      saveBotEvent({
        event_type: 'V73_ACCUM_DECISION',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        data: {
          decision: 'BLOCKED_DOMINANT_SIDE',
          accumulate_side: accumulateSide,
          dominant_side: sideAnalysis.dominantSide,
          minority_side: sideAnalysis.minoritySide,
          current_cpp: null,
          new_cpp: null,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      reason: `ACCUMULATE_BLOCKED: cannot accumulate on dominant side (${accumulateSide})`,
      newCpp: null,
      currentCpp: null,
    };
  }
  
  // Calculate current CPP
  const currentCpp = calculateCpp(upShares, downShares, upCost, downCost);
  if (currentCpp === null) {
    // Not paired yet - allow initial accumulate
    // V73 Event: Accumulate allowed - not paired yet
    saveBotEvent({
      event_type: 'V73_ACCUM_DECISION',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        decision: 'ALLOWED_NOT_PAIRED',
        accumulate_side: accumulateSide,
        dominant_side: sideAnalysis.dominantSide,
        minority_side: sideAnalysis.minoritySide,
        current_cpp: null,
        new_cpp: null,
      },
    }).catch(() => {});
    
    return {
      allowed: true,
      reason: 'ACCUMULATE_ALLOWED: not yet paired',
      newCpp: null,
      currentCpp: null,
    };
  }
  
  // Calculate new CPP after accumulate
  const newUpShares = accumulateSide === 'UP' ? upShares + accumulateShares : upShares;
  const newDownShares = accumulateSide === 'DOWN' ? downShares + accumulateShares : downShares;
  const newUpCost = accumulateSide === 'UP' ? upCost + (accumulateShares * accumulatePrice) : upCost;
  const newDownCost = accumulateSide === 'DOWN' ? downCost + (accumulateShares * accumulatePrice) : downCost;
  
  const newCpp = calculateCpp(newUpShares, newDownShares, newUpCost, newDownCost);
  
  if (newCpp === null || newCpp >= currentCpp) {
    const lastLog = logThrottles.get(`acc_cpp_${key}`) ?? 0;
    if (now - lastLog > cfg.logThrottleMs) {
      logThrottles.set(`acc_cpp_${key}`, now);
      console.log(`🚫 [CPP_QUALITY] ACCUMULATE_BLOCKED_CPP: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   newCpp=${newCpp?.toFixed(4)} >= currentCpp=${currentCpp.toFixed(4)}`);
      
      // V73 Event: Accumulate blocked - CPP worse
      saveBotEvent({
        event_type: 'V73_ACCUM_DECISION',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        data: {
          decision: 'BLOCKED_CPP_WORSE',
          accumulate_side: accumulateSide,
          accumulate_price: accumulatePrice,
          accumulate_shares: accumulateShares,
          current_cpp: currentCpp,
          new_cpp: newCpp,
          dominant_side: sideAnalysis.dominantSide,
          minority_side: sideAnalysis.minoritySide,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      reason: `ACCUMULATE_BLOCKED: newCpp=${newCpp?.toFixed(4)} >= currentCpp=${currentCpp.toFixed(4)}`,
      newCpp,
      currentCpp,
    };
  }
  
  // V73 Event: Accumulate allowed - CPP improved
  saveBotEvent({
    event_type: 'V73_ACCUM_DECISION',
    asset,
    market_id: marketId,
    ts: now,
    run_id: runId,
    data: {
      decision: 'ALLOWED_CPP_IMPROVED',
      accumulate_side: accumulateSide,
      accumulate_price: accumulatePrice,
      accumulate_shares: accumulateShares,
      current_cpp: currentCpp,
      new_cpp: newCpp,
      cpp_improvement: currentCpp - newCpp,
      dominant_side: sideAnalysis.dominantSide,
      minority_side: sideAnalysis.minoritySide,
    },
  }).catch(() => {});
  
  return {
    allowed: true,
    reason: `ACCUMULATE_ALLOWED: newCpp=${newCpp.toFixed(4)} < currentCpp=${currentCpp.toFixed(4)}`,
    newCpp,
    currentCpp,
  };
}

// ============================================================
// REV D.2: INVARIANT 2 — NO EXPENSIVE MINORITY BUYS
// ============================================================

/**
 * INVARIANT 2: The bot must NEVER buy the more expensive side solely to reduce skew.
 * 
 * Example: UP = 0.15, DOWN = 0.85
 * → Buying DOWN is forbidden, even if skewed toward UP.
 * 
 * Skew may persist. Loss must not be locked in.
 */
export function isExpensiveMinorityBuyBlocked(params: {
  marketId: string;
  asset: string;
  buySide: Side;
  buyPrice: number;
  upAsk: number;
  downAsk: number;
  upShares: number;
  downShares: number;
  runId?: string;
  cfg?: typeof CPP_QUALITY_CONFIG;
}): { blocked: boolean; reason: string } {
  const { 
    marketId, asset, buySide, buyPrice, upAsk, downAsk, 
    upShares, downShares, runId, cfg = CPP_QUALITY_CONFIG 
  } = params;
  
  // Only check if this config is enabled
  if (!cfg.blockExpensiveMinorityBuys) {
    return { blocked: false, reason: 'EXPENSIVE_MINORITY_CHECK_DISABLED' };
  }
  
  const sideAnalysis = analyzeSides(upShares, downShares);
  
  // If buying minority side AND it's expensive → BLOCK
  if (buySide === sideAnalysis.minoritySide) {
    const minorityAsk = buySide === 'UP' ? upAsk : downAsk;
    
    if (minorityAsk > cfg.expensiveSideThreshold) {
      const now = Date.now();
      console.log(`🚫 [CPP_QUALITY] EXPENSIVE_MINORITY_BUY_BLOCKED: ${asset} ${marketId.slice(0, 8)}`);
      console.log(`   Cannot buy ${buySide} at ${minorityAsk.toFixed(4)} > threshold ${cfg.expensiveSideThreshold}`);
      console.log(`   This would worsen CPP. Skew must persist.`);
      
      saveBotEvent({
        event_type: 'EXPENSIVE_MINORITY_BUY_BLOCKED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'INVARIANT_2_VIOLATION',
        data: {
          buy_side: buySide,
          minority_side: sideAnalysis.minoritySide,
          minority_ask: minorityAsk,
          threshold: cfg.expensiveSideThreshold,
          up_shares: upShares,
          down_shares: downShares,
        },
      }).catch(() => {});
      
      return {
        blocked: true,
        reason: `EXPENSIVE_MINORITY_BLOCKED: ${buySide} ask=${minorityAsk.toFixed(4)} > ${cfg.expensiveSideThreshold}`,
      };
    }
  }
  
  return { blocked: false, reason: 'MINORITY_BUY_OK' };
}

/**
 * Check if adding to position is allowed (for initial sizing adds).
 * Only if cpp < maxCppForAdds AND projected CPP still <= entryCppMax.
 */
export function isAddAllowed(params: {
  marketId: string;
  asset: string;
  addSide: Side;
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
  
  // Block if not in NORMAL or if CPP too high
  if (activityResult.state !== 'NORMAL') {
    return {
      allowed: false,
      reason: `ADD_BLOCKED: state=${activityResult.state}`,
    };
  }
  
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
    // Estimate new avg price after add (use hedge chunk size)
    const addShares = getHedgeChunkSize(cfg);
    const newShares = currentShares + addShares;
    const newCost = currentCost + (addShares * params.addPrice);
    const newAvg = newCost / newShares;
    
    // Use maker-estimated hedge price
    const makerHedgePrice = estimateMakerPrice(params.oppositeSideAsk, cfg);
    const projectedCpp = newAvg + makerHedgePrice;
    
    if (projectedCpp > cfg.entryCppMax) {
      return {
        allowed: false,
        reason: `ADD_BLOCKED: projectedCpp=${projectedCpp.toFixed(4)} > ${cfg.entryCppMax}`,
      };
    }
  }
  
  return { allowed: true, reason: 'ADD_ALLOWED' };
}

// ============================================================
// PRIORITY 5: ENTRY SIZING
// ============================================================

/**
 * Calculate initial entry size (5-10 shares).
 */
export function getInitialEntrySize(cfg: typeof CPP_QUALITY_CONFIG = CPP_QUALITY_CONFIG): number {
  const { min, max } = cfg.initialEntryShares;
  return Math.floor(min + Math.random() * (max - min + 1));
}

// ============================================================
// PRIORITY 6: OBSERVABILITY METRICS
// ============================================================

/**
 * Get comprehensive CPP metrics for a market.
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
  
  const actualCpp = calculateCpp(upShares, downShares, upCost, downCost);
  
  const cppDrift = (state?.projectedCppMakerAtEntry !== null && actualCpp !== null)
    ? actualCpp - state.projectedCppMakerAtEntry
    : null;
  
  const timeToFirstPairMs = (state?.entryTs !== null && state?.firstPairTs !== null)
    ? state.firstPairTs - state.entryTs
    : null;
  
  const sideAnalysis = (upShares > 0 || downShares > 0) 
    ? analyzeSides(upShares, downShares)
    : null;
  
  // Pairing rate calculation
  const pairedShares = Math.min(upShares, downShares);
  const totalShares = upShares + downShares;
  const pairingRate = totalShares > 0 ? pairedShares / totalShares : null;
  
  return {
    projectedCppMaker: state?.projectedCppMakerAtEntry ?? null,
    projectedCppTaker: state?.projectedCppTakerAtEntry ?? null,
    actualCpp,
    cppDrift,
    timeToFirstPairMs,
    dominantSide: sideAnalysis?.dominantSide ?? null,
    minoritySide: sideAnalysis?.minoritySide ?? null,
    activityState: state?.lastActivityState ?? 'NORMAL',
    maxUpPriceSeen: state?.maxUpPriceSeen ?? 0,
    maxDownPriceSeen: state?.maxDownPriceSeen ?? 0,
    pairingRate,
    skippedReason: null,
  };
}

/**
 * Update max leg price seen (for observability).
 */
export function updateMaxLegPrice(params: {
  marketId: string;
  asset: string;
  side: Side;
  price: number;
}): void {
  const key = `${params.marketId}:${params.asset}`;
  const state = getOrCreateState(key);
  
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
  
  // Helpers
  analyzeSides,
  estimateMakerPrice,
  calculateCpp,
  
  // Priority 1: Feasibility (maker-based)
  checkFeasibility: checkCppFeasibility,
  
  // Priority 2: Combination guard
  checkCombination: checkCombinationGuard,
  
  // Priority 3: Activity state
  getActivityState: getCppActivityState,
  isEntryAllowed: isEntryAllowedByActivityState,
  isHedgeAllowed: isHedgeAllowedByActivityState,
  
  // REV D.2: Invariant 2 - No expensive minority buys
  isExpensiveMinorityBuyBlocked,
  
  // Priority 4: Hedge & accumulate
  getHedgeTarget,
  getHedgeChunkSize,
  isAccumulateAllowed,
  isAddAllowed,
  
  // Priority 5: Entry sizing
  getInitialEntrySize,
  
  // Priority 6: Observability
  getMetrics: getCppMetrics,
  updateMaxLegPrice,
  clearState: clearCppState,
  logMetricsSnapshot: logCppMetricsSnapshot,
};
