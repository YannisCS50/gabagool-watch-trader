/**
 * hard-invariants.ts - v7.2.7 REV C.4.1 HARD INVARIANTS + CONCURRENCY SAFETY
 * ==========================================================================
 * Implements ABSOLUTE guards that MUST hold for every order:
 * 
 * A) HARD POSITION CAP ENFORCEMENT via ExposureLedger
 *    - EFFECTIVE EXPOSURE = position + open + pending shares
 *    - effectiveUp <= maxSharesPerSide (100)
 *    - effectiveDown <= maxSharesPerSide (100)
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
 * D) SINGLE ORDER GATEWAY
 *    - ALL order placements MUST go through placeOrderWithCaps()
 *    - This function is the ONLY allowed entry point
 *    - Direct placeOrder() calls are FORBIDDEN
 * 
 * E) EXPOSURE LEDGER (v7.2.6)
 *    - Tracks position, open orders, and pending orders per market/side
 *    - Cap checks use EFFECTIVE EXPOSURE to prevent race conditions
 *    - Ledger updated on: place, ack, fill, cancel, reject
 * 
 * F) CONCURRENCY SAFETY (v7.2.7 REV C.4.1)
 *    - Per-market mutex to prevent concurrent order placement
 *    - Burst limiter (max 6 orders/min, min 2s interval)
 *    - Halt on invariant breach (cancel orders + suspend market)
 * 
 * These invariants are checked IMMEDIATELY BEFORE any order placement.
 * NO CODE PATH MAY BYPASS THESE CHECKS.
 */

import { saveBotEvent } from './backend.js';
import { placeOrder as rawPlaceOrder, getOrderbookDepth, OrderbookDepth, cancelOrder } from './polymarket.js';
import {
  checkCapWithEffectiveExposure,
  reservePending,
  promoteToOpen,
  onFill as ledgerOnFill,
  onRejectPending,
  assertInvariants as ledgerAssertInvariants,
  logOrderAttempt,
  syncPosition as ledgerSyncPosition,
  incrementPosition as ledgerIncrementPosition,
  clearMarket as ledgerClearMarket,
  getEffectiveExposure,
  getLedgerEntry,
  EXPOSURE_CAP_CONFIG,
  type Side as LedgerSide,
} from './exposure-ledger.js';

// v7.2.7 REV C.4.1: Concurrency safety imports
import { tryAcquire, forceRelease, getMutexStats, type AcquireResult } from './market-mutex.js';
import { checkBurstLimit, recordOrderPlacement, clearBurstState, getBurstStats, BURST_LIMITER_CONFIG } from './burst-limiter.js';

// Rev D: CPP Quality imports
import {
  CppQuality,
  checkCppFeasibility,
  checkCombinationGuard,
  getCppActivityState,
  isEntryAllowedByActivityState,
  isHedgeAllowedByActivityState,
  CPP_QUALITY_CONFIG,
  type CppActivityState,
} from './cpp-quality.js';

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
// HALT-ON-BREACH CONFIGURATION (v7.2.7 REV C.4.1)
// ============================================================

export const HALT_ON_BREACH_CONFIG = {
  // Suspend market for this duration on breach
  suspendDurationMs: 15 * 60 * 1000, // 15 minutes
  // Cancel all open orders on breach
  cancelOrdersOnBreach: true,
  // Max cancel attempts per order
  maxCancelAttempts: 3,
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

// ============================================================
// PENDING BUY SHARE RESERVATIONS (prevents multi-order cap breach)
// ============================================================
//
// Root cause of "cap breach" in practice is multiple BUY orders getting placed
// before inventory (fills/polling) updates `currentUpShares/currentDownShares`.
//
// We solve this at the LAST gate by reserving shares at order-placement time
// and treating reserved shares as already held for cap calculations.
//
const reservedBuySharesState = new Map<string, { up: number; down: number }>();

function getReservedBuyShares(marketId: string, asset: string): { up: number; down: number } {
  const key = `${marketId}:${asset}`;
  const v = reservedBuySharesState.get(key);
  return v ?? { up: 0, down: 0 };
}

function reserveBuyShares(marketId: string, asset: string, outcome: Outcome, qty: number): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const key = `${marketId}:${asset}`;
  const cur = reservedBuySharesState.get(key) ?? { up: 0, down: 0 };
  if (outcome === 'UP') cur.up += qty;
  else cur.down += qty;
  reservedBuySharesState.set(key, cur);
}

