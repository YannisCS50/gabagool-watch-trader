/**
 * v8 Price Guard
 * 
 * Enforces NO-CROSSING invariant for maker-first execution.
 * Ensures BUY orders never cross the ask and SELL orders never cross the bid.
 */

import { V8 } from './config.js';

export type Side = 'BUY' | 'SELL';

export interface BookTop {
  bestBid: number;
  bestAsk: number;
  ageMs: number;
}

export type ValidationResult = 
  | { ok: true; price: number }
  | { ok: false; reason: 'RAW_NAN' | 'NO_CROSSING_BUY' | 'NO_CROSSING_SELL' | 'STALE_BOOK' | 'INVALID_BOOK' };

/**
 * Round price DOWN to nearest tick (for BUY orders)
 */
export function roundDown(price: number, tick: number = V8.execution.tick): number {
  return Math.floor(price / tick) * tick;
}

/**
 * Round price UP to nearest tick (for SELL orders)
 */
export function roundUp(price: number, tick: number = V8.execution.tick): number {
  return Math.ceil(price / tick) * tick;
}

/**
 * Round price based on side
 */
export function roundPrice(side: Side, price: number, tick: number = V8.execution.tick): number {
  return side === 'BUY' ? roundDown(price, tick) : roundUp(price, tick);
}

/**
 * Validate that book is fresh enough
 */
export function isBookFresh(book: BookTop, maxAgeMs: number = V8.execution.maxBookAgeMs): boolean {
  return book.ageMs <= maxAgeMs;
}

/**
 * Validate that book has sane values
 */
export function isBookValid(book: BookTop): boolean {
  if (!Number.isFinite(book.bestBid) || !Number.isFinite(book.bestAsk)) return false;
  if (book.bestBid <= 0 || book.bestAsk <= 0) return false;
  if (book.bestBid >= book.bestAsk) return false; // Crossed book is invalid
  return true;
}

/**
 * Validate and compute maker price that respects NO-CROSSING invariant
 * 
 * INV-2: NO-CROSSING (maker-first)
 * - For BUY: finalPrice <= bestAsk - tick
 * - For SELL: finalPrice >= bestBid + tick
 * 
 * @param side - BUY or SELL
 * @param rawPrice - Raw intended price
 * @param tick - Tick size
 * @param book - Current top of book
 * @returns Validated price or rejection reason
 */
export function validateMakerPrice(
  side: Side,
  rawPrice: number,
  tick: number = V8.execution.tick,
  book: BookTop
): ValidationResult {
  // Check for NaN
  if (!Number.isFinite(rawPrice)) {
    return { ok: false, reason: 'RAW_NAN' };
  }
  
  // Check book validity
  if (!isBookValid(book)) {
    return { ok: false, reason: 'INVALID_BOOK' };
  }
  
  // Check book freshness
  if (!isBookFresh(book)) {
    return { ok: false, reason: 'STALE_BOOK' };
  }
  
  // Round price based on side
  const p = roundPrice(side, rawPrice, tick);
  
  if (side === 'BUY') {
    // BUY must not cross ask: price <= bestAsk - tick
    const maxBuyPrice = book.bestAsk - tick;
    if (p > maxBuyPrice) {
      return { ok: false, reason: 'NO_CROSSING_BUY' };
    }
    return { ok: true, price: p };
  } else {
    // SELL must not cross bid: price >= bestBid + tick
    const minSellPrice = book.bestBid + tick;
    if (p < minSellPrice) {
      return { ok: false, reason: 'NO_CROSSING_SELL' };
    }
    return { ok: true, price: p };
  }
}

/**
 * Compute optimal maker BUY price (just above best bid)
 */
export function computeMakerBuyPrice(book: BookTop, tick: number = V8.execution.tick): number {
  return roundDown(book.bestBid + tick, tick);
}

/**
 * Compute optimal maker SELL price (just below best ask)
 */
export function computeMakerSellPrice(book: BookTop, tick: number = V8.execution.tick): number {
  return roundUp(book.bestAsk - tick, tick);
}

/**
 * Emergency crossing validation (when emergency exit is enabled)
 * Allows bounded crossing up to emergencyCrossTicks
 */
export function validateEmergencyCrossPrice(
  side: Side,
  rawPrice: number,
  book: BookTop,
  maxCrossTicks: number = V8.execution.emergencyCrossTicks,
  tick: number = V8.execution.tick
): ValidationResult {
  if (!Number.isFinite(rawPrice)) {
    return { ok: false, reason: 'RAW_NAN' };
  }
  
  if (!isBookValid(book)) {
    return { ok: false, reason: 'INVALID_BOOK' };
  }
  
  const p = roundPrice(side, rawPrice, tick);
  
  if (side === 'BUY') {
    // Emergency BUY: allow crossing up to maxCrossTicks into the ask
    const maxEmergencyBuyPrice = book.bestAsk + (maxCrossTicks * tick);
    if (p > maxEmergencyBuyPrice) {
      return { ok: false, reason: 'NO_CROSSING_BUY' };
    }
    return { ok: true, price: p };
  } else {
    // Emergency SELL: allow crossing up to maxCrossTicks into the bid
    const minEmergencySellPrice = book.bestBid - (maxCrossTicks * tick);
    if (p < minEmergencySellPrice) {
      return { ok: false, reason: 'NO_CROSSING_SELL' };
    }
    return { ok: true, price: p };
  }
}

/**
 * Get spread in cents
 */
export function getSpread(book: BookTop): number {
  return book.bestAsk - book.bestBid;
}

/**
 * Compute mid price
 */
export function getMid(book: BookTop): number {
  return (book.bestBid + book.bestAsk) / 2;
}
