/**
 * v7-patch.ts - v7.0.1 Minimal Patch Layer
 * ============================================================
 * PATCH-ONLY: Adds 5 MUST patches on top of existing v6 infrastructure.
 * 
 * Patches:
 * 1. Readiness Gate + Timeout (12s)
 * 2. Bounded per-market intent slots (no drop queue)
 * 3. Micro-hedge accumulator (min order size safe)
 * 4. Degraded mode via riskScore threshold
 * 5. Queue-stress gating
 * 
 * Does NOT replace:
 * - hedge-escalator.ts (retry/backoff)
 * - order-rate-limiter.ts
 * - inventory-risk.ts (basis degraded)
 * - resolved-config.ts (config unification)
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// PATCH VERSION
// ============================================================
export const V7_PATCH_VERSION = '7.0.1';

// ============================================================
// 1. READINESS GATE + TIMEOUT
// ============================================================

export interface BookTop {
  bid: number | null;
  ask: number | null;
}

export interface MarketBook {
  up: BookTop;
  down: BookTop;
  updatedAtMs: number;
}

export interface ReadinessState {
  marketId: string;
  marketOpenTs: number;
  upReady: boolean;
  downReady: boolean;
  disabled: boolean;
  disabledReason?: string;
  lastCheckTs: number;
}

const V7_READINESS_CONFIG = {
  maxSnapshotAgeMs: 2000,          // Orderbook must be < 2s old
  minLevels: 1,                     // At least 1 level required
  disableTimeoutSec: 12,            // Disable market if not ready after 12s
};

const readinessStore = new Map<string, ReadinessState>();

/**
 * Check if a single token side is ready
 */
export function isTokenReady(book: BookTop, bookAgeMs: number): boolean {
  // Must have book data
  if (!book) return false;
  
  // Must have bid OR ask
  if (book.bid === null && book.ask === null) return false;
  
  // Must be fresh
  if (bookAgeMs > V7_READINESS_CONFIG.maxSnapshotAgeMs) return false;
  
  return true;
}

/**
 * Check if entire market (both UP and DOWN) is ready for trading
 */
export function isMarketReady(
  book: MarketBook,
  nowMs: number = Date.now()
): { ready: boolean; upReady: boolean; downReady: boolean; reason?: string } {
  const bookAgeMs = nowMs - book.updatedAtMs;
  
  const upReady = isTokenReady(book.up, bookAgeMs);
  const downReady = isTokenReady(book.down, bookAgeMs);
  
  if (!upReady && !downReady) {
    return { ready: false, upReady, downReady, reason: 'BOTH_SIDES_NOT_READY' };
  }
  if (!upReady) {
    return { ready: false, upReady, downReady, reason: 'UP_NOT_READY' };
  }
  if (!downReady) {
    return { ready: false, upReady, downReady, reason: 'DOWN_NOT_READY' };
  }
  
  return { ready: true, upReady, downReady };
}

/**
 * Check readiness gate with 12s timeout - returns whether trading is allowed
 */
