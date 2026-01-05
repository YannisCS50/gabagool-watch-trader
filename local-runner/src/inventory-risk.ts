/**
 * inventory-risk.ts - v6.5.0 Robustness Patch
 * ============================================================
 * First-class inventory risk management with:
 * - Inventory risk score tracking (unpaired exposure × age)
 * - Degraded mode when hedge infeasible
 * - Queue-aware throttling
 * - ACTION_SKIPPED event logging
 * 
 * This module provides runtime risk metrics without changing core strategy logic.
 */

import { saveBotEvent, BotEvent, saveInventorySnapshot } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const INVENTORY_RISK_CONFIG = {
  // Degraded Mode Thresholds
  degradedTriggerNotional: 15,    // USD - trigger when unpaired notional >= this
  degradedTriggerAgeSec: 20,      // seconds - AND unpaired age >= this
  riskScoreTrigger: 300,          // inventory_risk_score >= this triggers degraded mode
  
  // Queue Stress Thresholds
  queueStressSize: 6,             // pending orders in queue to trigger stress
  queueStressBackoffActive: true,
  queueStressWindowMs: 5000,      // time window for queue stress evaluation
  queueStressCooldownMultiplier: 2, // multiply cooldowns when stressed
  
  // Logging
  logEvents: true,
  logIntervalMs: 5000,            // Don't spam logs more than once per 5s per market
  
  // v6.6.0: Emergency Unwind Thresholds
  cppEmergency: 1.10,             // cpp >= this triggers emergency unwind
  cppImplausible: 1.50,           // cpp > this = likely units bug, force unwind
  hardSkewCap: 0.70,              // skew ratio >= this + age triggers emergency
  skewAgeEmergencySec: 20,        // seconds skewed before emergency
  emergencyUnwindMaxSec: 45,      // max time in emergency unwind mode
  cooldownAfterEmergencySec: 600, // freeze new entries after emergency (10m)
  
  // v6.6.0: Safety Block (Invalid Book)
  safetyBlockOnInvalidBook: true, // block all trading when book is invalid
};

// ============================================================
// TYPES
// ============================================================

export type IntendedAction = 'ADD' | 'ACCUMULATE' | 'MICRO_HEDGE' | 'REBALANCE' | 'UNWIND' | 'ENTRY_HEDGE' | 'ENTRY' | 'HEDGE' | 'CANCEL_ALL';

export type SkipReason = 
  | 'PAIR_COST'           // Would worsen pair cost
  | 'COOLDOWN'            // On cooldown
  | 'QUEUE_STRESS'        // Queue too full
  | 'FUNDS'               // Insufficient funds
  | 'NO_DEPTH'            // No orderbook depth
  | 'RATE_LIMIT'          // Rate limited
  | 'DEGRADED_MODE'       // In degraded mode, only hedges allowed
  | 'TIME_EXPIRED'        // Too close to expiry
  | 'EDGE_INSUFFICIENT'   // Edge below threshold
  | 'SKEW_LIMIT'          // Would exceed skew cap
  | 'STARTUP_GRACE'       // Market started before boot
  | 'TAIL_ENTRY_BLOCK'    // v7: Price too low (tail odds)
  | 'NO_PAIR_EDGE'        // v7: Combined ask >= 1 - buffer (no edge)
  | 'CONTRA_ENTRY_BLOCK'  // v7: Entry against spot direction
  | 'SAFETY_BLOCK'        // v6.6: Book is invalid/suspicious
  | 'EMERGENCY_UNWIND'    // v6.6: Emergency unwind in progress
  | 'EMERGENCY_COOLDOWN'  // v6.6: Cooling down after emergency
  | 'CPP_UNDEFINED_ONE_SIDED' // v6.6.1: paired=0, CPP guards not applicable
  | 'ONE_SIDED_CAP_BLOCK';    // v6.6.1: Would exceed one-sided notional cap

export interface ActionSkippedEvent {
  ts: number;
  marketId: string;
  asset: string;
  intendedAction: IntendedAction;
  reason: SkipReason;
  keyMetrics: {
    unpairedShares: number;
    unpairedNotionalUsd: number;
    inventoryRiskScore: number;
    secondsRemaining: number;
    pairCost: number | null;
    queueSize?: number;
    degradedMode?: boolean;
  };
}

export interface InventoryRiskState {
  marketId: string;
  asset: string;
  
  // Core metrics
  unpairedShares: number;
  unpairedNotionalUsd: number;
  unpairedAgeSec: number;
  inventoryRiskScore: number;
  
  // Tracking timestamps
  lastZeroUnpairedTs: number | null;  // When unpaired was last zero
  firstNonZeroUnpairedTs: number | null; // When unpaired became non-zero
  
  // Max values (for aggregation)
  inventoryRiskScoreMax: number;
  unpairedNotionalMax: number;
  unpairedAgeMaxSec: number;
  
