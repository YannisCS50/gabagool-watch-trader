/**
 * hard-invariants.ts - v7.2.4 REV C.4 HARD INVARIANTS
 * ====================================================
 * Implements ABSOLUTE guards that MUST hold for every order:
 * 
 * A) HARD POSITION CAP ENFORCEMENT
 *    - upShares <= maxSharesPerSide (100)
 *    - downShares <= maxSharesPerSide (100)
 *    - total <= maxTotalSharesPerMarket (200)
 * 
 * B) ONE-SIDED FREEZE ADDS
 *    - After first fill creates ONE_SIDED, no more BUY on dominant side
 *    - Only HEDGE or SELL/UNWIND allowed
 * 
 * C) CPP METRICS: PAIRED-ONLY
 *    - cppPairedOnlyCents = avgUpPriceCents + avgDownPriceCents
 *    - No CPP-based emergency when paired=0
 * 
 * These invariants are checked IMMEDIATELY BEFORE any order placement.
 * NO CODE PATH MAY BYPASS THESE CHECKS.
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const HARD_INVARIANT_CONFIG = {
  maxSharesPerSide: 100,
  maxTotalSharesPerMarket: 200,
  
  // One-sided freeze exceptions (OFF by default)
  allowOneSidedAddIfDeepEdge: false,
  microAddMaxShares: 5,
  deepEdgeThreshold: 0.95, // combinedAsk <= 0.95
  
  // Logging throttle
  logThrottleMs: 5000,
};

// ============================================================
// TYPES
// ============================================================

export type OrderSide = 'BUY' | 'SELL';
export type Outcome = 'UP' | 'DOWN';

export interface ClampOrderResult {
  allowedSize: number;
  blocked: boolean;
  blockReason: string | null;
  originalSize: number;
  clamped: boolean;
  clampReason: string | null;
}

export interface OneSidedFreezeResult {
  blocked: boolean;
  reason: string | null;
}

export interface CppPairedOnlyResult {
  cppPairedOnlyCents: number | null;
  avgUpCents: number | null;
  avgDownCents: number | null;
  isValid: boolean;
  reason: string;
}

export interface InvariantCheckResult {
  allowed: boolean;
  finalSize: number;
  blockReason: string | null;
  clampApplied: boolean;
  freezeApplied: boolean;
  cppValid: boolean;
}

// ============================================================
// A) HARD POSITION CAP ENFORCEMENT
// ============================================================

/**
 * clampOrderToCaps - MUST be called immediately before ANY order placement
 * 
 * Rules:
 * 1) For BUY orders:
 *    - remaining = maxSharesPerSide - currentShares (for that outcome)
 *    - remainingTotal = maxTotalSharesPerMarket - (upShares + downShares)
 *    - allowedSize = max(0, min(requestedSize, remaining, remainingTotal))
 * 
 * 2) For SELL orders:
 *    - allowedSize = min(requestedSize, currentSharesOnThatOutcome) // never short
 * 
 * 3) If allowedSize == 0: DO NOT place order, log CAP_BLOCKED
 */