export function checkReadinessGate(
  marketId: string,
  book: MarketBook,
  marketOpenTs: number,
  asset: string,
  runId?: string,
  nowMs: number = Date.now()
): { allowed: boolean; disabled: boolean; reason?: string } {
  // Get or create state
  let state = readinessStore.get(marketId);
  if (!state) {
    state = {
      marketId,
      marketOpenTs,
      upReady: false,
      downReady: false,
      disabled: false,
      lastCheckTs: nowMs,
    };
    readinessStore.set(marketId, state);
  }
  
  // If already disabled, stay disabled
  if (state.disabled) {
    return { allowed: false, disabled: true, reason: state.disabledReason };
  }
  
  // Check current readiness
  const readiness = isMarketReady(book, nowMs);
  state.upReady = readiness.upReady;
  state.downReady = readiness.downReady;
  state.lastCheckTs = nowMs;
  
  if (readiness.ready) {
    return { allowed: true, disabled: false };
  }
  
  // Not ready - check if we should disable
  const secSinceOpen = (nowMs - marketOpenTs) / 1000;
  
  if (secSinceOpen > V7_READINESS_CONFIG.disableTimeoutSec) {
    // DISABLE this market until next round
    state.disabled = true;
    state.disabledReason = `MARKET_DISABLED_NO_ORDERBOOK: not ready after ${V7_READINESS_CONFIG.disableTimeoutSec}s`;
    
    console.log(`🚫 [v7.0.1] MARKET DISABLED: ${marketId}`);
    console.log(`   Reason: ${readiness.reason}`);
    console.log(`   Time since open: ${secSinceOpen.toFixed(1)}s > ${V7_READINESS_CONFIG.disableTimeoutSec}s threshold`);
    
    // Log event
    saveBotEvent({
      event_type: 'MARKET_DISABLED_NO_ORDERBOOK',
      asset,
      market_id: marketId,
      run_id: runId,
      reason_code: readiness.reason,
      data: {
        secSinceOpen,
        upReady: readiness.upReady,
        downReady: readiness.downReady,
        bookAgeMs: nowMs - book.updatedAtMs,
      },
      ts: nowMs,
    }).catch(() => {});
    
    return { allowed: false, disabled: true, reason: state.disabledReason };
  }
  
  // Not ready but not timed out yet - block but don't disable
  return { allowed: false, disabled: false, reason: readiness.reason };
}

/**
 * Clear readiness state for a market (e.g. when market ends)
 */
export function clearReadinessState(marketId: string): void {
  readinessStore.delete(marketId);
}

// ============================================================
// 2. BOUNDED PER-MARKET INTENT SLOTS
// ============================================================

export type IntentType = 'ENTRY' | 'ACCUMULATE' | 'HEDGE' | 'MICRO_HEDGE';

export interface PendingIntent {
  type: IntentType;
  side: 'UP' | 'DOWN';
  shares: number;
  price: number;
  createdTs: number;
  correlationId?: string;
}

export interface MarketIntentSlots {
  // Single slot for ENTRY/ACCUMULATE - latest overwrites
  entrySlot: PendingIntent | null;
  // Single slot for HEDGE/MICRO_HEDGE - priority, cannot be overwritten except by newer hedge
  hedgeSlot: PendingIntent | null;
}

const intentSlotsStore = new Map<string, MarketIntentSlots>();

/**
 * Get intent slots for a market
 */
export function getIntentSlots(marketId: string): MarketIntentSlots {
  let slots = intentSlotsStore.get(marketId);
  if (!slots) {
    slots = { entrySlot: null, hedgeSlot: null };
    intentSlotsStore.set(marketId, slots);
  }
  return slots;
}

/**
 * Set pending entry intent (overwrites any existing entry intent)
 */
export function setPendingEntry(
  marketId: string,
  intent: Omit<PendingIntent, 'createdTs'>
): void {
  const slots = getIntentSlots(marketId);
  slots.entrySlot = { ...intent, createdTs: Date.now() };
}

/**
 * Set pending hedge intent (overwrites existing hedge)
 */
export function setPendingHedge(
  marketId: string,
  intent: Omit<PendingIntent, 'createdTs'>
): void {
  const slots = getIntentSlots(marketId);
  slots.hedgeSlot = { ...intent, createdTs: Date.now() };
}

/**
 * Clear entry slot after execution
 */
export function clearEntrySlot(marketId: string): void {
  const slots = intentSlotsStore.get(marketId);
  if (slots) slots.entrySlot = null;
}

/**
 * Clear hedge slot after execution
 */
export function clearHedgeSlot(marketId: string): void {
  const slots = intentSlotsStore.get(marketId);
  if (slots) slots.hedgeSlot = null;
}

/**
 * Get count of pending intents for a market (max 2)
 */
export function getPendingIntentCount(marketId: string): number {
  const slots = getIntentSlots(marketId);
  let count = 0;
  if (slots.entrySlot) count++;
  if (slots.hedgeSlot) count++;
  return count;
}