function releaseBuyShares(marketId: string, asset: string, outcome: Outcome, qty: number): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const key = `${marketId}:${asset}`;
  const cur = reservedBuySharesState.get(key);
  if (!cur) return;

  if (outcome === 'UP') cur.up = Math.max(0, cur.up - qty);
  else cur.down = Math.max(0, cur.down - qty);

  if (cur.up === 0 && cur.down === 0) reservedBuySharesState.delete(key);
  else reservedBuySharesState.set(key, cur);
}

function consumeReservedBuySharesOnFill(marketId: string, asset: string, fillSide: Outcome, fillQty: number): void {
  // Called after local inventory has been incremented.
  // Reduces reserved shares so caps remain accurate for subsequent orders.
  releaseBuyShares(marketId, asset, fillSide, fillQty);
}


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
 * Called after each fill to update freeze state, ledger, and check invariants.
 * 
 * v7.2.6: Also updates ExposureLedger:
 *   - ledgerOnFill: reduce openOrderShares
 *   - ledgerIncrementPosition: increase positionShares
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
    fillQty,
    newUpShares,
    newDownShares,
    upCost,
    downCost,
    runId,
  } = params;

  // v7.2.6: Update ExposureLedger on fill
  // 1) Reduce open order shares (order is being filled)
  ledgerOnFill(marketId, asset, fillSide, fillQty);
  // 2) Increment position shares in ledger
  ledgerIncrementPosition(marketId, asset, fillSide, fillQty);

  // Legacy: consume reserved shares (for backward compat during transition)
  consumeReservedBuySharesOnFill(marketId, asset, fillSide, fillQty);

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
  
  // Assert position invariants (legacy)
  const invariantCheck = assertPositionInvariants({
    marketId,
    asset,
    upShares: newUpShares,
    downShares: newDownShares,
  });

  // v7.2.6: Also assert ledger invariants (effective exposure)
  const ledgerInvariant = ledgerAssertInvariants(marketId, asset, runId);
  
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
    invariantViolated: !invariantCheck.valid || !ledgerInvariant.valid,
    cppPairedOnlyCents: cppResult.cppPairedOnlyCents,
  };
}

// ============================================================
// G) SINGLE ORDER GATEWAY - placeOrderWithCaps (v7.2.5)
// ============================================================

/**
 * OrderRequest interface matching polymarket.ts
 */
interface CappedOrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD' | 'FOK';
  intent?: 'ENTRY' | 'HEDGE' | 'FORCE' | 'SURVIVAL';
  spread?: number;
}

/**
 * OrderResponse interface matching polymarket.ts
 */
interface CappedOrderResponse {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  status?: 'filled' | 'partial' | 'open' | 'pending' | 'unknown';
  failureReason?: 'no_liquidity' | 'cloudflare' | 'auth' | 'balance' | 'no_orderbook' | 'cap_blocked' | 'unknown';
  clamped?: boolean;
  originalSize?: number;
}

/**
 * Context required for position cap enforcement
 * Rev D: Extended with orderbook data for CPP feasibility checks
 */
export interface OrderContext {
  marketId: string;
  asset: string;
  outcome: Outcome;
  currentUpShares: number;
  currentDownShares: number;
  upCost?: number;
  downCost?: number;
  intentType: string;
  runId?: string;
  // Rev D: Orderbook data for CPP feasibility and combination guards
  upAsk?: number;
  downAsk?: number;
  entryPrice?: number;  // The price we're placing this order at
}

/**
 * placeOrderWithCaps - THE ONLY ALLOWED ENTRY POINT FOR ORDER PLACEMENT
 * 
 * v7.2.7 REV C.4.1: Now includes:
 * - Per-market mutex (concurrency protection)
 * - Burst limiter (max 6 orders/min, min 2s interval)
 * - Halt on invariant breach (suspend market)
 * 
 * v7.2.6: Uses ExposureLedger for authoritative cap tracking.
 * 
 * This function:
 * 1. Acquires market mutex (blocks concurrent orders)
 * 2. Checks burst limit (rate limiting)
 * 3. Checks caps using EFFECTIVE EXPOSURE (position + open + pending)
 * 4. Reserves pending shares BEFORE calling rawPlaceOrder
 * 5. Promotes to open on ACK, releases on rejection
 * 6. Records order placement for burst limiter
 * 7. Releases mutex
 * 
 * ALL order placements in the codebase MUST use this function.
 * Direct calls to placeOrder are FORBIDDEN.
 */
