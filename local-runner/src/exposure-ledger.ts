/**
 * exposure-ledger.ts — v7.2.6 EXPOSURE LEDGER
 * ===========================================
 * Single authoritative state for per-market exposure tracking.
 *
 * EFFECTIVE EXPOSURE = positionShares + openOrderShares + pendingShares
 *
 * This ledger MUST be updated on:
 *   A) Order Request   → add to pendingShares (before API call)
 *   B) Order ACK       → move pendingShares → openOrderShares
 *   C) Partial/Full Fill → subtract openOrderShares; NOT position (external caller updates position)
 *   D) Cancel/Reject   → subtract pendingShares OR openOrderShares
 *
 * Cap checks use effective exposure so concurrent/in-flight orders cannot breach 100 shares.
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const EXPOSURE_CAP_CONFIG = {
  maxSharesPerSide: 100,
  maxTotalSharesPerMarket: 200,
};

// ============================================================
// TYPES
// ============================================================

export type Side = 'UP' | 'DOWN';

export interface LedgerEntry {
  positionUp: number;
  positionDown: number;
  openUp: number;
  openDown: number;
  pendingUp: number;
  pendingDown: number;
}

export interface EffectiveExposure {
  effectiveUp: number;
  effectiveDown: number;
  remainingUp: number;
  remainingDown: number;
}

export interface CapCheckResult {
  allowed: boolean;
  clampedQty: number;
  originalQty: number;
  blocked: boolean;
  blockReason: string | null;
  effectiveExposure: EffectiveExposure;
}

// ============================================================
// LEDGER STORAGE (in-memory, keyed by "marketId:asset")
// ============================================================

const ledger = new Map<string, LedgerEntry>();

function key(marketId: string, asset: string): string {
  return `${marketId}:${asset}`;
}

function getOrCreate(marketId: string, asset: string): LedgerEntry {
  const k = key(marketId, asset);
  let entry = ledger.get(k);
  if (!entry) {
    entry = {
      positionUp: 0,
      positionDown: 0,
      openUp: 0,
      openDown: 0,
      pendingUp: 0,
      pendingDown: 0,
    };
    ledger.set(k, entry);
  }
  return entry;
}

// ============================================================
// EFFECTIVE EXPOSURE CALCULATION
// ============================================================

export function getEffectiveExposure(marketId: string, asset: string): EffectiveExposure {
  const e = getOrCreate(marketId, asset);
  const effectiveUp = e.positionUp + e.openUp + e.pendingUp;
  const effectiveDown = e.positionDown + e.openDown + e.pendingDown;
  return {
    effectiveUp,
    effectiveDown,
    remainingUp: Math.max(0, EXPOSURE_CAP_CONFIG.maxSharesPerSide - effectiveUp),
    remainingDown: Math.max(0, EXPOSURE_CAP_CONFIG.maxSharesPerSide - effectiveDown),
  };
}

export function getLedgerEntry(marketId: string, asset: string): LedgerEntry {
  return { ...getOrCreate(marketId, asset) };
}

// ============================================================
// CAP CHECK (uses effective exposure)
// ============================================================

export function checkCapWithEffectiveExposure(params: {
  marketId: string;
  asset: string;
  side: Side;
  requestedQty: number;
}): CapCheckResult {
  const { marketId, asset, side, requestedQty } = params;
  const exposure = getEffectiveExposure(marketId, asset);

  const remaining = side === 'UP' ? exposure.remainingUp : exposure.remainingDown;
  const effective = side === 'UP' ? exposure.effectiveUp : exposure.effectiveDown;

  if (remaining <= 0) {
    return {
      allowed: false,
      clampedQty: 0,
      originalQty: requestedQty,
      blocked: true,
      blockReason: `CAP_BLOCKED: ${side} effective=${effective} >= ${EXPOSURE_CAP_CONFIG.maxSharesPerSide}`,
      effectiveExposure: exposure,
    };
  }

  const clampedQty = Math.min(requestedQty, remaining);
  const wasClamped = clampedQty < requestedQty;

  return {
    allowed: true,
    clampedQty,
    originalQty: requestedQty,
    blocked: false,
    blockReason: null,
    effectiveExposure: exposure,
  };
}

// ============================================================
// LEDGER MUTATIONS
// ============================================================

/**
 * A) ORDER REQUEST — add to pendingShares before API call
 */
export function reservePending(
  marketId: string,
  asset: string,
  side: Side,
  qty: number,
): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') e.pendingUp += qty;
  else e.pendingDown += qty;
}

/**
 * B) ORDER ACK — move pendingShares → openOrderShares
 *    (Call when exchange acknowledges order creation)
 */
export function promoteToOpen(
  marketId: string,
  asset: string,
  side: Side,
  qty: number,
): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') {
    e.pendingUp = Math.max(0, e.pendingUp - qty);
    e.openUp += qty;
  } else {
    e.pendingDown = Math.max(0, e.pendingDown - qty);
    e.openDown += qty;
  }
}

/**
 * C) PARTIAL/FULL FILL — reduce openOrderShares by filledQty
 *    Caller is responsible for incrementing positionShares externally.
 *    This function just reduces "open" since those shares are no longer on the book.
 */
export function onFill(
  marketId: string,
  asset: string,
  side: Side,
  filledQty: number,
): void {
  if (!Number.isFinite(filledQty) || filledQty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') {
    e.openUp = Math.max(0, e.openUp - filledQty);
  } else {
    e.openDown = Math.max(0, e.openDown - filledQty);
  }
}

/**
 * D-1) ORDER CANCEL/EXPIRE — reduce openOrderShares (order was live on book)
 */
