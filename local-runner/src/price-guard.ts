/**
 * price-guard.ts - v8.0 EXECUTION-FIRST SPEC
 * ============================================
 * Central NO-CROSSING invariant enforcer.
 * 
 * ALL order paths MUST pass through this module before submission.
 * This is the SINGLE SOURCE OF TRUTH for price validation.
 * 
 * INVARIANT (MUST NEVER VIOLATE):
 *   BUY:  submittedPrice <= bestAsk - tick  (one tick inside)
 *   SELL: submittedPrice >= bestBid + tick  (one tick inside)
 * 
 * Only exception: explicit EMERGENCY_EXIT mode, bounded and rate-limited.
 * 
 * Rounding Rules:
 *   BUY:  Math.floor(price * 100) / 100  (round DOWN)
 *   SELL: Math.ceil(price * 100) / 100   (round UP)
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const PRICE_GUARD_CONFIG = {
  // Standard tick size
  tickSize: 0.01,
  
  // Book freshness threshold (reject if book older than this)
  maxBookAgeMs: 500,
  
  // Emergency exit configuration
  emergency: {
    // Max ticks allowed to cross in emergency mode
    maxCrossTicks: 2,
    // Rate limit: min interval between emergency orders per market
    minIntervalMs: 30_000,
    // Only allow emergency exit if time remaining is below this
    maxTimeRemainingForEmergency: 90, // seconds
  },
  
  // Minimum spread required to place maker orders
  minSpreadForMaker: 0.02, // 2 ticks = 2¢
};

// ============================================================
// TYPES
// ============================================================

export type PriceGuardResult = 
  | { 
      allowed: true; 
      safePrice: number; 
      crossingFlag: false;
      roundedFrom: number;
      ticksFromEdge: number;
    }
  | { 
      allowed: false; 
      reason: string; 
      crossingFlag: true;
      requestedPrice: number;
      bestPrice: number; // bestAsk for BUY, bestBid for SELL
    };

export interface BookSnapshot {
  bestBid: number;
  bestAsk: number;
  fetchedAt: number; // timestamp when book was fetched
}

export interface PriceCheckParams {
  side: 'BUY' | 'SELL';
  requestedPrice: number;
  book: BookSnapshot;
  emergencyMode: boolean;
  marketId: string;
  asset: string;
  intent: string;
  runId?: string;
}

/**
 * Simplified interface for hard-invariants integration
 */
export interface SimplePriceCheckParams {
  side: 'BUY' | 'SELL';
  submittedPrice: number;
  bestBid: number;
  bestAsk: number;
  bookAgeMs: number;
  intent: string;
  marketId: string;
  emergencyMode: boolean;
}

export interface SimplePriceCheckResult {
  allowed: boolean;
  reason?: string;
  crossingFlag: boolean;
  adjustedPrice?: number;
}

export interface BookFreshnessResult {
  fresh: boolean;
  ageMs: number;
  reason?: string;
}

// ============================================================
// EMERGENCY EXIT RATE LIMITING
// ============================================================

// Track last emergency order per market
const lastEmergencyOrderTs = new Map<string, number>();

function canPlaceEmergencyOrder(marketId: string, asset: string): boolean {
  const key = `${marketId}:${asset}`;
  const lastTs = lastEmergencyOrderTs.get(key) || 0;
  const now = Date.now();
  return (now - lastTs) >= PRICE_GUARD_CONFIG.emergency.minIntervalMs;
}

function recordEmergencyOrder(marketId: string, asset: string): void {
  const key = `${marketId}:${asset}`;
  lastEmergencyOrderTs.set(key, Date.now());
}

// ============================================================
// ROUNDING FUNCTIONS
// ============================================================

/**
 * Round BUY price DOWN to nearest tick
 * This ensures we never accidentally cross the spread
 */
export function roundBuyPrice(price: number): number {
  return Math.floor(price * 100) / 100;
}

/**
 * Round SELL price UP to nearest tick
 * This ensures we never accidentally cross the spread
 */
export function roundSellPrice(price: number): number {
  return Math.ceil(price * 100) / 100;
}

/**
 * Round price based on side
 */
export function roundPrice(price: number, side: 'BUY' | 'SELL'): number {
  return side === 'BUY' ? roundBuyPrice(price) : roundSellPrice(price);
}

// ============================================================
// BOOK FRESHNESS CHECK
// ============================================================

