/**
 * hedge-priority.ts - v8.0 EXECUTION-FIRST SPEC
 * ==============================================
 * Hedge Priority Lane implementation.
 * 
 * Hedges bypass:
 * - Rate limiters
 * - Burst limiters
 * - CPP activity state blocking
 * - Normal mutex queuing (pre-emption)
 * 
 * Hedge escalation cadence:
 * - 0-10s: Maker at bestBid+1tick / bestAsk-1tick
 * - 10-30s: Tighter pricing (bestBid+2ticks / bestAsk-2ticks)
 * - 30-60s: SURVIVAL intent, reprice every 10s
 * - 60-90s from expiry: EMERGENCY_EXIT mode
 * - <90s + unhedged: Execute emergency taker exit
 */

import { saveBotEvent } from './backend.js';
import { PriceGuard, type BookSnapshot } from './price-guard.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const HEDGE_PRIORITY_CONFIG = {
  // Escalation time thresholds (seconds since entry fill)
  escalation: {
    normalHedgeMaxSec: 10,      // 0-10s: normal maker hedge
    urgentHedgeMaxSec: 30,      // 10-30s: urgent, tighter pricing
    survivalModeMaxSec: 60,     // 30-60s: survival mode, reprice every 10s
    emergencyExitSec: 90,       // <90s to expiry: emergency exit
  },
  
  // Reprice intervals
  repriceIntervalMs: {
    normal: 5_000,    // Every 5s in normal mode
    urgent: 3_000,    // Every 3s in urgent mode
    survival: 10_000, // Every 10s in survival mode
  },
  
  // Max hedge attempts before giving up and exiting
  maxHedgeAttempts: 10,
};

// ============================================================
// TYPES
// ============================================================

export type HedgeIntent = 'HEDGE' | 'HEDGE_URGENT' | 'SURVIVAL' | 'EMERGENCY_EXIT';

// Type alias for hard-invariants integration
export type IntentType = string;

export interface HedgeState {
  marketId: string;
  asset: string;
  entryFillTs: number;
  entrySide: 'UP' | 'DOWN';
  entryQty: number;
  hedgeAttempts: number;
  lastAttemptTs: number;
  currentIntent: HedgeIntent;
  hedgeFillTs: number | null;
  hedgeFillQty: number;
  resolved: boolean;
  resolution: 'PENDING' | 'HEDGED' | 'EXITED' | 'EXPIRED_UNHEDGED';
}

export interface HedgeDecision {
  shouldAct: boolean;
  intent: HedgeIntent;
  action: 'PLACE_HEDGE' | 'REPRICE_HEDGE' | 'EMERGENCY_EXIT' | 'WAIT' | 'GIVE_UP';
  reason: string;
  emergencyMode: boolean;
}

// ============================================================
// STATE
// ============================================================

// Active hedge states by market
const activeHedges = new Map<string, HedgeState>();

// ============================================================
// HEDGE STATE MANAGEMENT
// ============================================================

function getHedgeKey(marketId: string, asset: string): string {
  return `${marketId}:${asset}`;
}

/**
 * Start tracking a new hedge requirement (called after entry fill)
 */
export function startHedgeTracking(params: {
  marketId: string;
  asset: string;
  entrySide: 'UP' | 'DOWN';
  entryQty: number;
  runId?: string;
}): HedgeState {
  const { marketId, asset, entrySide, entryQty, runId } = params;
  const key = getHedgeKey(marketId, asset);
  const now = Date.now();
  
  const state: HedgeState = {
    marketId,
    asset,
    entryFillTs: now,
    entrySide,
    entryQty,
    hedgeAttempts: 0,
    lastAttemptTs: 0,
    currentIntent: 'HEDGE',
    hedgeFillTs: null,
    hedgeFillQty: 0,
    resolved: false,
    resolution: 'PENDING',
  };
  
  activeHedges.set(key, state);
  
  console.log(`🎯 HEDGE_STARTED: ${asset} ${marketId.slice(0, 12)}... entry=${entrySide} qty=${entryQty}`);
  
  saveBotEvent({
    event_type: 'HEDGE_STARTED',
    asset,
    market_id: marketId,
    ts: now,
    run_id: runId,
    data: {
      entrySide,
      entryQty,
    },
  }).catch(() => {});
  
  return state;
}