  // Mode flags
  degradedMode: boolean;
  degradedModeEnterTs: number | null;
  degradedModeSecondsTotal: number;
  
  queueStress: boolean;
  queueStressEnterTs: number | null;
  queueStressSecondsTotal: number;
  
  // v6.6.0: Emergency unwind tracking
  emergencyUnwindActive: boolean;
  emergencyUnwindEnterTs: number | null;
  emergencyCooldownUntilTs: number | null;
  
  // v6.6.0: Safety block tracking (invalid book)
  safetyBlockActive: boolean;
  safetyBlockReason: string | null;
  
  // v6.6.0: Guardrail log throttle (state-change only)
  lastGuardrailState: string | null;
  lastGuardrailLogTs: number;
  
  // Action skip tracking
  actionSkippedCounts: Record<SkipReason, number>;
  
  // Last log timestamp (prevent spam)
  lastLogTs: number;
}

export interface MarketAggregation {
  marketId: string;
  asset: string;
  
  // From existing
  pairedDelaySec: number | null;
  
  // New v6.5.0
  unpairedNotionalMax: number;
  unpairedAgeMaxSec: number;
  inventoryRiskScoreMax: number;
  degradedModeSecondsTotal: number;
  queueStressSecondsTotal: number;
  actionSkippedCountsByReason: Record<SkipReason, number>;
}

// ============================================================
// INVENTORY RISK STORE
// ============================================================

const inventoryRiskStore = new Map<string, InventoryRiskState>();
let globalQueueSize = 0; // Updated externally
let globalQueueLastUpdate = 0;

export function getOrCreateRiskState(marketId: string, asset: string): InventoryRiskState {
  let state = inventoryRiskStore.get(marketId);
  if (!state) {
    state = {
      marketId,
      asset,
      unpairedShares: 0,
      unpairedNotionalUsd: 0,
      unpairedAgeSec: 0,
      inventoryRiskScore: 0,
      lastZeroUnpairedTs: null,
      firstNonZeroUnpairedTs: null,
      inventoryRiskScoreMax: 0,
      unpairedNotionalMax: 0,
      unpairedAgeMaxSec: 0,
      degradedMode: false,
      degradedModeEnterTs: null,
      degradedModeSecondsTotal: 0,
      queueStress: false,
      queueStressEnterTs: null,
      queueStressSecondsTotal: 0,
      // v6.6.0: Emergency unwind tracking
      emergencyUnwindActive: false,
      emergencyUnwindEnterTs: null,
      emergencyCooldownUntilTs: null,
      // v6.6.0: Safety block tracking
      safetyBlockActive: false,
      safetyBlockReason: null,
      // v6.6.0: Guardrail log throttle
      lastGuardrailState: null,
      lastGuardrailLogTs: 0,
      actionSkippedCounts: {} as Record<SkipReason, number>,
      lastLogTs: 0,
    };
    inventoryRiskStore.set(marketId, state);
  }
  return state;
}

export function clearRiskState(marketId: string): MarketAggregation | null {
  const state = inventoryRiskStore.get(marketId);
  if (!state) return null;
  
  // Return aggregation before clearing
  const agg: MarketAggregation = {
    marketId: state.marketId,
    asset: state.asset,
    pairedDelaySec: null, // Filled elsewhere
    unpairedNotionalMax: state.unpairedNotionalMax,
    unpairedAgeMaxSec: state.unpairedAgeMaxSec,
    inventoryRiskScoreMax: state.inventoryRiskScoreMax,
    degradedModeSecondsTotal: state.degradedModeSecondsTotal,
    queueStressSecondsTotal: state.queueStressSecondsTotal,
    actionSkippedCountsByReason: { ...state.actionSkippedCounts },
  };
  
  inventoryRiskStore.delete(marketId);
  return agg;
}

// ============================================================
// QUEUE STRESS MANAGEMENT
// ============================================================

export function updateQueueSize(size: number): void {
  globalQueueSize = size;
  globalQueueLastUpdate = Date.now();
}

export function isQueueStressed(): boolean {
  if (!INVENTORY_RISK_CONFIG.queueStressBackoffActive) return false;
  
  // Only trust queue size if recently updated
  const now = Date.now();
  if (now - globalQueueLastUpdate > INVENTORY_RISK_CONFIG.queueStressWindowMs * 2) {
    return false; // Stale data, assume not stressed
  }
  
  return globalQueueSize >= INVENTORY_RISK_CONFIG.queueStressSize;
}

export function getQueueSize(): number {
  return globalQueueSize;
}

// ============================================================
// INVENTORY RISK SCORE CALCULATION
// ============================================================

export interface InventoryMetrics {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  midPrice?: number; // Mid price of underlying side for notional calc
}