export async function placeOrderWithCaps(
  order: CappedOrderRequest,
  ctx: OrderContext
): Promise<CappedOrderResponse> {
  const now = Date.now();
  const {
    marketId,
    asset,
    outcome,
    currentUpShares: _posUpIgnored, // Position is now tracked by ledger
    currentDownShares: _posDownIgnored,
    upCost = 0,
    downCost = 0,
    intentType,
    runId,
  } = ctx;

  // ================================================================
  // STEP 0: CHECK BURST LIMIT (before acquiring mutex)
  // ================================================================
  const burstCheck = checkBurstLimit({
    marketId,
    asset,
    side: order.side,
    runId,
  });

  if (burstCheck.blocked) {
    return {
      success: false,
      error: `BURST_BLOCKED: ${burstCheck.reason}`,
      failureReason: 'cap_blocked',
    };
  }

  // ================================================================
  // STEP 1: ACQUIRE MARKET MUTEX
  // ================================================================
  const lock = tryAcquire(marketId, asset, `placeOrder_${intentType}`, runId);

  if (!lock.acquired) {
    saveBotEvent({
      event_type: 'ORDER_MUTEX_BLOCKED',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        side: order.side,
        outcome,
        size: order.size,
        intentType,
        reason: lock.reason,
      },
    }).catch(() => {});

    return {
      success: false,
      error: `MUTEX_BLOCKED: ${lock.reason}`,
      failureReason: 'cap_blocked',
    };
  }

  // From this point, we MUST release the mutex in finally block
  try {
    return await placeOrderWithCapsInner(order, ctx, now);
  } finally {
    lock.release();
  }
}

/**
 * Inner function that does the actual order placement.
 * Must be called with mutex already acquired.
 */