/**
 * Record hedge fill (partial or complete)
 */
export function recordHedgeFill(params: {
  marketId: string;
  asset: string;
  fillQty: number;
  runId?: string;
}): void {
  const { marketId, asset, fillQty, runId } = params;
  const key = getHedgeKey(marketId, asset);
  const state = activeHedges.get(key);
  
  if (!state) {
    console.warn(`⚠️ recordHedgeFill: no active hedge for ${asset} ${marketId.slice(0, 12)}...`);
    return;
  }
  
  const now = Date.now();
  state.hedgeFillQty += fillQty;
  
  if (state.hedgeFillTs === null) {
    state.hedgeFillTs = now;
  }
  
  // Check if fully hedged
  if (state.hedgeFillQty >= state.entryQty) {
    state.resolved = true;
    state.resolution = 'HEDGED';
    
    const hedgeLagMs = state.hedgeFillTs - state.entryFillTs;
    
    console.log(`✅ HEDGE_COMPLETED: ${asset} ${marketId.slice(0, 12)}... lag=${hedgeLagMs}ms attempts=${state.hedgeAttempts}`);
    
    saveBotEvent({
      event_type: 'HEDGE_COMPLETED',
      asset,
      market_id: marketId,
      ts: now,
      run_id: runId,
      data: {
        entryFillTs: state.entryFillTs,
        hedgeFillTs: state.hedgeFillTs,
        hedgeLagMs,
        hedgeAttempts: state.hedgeAttempts,
        finalState: 'HEDGED',
        exitUsed: false,
      },
    }).catch(() => {});
  }
}

/**
 * Record emergency exit execution
 */
export function recordEmergencyExit(params: {
  marketId: string;
  asset: string;
  exitQty: number;
  runId?: string;
}): void {
  const { marketId, asset, exitQty, runId } = params;
  const key = getHedgeKey(marketId, asset);
  const state = activeHedges.get(key);
  
  if (!state) return;
  
  const now = Date.now();
  state.resolved = true;
  state.resolution = 'EXITED';
  
  console.log(`🚨 HEDGE_EXITED: ${asset} ${marketId.slice(0, 12)}... via emergency exit`);
  
  saveBotEvent({
    event_type: 'HEDGE_COMPLETED',
    asset,
    market_id: marketId,
    ts: now,
    run_id: runId,
    data: {
      entryFillTs: state.entryFillTs,
      hedgeFillTs: null,
      hedgeLagMs: null,
      hedgeAttempts: state.hedgeAttempts,
      finalState: 'EXITED',
      exitUsed: true,
      exitQty,
    },
  }).catch(() => {});
}

/**
 * Mark hedge as expired unhedged (called at market expiry)
 */
export function markHedgeExpired(params: {
  marketId: string;
  asset: string;
  runId?: string;
}): void {
  const { marketId, asset, runId } = params;
  const key = getHedgeKey(marketId, asset);
  const state = activeHedges.get(key);
  
  if (!state || state.resolved) return;
  
  const now = Date.now();
  state.resolved = true;
  state.resolution = 'EXPIRED_UNHEDGED';
  
  console.log(`❌ HEDGE_FAILED: ${asset} ${marketId.slice(0, 12)}... expired unhedged after ${state.hedgeAttempts} attempts`);
  
  saveBotEvent({
    event_type: 'HEDGE_COMPLETED',
    asset,
    market_id: marketId,
    ts: now,
    run_id: runId,
    data: {
      entryFillTs: state.entryFillTs,
      hedgeFillTs: null,
      hedgeLagMs: null,
      hedgeAttempts: state.hedgeAttempts,
      finalState: 'EXPIRED_UNHEDGED',
      exitUsed: false,
    },
  }).catch(() => {});
}