export function calculateInventoryRisk(
  marketId: string,
  asset: string,
  metrics: InventoryMetrics,
  nowMs: number = Date.now()
): InventoryRiskState {
  const state = getOrCreateRiskState(marketId, asset);
  const { upShares, downShares, upCost, downCost, midPrice } = metrics;
  
  // Calculate unpaired shares
  const unpaired = Math.abs(upShares - downShares);
  const unpairedSide = upShares > downShares ? 'UP' : 'DOWN';
  
  // Calculate unpaired notional
  // Use average cost of the unpaired side, or mid price if available
  let unpairedNotional = 0;
  if (unpaired > 0) {
    if (unpairedSide === 'UP' && upShares > 0) {
      const avgUp = upCost / upShares;
      unpairedNotional = unpaired * avgUp;
    } else if (unpairedSide === 'DOWN' && downShares > 0) {
      const avgDown = downCost / downShares;
      unpairedNotional = unpaired * avgDown;
    } else if (midPrice) {
      unpairedNotional = unpaired * midPrice;
    }
  }
  
  // Track when unpaired became non-zero
  if (unpaired === 0) {
    state.lastZeroUnpairedTs = nowMs;
    state.firstNonZeroUnpairedTs = null;
    state.unpairedAgeSec = 0;
  } else {
    if (state.firstNonZeroUnpairedTs === null) {
      state.firstNonZeroUnpairedTs = nowMs;
    }
    state.unpairedAgeSec = (nowMs - state.firstNonZeroUnpairedTs) / 1000;
  }
  
  // Calculate inventory risk score
  const riskScore = unpairedNotional * state.unpairedAgeSec;
  
  // Update state
  state.unpairedShares = unpaired;
  state.unpairedNotionalUsd = unpairedNotional;
  state.inventoryRiskScore = riskScore;
  
  // Update max values
  if (riskScore > state.inventoryRiskScoreMax) {
    state.inventoryRiskScoreMax = riskScore;
  }
  if (unpairedNotional > state.unpairedNotionalMax) {
    state.unpairedNotionalMax = unpairedNotional;
  }
  if (state.unpairedAgeSec > state.unpairedAgeMaxSec) {
    state.unpairedAgeMaxSec = state.unpairedAgeSec;
  }
  
  return state;
}

// ============================================================
// DEGRADED MODE MANAGEMENT
// ============================================================

export interface DegradedModeContext {
  hedgeFeasible: boolean;  // Can we hedge at acceptable price?
  unpairedNotional: number;
  unpairedAgeSec: number;
  riskScore: number;
}

export function evaluateDegradedMode(
  marketId: string,
  asset: string,
  ctx: DegradedModeContext,
  runId?: string
): { inDegradedMode: boolean; reason?: string } {
  const state = getOrCreateRiskState(marketId, asset);
  const now = Date.now();
  
  const wasInDegradedMode = state.degradedMode;
  
  // Exit conditions (check first)
  if (state.degradedMode) {
    const shouldExit = (
      ctx.hedgeFeasible && 
      ctx.unpairedNotional < INVENTORY_RISK_CONFIG.degradedTriggerNotional * 0.5
    ) || ctx.unpairedNotional === 0;
    
    if (shouldExit) {
      // Exit degraded mode
      if (state.degradedModeEnterTs) {
        state.degradedModeSecondsTotal += (now - state.degradedModeEnterTs) / 1000;
      }
      state.degradedMode = false;
      state.degradedModeEnterTs = null;
      
      if (INVENTORY_RISK_CONFIG.logEvents) {
        console.log(`🟢 [DEGRADED_MODE_EXIT] ${marketId} - hedge feasible, notional reduced`);
      }
      
      // Log event
      saveBotEvent({
        event_type: 'DEGRADED_MODE_EXIT',
        asset,
        market_id: marketId,
        run_id: runId,
        data: {
          unpairedNotional: ctx.unpairedNotional,
          unpairedAgeSec: ctx.unpairedAgeSec,
          degradedModeSecondsTotal: state.degradedModeSecondsTotal,
        },
        ts: now,
      }).catch(() => {});
      
      return { inDegradedMode: false, reason: 'Exited: hedge feasible and notional reduced' };
    }
  }
  
  // Entry conditions
  const triggerByNotionalAndAge = (
    ctx.unpairedNotional >= INVENTORY_RISK_CONFIG.degradedTriggerNotional &&
    ctx.unpairedAgeSec >= INVENTORY_RISK_CONFIG.degradedTriggerAgeSec
  );
  
  const triggerByRiskScore = (
    !ctx.hedgeFeasible && 
    ctx.riskScore >= INVENTORY_RISK_CONFIG.riskScoreTrigger
  );
  
  if (!state.degradedMode && (triggerByNotionalAndAge || triggerByRiskScore)) {
    // Enter degraded mode
    state.degradedMode = true;
    state.degradedModeEnterTs = now;
    
    const reason = triggerByNotionalAndAge 
      ? `Notional $${ctx.unpairedNotional.toFixed(2)} >= $${INVENTORY_RISK_CONFIG.degradedTriggerNotional} AND age ${ctx.unpairedAgeSec.toFixed(0)}s >= ${INVENTORY_RISK_CONFIG.degradedTriggerAgeSec}s`
      : `Risk score ${ctx.riskScore.toFixed(0)} >= ${INVENTORY_RISK_CONFIG.riskScoreTrigger} AND hedge infeasible`;
    
    if (INVENTORY_RISK_CONFIG.logEvents) {
      console.log(`🔴 [DEGRADED_MODE_ENTER] ${marketId}`);
      console.log(`   Reason: ${reason}`);
      console.log(`   Actions blocked: ADD, ACCUMULATE. Only HEDGE allowed.`);
    }
    
    // Log event
    saveBotEvent({
      event_type: 'DEGRADED_MODE_ENTER',
      asset,
      market_id: marketId,
      run_id: runId,
      data: {
        reason,
        unpairedNotional: ctx.unpairedNotional,
        unpairedAgeSec: ctx.unpairedAgeSec,
        riskScore: ctx.riskScore,
        hedgeFeasible: ctx.hedgeFeasible,
      },
      ts: now,
    }).catch(() => {});
    
    return { inDegradedMode: true, reason };
  }
  
  // Update time in degraded mode if still in it
  if (state.degradedMode && state.degradedModeEnterTs) {
    // Don't accumulate here - will be calculated at exit
  }
  
  return { 
    inDegradedMode: state.degradedMode, 
    reason: state.degradedMode ? 'Still in degraded mode' : undefined 
  };
}

