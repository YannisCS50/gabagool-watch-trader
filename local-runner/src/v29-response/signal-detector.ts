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

// Track share price at last signal to detect if already repriced
const lastSharePriceAtSignal: Record<string, number> = {};

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
  | 'no_previous_tick';

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
  
  // 7. Check if already repriced
  const signalKey = `${asset}:${direction}`;
  const lastPriceAtSignal = lastSharePriceAtSignal[signalKey];
  
  if (lastPriceAtSignal !== undefined) {
    const repricedCents = (bestAsk - lastPriceAtSignal) * 100;
    if (repricedCents > config.max_share_move_cents) {
      logFn(`SKIP: ${asset} ${direction} - already repriced +${repricedCents.toFixed(2)}¢`, {
        asset, direction, repricedCents, lastPriceAtSignal, currentAsk: bestAsk,
      });
      return { triggered: false, skipReason: 'already_repriced', skipDetails: `moved=${repricedCents.toFixed(2)}¢` };
    }
  }
  
  // 8. Check price range
  if (bestAsk < config.min_share_price || bestAsk > config.max_share_price) {
    logFn(`SKIP: ${asset} ${direction} - price ${(bestAsk * 100).toFixed(1)}¢ out of range`, {
      asset, direction, price: bestAsk,
    });
    return { triggered: false, skipReason: 'price_out_of_range' };
  }
  
  // 9. Check cooldown
  if (inCooldown) {
    return { triggered: false, skipReason: 'cooldown' };
  }
  
  // 10. Check single position rule
  if (config.single_position_per_market && hasOpenPosition) {
    logFn(`SKIP: ${asset} ${direction} - position already open`, { asset, direction });
    return { triggered: false, skipReason: 'position_open' };
  }
  
  // 11. Check exposure limit
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
  
  // Record share price for future repricing check
  lastSharePriceAtSignal[signalKey] = bestAsk;
  
  const binancePrice = priceState.binance ?? 0;
  
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
  for (const key of Object.keys(lastSharePriceAtSignal)) {
    if (key.startsWith(`${asset}:`)) {
      delete lastSharePriceAtSignal[key];
    }
  }
}