export function clampOrderToCaps(params: {
  marketId: string;
  asset: string;
  side: OrderSide;
  outcome: Outcome;
  requestedSize: number;
  currentUpShares: number;
  currentDownShares: number;
  cfg?: {
    maxSharesPerSide: number;
    maxTotalSharesPerMarket: number;
  };
}): ClampOrderResult {
  const {
    marketId,
    asset,
    side,
    outcome,
    requestedSize,
    currentUpShares,
    currentDownShares,
    cfg = HARD_INVARIANT_CONFIG,
  } = params;
  
  const currentShares = outcome === 'UP' ? currentUpShares : currentDownShares;
  const totalShares = currentUpShares + currentDownShares;
  
  if (side === 'BUY') {
    // Calculate remaining capacity
    const remainingOnSide = cfg.maxSharesPerSide - currentShares;
    const remainingTotal = cfg.maxTotalSharesPerMarket - totalShares;
    
    // Clamp to minimum of all limits
    const allowedSize = Math.max(0, Math.min(requestedSize, remainingOnSide, remainingTotal));
    
    if (allowedSize === 0) {
      return {
        allowedSize: 0,
        blocked: true,
        blockReason: `CAP_BLOCKED: ${outcome} side at ${currentShares}/${cfg.maxSharesPerSide}, total ${totalShares}/${cfg.maxTotalSharesPerMarket}`,
        originalSize: requestedSize,
        clamped: false,
        clampReason: null,
      };
    }
    
    if (allowedSize < requestedSize) {
      const clampReason = remainingOnSide < remainingTotal
        ? `CLAMPED: ${outcome} side limit (${currentShares}+${allowedSize}=${currentShares + allowedSize}/${cfg.maxSharesPerSide})`
        : `CLAMPED: total market limit (${totalShares}+${allowedSize}=${totalShares + allowedSize}/${cfg.maxTotalSharesPerMarket})`;
      
      return {
        allowedSize,
        blocked: false,
        blockReason: null,
        originalSize: requestedSize,
        clamped: true,
        clampReason,
      };
    }
    
    return {
      allowedSize,
      blocked: false,
      blockReason: null,
      originalSize: requestedSize,
      clamped: false,
      clampReason: null,
    };
  }
  
  // SELL order - never short
  if (side === 'SELL') {
    const allowedSize = Math.min(requestedSize, currentShares);
    
    if (allowedSize === 0) {
      return {
        allowedSize: 0,
        blocked: true,
        blockReason: `CAP_BLOCKED: Cannot SELL ${requestedSize} ${outcome}, only have ${currentShares}`,
        originalSize: requestedSize,
        clamped: false,
        clampReason: null,
      };
    }
    
    if (allowedSize < requestedSize) {
      return {
        allowedSize,
        blocked: false,
        blockReason: null,
        originalSize: requestedSize,
        clamped: true,
        clampReason: `CLAMPED: only ${currentShares} ${outcome} shares available to sell`,
      };
    }
    
    return {
      allowedSize,
      blocked: false,
      blockReason: null,
      originalSize: requestedSize,
      clamped: false,
      clampReason: null,
    };
  }
  
  // Unknown side - block
  return {
    allowedSize: 0,
    blocked: true,
    blockReason: `CAP_BLOCKED: Unknown order side ${side}`,
    originalSize: requestedSize,
    clamped: false,
    clampReason: null,
  };
}

// ============================================================
// B) ONE-SIDED FREEZE ADDS
// ============================================================

// Per-market freeze state
const freezeAddsState = new Map<string, {
  frozen: boolean;
  frozenAt: number;
  dominantSide: Outcome;
}>();

/**
 * Activate freezeAdds for a market after first fill creates ONE_SIDED position
 */
export function activateFreezeAdds(
  marketId: string,
  asset: string,
  dominantSide: Outcome,
  runId?: string
): void {
  const key = `${marketId}:${asset}`;
  
  if (freezeAddsState.has(key)) {
    return; // Already frozen
  }
  
  const now = Date.now();
  freezeAddsState.set(key, {
    frozen: true,
    frozenAt: now,
    dominantSide,
  });
  
  console.log(`🧊 [HARD_INVARIANT] ONE_SIDED_FREEZE_ACTIVATED: ${asset} ${marketId}`);
  console.log(`   Dominant side: ${dominantSide} - further BUY on ${dominantSide} BLOCKED`);
  console.log(`   Only HEDGE (${dominantSide === 'UP' ? 'DOWN' : 'UP'}) or SELL allowed`);
  
  saveBotEvent({
    event_type: 'ONE_SIDED_FREEZE_ACTIVATED',
    asset,
    market_id: marketId,
    ts: now,
    run_id: runId,
    data: { dominantSide },
  }).catch(() => {});
}

/**
 * Clear freeze state (e.g., when market expires or position becomes PAIRED)
 */
export function clearFreezeAdds(marketId: string, asset: string): void {
  const key = `${marketId}:${asset}`;
  freezeAddsState.delete(key);
}

/**
 * Check if a BUY order on dominant side should be blocked due to freeze
 */
