/**
 * market-mutex.ts - v7.2.7 CONCURRENCY-SAFE PER-MARKET MUTEX
 * ===========================================================
 * Implements async lock per marketId to prevent concurrent evaluateMarket() ticks
 * from placing multiple orders before the ledger updates.
 * 
 * REQUIREMENT (from revC4.1 spec):
 * 1) Only ONE evaluate+place path may run at a time per marketId
 * 2) If a tick arrives while locked: DROP (skip) the tick
 * 3) Wrap the ENTIRE market evaluation + order placements in the lock
 * 
 * LOGGING:
 * - MARKET_LOCK_ACQUIRED marketId
 * - MARKET_LOCK_SKIPPED marketId reason=LOCKED
 * - MARKET_LOCK_RELEASED marketId
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const MARKET_MUTEX_CONFIG = {
  // Logging throttle to prevent spam
  logThrottleMs: 5000,
  // Enable debounce-once behavior (queue 1 retry after unlock)
  enableDebounceOnce: false,
  // Maximum lock hold time before auto-release (safety net)
  maxLockHoldMs: 30_000,
};

// ============================================================
// TYPES
// ============================================================

interface LockState {
  locked: boolean;
  lockedAt: number;
  lockedBy: string;
  debounceQueued: boolean;
}

export interface AcquireResult {
  acquired: boolean;
  release: () => void;
  reason?: string;
}

// ============================================================
// MUTEX STATE (in-memory, keyed by "marketId:asset")
// ============================================================

const lockState = new Map<string, LockState>();
const logThrottleMap = new Map<string, number>();

function key(marketId: string, asset: string): string {
  return `${marketId}:${asset}`;
}

function shouldLog(eventKey: string): boolean {
  const now = Date.now();
  const lastLog = logThrottleMap.get(eventKey) || 0;
  if (now - lastLog > MARKET_MUTEX_CONFIG.logThrottleMs) {
    logThrottleMap.set(eventKey, now);
    return true;
  }
  return false;
}

// ============================================================
// MUTEX API
// ============================================================

/**
 * Try to acquire the lock for a market.
 * If already locked, returns { acquired: false }.
 * If acquired, returns { acquired: true, release: () => void }.
 */
export function tryAcquire(
  marketId: string,
  asset: string,
  caller: string = 'unknown',
  runId?: string
): AcquireResult {
  const k = key(marketId, asset);
  const now = Date.now();
  
  let state = lockState.get(k);
  
  // Check for stale lock (safety net)
  if (state?.locked) {
    const lockAge = now - state.lockedAt;
    if (lockAge > MARKET_MUTEX_CONFIG.maxLockHoldMs) {
      console.warn(`⚠️ [MUTEX] STALE_LOCK_CLEARED: ${asset} held for ${(lockAge / 1000).toFixed(1)}s by ${state.lockedBy}`);
      state.locked = false;
      state.lockedBy = '';
      
      saveBotEvent({
        event_type: 'MARKET_LOCK_STALE_CLEARED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        data: { lockAgeMs: lockAge, previousHolder: state.lockedBy },
      }).catch(() => {});
    }
  }
  
  // Check if locked
  if (state?.locked) {
    // LOCKED - skip this tick
    if (shouldLog(`skip_${k}`)) {
      console.log(`🔒 [MUTEX] MARKET_LOCK_SKIPPED: ${asset} ${marketId.slice(-15)} reason=LOCKED by=${state.lockedBy}`);
      
      saveBotEvent({
        event_type: 'MARKET_LOCK_SKIPPED',
        asset,
        market_id: marketId,
        ts: now,
        run_id: runId,
        data: { reason: 'LOCKED', lockedBy: state.lockedBy, caller },
      }).catch(() => {});
    }
    
    // Optional: queue a debounce retry
    if (MARKET_MUTEX_CONFIG.enableDebounceOnce && !state.debounceQueued) {
      state.debounceQueued = true;
    }
    
    return {
      acquired: false,
      release: () => {},
      reason: `LOCKED by ${state.lockedBy}`,
    };
  }
  
  // ACQUIRE LOCK
  if (!state) {
    state = {
      locked: true,
      lockedAt: now,
      lockedBy: caller,
      debounceQueued: false,
    };
    lockState.set(k, state);
  } else {
    state.locked = true;
    state.lockedAt = now;
    state.lockedBy = caller;
    state.debounceQueued = false;
  }
  
  if (shouldLog(`acquire_${k}`)) {
    console.log(`🔓 [MUTEX] MARKET_LOCK_ACQUIRED: ${asset} ${marketId.slice(-15)} by=${caller}`);
  }
  
  // Return release function
  const release = () => {
    const s = lockState.get(k);
    if (s && s.locked) {
      s.locked = false;
      s.lockedBy = '';
      
      if (shouldLog(`release_${k}`)) {
        console.log(`🔓 [MUTEX] MARKET_LOCK_RELEASED: ${asset} ${marketId.slice(-15)}`);
      }
    }
  };
  
  return { acquired: true, release };
}

/**
 * Check if a market is currently locked.
 */
export function isLocked(marketId: string, asset: string): boolean {
  const k = key(marketId, asset);
  const state = lockState.get(k);
  return state?.locked ?? false;
}

/**
 * Force release a lock (for cleanup, e.g., on market expiry).
 */
export function forceRelease(marketId: string, asset: string): void {
  const k = key(marketId, asset);
  lockState.delete(k);
}

/**
 * Get mutex stats for diagnostics.
 */
export function getMutexStats(): {
  lockedMarkets: number;
  markets: Array<{ key: string; lockedBy: string; lockAgeMs: number }>;
} {
  const now = Date.now();
  const markets: Array<{ key: string; lockedBy: string; lockAgeMs: number }> = [];
  
  for (const [k, state] of lockState) {
    if (state.locked) {
      markets.push({
        key: k,
        lockedBy: state.lockedBy,
        lockAgeMs: now - state.lockedAt,
      });
    }
  }
  
  return {
    lockedMarkets: markets.length,
    markets,
  };
}

// ============================================================
// WRAPPER FOR CRITICAL SECTIONS
// ============================================================

/**
 * Execute a function while holding the market lock.
 * If lock cannot be acquired, returns null.
 */
export async function withMarketLock<T>(
  marketId: string,
  asset: string,
  caller: string,
  fn: () => Promise<T>,
  runId?: string
): Promise<T | null> {
  const lock = tryAcquire(marketId, asset, caller, runId);
  
  if (!lock.acquired) {
    return null;
  }
  
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Synchronous version for non-async critical sections.
 */
export function withMarketLockSync<T>(
  marketId: string,
  asset: string,
  caller: string,
  fn: () => T,
  runId?: string
): T | null {
  const lock = tryAcquire(marketId, asset, caller, runId);
  
  if (!lock.acquired) {
    return null;
  }
  
  try {
    return fn();
  } finally {
    lock.release();
  }
}
