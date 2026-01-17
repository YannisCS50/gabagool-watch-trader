/**
 * V29 Response-Based Strategy - Signal Detector
 * 
 * SIGNAL DEFINITION (tick-to-tick like V29):
 * 1. Binance price move ≥ $6 between consecutive ticks (Binance already buffers at 100ms)
 * 2. Direction: up-tick → UP, down-tick → DOWN
 * 3. Polymarket share price NOT moved more than max_share_move_cents
 * 4. Spread ≤ max_spread_cents
 */

import type { Asset, V29Config, Direction } from './config.js';
import type { PriceState, MarketInfo, Signal } from './types.js';
import { randomUUID } from 'crypto';

// ============================================
// SIMPLE TICK-TO-TICK TRACKING (like V29)
// ============================================

// Track previous price per asset (Binance feed already buffers at 100ms)
const previousPrice: Record<Asset, number | null> = {
  BTC: null,
  ETH: null,
  SOL: null,
  XRP: null,
};

// Track share price AND timestamp at last signal to detect if already repriced
// Expires after 2 seconds (new Binance move = fresh opportunity)
const lastSignalData: Record<string, { price: number; ts: number }> = {};
const REPRICING_MEMORY_MS = 2000; // 2 seconds

// ============================================
// SKIP REASONS
// ============================================

export type SkipReason = 
  | 'no_market'
  | 'disabled'
  | 'delta_too_small'
  | 'no_orderbook'
  | 'spread_too_wide'
  | 'already_repriced'
  | 'price_out_of_range'
  | 'cooldown'
  | 'position_open'
  | 'exposure_limit'
  | 'no_previous_tick'
  | 'delta_direction_mismatch';  // New: wrong side for this delta

// ============================================
// SIGNAL RESULT
// ============================================

export interface SignalResult {
  triggered: boolean;
  signal?: Signal;
  skipReason?: SkipReason;
  skipDetails?: string;
}

// ============================================
// TICK-TO-TICK LOGIC (like V29)
// ============================================

/**
 * Process a price tick and get delta from previous tick.
 * Binance feed already buffers at 100ms, so we just compare consecutive ticks.
 */
export function processTick(asset: Asset, price: number): { 
  hasPrevious: boolean; 
  delta: number; 
  direction: Direction | null;
} {
  const previous = previousPrice[asset];
  
  // Update for next comparison
  previousPrice[asset] = price;
  
  if (previous === null) {
    return { hasPrevious: false, delta: 0, direction: null };
  }
  
  const delta = price - previous;
  const direction: Direction | null = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : null;
  
  return { hasPrevious: true, delta, direction };
}

// Legacy function for compatibility (not used but kept for imports)
export function addPriceTick(_asset: Asset, _price: number, _ts: number, _bufferMs?: number): boolean {
  return true; // Always check signal on tick
}

/**
 * Check if a signal should be generated.
 * Called after processTick to check all conditions.
 */