/**
 * Clear hedge state (called after market expires/settles)
 */
export function clearHedgeState(marketId: string, asset: string): void {
  const key = getHedgeKey(marketId, asset);
  activeHedges.delete(key);
}

/**
 * Get active hedge state
 */
export function getHedgeState(marketId: string, asset: string): HedgeState | null {
  const key = getHedgeKey(marketId, asset);
  return activeHedges.get(key) || null;
}

// ============================================================
// HEDGE DECISION LOGIC
// ============================================================

/**
 * Determine what hedge action to take based on current state
 */
export function getHedgeDecision(params: {
  marketId: string;
  asset: string;
  secondsToExpiry: number;
  hasOpenHedgeOrder: boolean;
}): HedgeDecision {
  const { marketId, asset, secondsToExpiry, hasOpenHedgeOrder } = params;
  const key = getHedgeKey(marketId, asset);
  const state = activeHedges.get(key);
  
  // No active hedge needed
  if (!state || state.resolved) {
    return {
      shouldAct: false,
      intent: 'HEDGE',
      action: 'WAIT',
      reason: 'NO_ACTIVE_HEDGE',
      emergencyMode: false,
    };
  }
  
  const now = Date.now();
  const secsSinceEntry = (now - state.entryFillTs) / 1000;
  const cfg = HEDGE_PRIORITY_CONFIG;
  
  // Check if we should give up (too many attempts)
  if (state.hedgeAttempts >= cfg.maxHedgeAttempts) {
    return {
      shouldAct: true,
      intent: 'EMERGENCY_EXIT',
      action: 'EMERGENCY_EXIT',
      reason: `MAX_ATTEMPTS_REACHED: ${state.hedgeAttempts} attempts`,
      emergencyMode: true,
    };
  }
  
  // Determine intent based on time
  let intent: HedgeIntent = 'HEDGE';
  let repriceInterval = cfg.repriceIntervalMs.normal;
  
  if (secondsToExpiry <= cfg.escalation.emergencyExitSec) {
    intent = 'EMERGENCY_EXIT';
    repriceInterval = 0; // Immediate
  } else if (secsSinceEntry > cfg.escalation.survivalModeMaxSec) {
    intent = 'SURVIVAL';
    repriceInterval = cfg.repriceIntervalMs.survival;
  } else if (secsSinceEntry > cfg.escalation.urgentHedgeMaxSec) {
    intent = 'HEDGE_URGENT';
    repriceInterval = cfg.repriceIntervalMs.urgent;
  }
  
  state.currentIntent = intent;
  
  // Emergency exit mode
  if (intent === 'EMERGENCY_EXIT') {
    return {
      shouldAct: true,
      intent,
      action: 'EMERGENCY_EXIT',
      reason: `TIME_CRITICAL: ${secondsToExpiry}s to expiry, unhedged`,
      emergencyMode: true,
    };
  }
  
  // Check if we should reprice
  const timeSinceLastAttempt = now - state.lastAttemptTs;
  
  if (!hasOpenHedgeOrder) {
    // No order - place one
    state.hedgeAttempts++;
    state.lastAttemptTs = now;
    
    return {
      shouldAct: true,
      intent,
      action: 'PLACE_HEDGE',
      reason: `NO_OPEN_ORDER: attempt ${state.hedgeAttempts}`,
      emergencyMode: false,
    };
  }
  
  if (timeSinceLastAttempt >= repriceInterval) {
    // Time to reprice
    state.hedgeAttempts++;
    state.lastAttemptTs = now;
    
    return {
      shouldAct: true,
      intent,
      action: 'REPRICE_HEDGE',
      reason: `REPRICE: ${(timeSinceLastAttempt / 1000).toFixed(1)}s since last attempt`,
      emergencyMode: false,
    };
  }
  
  // Wait for reprice interval
  return {
    shouldAct: false,
    intent,
    action: 'WAIT',
    reason: `WAIT_FOR_REPRICE: ${((repriceInterval - timeSinceLastAttempt) / 1000).toFixed(1)}s remaining`,
    emergencyMode: false,
  };
}