async function placeOrderWithCapsInner(
  order: CappedOrderRequest,
  ctx: OrderContext,
  startTime: number
): Promise<CappedOrderResponse> {
  const {
    marketId,
    asset,
    outcome,
    upCost = 0,
    downCost = 0,
    intentType,
    runId,
  } = ctx;

  // Map side to OrderSide type
  const orderSide: OrderSide = order.side;
  const ledgerSide: LedgerSide = outcome;

  // SELL orders: use legacy clamp (never short), skip ledger reservation
  if (order.side === 'SELL') {
    // For SELL, we only need to ensure we don't sell more than we have
    const ledgerEntry = getLedgerEntry(marketId, asset);
    const currentShares = outcome === 'UP' ? ledgerEntry.positionUp : ledgerEntry.positionDown;
    const allowedSize = Math.min(order.size, currentShares);

    if (allowedSize <= 0) {
      logOrderAttempt({
        marketId,
        asset,
        side: ledgerSide,
        reqQty: order.size,
        decision: 'block',
        reason: `SELL_NO_SHARES: have ${currentShares}`,
        runId,
      });
      return {
        success: false,
        error: `CAP_BLOCKED: Cannot SELL ${order.size} ${outcome}, only have ${currentShares}`,
        failureReason: 'cap_blocked',
      };
    }

    const wasClamped = allowedSize < order.size;
    if (wasClamped) {
      logOrderAttempt({
        marketId,
        asset,
        side: ledgerSide,
        reqQty: order.size,
        decision: 'clamp',
        clampedQty: allowedSize,
        reason: `SELL_CLAMP: only ${currentShares} available`,
        runId,
      });
    } else {
      logOrderAttempt({
        marketId,
        asset,
        side: ledgerSide,
        reqQty: order.size,
        decision: 'place',
        runId,
      });
    }

    // Place the SELL order (no ledger reservation needed)
    let result: CappedOrderResponse;
    try {
      result = await rawPlaceOrder({
        tokenId: order.tokenId,
        side: order.side,
        price: order.price,
        size: allowedSize,
        orderType: order.orderType,
        intent: order.intent,
        spread: order.spread,
      });
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Order placement exception',
        failureReason: 'unknown',
      };
    }

    return {
      ...result,
      clamped: wasClamped,
      originalSize: wasClamped ? order.size : undefined,
    };
  }

  // ================================================================
  // BUY ORDER: Rev D CPP Quality + ExposureLedger for cap enforcement
  // ================================================================

  // Rev D PRIORITY 3: Check CPP activity state BEFORE placing order
  // HEDGE_ONLY allows hedges, blocks entries
  // HOLD_ONLY blocks everything
  const ledgerEntry = getLedgerEntry(marketId, asset);
  const currentUpShares = ledgerEntry.positionUp;
  const currentDownShares = ledgerEntry.positionDown;
  
  const isHedgeIntent = intentType === 'HEDGE' || intentType === 'hedge' || 
                        intentType === 'FORCE' || intentType === 'SURVIVAL' ||
                        intentType === 'force_hedge' || intentType === 'panic_hedge';
  
  if (isHedgeIntent) {
    // Check if hedge is allowed by activity state
    const hedgeAllowed = isHedgeAllowedByActivityState({
      marketId,
      asset,
      upShares: currentUpShares,
      downShares: currentDownShares,
      upCost,
      downCost,
      runId,
    });
    
    if (!hedgeAllowed.allowed) {
      logOrderAttempt({
        marketId,
        asset,
        side: ledgerSide,
        reqQty: order.size,
        decision: 'block',
        reason: hedgeAllowed.reason,
        runId,
      });
      
      return {
        success: false,
        error: `CPP_STATE_BLOCKED: ${hedgeAllowed.reason}`,
        failureReason: 'cap_blocked',
      };
    }
  } else {
    // Entry/accumulate: check if entry is allowed by activity state
    const entryAllowed = isEntryAllowedByActivityState({
      marketId,
      asset,
      upShares: currentUpShares,
      downShares: currentDownShares,
      upCost,
      downCost,
      runId,
    });
    
    if (!entryAllowed.allowed) {
      logOrderAttempt({
        marketId,
        asset,
        side: ledgerSide,
        reqQty: order.size,
        decision: 'block',
        reason: entryAllowed.reason,
        runId,
      });
      
      return {
        success: false,
        error: `CPP_STATE_BLOCKED: ${entryAllowed.reason}`,
        failureReason: 'cap_blocked',
      };
    }
    
    // Rev D PRIORITY 1: CPP Feasibility check for new entries
    // Only check if we have orderbook data AND this is a fresh entry (no existing position on this side)
    const currentSideShares = outcome === 'UP' ? currentUpShares : currentDownShares;
    const hasOrderbookData = ctx.upAsk !== undefined && ctx.downAsk !== undefined && ctx.entryPrice !== undefined;
    
    if (hasOrderbookData && currentSideShares === 0) {
      const feasibility = checkCppFeasibility({
        marketId,
        asset,
        entrySide: outcome,
        entryPrice: ctx.entryPrice!,
        upAsk: ctx.upAsk!,
        downAsk: ctx.downAsk!,
        runId,
      });
      
      if (!feasibility.allowed) {
        logOrderAttempt({
          marketId,
          asset,
          side: ledgerSide,
          reqQty: order.size,
          decision: 'block',
          reason: feasibility.reason,
          runId,
        });
        
        return {
          success: false,
          error: `CPP_FEASIBILITY_BLOCKED: ${feasibility.reason}`,
          failureReason: 'cap_blocked',
        };
      }
    }
    
    // Rev D PRIORITY 2: Combination guard for adds (when we already have position)
    if (hasOrderbookData && currentSideShares > 0) {
      const currentCost = outcome === 'UP' ? upCost : downCost;
      const currentAvgPrice = currentCost / currentSideShares;
      const oppositeSideAsk = outcome === 'UP' ? ctx.downAsk! : ctx.upAsk!;
      
      const combinationCheck = checkCombinationGuard({
        marketId,
        asset,
        side: outcome,
        currentAvgPrice,
        oppositeSideAsk,
        runId,
      });
      
      if (!combinationCheck.allowed) {
        logOrderAttempt({
          marketId,
          asset,
          side: ledgerSide,
          reqQty: order.size,
          decision: 'block',
          reason: combinationCheck.reason,
          runId,
        });
        
        return {
          success: false,
          error: `COMBINATION_GUARD_BLOCKED: ${combinationCheck.reason}`,
          failureReason: 'cap_blocked',
        };
      }
    }
  }

  // 1) CHECK CAP using effective exposure
  const capCheck = checkCapWithEffectiveExposure({
    marketId,
    asset,
    side: ledgerSide,
    requestedQty: order.size,
  });

  // 2) BLOCKED: Return immediately
  if (capCheck.blocked) {
    logOrderAttempt({
      marketId,
      asset,
      side: ledgerSide,
      reqQty: order.size,
      decision: 'block',
      reason: capCheck.blockReason ?? 'CAP_EXCEEDED',
      runId,
    });

    saveBotEvent({
      event_type: 'ORDER_CAP_BLOCKED',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      reason_code: 'EFFECTIVE_CAP',
      data: {
        side: order.side,
        outcome,
        requestedSize: order.size,
        effectiveExposure: capCheck.effectiveExposure,
        blockReason: capCheck.blockReason,
        intentType,
      },
    }).catch(() => {});

    return {
      success: false,
      error: `CAP_BLOCKED: ${capCheck.blockReason}`,
      failureReason: 'cap_blocked',
    };
  }

  // 3) CLAMP if needed
  const finalSize = capCheck.clampedQty;
  const wasClamped = finalSize < order.size;

  if (wasClamped) {
    logOrderAttempt({
      marketId,
      asset,
      side: ledgerSide,
      reqQty: order.size,
      decision: 'clamp',
      clampedQty: finalSize,
      reason: `EFFECTIVE_CAP: remaining=${capCheck.effectiveExposure.remainingUp}/${capCheck.effectiveExposure.remainingDown}`,
      runId,
    });

    saveBotEvent({
      event_type: 'ORDER_CLAMPED',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        side: order.side,
        outcome,
        originalSize: order.size,
        clampedSize: finalSize,
        effectiveExposure: capCheck.effectiveExposure,
        intentType,
      },
    }).catch(() => {});
  } else {
    logOrderAttempt({
      marketId,
      asset,
      side: ledgerSide,
      reqQty: order.size,
      decision: 'place',
      runId,
    });
  }

  // 4) RESERVE PENDING before API call
  reservePending(marketId, asset, ledgerSide, finalSize);

  // 5) PLACE ORDER
  let result: CappedOrderResponse;
  try {
    result = await rawPlaceOrder({
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      size: finalSize,
      orderType: order.orderType,
      intent: order.intent,
      spread: order.spread,
    });
  } catch (err: any) {
    // API call failed: release pending reservation
    onRejectPending(marketId, asset, ledgerSide, finalSize);
    return {
      success: false,
      error: err?.message || 'Order placement exception',
      failureReason: 'unknown',
    };
  }

  // 6) UPDATE LEDGER based on result
  if (!result.success) {
    // Order rejected: release pending
    onRejectPending(marketId, asset, ledgerSide, finalSize);
  } else {
    // Order accepted: promote pending → open
    promoteToOpen(marketId, asset, ledgerSide, finalSize);

    // v7.2.7 REV C.4.1: Record successful order for burst limiter
    recordOrderPlacement({
      marketId,
      asset,
      side: order.side,
    });
  }

  // 7) ASSERT INVARIANTS after ledger update
  const invariantCheck = ledgerAssertInvariants(marketId, asset, runId);
  if (!invariantCheck.valid) {
    // v7.2.7 REV C.4.1: HALT ON BREACH - Cancel orders and suspend market
    console.error(`🚨 [LEDGER] INVARIANT_BREACH_HALT: ${asset} ${marketId}`);
    console.error(`   Effective: UP=${invariantCheck.exposure.effectiveUp} DOWN=${invariantCheck.exposure.effectiveDown}`);
    console.error(`   Caps: maxPerSide=${EXPOSURE_CAP_CONFIG.maxSharesPerSide} maxTotal=${EXPOSURE_CAP_CONFIG.maxTotalSharesPerMarket}`);

    saveBotEvent({
      event_type: 'INVARIANT_BREACH_HALT',
      asset,
      market_id: marketId,
      ts: Date.now(),
      run_id: runId,
      reason_code: 'EFFECTIVE_EXPOSURE_BREACH',
      data: {
        effectiveUp: invariantCheck.exposure.effectiveUp,
        effectiveDown: invariantCheck.exposure.effectiveDown,
        effectiveTotal: invariantCheck.exposure.effectiveUp + invariantCheck.exposure.effectiveDown,
        maxSharesPerSide: EXPOSURE_CAP_CONFIG.maxSharesPerSide,
        maxTotalSharesPerMarket: EXPOSURE_CAP_CONFIG.maxTotalSharesPerMarket,
        violations: invariantCheck.violations,
        lastOrderId: result.orderId,
      },
    }).catch(() => {});

    // v7.2.7: Cancel all open orders for this market (best-effort)
    if (HALT_ON_BREACH_CONFIG.cancelOrdersOnBreach && result.orderId) {
      console.log(`🚫 [HALT] Attempting to cancel order ${result.orderId}...`);
      try {
        await cancelOrder(result.orderId);
        console.log(`✅ [HALT] Order ${result.orderId} cancelled`);
      } catch (cancelErr: any) {
        console.error(`❌ [HALT] Failed to cancel order: ${cancelErr?.message}`);
      }
    }

    // Note: Market suspension should be handled by the caller (index.ts)
    // as it has access to the MarketStateManager instance.
    // We return a special flag to indicate breach occurred.
    return {
      ...result,
      clamped: wasClamped,
      originalSize: wasClamped ? order.size : undefined,
      // Signal to caller that market should be suspended
      error: result.success ? 'INVARIANT_BREACH_HALT' : result.error,
    };
  }

  // 8) LOG SUCCESS with cap enforcement info
  if (result.success && wasClamped) {
    console.log(`✅ [LEDGER] CLAMPED ORDER PLACED: ${finalSize}@${(order.price * 100).toFixed(0)}¢ (was ${order.size})`);
  }

  return {
    ...result,
    clamped: wasClamped,
    originalSize: wasClamped ? order.size : undefined,
  };
}