export function checkOneSidedFreeze(params: {
  marketId: string;
  asset: string;
  side: OrderSide;
  outcome: Outcome;
  intentType: string;
  combinedAsk?: number | null;
  cfg?: typeof HARD_INVARIANT_CONFIG;
}): OneSidedFreezeResult {
  const { marketId, asset, side, outcome, intentType, combinedAsk, cfg = HARD_INVARIANT_CONFIG } = params;
  
  // Only applies to BUY orders
  if (side !== 'BUY') {
    return { blocked: false, reason: null };
  }
  
  // HEDGE intents are always allowed (they're the cure, not the problem)
  if (intentType === 'HEDGE' || intentType === 'hedge') {
    return { blocked: false, reason: null };
  }
  
  const key = `${marketId}:${asset}`;
  const state = freezeAddsState.get(key);
  
  if (!state || !state.frozen) {
    return { blocked: false, reason: null };
  }
  
  // Check if trying to add to dominant side
  if (outcome === state.dominantSide) {
    // Exception: deep edge micro-add (if enabled)
    if (cfg.allowOneSidedAddIfDeepEdge && combinedAsk !== null && combinedAsk !== undefined) {
      if (combinedAsk <= cfg.deepEdgeThreshold) {
        return { blocked: false, reason: 'EXCEPTION: deep edge micro-add allowed' };
      }
    }
    
    return {
      blocked: true,
      reason: `ADD_BLOCKED_ONE_SIDED_FREEZE: ${outcome} is frozen dominant side`,
    };
  }
  
  return { blocked: false, reason: null };
}

/**
 * Check if freeze is active for a market
 */
export function isFreezeAddsActive(marketId: string, asset: string): boolean {
  const key = `${marketId}:${asset}`;
  const state = freezeAddsState.get(key);
  return state?.frozen ?? false;
}

/**
 * Get freeze state for a market
 */
export function getFreezeAddsState(marketId: string, asset: string): {
  frozen: boolean;
  dominantSide?: Outcome;
  frozenAt?: number;
} {
  const key = `${marketId}:${asset}`;
  const state = freezeAddsState.get(key);
  if (!state) {
    return { frozen: false };
  }
  return {
    frozen: state.frozen,
    dominantSide: state.dominantSide,
    frozenAt: state.frozenAt,
  };
}

// ============================================================
// C) CPP METRICS: PAIRED-ONLY
// ============================================================

/**
 * Calculate cppPairedOnlyCents - the ONLY valid CPP metric for guardrails
 * 
 * Formula: avgUpPriceCents + avgDownPriceCents
 * Returns null if either side has no shares (paired=0)
 */
export function calculateCppPairedOnly(params: {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
}): CppPairedOnlyResult {
  const { upShares, downShares, upCost, downCost } = params;
  
  // Must have shares on BOTH sides to calculate valid CPP
  if (upShares <= 0 || downShares <= 0) {
    return {
      cppPairedOnlyCents: null,
      avgUpCents: null,
      avgDownCents: null,
      isValid: false,
      reason: `CPP_UNAVAILABLE: ${upShares > 0 ? 'no DOWN' : 'no UP'} shares`,
    };
  }
  
  const avgUpCents = (upCost / upShares) * 100; // Convert to cents
  const avgDownCents = (downCost / downShares) * 100;
  const cppPairedOnlyCents = avgUpCents + avgDownCents;
  
  return {
    cppPairedOnlyCents,
    avgUpCents,
    avgDownCents,
    isValid: true,
    reason: `CPP=${cppPairedOnlyCents.toFixed(1)}¢ (${avgUpCents.toFixed(1)}¢ + ${avgDownCents.toFixed(1)}¢)`,
  };
}

/**
 * Check if CPP-based emergency should trigger
 * ONLY triggers when cppPairedOnlyCents is valid AND exceeds threshold
 */
export function shouldTriggerCppEmergency(params: {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  emergencyThresholdCents: number; // e.g., 110 for $1.10
}): {
  shouldTrigger: boolean;
  cppPairedOnlyCents: number | null;
  reason: string;
} {
  const { emergencyThresholdCents } = params;
  const cppResult = calculateCppPairedOnly(params);
  
  if (!cppResult.isValid || cppResult.cppPairedOnlyCents === null) {
    return {
      shouldTrigger: false,
      cppPairedOnlyCents: null,
      reason: `CPP_EMERGENCY_SKIPPED: ${cppResult.reason}`,
    };
  }
  
  if (cppResult.cppPairedOnlyCents >= emergencyThresholdCents) {
    return {
      shouldTrigger: true,
      cppPairedOnlyCents: cppResult.cppPairedOnlyCents,
      reason: `CPP_EMERGENCY: ${cppResult.cppPairedOnlyCents.toFixed(1)}¢ >= ${emergencyThresholdCents}¢`,
    };
  }
  
  return {
    shouldTrigger: false,
    cppPairedOnlyCents: cppResult.cppPairedOnlyCents,
    reason: `CPP_OK: ${cppResult.cppPairedOnlyCents.toFixed(1)}¢ < ${emergencyThresholdCents}¢`,
  };
}