export function isDegradedMode(marketId: string): boolean {
  const state = inventoryRiskStore.get(marketId);
  return state?.degradedMode ?? false;
}

// ============================================================
// QUEUE STRESS TRACKING
// ============================================================

export function evaluateQueueStress(
  marketId: string,
  asset: string,
  runId?: string
): { stressed: boolean } {
  const state = getOrCreateRiskState(marketId, asset);
  const now = Date.now();
  const wasStressed = state.queueStress;
  const isStressed = isQueueStressed();
  
  if (!wasStressed && isStressed) {
    // Enter queue stress
    state.queueStress = true;
    state.queueStressEnterTs = now;
    
    if (INVENTORY_RISK_CONFIG.logEvents) {
      console.log(`⚡ [QUEUE_STRESS_ENTER] Queue size ${globalQueueSize} >= ${INVENTORY_RISK_CONFIG.queueStressSize}`);
    }
    
    saveBotEvent({
      event_type: 'QUEUE_STRESS_ENTER',
      asset,
      market_id: marketId,
      run_id: runId,
      data: {
        queueSize: globalQueueSize,
        threshold: INVENTORY_RISK_CONFIG.queueStressSize,
      },
      ts: now,
    }).catch(() => {});
  } else if (wasStressed && !isStressed) {
    // Exit queue stress
    if (state.queueStressEnterTs) {
      state.queueStressSecondsTotal += (now - state.queueStressEnterTs) / 1000;
    }
    state.queueStress = false;
    state.queueStressEnterTs = null;
    
    if (INVENTORY_RISK_CONFIG.logEvents) {
      console.log(`✅ [QUEUE_STRESS_EXIT] Queue size ${globalQueueSize} < ${INVENTORY_RISK_CONFIG.queueStressSize}`);
    }
    
    saveBotEvent({
      event_type: 'QUEUE_STRESS_EXIT',
      asset,
      market_id: marketId,
      run_id: runId,
      data: {
        queueSize: globalQueueSize,
        queueStressSecondsTotal: state.queueStressSecondsTotal,
      },
      ts: now,
    }).catch(() => {});
  }
  
  return { stressed: state.queueStress };
}

// ============================================================
// ACTION SKIPPED LOGGING
// ============================================================