// ============================================================
// H) HALT-ON-BREACH API (v7.2.7 REV C.4.1)
// ============================================================

/**
 * Check if effective exposure exceeds caps for a market.
 * Used for proactive breach detection in the main loop.
 */
export function checkForEffectiveBreachHalt(
  marketId: string,
  asset: string,
  runId?: string
): {
  breached: boolean;
  effectiveUp: number;
  effectiveDown: number;
  effectiveTotal: number;
  violations: string[];
} {
  const exposure = getEffectiveExposure(marketId, asset);
  const effectiveTotal = exposure.effectiveUp + exposure.effectiveDown;
  const violations: string[] = [];

  if (exposure.effectiveUp > EXPOSURE_CAP_CONFIG.maxSharesPerSide) {
    violations.push(`EFFECTIVE_UP=${exposure.effectiveUp} > ${EXPOSURE_CAP_CONFIG.maxSharesPerSide}`);
  }
  if (exposure.effectiveDown > EXPOSURE_CAP_CONFIG.maxSharesPerSide) {
    violations.push(`EFFECTIVE_DOWN=${exposure.effectiveDown} > ${EXPOSURE_CAP_CONFIG.maxSharesPerSide}`);
  }
  if (effectiveTotal > EXPOSURE_CAP_CONFIG.maxTotalSharesPerMarket) {
    violations.push(`EFFECTIVE_TOTAL=${effectiveTotal} > ${EXPOSURE_CAP_CONFIG.maxTotalSharesPerMarket}`);
  }

  const breached = violations.length > 0;

  if (breached) {
    saveBotEvent({
      event_type: 'EFFECTIVE_BREACH_DETECTED',
      asset,
      market_id: marketId,
      ts: Date.now(),
      run_id: runId,
      data: {
        effectiveUp: exposure.effectiveUp,
        effectiveDown: exposure.effectiveDown,
        effectiveTotal,
        violations,
      },
    }).catch(() => {});
  }

  return {
    breached,
    effectiveUp: exposure.effectiveUp,
    effectiveDown: exposure.effectiveDown,
    effectiveTotal,
    violations,
  };
}

