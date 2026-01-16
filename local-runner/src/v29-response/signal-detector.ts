/**
 * V29 Response-Based Strategy - Signal Detector
 * 
 * SIGNAL DEFINITION:
 * 1. Binance price move ≥ $6 within 300ms rolling window
 * 2. Direction: up-tick → UP, down-tick → DOWN
 * 3. Polymarket share price NOT moved more than +0.5¢
 * 4. Spread ≤ 1.0¢
 * 5. No toxicity (large taker fills in last 300ms) - TODO: implement via WS
 */

import type { Asset, V29Config, Direction } from './config.js';
import type { PriceTick, PriceState, MarketInfo, Signal } from './types.js';
import { randomUUID } from 'crypto';

// ============================================
// ROLLING PRICE WINDOW PER ASSET
// ============================================

interface RollingWindow {
  ticks: PriceTick[];
  lastEmittedPrice: number | null;
}

const rollingWindows: Record<Asset, RollingWindow> = {
  BTC: { ticks: [], lastEmittedPrice: null },
  ETH: { ticks: [], lastEmittedPrice: null },
  SOL: { ticks: [], lastEmittedPrice: null },
  XRP: { ticks: [], lastEmittedPrice: null },
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
  | 'exposure_limit';

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
// CORE DETECTION LOGIC
// ============================================

export function addPriceTick(asset: Asset, price: number, ts: number): void {
  const window = rollingWindows[asset];
  window.ticks.push({ price, ts });
}

export function cleanOldTicks(asset: Asset, windowMs: number, now: number): void {
  const window = rollingWindows[asset];
  const cutoff = now - windowMs;
  window.ticks = window.ticks.filter(t => t.ts >= cutoff);
}

export function getRollingDelta(asset: Asset): { delta: number; direction: Direction | null } {
  const window = rollingWindows[asset];
  
  if (window.ticks.length < 2) {
    return { delta: 0, direction: null };
  }
  
  const first = window.ticks[0];
  const last = window.ticks[window.ticks.length - 1];
  const delta = last.price - first.price;
  
  return {
    delta,
    direction: delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : null,
  };
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
  
  // 3. Clean old ticks and calculate rolling delta
  cleanOldTicks(asset, config.signal_window_ms, now);
  const { delta, direction } = getRollingDelta(asset);
  
  if (!direction) {
    return { triggered: false, skipReason: 'delta_too_small' };
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
  rollingWindows[asset] = { ticks: [], lastEmittedPrice: null };
  
  // Clear repricing tracking for this asset
  for (const key of Object.keys(lastSharePriceAtSignal)) {
    if (key.startsWith(`${asset}:`)) {
      delete lastSharePriceAtSignal[key];
    }
  }
}