export function logActionSkipped(
  marketId: string,
  asset: string,
  intendedAction: IntendedAction,
  reason: SkipReason,
  keyMetrics: ActionSkippedEvent['keyMetrics'],
  runId?: string
): void;
export function logActionSkipped(event: {
  ts?: number;
  marketId: string;
  asset?: string;
  intendedAction: IntendedAction;
  reason: SkipReason;
  keyMetrics: ActionSkippedEvent['keyMetrics'];
  runId?: string;
}): void;
export function logActionSkipped(...args: any[]): void {
  // Backwards-compatible: support both the newer "args" signature and older "event object" signature.
  const normalized =
    args.length === 1 && args[0] && typeof args[0] === 'object'
      ? {
          ts: typeof args[0].ts === 'number' ? args[0].ts : Date.now(),
          marketId: args[0].marketId,
          asset: args[0].asset,
          intendedAction: args[0].intendedAction,
          reason: args[0].reason,
          keyMetrics: args[0].keyMetrics,
          runId: args[0].runId,
        }
      : {
          ts: Date.now(),
          marketId: args[0],
          asset: args[1],
          intendedAction: args[2],
          reason: args[3],
          keyMetrics: args[4],
          runId: args[5],
        };

  const derivedAsset =
    (typeof normalized.asset === 'string' && normalized.asset.trim())
      ? normalized.asset.trim()
      : (typeof normalized.marketId === 'string' && normalized.marketId.split('-')[0]
          ? normalized.marketId.split('-')[0].toUpperCase()
          : 'UNKNOWN');

  const marketId = normalized.marketId as string;
  const intendedAction = normalized.intendedAction as IntendedAction;
  const reason = normalized.reason as SkipReason;
  const keyMetrics = normalized.keyMetrics as ActionSkippedEvent['keyMetrics'];
  const runId = normalized.runId as string | undefined;

  const state = getOrCreateRiskState(marketId, derivedAsset);
  const now = Date.now();

  // Increment skip counter
  state.actionSkippedCounts[reason] = (state.actionSkippedCounts[reason] || 0) + 1;

  // Rate limit logging
  if (now - state.lastLogTs < INVENTORY_RISK_CONFIG.logIntervalMs) {
    return; // Don't spam logs
  }
  state.lastLogTs = now;

  if (INVENTORY_RISK_CONFIG.logEvents) {
    console.log(`⏭️ [ACTION_SKIPPED] ${intendedAction} on ${marketId}`);
    console.log(`   Reason: ${reason}`);
    if (keyMetrics) {
      console.log(
        `   Unpaired: ${keyMetrics.unpairedShares} shares ($${keyMetrics.unpairedNotionalUsd.toFixed(2)})`
      );
      console.log(
        `   Risk Score: ${keyMetrics.inventoryRiskScore.toFixed(0)} | Pair Cost: ${keyMetrics.pairCost?.toFixed(4) ?? 'N/A'}`
      );
      console.log(
        `   Time Left: ${keyMetrics.secondsRemaining}s | Degraded: ${keyMetrics.degradedMode ?? false}`
      );
    }
  }

  // Log to backend (only if we have valid data)
  const data = keyMetrics ? { intendedAction, ...keyMetrics } : { intendedAction };

  saveBotEvent({
    event_type: 'ACTION_SKIPPED',
    asset: derivedAsset,
    market_id: marketId,
    run_id: runId,
    reason_code: reason,
    data,
    ts: normalized.ts,
  }).catch(() => {});
}

// ============================================================
// GATING FUNCTIONS (Use these in main loop)
// ============================================================

export interface RiskGateResult {
  allowed: boolean;
  reason?: SkipReason;
  degradedMode: boolean;
  queueStress: boolean;
}

/**
 * Check if an action is allowed given current risk state.
 * Call this before executing any trade.
 */
export function checkRiskGate(
  marketId: string,
  asset: string,
  action: IntendedAction,
  metrics: InventoryMetrics,
  hedgeFeasible: boolean,
  secondsRemaining: number,
  pairCost: number | null,
  runId?: string
): RiskGateResult {
  const now = Date.now();
  
  // Calculate inventory risk
  const state = calculateInventoryRisk(marketId, asset, metrics, now);
  
  // Evaluate modes
  const degradedResult = evaluateDegradedMode(marketId, asset, {
    hedgeFeasible,
    unpairedNotional: state.unpairedNotionalUsd,
    unpairedAgeSec: state.unpairedAgeSec,
    riskScore: state.inventoryRiskScore,
  }, runId);
  
  const queueResult = evaluateQueueStress(marketId, asset, runId);
  
  // Build key metrics for logging
  const keyMetrics: ActionSkippedEvent['keyMetrics'] = {
    unpairedShares: state.unpairedShares,
    unpairedNotionalUsd: state.unpairedNotionalUsd,
    inventoryRiskScore: state.inventoryRiskScore,
    secondsRemaining,
    pairCost,
    queueSize: globalQueueSize,
    degradedMode: degradedResult.inDegradedMode,
  };
  
  // In degraded mode: only allow hedging actions
  if (degradedResult.inDegradedMode) {
    const isHedgeAction = action === 'MICRO_HEDGE' || action === 'ENTRY_HEDGE' || action === 'UNWIND' || action === 'REBALANCE';
    
    if (!isHedgeAction) {
      logActionSkipped(marketId, asset, action, 'DEGRADED_MODE', keyMetrics, runId);
      return {
        allowed: false,
        reason: 'DEGRADED_MODE',
        degradedMode: true,
        queueStress: queueResult.stressed,
      };
    }
  }
  
  // In queue stress: only allow hedging, no new entries
  if (queueResult.stressed) {
    const isNewEntry = action === 'ADD' || action === 'ACCUMULATE';
    
    if (isNewEntry) {
      logActionSkipped(marketId, asset, action, 'QUEUE_STRESS', keyMetrics, runId);
      return {
        allowed: false,
        reason: 'QUEUE_STRESS',
        degradedMode: degradedResult.inDegradedMode,
        queueStress: true,
      };
    }
  }
  
  return {
    allowed: true,
    degradedMode: degradedResult.inDegradedMode,
    queueStress: queueResult.stressed,
  };
}