/**
 * Check if market has room for a new intent of given type
 */
export function canAddIntent(marketId: string, type: IntentType): boolean {
  const slots = getIntentSlots(marketId);
  
  if (type === 'ENTRY' || type === 'ACCUMULATE') {
    // Entry slot - always can add (overwrites)
    return true;
  }
  
  if (type === 'HEDGE' || type === 'MICRO_HEDGE') {
    // Hedge slot - always can add (overwrites)
    return true;
  }
  
  return true;
}

/**
 * Clear all intent slots for a market
 */
export function clearIntentSlots(marketId: string): void {
  intentSlotsStore.delete(marketId);
}

// ============================================================
// 3. MICRO-HEDGE ACCUMULATOR
// ============================================================

export interface MicroHedgeAccumulator {
  marketId: string;
  hedgeNeededShares: number;
  lastAccumulateTs: number;
}

const V7_MICRO_HEDGE_CONFIG = {
  minLotShares: 5,                  // Minimum shares to place hedge
  urgentThresholdSec: 60,           // Force hedge even if < minLotShares when < 60s remaining
};

const microHedgeAccumulators = new Map<string, MicroHedgeAccumulator>();

/**
 * Get accumulator for a market
 */
export function getMicroHedgeAccumulator(marketId: string): MicroHedgeAccumulator {
  let acc = microHedgeAccumulators.get(marketId);
  if (!acc) {
    acc = { marketId, hedgeNeededShares: 0, lastAccumulateTs: 0 };
    microHedgeAccumulators.set(marketId, acc);
  }
  return acc;
}

/**
 * Accumulate hedge needed shares (call after fill delta)
 */
export function accumulateHedgeNeeded(marketId: string, deltaShares: number): number {
  const acc = getMicroHedgeAccumulator(marketId);
  acc.hedgeNeededShares += deltaShares;
  acc.lastAccumulateTs = Date.now();
  return acc.hedgeNeededShares;
}

/**
 * Check if we should place micro-hedge now
 */
export function shouldPlaceMicroHedge(
  marketId: string,
  secondsRemaining: number
): { should: boolean; shares: number; reason: string } {
  const acc = getMicroHedgeAccumulator(marketId);
  
  if (acc.hedgeNeededShares <= 0) {
    return { should: false, shares: 0, reason: 'NO_HEDGE_NEEDED' };
  }
  
  // Check if urgent (< 60s remaining)
  const isUrgent = secondsRemaining <= V7_MICRO_HEDGE_CONFIG.urgentThresholdSec;
  
  if (isUrgent) {
    // Urgent: hedge any amount
    const shares = Math.ceil(acc.hedgeNeededShares);
    return { should: true, shares, reason: 'URGENT_HEDGE' };
  }
  
  // Normal: only hedge if >= minLotShares
  if (acc.hedgeNeededShares >= V7_MICRO_HEDGE_CONFIG.minLotShares) {
    const shares = Math.floor(acc.hedgeNeededShares);
    return { should: true, shares, reason: 'ACCUMULATED_MIN_LOT' };
  }
  
  return { 
    should: false, 
    shares: 0, 
    reason: `BELOW_MIN_LOT: ${acc.hedgeNeededShares.toFixed(1)} < ${V7_MICRO_HEDGE_CONFIG.minLotShares}` 
  };
}

/**
 * Clear accumulator after hedge placed
 */
export function clearMicroHedgeAccumulator(marketId: string, hedgedShares: number): void {
  const acc = getMicroHedgeAccumulator(marketId);
  acc.hedgeNeededShares = Math.max(0, acc.hedgeNeededShares - hedgedShares);
}

/**
 * Reset accumulator for a market
 */
export function resetMicroHedgeAccumulator(marketId: string): void {
  microHedgeAccumulators.delete(marketId);
}

// ============================================================
// 4. DEGRADED MODE VIA RISK SCORE
// ============================================================