/**
 * Calculate hedge price based on intent and book state
 */
export function calculateHedgePrice(params: {
  hedgeSide: 'UP' | 'DOWN';
  intent: HedgeIntent;
  book: BookSnapshot;
}): { price: number; emergencyMode: boolean } {
  const { hedgeSide, intent, book } = params;
  const orderSide = hedgeSide === 'UP' ? 'BUY' : 'BUY'; // We're buying the hedge side
  
  // For emergency, use aggressive pricing
  if (intent === 'EMERGENCY_EXIT') {
    // Cross the spread if needed
    return {
      price: book.bestAsk + 0.02, // 2 ticks above ask
      emergencyMode: true,
    };
  }
  
  // For normal/urgent/survival, use maker pricing
  const makerPrice = PriceGuard.selectMakerBuyPrice(book);
  
  // Adjust based on urgency
  let adjustedPrice = makerPrice;
  
  if (intent === 'HEDGE_URGENT') {
    // Move 1 tick closer to ask
    adjustedPrice = Math.min(makerPrice + 0.01, book.bestAsk - 0.01);
  } else if (intent === 'SURVIVAL') {
    // Move 2 ticks closer to ask (but still maker)
    adjustedPrice = Math.min(makerPrice + 0.02, book.bestAsk - 0.01);
  }
  
  return {
    price: PriceGuard.roundBuyPrice(adjustedPrice),
    emergencyMode: false,
  };
}

// ============================================================
// PRIORITY LANE BYPASS CHECKS
// ============================================================

/**
 * Check if intent qualifies for hedge priority lane
 */
export function isHedgePriorityIntent(intent: string): boolean {
  const priorityIntents = ['HEDGE', 'HEDGE_URGENT', 'SURVIVAL', 'EMERGENCY_EXIT', 'FORCE', 'force_hedge', 'panic_hedge'];
  return priorityIntents.includes(intent);
}

/**
 * Check if rate limiter should be bypassed for this intent
 */
export function shouldBypassRateLimiter(intent: string): boolean {
  return isHedgePriorityIntent(intent);
}

/**
 * Check if burst limiter should be bypassed for this intent
 */
export function shouldBypassBurstLimiter(intent: string): boolean {
  return isHedgePriorityIntent(intent);
}

/**
 * Check if CPP gating should be bypassed for this intent
 */
export function shouldBypassCppGating(intent: string): boolean {
  return isHedgePriorityIntent(intent);
}

/**
 * Get escalation level name based on seconds since entry
 */
export function getEscalationLevel(secsSinceEntry: number): HedgeIntent {
  const cfg = HEDGE_PRIORITY_CONFIG.escalation;
  
  if (secsSinceEntry <= cfg.normalHedgeMaxSec) return 'HEDGE';
  if (secsSinceEntry <= cfg.urgentHedgeMaxSec) return 'HEDGE_URGENT';
  if (secsSinceEntry <= cfg.survivalModeMaxSec) return 'SURVIVAL';
  return 'EMERGENCY_EXIT';
}

// ============================================================
// EXPORTS
// ============================================================

export const HedgePriority = {
  // State management
  startHedgeTracking,
  recordHedgeFill,
  recordEmergencyExit,
  markHedgeExpired,
  clearHedgeState,
  getHedgeState,
  
  // Decision logic
  getHedgeDecision,
  calculateHedgePrice,
  getEscalationLevel,
  
  // Bypass checks
  isHedgePriorityIntent,
  shouldBypassRateLimiter,
  shouldBypassBurstLimiter,
  shouldBypassCppGating,
  
  // Config
  CONFIG: HEDGE_PRIORITY_CONFIG,
};

export default HedgePriority;