export function onCancelOpen(
  marketId: string,
  asset: string,
  side: Side,
  qty: number,
): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') {
    e.openUp = Math.max(0, e.openUp - qty);
  } else {
    e.openDown = Math.max(0, e.openDown - qty);
  }
}

/**
 * D-2) ORDER REJECT — reduce pendingShares (never made it to the book)
 */
export function onRejectPending(
  marketId: string,
  asset: string,
  side: Side,
  qty: number,
): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') {
    e.pendingUp = Math.max(0, e.pendingUp - qty);
  } else {
    e.pendingDown = Math.max(0, e.pendingDown - qty);
  }
}

/**
 * SYNC POSITION — Overwrite positionShares from external source (e.g. fetchExistingTrades).
 * Does NOT touch pending/open; those are order-lifecycle managed.
 */
export function syncPosition(
  marketId: string,
  asset: string,
  positionUp: number,
  positionDown: number,
): void {
  const e = getOrCreate(marketId, asset);
  e.positionUp = Math.max(0, positionUp);
  e.positionDown = Math.max(0, positionDown);
}

/**
 * INCREMENT POSITION — Called when we confirm a fill locally (after inventory update).
 */
export function incrementPosition(
  marketId: string,
  asset: string,
  side: Side,
  qty: number,
): void {
  if (!Number.isFinite(qty) || qty <= 0) return;
  const e = getOrCreate(marketId, asset);
  if (side === 'UP') e.positionUp += qty;
  else e.positionDown += qty;
}

/**
 * CLEAR MARKET — Reset ledger for a market (e.g. on expiry).
 */
export function clearMarket(marketId: string, asset: string): void {
  ledger.delete(key(marketId, asset));
}

// ============================================================
// INVARIANT ASSERTIONS
// ============================================================

export interface InvariantCheckResult {
  valid: boolean;
  violations: string[];
  ledger: LedgerEntry;
  exposure: EffectiveExposure;
}

export function assertInvariants(
  marketId: string,
  asset: string,
  runId?: string,
): InvariantCheckResult {
  const e = getOrCreate(marketId, asset);
  const exposure = getEffectiveExposure(marketId, asset);
  const violations: string[] = [];

  if (exposure.effectiveUp > EXPOSURE_CAP_CONFIG.maxSharesPerSide) {
    violations.push(
      `EFFECTIVE_UP_BREACH: ${exposure.effectiveUp} > ${EXPOSURE_CAP_CONFIG.maxSharesPerSide}`,
    );
  }
  if (exposure.effectiveDown > EXPOSURE_CAP_CONFIG.maxSharesPerSide) {
    violations.push(
      `EFFECTIVE_DOWN_BREACH: ${exposure.effectiveDown} > ${EXPOSURE_CAP_CONFIG.maxSharesPerSide}`,
    );
  }

  const valid = violations.length === 0;

  if (!valid) {
    console.error(`🚨 [LEDGER] INVARIANT_BREACH: ${asset} ${marketId}`);
    violations.forEach((v) => console.error(`   ${v}`));
    console.error(`   Ledger: pos=${e.positionUp}/${e.positionDown} open=${e.openUp}/${e.openDown} pending=${e.pendingUp}/${e.pendingDown}`);

    saveBotEvent({
      event_type: 'LEDGER_INVARIANT_BREACH',
      asset,
      market_id: marketId,
      ts: Date.now(),
      run_id: runId,
      data: {
        violations,
        ledger: e,
        exposure,
      },
    }).catch(() => {});
  }

  return {
    valid,
    violations,
    ledger: { ...e },
    exposure,
  };
}

// ============================================================
// STRUCTURED LOGGING FOR ORDER ATTEMPTS
// ============================================================

export function logOrderAttempt(params: {
  marketId: string;
  asset: string;
  side: Side;
  reqQty: number;
  decision: 'place' | 'clamp' | 'block';
  clampedQty?: number;
  reason?: string;
  runId?: string;
}): void {
  const { marketId, asset, side, reqQty, decision, clampedQty, reason, runId } = params;
  const e = getOrCreate(marketId, asset);
  const exposure = getEffectiveExposure(marketId, asset);

  const remaining = side === 'UP' ? exposure.remainingUp : exposure.remainingDown;

  console.log(
    `📊 [LEDGER] ORDER_ATTEMPT: ${asset} ${marketId.slice(-15)} ${side} reqQty=${reqQty} → ${decision}` +
      (decision === 'clamp' ? ` (clamped to ${clampedQty})` : '') +
      (reason ? ` [${reason}]` : ''),
  );
  console.log(
    `   pos=${e.positionUp}/${e.positionDown} open=${e.openUp}/${e.openDown} pending=${e.pendingUp}/${e.pendingDown} eff=${exposure.effectiveUp}/${exposure.effectiveDown} rem=${exposure.remainingUp}/${exposure.remainingDown}`,
  );

  saveBotEvent({
    event_type: 'ORDER_ATTEMPT',
    asset,
    market_id: marketId,
    ts: Date.now(),
    run_id: runId,
    data: {
      side,
      reqQty,
      decision,
      clampedQty: clampedQty ?? reqQty,
      reason: reason ?? null,
      positionUp: e.positionUp,
      positionDown: e.positionDown,
      openUp: e.openUp,
      openDown: e.openDown,
      pendingUp: e.pendingUp,
      pendingDown: e.pendingDown,
      effectiveUp: exposure.effectiveUp,
      effectiveDown: exposure.effectiveDown,
      remainingUp: exposure.remainingUp,
      remainingDown: exposure.remainingDown,
    },
  }).catch(() => {});
}