/**
 * Check if orderbook snapshot is fresh enough for order placement
 */
export function checkBookFreshness(
  book: BookSnapshot,
  cfg = PRICE_GUARD_CONFIG
): BookFreshnessResult {
  const now = Date.now();
  const ageMs = now - book.fetchedAt;
  
  if (ageMs > cfg.maxBookAgeMs) {
    return {
      fresh: false,
      ageMs,
      reason: `STALE_BOOK: age=${ageMs}ms exceeds max=${cfg.maxBookAgeMs}ms`,
    };
  }
  
  return { fresh: true, ageMs };
}

// ============================================================
// PRICE GUARD - CORE FUNCTION
// ============================================================

/**
 * checkPrice - THE central guard that validates all order prices
 * 
 * INVARIANT:
 *   BUY:  safePrice <= bestAsk - tick
 *   SELL: safePrice >= bestBid + tick
 * 
 * Returns allowed=true with safePrice if order can proceed as maker.
 * Returns allowed=false with reason if order would cross spread.
 * 
 * Emergency mode allows bounded crossing (max 2 ticks) for exit purposes only.
 */
export function checkPrice(params: PriceCheckParams): PriceGuardResult {
  const {
    side,
    requestedPrice,
    book,
    emergencyMode,
    marketId,
    asset,
    intent,
    runId,
  } = params;
  
  const { bestBid, bestAsk } = book;
  const tick = PRICE_GUARD_CONFIG.tickSize;
  
  // Validate book has valid prices
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return {
      allowed: false,
      reason: 'INVALID_BOOK: bestBid or bestAsk is invalid',
      crossingFlag: true,
      requestedPrice,
      bestPrice: side === 'BUY' ? bestAsk : bestBid,
    };
  }
  
  // Check for inverted book (bid >= ask)
  if (bestBid >= bestAsk) {
    return {
      allowed: false,
      reason: `INVERTED_BOOK: bestBid=${bestBid} >= bestAsk=${bestAsk}`,
      crossingFlag: true,
      requestedPrice,
      bestPrice: side === 'BUY' ? bestAsk : bestBid,
    };
  }
  
  // Round the price based on side
  const roundedPrice = roundPrice(requestedPrice, side);
  
  if (side === 'BUY') {
    // BUY: Must be at least 1 tick below bestAsk
    const maxAllowedPrice = bestAsk - tick;
    
    if (roundedPrice <= maxAllowedPrice) {
      // Order is safe - will rest as maker
      const ticksFromEdge = Math.round((bestAsk - roundedPrice) / tick);
      return {
        allowed: true,
        safePrice: roundedPrice,
        crossingFlag: false,
        roundedFrom: requestedPrice,
        ticksFromEdge,
      };
    }
    
    // Would cross spread
    if (emergencyMode) {
      // Emergency mode: allow bounded crossing
      if (!canPlaceEmergencyOrder(marketId, asset)) {
        return {
          allowed: false,
          reason: 'EMERGENCY_RATE_LIMITED: too soon after last emergency order',
          crossingFlag: true,
          requestedPrice: roundedPrice,
          bestPrice: bestAsk,
        };
      }
      
      const maxEmergencyPrice = bestAsk + (PRICE_GUARD_CONFIG.emergency.maxCrossTicks * tick);
      const emergencyPrice = Math.min(roundedPrice, maxEmergencyPrice);
      const ticksCrossed = Math.round((emergencyPrice - bestAsk) / tick);
      
      // Log emergency crossing
      console.log(`🚨 EMERGENCY_CROSS: BUY ${asset} @ ${emergencyPrice.toFixed(2)} (bestAsk=${bestAsk.toFixed(2)}, +${ticksCrossed} ticks)`);
      
      saveBotEvent({
        event_type: 'EMERGENCY_CROSS',
        asset,
        market_id: marketId,
        ts: Date.now(),
        run_id: runId,
        data: {
          side: 'BUY',
          intent,
          requestedPrice: roundedPrice,
          emergencyPrice,
          bestAsk,
          ticksCrossed,
        },
      }).catch(() => {});
      
      recordEmergencyOrder(marketId, asset);
      
      return {
        allowed: true,
        safePrice: emergencyPrice,
        crossingFlag: false, // Allowed in emergency mode
        roundedFrom: requestedPrice,
        ticksFromEdge: -ticksCrossed, // Negative = crossing
      };
    }
    
    // Not emergency mode - block
    const ticksOver = Math.round((roundedPrice - maxAllowedPrice) / tick);
    return {
      allowed: false,
      reason: `CROSSING_BLOCKED: BUY @ ${roundedPrice.toFixed(2)} would cross (bestAsk=${bestAsk.toFixed(2)}, over by ${ticksOver} ticks)`,
      crossingFlag: true,
      requestedPrice: roundedPrice,
      bestPrice: bestAsk,
    };
  } else {
    // SELL: Must be at least 1 tick above bestBid
    const minAllowedPrice = bestBid + tick;
    
    if (roundedPrice >= minAllowedPrice) {
      // Order is safe - will rest as maker
      const ticksFromEdge = Math.round((roundedPrice - bestBid) / tick);
      return {
        allowed: true,
        safePrice: roundedPrice,
        crossingFlag: false,
        roundedFrom: requestedPrice,
        ticksFromEdge,
      };
    }
    
    // Would cross spread
    if (emergencyMode) {
      // Emergency mode: allow bounded crossing
      if (!canPlaceEmergencyOrder(marketId, asset)) {
        return {
          allowed: false,
          reason: 'EMERGENCY_RATE_LIMITED: too soon after last emergency order',
          crossingFlag: true,
          requestedPrice: roundedPrice,
          bestPrice: bestBid,
        };
      }
      
      const minEmergencyPrice = bestBid - (PRICE_GUARD_CONFIG.emergency.maxCrossTicks * tick);
      const emergencyPrice = Math.max(roundedPrice, minEmergencyPrice);
      const ticksCrossed = Math.round((bestBid - emergencyPrice) / tick);
      
      // Log emergency crossing
      console.log(`🚨 EMERGENCY_CROSS: SELL ${asset} @ ${emergencyPrice.toFixed(2)} (bestBid=${bestBid.toFixed(2)}, -${ticksCrossed} ticks)`);
      
      saveBotEvent({
        event_type: 'EMERGENCY_CROSS',
        asset,
        market_id: marketId,
        ts: Date.now(),
        run_id: runId,
        data: {
          side: 'SELL',
          intent,
          requestedPrice: roundedPrice,
          emergencyPrice,
          bestBid,
          ticksCrossed,
        },
      }).catch(() => {});
      
      recordEmergencyOrder(marketId, asset);
      
      return {
        allowed: true,
        safePrice: emergencyPrice,
        crossingFlag: false,
        roundedFrom: requestedPrice,
        ticksFromEdge: -ticksCrossed,
      };
    }
    
    // Not emergency mode - block
    const ticksUnder = Math.round((minAllowedPrice - roundedPrice) / tick);
    return {
      allowed: false,
      reason: `CROSSING_BLOCKED: SELL @ ${roundedPrice.toFixed(2)} would cross (bestBid=${bestBid.toFixed(2)}, under by ${ticksUnder} ticks)`,
      crossingFlag: true,
      requestedPrice: roundedPrice,
      bestPrice: bestBid,
    };
  }
}