const V7_DEGRADED_CONFIG = {
  riskScoreThreshold: 400,          // riskScore = unpairedNotional * unpairedAgeSec
  minNotionalForRisk: 5,            // Don't calc risk if notional < $5
};

export interface RiskScoreResult {
  riskScore: number;
  unpairedNotional: number;
  unpairedAgeSec: number;
  inDegradedMode: boolean;
}

/**
 * Calculate inventory risk score
 * riskScore = unpairedNotional * unpairedAgeSec
 */
export function calculateRiskScore(
  unpairedNotional: number,
  unpairedAgeSec: number
): RiskScoreResult {
  // Skip if notional too low
  if (unpairedNotional < V7_DEGRADED_CONFIG.minNotionalForRisk) {
    return {
      riskScore: 0,
      unpairedNotional,
      unpairedAgeSec,
      inDegradedMode: false,
    };
  }
  
  const riskScore = unpairedNotional * unpairedAgeSec;
  const inDegradedMode = riskScore >= V7_DEGRADED_CONFIG.riskScoreThreshold;
  
  return {
    riskScore,
    unpairedNotional,
    unpairedAgeSec,
    inDegradedMode,
  };
}

/**
 * Check if action is allowed given degraded mode
 * In degraded: block ENTRY/ACCUMULATE, allow hedges/unwind only
 */
export function isActionAllowedInDegradedMode(
  action: IntentType | 'UNWIND',
  inDegradedMode: boolean
): { allowed: boolean; reason?: string } {
  if (!inDegradedMode) {
    return { allowed: true };
  }
  
  // In degraded mode
  if (action === 'ENTRY' || action === 'ACCUMULATE') {
    return { allowed: false, reason: 'DEGRADED_MODE_BLOCKS_ENTRY' };
  }
  
  // Allow hedges and unwind
  return { allowed: true };
}

// ============================================================
// 5. QUEUE-STRESS GATING
// ============================================================

const V7_QUEUE_STRESS_CONFIG = {
  maxPendingPerMarket: 2,           // Max pending intents per market
  globalStressThreshold: 6,         // Global queue stress threshold
};

let globalPendingCount = 0;
let queueStressActive = false;
let queueStressEnterTs: number | null = null;

/**
 * Update global pending count
 */
export function updateGlobalPendingCount(count: number): void {
  const wasStressed = queueStressActive;
  globalPendingCount = count;
  queueStressActive = count >= V7_QUEUE_STRESS_CONFIG.globalStressThreshold;
  
  if (!wasStressed && queueStressActive) {
    queueStressEnterTs = Date.now();
    console.log(`⚡ [v7.0.1] QUEUE_STRESS_ENTER: ${count} >= ${V7_QUEUE_STRESS_CONFIG.globalStressThreshold}`);
  } else if (wasStressed && !queueStressActive) {
    const durationSec = queueStressEnterTs ? (Date.now() - queueStressEnterTs) / 1000 : 0;
    console.log(`✅ [v7.0.1] QUEUE_STRESS_EXIT: ${count} < ${V7_QUEUE_STRESS_CONFIG.globalStressThreshold} (was stressed ${durationSec.toFixed(1)}s)`);
    queueStressEnterTs = null;
  }
}

/**
 * Check if queue is stressed
 */
export function isQueueStressed(): boolean {
  return queueStressActive;
}

/**
 * Check if action is allowed given queue stress
 * In stress: block ENTRY/ACCUMULATE, allow hedges
 */
export function isActionAllowedInQueueStress(
  action: IntentType | 'UNWIND'
): { allowed: boolean; reason?: string } {
  if (!queueStressActive) {
    return { allowed: true };
  }
  
  // In queue stress
  if (action === 'ENTRY' || action === 'ACCUMULATE') {
    return { allowed: false, reason: 'QUEUE_STRESS_BLOCKS_ENTRY' };
  }
  
  // Allow hedges and unwind
  return { allowed: true };
}