/**
 * Get concurrency stats for diagnostics.
 */
export function getConcurrencyStats(): {
  mutex: ReturnType<typeof getMutexStats>;
  burst: ReturnType<typeof getBurstStats>;
} {
  return {
    mutex: getMutexStats(),
    burst: getBurstStats(),
  };
}

/**
 * Clear all concurrency state for a market (e.g., on expiry).
 */
export function clearConcurrencyState(marketId: string, asset: string): void {
  forceRelease(marketId, asset);
  clearBurstState(marketId, asset);
}

/**
 * DEPRECATED: Direct placeOrder access
 * This re-export exists only for backwards compatibility detection.
 * All new code should use placeOrderWithCaps.
 */
export function placeOrderDirect(order: CappedOrderRequest): Promise<CappedOrderResponse> {
  console.warn(`⚠️ [DEPRECATED] placeOrderDirect called - should use placeOrderWithCaps!`);
  return rawPlaceOrder(order);
}

// ============================================================
// REV D EXPORTS - CPP Quality
// ============================================================

export {
  CppQuality,
  CPP_QUALITY_CONFIG,
  checkCppFeasibility,
  checkCombinationGuard,
  getCppActivityState,
  isEntryAllowedByActivityState,
  isHedgeAllowedByActivityState,
  type CppActivityState,
} from './cpp-quality.js';