// ============================================================
// D) RUNTIME INVARIANT ASSERTIONS
// ============================================================

/**
 * Assert position invariants after each fill
 * If violated, returns violation details for SUSPENDED state
 */
export function assertPositionInvariants(params: {
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  cfg?: {
    maxSharesPerSide: number;
    maxTotalSharesPerMarket: number;
  };
}): {
  valid: boolean;
  violations: string[];
} {
  const { marketId, asset, upShares, downShares, cfg = HARD_INVARIANT_CONFIG } = params;
  const violations: string[] = [];
  
  if (upShares > cfg.maxSharesPerSide) {
    violations.push(`UP=${upShares} exceeds maxSharesPerSide=${cfg.maxSharesPerSide}`);
  }
  
  if (downShares > cfg.maxSharesPerSide) {
    violations.push(`DOWN=${downShares} exceeds maxSharesPerSide=${cfg.maxSharesPerSide}`);
  }
  
  const total = upShares + downShares;
  if (total > cfg.maxTotalSharesPerMarket) {
    violations.push(`TOTAL=${total} exceeds maxTotalSharesPerMarket=${cfg.maxTotalSharesPerMarket}`);
  }
  
  if (violations.length > 0) {
    console.error(`🚨 [HARD_INVARIANT] INVARIANT_BREACH: ${asset} ${marketId}`);
    for (const v of violations) {
      console.error(`   ❌ ${v}`);
    }
    
    saveBotEvent({
      event_type: 'INVARIANT_BREACH',
      asset,
      market_id: marketId,
      ts: Date.now(),
      data: { violations, upShares, downShares, cfg },
    }).catch(() => {});
    
    return { valid: false, violations };
  }
  
  return { valid: true, violations: [] };
}

// ============================================================
// E) COMBINED INVARIANT CHECK (SINGLE ENTRY POINT)
// ============================================================

// Throttle logging
const logThrottles = new Map<string, number>();

/**
 * placeOrderWithGuards - SINGLE ENTRY POINT for all order placements
 * 
 * All code paths MUST call this function before placing any order.
 * This ensures:
 * 1. Position caps are enforced
 * 2. One-sided freeze is checked
 * 3. CPP is calculated correctly (for logging)
 * 
 * Returns the allowed order size (0 if blocked)
 */