// ============================================================
// COMBINED GATE CHECK (all v7.0.1 patches)
// ============================================================

export interface V7GateResult {
  allowed: boolean;
  reason?: string;
  details?: {
    readinessBlocked?: boolean;
    degradedBlocked?: boolean;
    queueStressBlocked?: boolean;
    marketDisabled?: boolean;
  };
}

/**
 * Combined v7.0.1 gate check - run ALL patches
 */
export function checkV7Gates(
  marketId: string,
  book: MarketBook,
  marketOpenTs: number,
  asset: string,
  action: IntentType | 'UNWIND',
  riskScore: RiskScoreResult,
  runId?: string
): V7GateResult {
  const details: V7GateResult['details'] = {};
  
  // 1. Readiness gate
  const readiness = checkReadinessGate(marketId, book, marketOpenTs, asset, runId);
  if (!readiness.allowed) {
    details.readinessBlocked = true;
    details.marketDisabled = readiness.disabled;
    return { allowed: false, reason: readiness.reason, details };
  }
  
  // 2. Degraded mode check
  const degradedCheck = isActionAllowedInDegradedMode(action, riskScore.inDegradedMode);
  if (!degradedCheck.allowed) {
    details.degradedBlocked = true;
    return { allowed: false, reason: degradedCheck.reason, details };
  }
  
  // 3. Queue stress check
  const queueCheck = isActionAllowedInQueueStress(action);
  if (!queueCheck.allowed) {
    details.queueStressBlocked = true;
    return { allowed: false, reason: queueCheck.reason, details };
  }
  
  return { allowed: true, details };
}

// ============================================================
// LOGGING / STATS
// ============================================================

export interface V7PatchStats {
  version: string;
  readiness: {
    marketsTracked: number;
    marketsDisabled: number;
  };
  intents: {
    marketsWithPending: number;
    totalPendingSlots: number;
  };
  microHedge: {
    marketsWithAccumulator: number;
    totalAccumulatedShares: number;
  };
  queueStress: {
    isStressed: boolean;
    globalPendingCount: number;
  };
}

export function getV7PatchStats(): V7PatchStats {
  let marketsDisabled = 0;
  for (const state of readinessStore.values()) {
    if (state.disabled) marketsDisabled++;
  }
  
  let totalPendingSlots = 0;
  for (const slots of intentSlotsStore.values()) {
    if (slots.entrySlot) totalPendingSlots++;
    if (slots.hedgeSlot) totalPendingSlots++;
  }
  
  let totalAccumulatedShares = 0;
  for (const acc of microHedgeAccumulators.values()) {
    totalAccumulatedShares += acc.hedgeNeededShares;
  }
  
  return {
    version: V7_PATCH_VERSION,
    readiness: {
      marketsTracked: readinessStore.size,
      marketsDisabled,
    },
    intents: {
      marketsWithPending: intentSlotsStore.size,
      totalPendingSlots,
    },
    microHedge: {
      marketsWithAccumulator: microHedgeAccumulators.size,
      totalAccumulatedShares,
    },
    queueStress: {
      isStressed: queueStressActive,
      globalPendingCount,
    },
  };
}

/**
 * Log v7 patch status (for periodic logging)
 */
export function logV7PatchStatus(): void {
  const stats = getV7PatchStats();
  console.log(`\n📊 [v7.0.1] PATCH STATUS:`);
  console.log(`   Readiness: ${stats.readiness.marketsTracked} tracked, ${stats.readiness.marketsDisabled} disabled`);
  console.log(`   Intent Slots: ${stats.intents.totalPendingSlots} pending across ${stats.intents.marketsWithPending} markets`);
  console.log(`   Micro-Hedge: ${stats.microHedge.totalAccumulatedShares.toFixed(1)} shares accumulated`);
  console.log(`   Queue Stress: ${stats.queueStress.isStressed ? 'STRESSED' : 'OK'} (${stats.queueStress.globalPendingCount} pending)`);
}