// ============================================================
// MAKER PRICE SELECTION
// ============================================================

/**
 * Select optimal BUY price that ensures maker execution
 * Places order 1-2 ticks inside the spread
 */
export function selectMakerBuyPrice(
  book: BookSnapshot,
  cfg = PRICE_GUARD_CONFIG
): number {
  const { bestBid, bestAsk } = book;
  const tick = cfg.tickSize;
  
  // Place at bestBid + 1 tick (improve the bid slightly)
  // But ensure we're still at least 1 tick below bestAsk
  const improvedBid = bestBid + tick;
  const maxSafePrice = bestAsk - tick;
  
  const price = Math.min(improvedBid, maxSafePrice);
  return roundBuyPrice(price);
}

/**
 * Select optimal SELL price that ensures maker execution
 * Places order 1-2 ticks inside the spread
 */
export function selectMakerSellPrice(
  book: BookSnapshot,
  cfg = PRICE_GUARD_CONFIG
): number {
  const { bestBid, bestAsk } = book;
  const tick = cfg.tickSize;
  
  // Place at bestAsk - 1 tick (improve the ask slightly)
  // But ensure we're still at least 1 tick above bestBid
  const improvedAsk = bestAsk - tick;
  const minSafePrice = bestBid + tick;
  
  const price = Math.max(improvedAsk, minSafePrice);
  return roundSellPrice(price);
}