export function checkAllInvariants(params: {
  marketId: string;
  asset: string;
  side: OrderSide;
  outcome: Outcome;
  requestedSize: number;
  intentType: string;
  currentUpShares: number;
  currentDownShares: number;
  upCost: number;
  downCost: number;
  combinedAsk?: number | null;
  runId?: string;
}): InvariantCheckResult {
  const {
    marketId,
    asset,
    side,
    outcome,
    requestedSize,
    intentType,
    currentUpShares,
    currentDownShares,
    upCost,
    downCost,
    combinedAsk,
    runId,
  } = params;
  
  const now = Date.now();
  const logKey = `${marketId}:${asset}:${outcome}`;
  
  // A) Check position caps
  const capResult = clampOrderToCaps({
    marketId,
    asset,
    side,
    outcome,
    requestedSize,
    currentUpShares,
    currentDownShares,
  });
  
  if (capResult.blocked) {
    // Throttled logging
    const lastLog = logThrottles.get(`cap_${logKey}`) ?? 0;
    if (now - lastLog > HARD_INVARIANT_CONFIG.logThrottleMs) {
      logThrottles.set(`cap_${logKey}`, now);
      console.log(`🚫 [HARD_INVARIANT] ${capResult.blockReason}`);
      
      saveBotEvent({
        event_type: 'CAP_BLOCKED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'POSITION_CAP',
        data: {
          side,
          outcome,
          requestedSize,
          currentUpShares,
          currentDownShares,
          blockReason: capResult.blockReason,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      finalSize: 0,
      blockReason: capResult.blockReason,
      clampApplied: false,
      freezeApplied: false,
      cppValid: false,
    };
  }
  
  // B) Check one-sided freeze
  const freezeResult = checkOneSidedFreeze({
    marketId,
    asset,
    side,
    outcome,
    intentType,
    combinedAsk,
  });
  
  if (freezeResult.blocked) {
    // Throttled logging
    const lastLog = logThrottles.get(`freeze_${logKey}`) ?? 0;
    if (now - lastLog > HARD_INVARIANT_CONFIG.logThrottleMs) {
      logThrottles.set(`freeze_${logKey}`, now);
      console.log(`🧊 [HARD_INVARIANT] ${freezeResult.reason}`);
      
      saveBotEvent({
        event_type: 'ADD_BLOCKED_ONE_SIDED_FREEZE',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        reason_code: 'FREEZE_ADDS',
        data: {
          side,
          outcome,
          intentType,
          requestedSize: capResult.allowedSize,
          reason: freezeResult.reason,
        },
      }).catch(() => {});
    }
    
    return {
      allowed: false,
      finalSize: 0,
      blockReason: freezeResult.reason,
      clampApplied: capResult.clamped,
      freezeApplied: true,
      cppValid: false,
    };
  }
  
  // C) Calculate CPP (for logging, not blocking)
  const cppResult = calculateCppPairedOnly({
    upShares: currentUpShares,
    downShares: currentDownShares,
    upCost,
    downCost,
  });
  
  // Log clamping if applied
  if (capResult.clamped) {
    console.log(`📏 [HARD_INVARIANT] ${capResult.clampReason} (${requestedSize}→${capResult.allowedSize})`);
  }
  
  return {
    allowed: true,
    finalSize: capResult.allowedSize,
    blockReason: null,
    clampApplied: capResult.clamped,
    freezeApplied: false,
    cppValid: cppResult.isValid,
  };
}

// ============================================================
// F) STATE TRANSITIONS TRIGGERED BY FILLS
// ============================================================

/**
 * Called after each fill to update freeze state and check invariants
 */
export function onFillUpdateInvariants(params: {
  marketId: string;
  asset: string;
  fillSide: Outcome;
  fillQty: number;
  newUpShares: number;
  newDownShares: number;
  upCost: number;
  downCost: number;
  runId?: string;
}): {
  freezeActivated: boolean;
  freezeCleared: boolean;
  invariantViolated: boolean;
  cppPairedOnlyCents: number | null;
} {
  const {
    marketId,
    asset,
    fillSide,
    newUpShares,
    newDownShares,
    upCost,
    downCost,
    runId,
  } = params;
  
  let freezeActivated = false;
  let freezeCleared = false;
  
  const paired = Math.min(newUpShares, newDownShares);
  const isOneSided = paired === 0 && (newUpShares > 0 || newDownShares > 0);
  const isPaired = paired >= 20 && Math.abs(newUpShares - newDownShares) <= paired * 0.2;
  
  // Check if we need to activate freeze
  if (isOneSided && !isFreezeAddsActive(marketId, asset)) {
    const dominantSide: Outcome = newUpShares > 0 ? 'UP' : 'DOWN';
    activateFreezeAdds(marketId, asset, dominantSide, runId);
    freezeActivated = true;
  }
  
  // Check if we should clear freeze (position is now PAIRED)
  if (isPaired && isFreezeAddsActive(marketId, asset)) {
    clearFreezeAdds(marketId, asset);
    freezeCleared = true;
    console.log(`🔓 [HARD_INVARIANT] FREEZE_CLEARED: ${asset} ${marketId} is now PAIRED`);
  }
  
  // Assert invariants
  const invariantCheck = assertPositionInvariants({
    marketId,
    asset,
    upShares: newUpShares,
    downShares: newDownShares,
  });
  
  // Calculate CPP for logging
  const cppResult = calculateCppPairedOnly({
    upShares: newUpShares,
    downShares: newDownShares,
    upCost,
    downCost,
  });
  
  return {
    freezeActivated,
    freezeCleared,
    invariantViolated: !invariantCheck.valid,
    cppPairedOnlyCents: cppResult.cppPairedOnlyCents,
  };
}