/**
 * Get current risk metrics for snapshot logging
 */
export function getRiskMetricsForSnapshot(marketId: string): {
  unpairedShares: number;
  unpairedNotionalUsd: number;
  unpairedAgeSec: number;
  inventoryRiskScore: number;
  degradedMode: boolean;
  queueStress: boolean;
} | null {
  const state = inventoryRiskStore.get(marketId);
  if (!state) return null;
  
  return {
    unpairedShares: state.unpairedShares,
    unpairedNotionalUsd: state.unpairedNotionalUsd,
    unpairedAgeSec: state.unpairedAgeSec,
    inventoryRiskScore: state.inventoryRiskScore,
    degradedMode: state.degradedMode,
    queueStress: state.queueStress,
  };
}

/**
 * Get market aggregation for settlement logging
 */
export function getMarketAggregation(marketId: string): MarketAggregation | null {
  return clearRiskState(marketId);
}

// ============================================================
// v6.6.0: SAFETY BLOCK (Invalid Book Detection)
// ============================================================

export interface SafetyBlockResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Set safety block when orderbook is invalid/suspicious.
 * Blocks all trading except CANCEL_ALL.
 */
export function setSafetyBlock(
  marketId: string,
  asset: string,
  reason: string,
  runId?: string
): void {
  const state = getOrCreateRiskState(marketId, asset);
  const wasBlocked = state.safetyBlockActive;
  
  if (!wasBlocked) {
    state.safetyBlockActive = true;
    state.safetyBlockReason = reason;
    
    // Only log on state change
    console.log(`🚨 [SAFETY_BLOCK_ACTIVE] ${marketId}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   → All trading blocked except CANCEL_ALL`);
    
    saveBotEvent({
      event_type: 'SAFETY_BLOCK_ACTIVE',
      asset,
      market_id: marketId,
      run_id: runId,
      reason_code: 'INVALID_BOOK',
      data: { reason },
      ts: Date.now(),
    }).catch(() => {});
  }
}

/**
 * Clear safety block when book becomes valid again.
 */
export function clearSafetyBlock(
  marketId: string,
  asset: string,
  runId?: string
): void {
  const state = inventoryRiskStore.get(marketId);
  if (!state || !state.safetyBlockActive) return;
  
  state.safetyBlockActive = false;
  const oldReason = state.safetyBlockReason;
  state.safetyBlockReason = null;
  
  console.log(`✅ [SAFETY_BLOCK_CLEARED] ${marketId}`);
  console.log(`   Previous reason: ${oldReason}`);
  
  saveBotEvent({
    event_type: 'SAFETY_BLOCK_CLEARED',
    asset,
    market_id: marketId,
    run_id: runId,
    data: { previousReason: oldReason },
    ts: Date.now(),
  }).catch(() => {});
}

/**
 * Check if market is in safety block mode.
 */
export function isSafetyBlocked(marketId: string): SafetyBlockResult {
  const state = inventoryRiskStore.get(marketId);
  if (!state || !state.safetyBlockActive) {
    return { blocked: false };
  }
  return { blocked: true, reason: state.safetyBlockReason || 'INVALID_BOOK' };
}

// ============================================================
// v6.6.0: EMERGENCY UNWIND
// ============================================================

export interface EmergencyUnwindContext {
  costPerPaired: number;
  skewRatio: number;    // max(up,down)/total
  unpairedAgeSec: number;
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
  paired: number;
}

export interface EmergencyUnwindResult {
  triggerEmergency: boolean;
  reason?: string;
  dominantSide?: 'UP' | 'DOWN';
  implausibleCpp?: boolean;
}

/**
 * Check if emergency unwind should be triggered.
 * Triggers on:
 * - cpp >= 1.10 (ONLY when paired > 0)
 * - cpp > 1.50 (implausible - likely units bug, ONLY when paired > 0)
 * - skewRatio >= 0.70 AND unpairedAgeSec > 20
 * 
 * v6.6.1 FIX: CPP checks only apply when paired > 0 to prevent Infinity deadlock
 */