/**
 * Select maker price based on side
 */
export function selectMakerPrice(
  side: 'BUY' | 'SELL',
  book: BookSnapshot,
  cfg = PRICE_GUARD_CONFIG
): number {
  return side === 'BUY' 
    ? selectMakerBuyPrice(book, cfg) 
    : selectMakerSellPrice(book, cfg);
}

// ============================================================
// SPREAD ANALYSIS
// ============================================================

/**
 * Check if spread is wide enough for maker orders
 */
export function isSpreadSufficient(
  book: BookSnapshot,
  cfg = PRICE_GUARD_CONFIG
): { sufficient: boolean; spreadCents: number; reason?: string } {
  const spread = book.bestAsk - book.bestBid;
  const spreadCents = Math.round(spread * 100);
  
  if (spread < cfg.minSpreadForMaker) {
    return {
      sufficient: false,
      spreadCents,
      reason: `SPREAD_TOO_TIGHT: ${spreadCents}¢ < ${cfg.minSpreadForMaker * 100}¢ minimum`,
    };
  }
  
  return { sufficient: true, spreadCents };
}

// ============================================================
// TELEMETRY HELPERS
// ============================================================

/**
 * Build telemetry object for order submission logging
 */
export function buildOrderTelemetry(params: {
  side: 'BUY' | 'SELL';
  requestedPrice: number;
  submittedPrice: number;
  book: BookSnapshot;
  intent: string;
  marketId: string;
  asset: string;
}): Record<string, unknown> {
  const { side, requestedPrice, submittedPrice, book, intent, marketId, asset } = params;
  const tick = PRICE_GUARD_CONFIG.tickSize;
  
  const crossingFlag = side === 'BUY' 
    ? submittedPrice >= book.bestAsk
    : submittedPrice <= book.bestBid;
  
  const ticksFromEdge = side === 'BUY'
    ? Math.round((book.bestAsk - submittedPrice) / tick)
    : Math.round((submittedPrice - book.bestBid) / tick);
  
  return {
    marketId,
    asset,
    side,
    intent,
    requestedPrice,
    submittedPrice,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bookAgeMs: Date.now() - book.fetchedAt,
    spreadCents: Math.round((book.bestAsk - book.bestBid) * 100),
    crossingFlag,
    ticksFromEdge,
  };
}

// ============================================================
// EXPORTS
// ============================================================

export const PriceGuard = {
  // Core validation
  checkPrice,
  checkBookFreshness,
  
  // Rounding
  roundBuyPrice,
  roundSellPrice,
  roundPrice,
  
  // Price selection
  selectMakerBuyPrice,
  selectMakerSellPrice,
  selectMakerPrice,
  
  // Analysis
  isSpreadSufficient,
  
  // Telemetry
  buildOrderTelemetry,
  
  // Config
  CONFIG: PRICE_GUARD_CONFIG,
};

/**
 * Factory function to create a PriceGuard instance with simplified interface
 * Used by hard-invariants.ts for integration
 */
export function createPriceGuard(cfg = PRICE_GUARD_CONFIG) {
  return {
    checkPrice(params: SimplePriceCheckParams): SimplePriceCheckResult {
      const book: BookSnapshot = {
        bestBid: params.bestBid,
        bestAsk: params.bestAsk,
        fetchedAt: Date.now() - params.bookAgeMs,
      };
      
      // Check book freshness first
      const freshness = checkBookFreshness(book, cfg);
      if (!freshness.fresh) {
        return {
          allowed: false,
          reason: freshness.reason,
          crossingFlag: false,
        };
      }
      
      // Check price
      const result = checkPrice({
        side: params.side,
        requestedPrice: params.submittedPrice,
        book,
        emergencyMode: params.emergencyMode,
        marketId: params.marketId,
        asset: 'UNKNOWN', // Not provided in simple interface
        intent: params.intent,
      });
      
      if (result.allowed) {
        return {
          allowed: true,
          crossingFlag: false,
          adjustedPrice: result.safePrice,
        };
      } else {
        return {
          allowed: false,
          reason: result.reason,
          crossingFlag: result.crossingFlag,
        };
      }
    },
    
    config: cfg,
  };
}

export type PriceGuardConfig = typeof PRICE_GUARD_CONFIG;

export default PriceGuard;