export function checkSignal(
  asset: Asset,
  config: V29Config,
  priceState: PriceState,
  market: MarketInfo | undefined,
  hasOpenPosition: boolean,
  inCooldown: boolean,
  currentExposure: number,
  delta: number,
  direction: Direction | null,
  logFn: (msg: string, data?: Record<string, unknown>) => void
): SignalResult {
  const now = Date.now();
  
  // 1. Check if enabled
  if (!config.enabled) {
    return { triggered: false, skipReason: 'disabled' };
  }
  
  // 2. Check if market exists
  if (!market) {
    return { triggered: false, skipReason: 'no_market' };
  }
  
  // 3. Check if we have a direction
  if (!direction) {
    return { triggered: false, skipReason: 'no_previous_tick' };
  }
  
  // 4. Check delta threshold
  const absDelta = Math.abs(delta);
  if (absDelta < config.signal_delta_usd) {
    return { triggered: false, skipReason: 'delta_too_small' };
  }
  
  // 5. Check orderbook availability
  const bestBid = direction === 'UP' ? priceState.upBestBid : priceState.downBestBid;
  const bestAsk = direction === 'UP' ? priceState.upBestAsk : priceState.downBestAsk;
  
  if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0) {
    logFn(`SKIP: ${asset} ${direction} - no orderbook`, { asset, direction });
    return { triggered: false, skipReason: 'no_orderbook' };
  }
  
  // 6. Check spread
  const spreadCents = (bestAsk - bestBid) * 100;
  if (spreadCents > config.max_spread_cents) {
    logFn(`SKIP: ${asset} ${direction} - spread ${spreadCents.toFixed(1)}¢ > ${config.max_spread_cents}¢`, {
      asset, direction, spreadCents,
    });
    return { triggered: false, skipReason: 'spread_too_wide', skipDetails: `spread=${spreadCents.toFixed(1)}¢` };
  }
  
  // 7. Check if already repriced (only if recent signal exists - expires after 2s)
  const signalKey = `${asset}:${direction}`;
  const lastData = lastSignalData[signalKey];
  
  if (lastData !== undefined) {
    const ageMs = now - lastData.ts;
    
    // Only check repricing if the last signal was recent (within memory window)
    if (ageMs < REPRICING_MEMORY_MS) {
      const repricedCents = (bestAsk - lastData.price) * 100;
      if (repricedCents > config.max_share_move_cents) {
        logFn(`SKIP: ${asset} ${direction} - already repriced +${repricedCents.toFixed(2)}¢`, {
          asset, direction, repricedCents, lastPriceAtSignal: lastData.price, currentAsk: bestAsk,
        });
        return { triggered: false, skipReason: 'already_repriced', skipDetails: `moved=${repricedCents.toFixed(2)}¢` };
      }
    }
    // Else: old signal expired, treat as fresh opportunity
  }
  
  // 8. Check price range
  if (bestAsk < config.min_share_price || bestAsk > config.max_share_price) {
    logFn(`SKIP: ${asset} ${direction} - price ${(bestAsk * 100).toFixed(1)}¢ out of range`, {
      asset, direction, price: bestAsk,
    });
    return { triggered: false, skipReason: 'price_out_of_range' };
  }
  
  // 9. DELTA-BASED DIRECTIONAL FILTER
  // Uses binance price vs strike to determine which sides are allowed
  // As we get closer to expiry, the allowed delta range narrows
  const binancePrice = priceState.binance ?? 0;
  const strikePrice = market.strikePrice ?? 0;
  const priceToStrikeDelta = strikePrice > 0 ? binancePrice - strikePrice : 0;
  const msToExpiry = market.endTime.getTime() - now;
  const minToExpiry = msToExpiry / 60_000;
  
  const directionAllowed = checkDeltaDirection(priceToStrikeDelta, direction, minToExpiry);
  
  if (!directionAllowed.allowed) {
    logFn(`SKIP: ${asset} ${direction} - delta direction blocked | Δ=${priceToStrikeDelta.toFixed(2)} | ${directionAllowed.reason}`, {
      asset, direction, priceToStrikeDelta, minToExpiry, reason: directionAllowed.reason,
    });
    return { triggered: false, skipReason: 'delta_direction_mismatch', skipDetails: directionAllowed.reason };
  }
  
  // 10. Check cooldown
  if (inCooldown) {
    return { triggered: false, skipReason: 'cooldown' };
  }
  
  // 11. Check max positions per asset
  // hasOpenPosition is now "at max positions" (passed from caller)
  if (hasOpenPosition) {
    logFn(`SKIP: ${asset} ${direction} - max positions reached`, { asset, direction });
    return { triggered: false, skipReason: 'position_open' };
  }
  
  // 12. Check exposure limit
  const orderCost = config.shares_per_trade * bestAsk;
  if (currentExposure + orderCost > config.max_exposure_usd) {
    logFn(`SKIP: ${asset} ${direction} - exposure limit`, {
      asset, direction, currentExposure, orderCost, limit: config.max_exposure_usd,
    });
    return { triggered: false, skipReason: 'exposure_limit' };
  }
  
  // ============================================
  // SIGNAL TRIGGERED!
  // ============================================
  
  // Record share price + timestamp for future repricing check
  lastSignalData[signalKey] = { price: bestAsk, ts: now };
  
  const signal: Signal = {
    id: randomUUID(),
    asset,
    direction,
    
    binance_price: binancePrice,
    binance_delta: delta,
    binance_ts: priceState.binanceTs,
    
    share_price_t0: bestAsk,
    spread_t0: spreadCents,
    
    market_slug: market.slug,
    strike_price: market.strikePrice,
    
    status: 'pending',
    
    signal_ts: now,
    decision_ts: now,
  };
  
  logFn(`🎯 SIGNAL: ${asset} ${direction} | Δ$${delta.toFixed(2)} | ask=${(bestAsk * 100).toFixed(1)}¢ | spread=${spreadCents.toFixed(1)}¢`, {
    signalId: signal.id,
    asset,
    direction,
    delta,
    bestAsk,
    spreadCents,
  });
  
  return { triggered: true, signal };
}

