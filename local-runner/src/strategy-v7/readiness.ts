/**
 * Strategy v7.0 Readiness Gates
 * ============================================================
 * HARD RULE: No order placement if orderbook not ready
 * No fallback "best guess" - wait or skip
 */

import type { BookTop, MarketSnapshot, MarketReadinessCache, ActionSkippedEvent, IntentType, Asset } from './types.js';
import { getConfig } from './config.js';

// ============================================================
// TOKEN READINESS CHECK
// ============================================================

export function isTokenReady(
  book: BookTop,
  now: number,
  maxAgeMs?: number
): boolean {
  const cfg = getConfig();
  const maxAge = maxAgeMs ?? cfg.readiness.maxSnapshotAgeMs;
  
  // Must have book data
  if (!book) return false;
  
  // Must have at least one level
  if (book.levels < cfg.readiness.minLevels) return false;
  
  // Must have bid OR ask (ideally both)
  if (book.bid === null && book.ask === null) return false;
  
  // Must be fresh
  if (now - book.ts > maxAge) return false;
  
  return true;
}

// ============================================================
// MARKET READINESS CHECK
// ============================================================

export function isMarketReady(snap: MarketSnapshot): boolean {
  return snap.readyUp && snap.readyDown;
}

export function updateReadinessCache(
  cache: MarketReadinessCache,
  snap: MarketSnapshot,
  now: number
): MarketReadinessCache {
  return {
    upReady: snap.readyUp,
    downReady: snap.readyDown,
    upLastSnapshotTs: snap.up.ts,
    downLastSnapshotTs: snap.down.ts,
    upTopBid: snap.up.bid,
    upTopAsk: snap.up.ask,
    downTopBid: snap.down.bid,
    downTopAsk: snap.down.ask,
  };
}

// ============================================================
// SNAPSHOT ENRICHMENT
// ============================================================

export function enrichSnapshotWithReadiness(
  snap: Omit<MarketSnapshot, 'readyUp' | 'readyDown'>,
  now: number
): MarketSnapshot {
  const readyUp = isTokenReady(snap.up, now);
  const readyDown = isTokenReady(snap.down, now);
  
  return {
    ...snap,
    readyUp,
    readyDown,
  };
}

// ============================================================
// READINESS GATE (blocks intents if not ready)
// ============================================================

export interface ReadinessGateResult {
  allowed: boolean;
  reason?: 'NO_ORDERBOOK' | 'STALE_DATA' | 'NO_LIQUIDITY';
  details?: string;
}

export function checkReadinessGate(
  snap: MarketSnapshot,
  intendedAction: IntentType
): ReadinessGateResult {
  // Must have both sides ready
  if (!snap.readyUp || !snap.readyDown) {
    return {
      allowed: false,
      reason: 'NO_ORDERBOOK',
      details: `readyUp=${snap.readyUp}, readyDown=${snap.readyDown}`,
    };
  }
  
  // For entries/accumulates, need valid asks on both sides
  if (intendedAction === 'ENTRY' || intendedAction === 'ACCUMULATE') {
    if (snap.up.ask === null || snap.down.ask === null) {
      return {
        allowed: false,
        reason: 'NO_LIQUIDITY',
        details: 'Missing ask on one or both sides',
      };
    }
  }
  
  // For hedges, need ask on the side we're buying
  // (This is checked at intent build time with the specific side)
  
  return { allowed: true };
}

// ============================================================
// PARKING INTENTS (for retry when not ready)
// ============================================================

interface ParkedIntent {
  intentType: IntentType;
  side: 'UP' | 'DOWN';
  qtyShares: number;
  limitPrice: number;
  reason: string;
  parkedAt: number;
  retryCount: number;
}

const parkedIntents = new Map<string, ParkedIntent>();

export function parkIntent(
  marketId: string,
  intent: ParkedIntent
): void {
  const key = `${marketId}:${intent.intentType}`;
  parkedIntents.set(key, intent);
}

export function getParkedIntent(
  marketId: string,
  intentType: IntentType
): ParkedIntent | undefined {
  const key = `${marketId}:${intentType}`;
  return parkedIntents.get(key);
}

export function clearParkedIntent(
  marketId: string,
  intentType: IntentType
): void {
  const key = `${marketId}:${intentType}`;
  parkedIntents.delete(key);
}

export function incrementParkedRetry(
  marketId: string,
  intentType: IntentType
): number {
  const key = `${marketId}:${intentType}`;
  const intent = parkedIntents.get(key);
  if (intent) {
    intent.retryCount++;
    return intent.retryCount;
  }
  return 0;
}

// ============================================================
// LOGGING HELPERS
// ============================================================

export function createActionSkippedEvent(
  snap: MarketSnapshot,
  intendedAction: IntentType,
  reason: ActionSkippedEvent['reason'],
  details?: string
): ActionSkippedEvent {
  return {
    type: 'ACTION_SKIPPED',
    ts: snap.ts,
    marketId: snap.marketId,
    asset: snap.asset,
    reason,
    intendedAction,
    details,
  };
}