export function checkEmergencyUnwindTrigger(
  marketId: string,
  asset: string,
  ctx: EmergencyUnwindContext,
  runId?: string
): EmergencyUnwindResult {
  const state = getOrCreateRiskState(marketId, asset);
  const cfg = INVENTORY_RISK_CONFIG;
  const now = Date.now();
  
  const { skewRatio, unpairedAgeSec, upShares, downShares, upInvested, downInvested, paired } = ctx;
  const dominantSide: 'UP' | 'DOWN' = upShares > downShares ? 'UP' : 'DOWN';
  
  // v7.2.2 REV C.2: Use paired-only CPP (avgUp + avgDown) instead of totalInvested/paired
  // This prevents false positives from unpaired exposure inflating the CPP
  let cppPairedOnly: number | null = null;
  if (paired > 0) {
    const avgUpCents = upShares > 0 ? (upInvested / upShares) * 100 : null;
    const avgDownCents = downShares > 0 ? (downInvested / downShares) * 100 : null;
    
    if (avgUpCents !== null && avgDownCents !== null) {
      cppPairedOnly = (avgUpCents + avgDownCents) / 100; // Back to dollars for comparison
    }
  }
  
  // v6.6.1 FIX: CPP checks only apply when paired > 0 AND we have valid paired-only CPP
  if (paired > 0 && cppPairedOnly !== null) {
    // v7.2.1 HOTFIX: CPP_IMPLAUSIBLE must NOT trigger EMERGENCY_UNWIND
    // The CPP formula includes unpaired exposure, so high values are expected
    // and do not indicate a real emergency situation.
    // Instead: log throttled warning + return implausibleCpp flag for FREEZE_ADDS
    if (cppPairedOnly > cfg.cppImplausible) {
      // Throttle log to once per 30s per market
      const logKey = `cpp_implausible_warn_${marketId}`;
      if (!(global as any)[logKey] || (now - (global as any)[logKey] > 30000)) {
        (global as any)[logKey] = now;
        console.warn(`⚠️ [CPP_PAIRED_ONLY] ${marketId} cpp=${cppPairedOnly.toFixed(3)} > ${cfg.cppImplausible}`);
        console.warn(`   Formula: (avgUp + avgDown) = cppPairedOnly`);
        console.warn(`   upShares=${upShares}, downShares=${downShares}, paired=${paired}`);
        console.warn(`   → FREEZE_ADDS only (no emergency order placement)`);
      }
      // Return implausibleCpp=true so caller can set FREEZE_ADDS
      // But triggerEmergency=false to prevent order placement!
      return { triggerEmergency: false, reason: 'CPP_IMPLAUSIBLE_FREEZE_ADDS', dominantSide, implausibleCpp: true };
    }
    
    // CPP emergency check (>= 1.10)
    if (cppPairedOnly >= cfg.cppEmergency) {
      const reason = `CPP_EMERGENCY: cppPairedOnly=${cppPairedOnly.toFixed(3)} >= ${cfg.cppEmergency}`;
      triggerEmergencyUnwind(state, asset, reason, dominantSide, false, runId);
      return { triggerEmergency: true, reason, dominantSide };
    }
  }
  
  // Skew + age emergency check (applies even when paired=0)
  if (skewRatio >= cfg.hardSkewCap && unpairedAgeSec > cfg.skewAgeEmergencySec) {
    const reason = `SKEW_EMERGENCY: skew=${(skewRatio * 100).toFixed(1)}% >= ${(cfg.hardSkewCap * 100).toFixed(0)}% AND age=${unpairedAgeSec.toFixed(0)}s > ${cfg.skewAgeEmergencySec}s`;
    triggerEmergencyUnwind(state, asset, reason, dominantSide, false, runId);
    return { triggerEmergency: true, reason, dominantSide };
  }
  
  // Check if we should exit emergency mode
  if (state.emergencyUnwindActive && state.emergencyUnwindEnterTs) {
    const elapsed = (now - state.emergencyUnwindEnterTs) / 1000;
    if (elapsed >= cfg.emergencyUnwindMaxSec) {
      exitEmergencyUnwind(state, asset, 'max_duration_reached', runId);
    } else if (costPerPaired < cfg.cppEmergency && skewRatio < cfg.hardSkewCap) {
      exitEmergencyUnwind(state, asset, 'conditions_improved', runId);
    }
  }
  
  return { triggerEmergency: false };
}

function triggerEmergencyUnwind(
  state: InventoryRiskState,
  asset: string,
  reason: string,
  dominantSide: 'UP' | 'DOWN',
  implausible: boolean,
  runId?: string
): void {
  const now = Date.now();
  
  if (!state.emergencyUnwindActive) {
    state.emergencyUnwindActive = true;
    state.emergencyUnwindEnterTs = now;
    
    console.log(`🚨 [EMERGENCY_UNWIND_START] ${state.marketId}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Dominant: ${dominantSide} - will attempt to reduce`);
    console.log(`   Max duration: ${INVENTORY_RISK_CONFIG.emergencyUnwindMaxSec}s`);
    
    saveBotEvent({
      event_type: 'EMERGENCY_UNWIND_START',
      asset,
      market_id: state.marketId,
      run_id: runId,
      reason_code: implausible ? 'CPP_IMPLAUSIBLE' : 'CPP_EMERGENCY',
      data: {
        reason,
        dominantSide,
        implausible,
      },
      ts: now,
    }).catch(() => {});
  }
}

