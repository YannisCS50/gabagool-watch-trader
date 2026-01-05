/**
 * hard-invariants.ts - v7.2.5 REV C.5 HARD INVARIANTS
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
 * D) SINGLE ORDER GATEWAY (v7.2.5)
 *    - ALL order placements MUST go through placeOrderWithCaps()
 *    - This function is the ONLY allowed entry point
 *    - Direct placeOrder() calls are FORBIDDEN
 * 
 * These invariants are checked IMMEDIATELY BEFORE any order placement.
 * NO CODE PATH MAY BYPASS THESE CHECKS.
 */

import { saveBotEvent } from './backend.js';
import { placeOrder as rawPlaceOrder, getOrderbookDepth, OrderbookDepth } from './polymarket.js';

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
    fillQty,
    newUpShares,
    newDownShares,
    upCost,
    downCost,
    runId,
  } = params;

  // Consume pending BUY reservations now that inventory has been applied locally.
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
}

/**
 * placeOrderWithCaps - THE ONLY ALLOWED ENTRY POINT FOR ORDER PLACEMENT
 * 
 * This function:
 * 1. Validates position caps BEFORE calling rawPlaceOrder
 * 2. Clamps order size if it would exceed caps
 * 3. Blocks orders entirely if no capacity remains
 * 4. Logs all cap enforcement events
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
    currentUpShares: currentUpSharesRaw,
    currentDownShares: currentDownSharesRaw,
    upCost = 0,
    downCost = 0,
    intentType,
    runId,
  } = ctx;

  // Include pending BUY reservations so multiple in-flight orders cannot breach caps.
  const reserved = getReservedBuyShares(marketId, asset);
  const effectiveUpShares = currentUpSharesRaw + reserved.up;
  const effectiveDownShares = currentDownSharesRaw + reserved.down;

  // Map side to OrderSide type
  const orderSide: OrderSide = order.side;

  // 1) CHECK ALL INVARIANTS (using effective shares)
  const invariantResult = checkAllInvariants({
    marketId,
    asset,
    side: orderSide,
    outcome,
    requestedSize: order.size,
    intentType,
    currentUpShares: effectiveUpShares,
    currentDownShares: effectiveDownShares,
    upCost,
    downCost,
    combinedAsk: null, // Will be fetched if needed
    runId,
  });

  // 2) BLOCKED: Return immediately with cap_blocked error
  if (!invariantResult.allowed) {
    console.log(`🚫 [HARD_INVARIANT] ORDER BLOCKED: ${invariantResult.blockReason}`);
    console.log(`   Request: ${order.side} ${order.size} ${outcome} @ ${(order.price * 100).toFixed(0)}¢`);
    console.log(
      `   Position: UP=${currentUpSharesRaw} (+${reserved.up} pending) DOWN=${currentDownSharesRaw} (+${reserved.down} pending)`
    );

    saveBotEvent({
      event_type: 'ORDER_CAP_BLOCKED',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      reason_code: 'HARD_CAP',
      data: {
        side: order.side,
        outcome,
        requestedSize: order.size,
        currentUpShares: currentUpSharesRaw,
        currentDownShares: currentDownSharesRaw,
        reservedBuyUpShares: reserved.up,
        reservedBuyDownShares: reserved.down,
        effectiveUpShares,
        effectiveDownShares,
        blockReason: invariantResult.blockReason,
        intentType,
      },
    }).catch(() => {});

    return {
      success: false,
      error: `CAP_BLOCKED: ${invariantResult.blockReason}`,
      failureReason: 'cap_blocked',
    };
  }

  // 3) CLAMPED: Adjust size and log
  const finalSize = invariantResult.finalSize;
  const wasClamped = invariantResult.clampApplied;

  if (wasClamped) {
    console.log(`📏 [HARD_INVARIANT] ORDER CLAMPED: ${order.size} → ${finalSize} shares`);
    console.log(
      `   Position: UP=${currentUpSharesRaw} (+${reserved.up} pending) DOWN=${currentDownSharesRaw} (+${reserved.down} pending)`
    );

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
        currentUpShares: currentUpSharesRaw,
        currentDownShares: currentDownSharesRaw,
        reservedBuyUpShares: reserved.up,
        reservedBuyDownShares: reserved.down,
        effectiveUpShares,
        effectiveDownShares,
        intentType,
      },
    }).catch(() => {});
  }

  // 4) FINAL SAFETY CHECK: Verify post-order position won't exceed caps (effective)
  const projectedShares = outcome === 'UP'
    ? effectiveUpShares + (order.side === 'BUY' ? finalSize : 0)
    : effectiveDownShares + (order.side === 'BUY' ? finalSize : 0);

  if (order.side === 'BUY' && projectedShares > HARD_INVARIANT_CONFIG.maxSharesPerSide) {
    console.error(`🚨 [HARD_INVARIANT] FATAL: Projected ${outcome}=${projectedShares} would exceed cap!`);
    console.error(`   This should have been caught by clampOrderToCaps. BLOCKING ORDER.`);

    saveBotEvent({
      event_type: 'INVARIANT_SAFETY_BLOCK',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        outcome,
        projectedShares,
        maxSharesPerSide: HARD_INVARIANT_CONFIG.maxSharesPerSide,
        currentSharesRaw: outcome === 'UP' ? currentUpSharesRaw : currentDownSharesRaw,
        reservedBuyShares: outcome === 'UP' ? reserved.up : reserved.down,
        orderSize: finalSize,
      },
    }).catch(() => {});

    return {
      success: false,
      error: `SAFETY_BLOCK: Projected ${outcome}=${projectedShares} > ${HARD_INVARIANT_CONFIG.maxSharesPerSide}`,
      failureReason: 'cap_blocked',
    };
  }

  // 5) Reserve shares BEFORE placing BUY order (prevents same-tick multi-order breach)
  if (order.side === 'BUY') {
    reserveBuyShares(marketId, asset, outcome, finalSize);
  }

  // 6) PLACE ORDER via rawPlaceOrder (and rollback reservation on failure)
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
    if (order.side === 'BUY') {
      releaseBuyShares(marketId, asset, outcome, finalSize);
    }
    return {
      success: false,
      error: err?.message || 'Order placement exception',
      failureReason: 'unknown',
    };
  }

  if (!result.success && order.side === 'BUY') {
    releaseBuyShares(marketId, asset, outcome, finalSize);
  }

  // 7) LOG SUCCESS with cap enforcement info
  if (result.success && wasClamped) {
    console.log(`✅ [HARD_INVARIANT] CLAMPED ORDER FILLED/PLACED: ${finalSize}@${(order.price * 100).toFixed(0)}¢ (was ${order.size})`);
  }

  return {
    ...result,
    clamped: wasClamped,
    originalSize: wasClamped ? order.size : undefined,
  };
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