/**
 * Reset the signal state when market changes
 */
export function resetSignalState(asset: Asset): void {
  previousPrice[asset] = null;
  
  // Clear repricing tracking for this asset
  for (const key of Object.keys(lastSignalData)) {
    if (key.startsWith(`${asset}:`)) {
      delete lastSignalData[key];
    }
  }
}

// ============================================
// DELTA-BASED DIRECTIONAL FILTER
// ============================================

/**
 * Check if a direction is allowed based on delta-to-strike and time remaining.
 * 
 * RULES:
 * - delta > +75  → only UP allowed (any time)
 * - delta < -75  → only DOWN allowed (any time)
 * - Within delta bands, both sides allowed but only until certain time:
 *   - -75 to +75 → both sides until 10 min remaining
 *   - -50 to +50 → both sides until 5 min remaining
 *   - -30 to +30 → both sides until 2 min remaining
 *   - <2 min remaining → only extremes (>75 or <-75) allowed
 */
function checkDeltaDirection(
  priceToStrikeDelta: number,
  direction: Direction,
  minToExpiry: number
): { allowed: boolean; reason: string } {
  const absDelta = Math.abs(priceToStrikeDelta);
  
  // EXTREMES: always allowed in correct direction
  if (priceToStrikeDelta > 75) {
    // Strong bullish - only UP allowed
    if (direction === 'UP') {
      return { allowed: true, reason: 'delta>+75, UP allowed' };
    } else {
      return { allowed: false, reason: `delta=+${priceToStrikeDelta.toFixed(0)}, only UP allowed` };
    }
  }
  
  if (priceToStrikeDelta < -75) {
    // Strong bearish - only DOWN allowed
    if (direction === 'DOWN') {
      return { allowed: true, reason: 'delta<-75, DOWN allowed' };
    } else {
      return { allowed: false, reason: `delta=${priceToStrikeDelta.toFixed(0)}, only DOWN allowed` };
    }
  }
  
  // WITHIN -75 to +75 band - time-based restrictions
  
  // Less than 2 min: no trading in neutral zone (too risky)
  if (minToExpiry < 2) {
    return { allowed: false, reason: `<2min + |delta|=${absDelta.toFixed(0)} (need |delta|>75)` };
  }
  
  // 2-5 min: need delta within -30 to +30 for both sides
  if (minToExpiry < 5) {
    if (absDelta <= 30) {
      return { allowed: true, reason: `2-5min + |delta|=${absDelta.toFixed(0)}≤30, both OK` };
    } else {
      return { allowed: false, reason: `2-5min + |delta|=${absDelta.toFixed(0)}>30 (need ≤30)` };
    }
  }
  
  // 5-10 min: need delta within -50 to +50 for both sides
  if (minToExpiry < 10) {
    if (absDelta <= 50) {
      return { allowed: true, reason: `5-10min + |delta|=${absDelta.toFixed(0)}≤50, both OK` };
    } else {
      return { allowed: false, reason: `5-10min + |delta|=${absDelta.toFixed(0)}>50 (need ≤50)` };
    }
  }
  
  // ≥10 min: delta within -75 to +75 allows both sides (already checked above)
  return { allowed: true, reason: `≥10min + |delta|=${absDelta.toFixed(0)}≤75, both OK` };
}