function exitEmergencyUnwind(
  state: InventoryRiskState,
  asset: string,
  exitReason: string,
  runId?: string
): void {
  const now = Date.now();
  const cfg = INVENTORY_RISK_CONFIG;
  
  state.emergencyUnwindActive = false;
  state.emergencyUnwindEnterTs = null;
  state.emergencyCooldownUntilTs = now + (cfg.cooldownAfterEmergencySec * 1000);
  
  console.log(`✅ [EMERGENCY_UNWIND_END] ${state.marketId}`);
  console.log(`   Exit reason: ${exitReason}`);
  console.log(`   Cooldown until: ${new Date(state.emergencyCooldownUntilTs).toISOString()}`);
  
  saveBotEvent({
    event_type: 'EMERGENCY_UNWIND_END',
    asset,
    market_id: state.marketId,
    run_id: runId,
    data: {
      exitReason,
      cooldownUntilTs: state.emergencyCooldownUntilTs,
      cooldownSec: cfg.cooldownAfterEmergencySec,
    },
    ts: now,
  }).catch(() => {});
}

/**
 * Check if market is in emergency unwind mode.
 */
export function isEmergencyUnwindActive(marketId: string): boolean {
  const state = inventoryRiskStore.get(marketId);
  return state?.emergencyUnwindActive ?? false;
}

/**
 * Check if market is in emergency cooldown (no new entries).
 */
export function isInEmergencyCooldown(marketId: string): boolean {
  const state = inventoryRiskStore.get(marketId);
  if (!state || !state.emergencyCooldownUntilTs) return false;
  return Date.now() < state.emergencyCooldownUntilTs;
}

// ============================================================
// v6.6.0: GUARDRAIL LOG THROTTLE (State-Change Only)
// ============================================================

export interface GuardrailLogContext {
  marketId: string;
  asset: string;
  trigger: string;
  paired: number;
  unpaired: number;
  totalInvested: number;
  costPerPaired: number;
  skewRatio: number;
  secondsRemaining: number;
  action: string;
}

/**
 * Log guardrail state only on change or every 5s.
 * Prevents log spam while maintaining observability.
 */
export function logGuardrailThrottled(ctx: GuardrailLogContext, runId?: string): void {
  const state = getOrCreateRiskState(ctx.marketId, ctx.asset);
  const now = Date.now();
  const cfg = INVENTORY_RISK_CONFIG;
  
  const currentState = ctx.trigger;
  const stateChanged = currentState !== state.lastGuardrailState;
  const intervalPassed = (now - state.lastGuardrailLogTs) >= cfg.logIntervalMs;
  
  // Only log on state change or interval
  if (!stateChanged && !intervalPassed) {
    return;
  }
  
  state.lastGuardrailState = currentState;
  state.lastGuardrailLogTs = now;
  
  // Only log if there's actually a guardrail triggered (not NONE)
  if (currentState === 'NONE') {
    return;
  }
  
  const emoji = currentState.includes('EMERGENCY') ? '🚨' : 
                currentState.includes('STOP') ? '🛑' :
                currentState.includes('SURVIVAL') ? '⏰' : '⚠️';
  
  console.log(`${emoji} [GUARDRAIL] ${currentState} on ${ctx.marketId}`);
  console.log(`   paired=${ctx.paired}, unpaired=${ctx.unpaired}, invested=$${ctx.totalInvested.toFixed(2)}`);
  console.log(`   cpp=${ctx.costPerPaired.toFixed(3)}, skew=${(ctx.skewRatio * 100).toFixed(1)}%, timeLeft=${ctx.secondsRemaining}s`);
  console.log(`   action=${ctx.action}`);
  
  // Log to backend
  saveBotEvent({
    event_type: 'GUARDRAIL_TRIGGERED',
    asset: ctx.asset,
    market_id: ctx.marketId,
    run_id: runId,
    reason_code: currentState,
    data: {
      trigger: currentState,
      paired: ctx.paired,
      unpaired: ctx.unpaired,
      totalInvested: ctx.totalInvested,
      costPerPaired: ctx.costPerPaired,
      skewRatio: ctx.skewRatio,
      secondsRemaining: ctx.secondsRemaining,
      action: ctx.action,
      stateChanged,
    },
    ts: now,
  }).catch(() => {});
}

// ============================================================
// EXPORTS
// ============================================================

export {
  inventoryRiskStore,
};