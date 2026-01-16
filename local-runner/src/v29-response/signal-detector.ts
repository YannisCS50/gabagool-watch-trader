/**
 * V29 Response-Based Strategy - Signal Detector
 * 
 * SIGNAL DEFINITION (tick-to-tick like V29):
 * 1. Binance price move ≥ $6 between buffered ticks (100ms buffer)
 * 2. Direction: up-tick → UP, down-tick → DOWN
 * 3. Polymarket share price NOT moved more than max_share_move_cents
 * 4. Spread ≤ max_spread_cents
 */

import type { Asset, V29Config, Direction } from './config.js';
import type { PriceTick, PriceState, MarketInfo, Signal } from './types.js';
import { randomUUID } from 'crypto';

// ============================================
// TICK-TO-TICK PRICE TRACKING (like V29)
// ============================================

interface TickBuffer {
  // Last emitted price (from previous buffer window)
  lastEmittedPrice: number | null;
  lastEmittedTs: number;
  
  // Current buffer window
  bufferStart: number;
  firstPrice: number | null;
  lastPrice: number | null;
  lastTs: number;
}

const tickBuffers: Record<Asset, TickBuffer> = {
  BTC: { lastEmittedPrice: null, lastEmittedTs: 0, bufferStart: 0, firstPrice: null, lastPrice: null, lastTs: 0 },
  ETH: { lastEmittedPrice: null, lastEmittedTs: 0, bufferStart: 0, firstPrice: null, lastPrice: null, lastTs: 0 },
  SOL: { lastEmittedPrice: null, lastEmittedTs: 0, bufferStart: 0, firstPrice: null, lastPrice: null, lastTs: 0 },
  XRP: { lastEmittedPrice: null, lastEmittedTs: 0, bufferStart: 0, firstPrice: null, lastPrice: null, lastTs: 0 },
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
 * Add a price tick to the buffer.
 * Returns true if buffer window completed and should check for signal.
 */
export function addPriceTick(asset: Asset, price: number, ts: number, bufferMs: number): boolean {
  const buffer = tickBuffers[asset];
  const now = Date.now();
  
  // First tick ever or buffer expired?
  if (buffer.firstPrice === null || (now - buffer.bufferStart) >= bufferMs) {
    // If we had a previous buffer, emit it
    if (buffer.lastPrice !== null) {
      buffer.lastEmittedPrice = buffer.lastPrice;
      buffer.lastEmittedTs = buffer.lastTs;
    }
    
    // Start new buffer
    buffer.bufferStart = now;
    buffer.firstPrice = price;
    buffer.lastPrice = price;
    buffer.lastTs = ts;
    
    // Signal to check for delta if we have previous emitted price
    return buffer.lastEmittedPrice !== null;
  }
  
  // Update current buffer
  buffer.lastPrice = price;
  buffer.lastTs = ts;
  return false;
}

/**
 * Get tick-to-tick delta (current buffer vs previous buffer)
 */
export function getTickDelta(asset: Asset): { delta: number; direction: Direction | null; currentPrice: number | null } {
  const buffer = tickBuffers[asset];
  
  if (buffer.lastEmittedPrice === null || buffer.lastPrice === null) {
    return { delta: 0, direction: null, currentPrice: buffer.lastPrice };
  }
  
  const delta = buffer.lastPrice - buffer.lastEmittedPrice;
  
  return {
    delta,
    direction: delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : null,
    currentPrice: buffer.lastPrice,
  };
}

// Legacy functions for compatibility
export function cleanOldTicks(_asset: Asset, _windowMs: number, _now: number): void {
  // No-op: tick-to-tick doesn't use rolling window
}

export function getRollingDelta(asset: Asset): { delta: number; direction: Direction | null } {
  const { delta, direction } = getTickDelta(asset);
  return { delta, direction };
}

/**
 * Check if a signal should be generated.
 * All conditions must pass; all skips are logged.
 */
export function checkSignal(
  asset: Asset,
  config: V29Config,
  priceState: PriceState,
  market: MarketInfo | undefined,
  hasOpenPosition: boolean,
  inCooldown: boolean,
  currentExposure: number,
  runId: string,
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
  
  // 3. Get tick-to-tick delta (like V29)
  const { delta, direction } = getTickDelta(asset);
  
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
  const lastPrice = lastSharePriceAtSignal[signalKey];
  
  if (lastPrice !== undefined) {
    const repricedCents = (bestAsk - lastPrice) * 100;
    if (repricedCents > config.max_share_move_cents) {
      logFn(`SKIP: ${asset} ${direction} - already repriced +${repricedCents.toFixed(2)}¢`, {
        asset, direction, repricedCents, lastPrice, currentAsk: bestAsk,
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
  tickBuffers[asset] = { 
    lastEmittedPrice: null, 
    lastEmittedTs: 0, 
    bufferStart: 0, 
    firstPrice: null, 
    lastPrice: null, 
    lastTs: 0 
  };
  
  // Clear repricing tracking for this asset
  for (const key of Object.keys(lastSharePriceAtSignal)) {
    if (key.startsWith(`${asset}:`)) {
      delete lastSharePriceAtSignal[key];
    }
  }
}
