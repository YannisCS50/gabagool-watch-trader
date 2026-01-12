/**
 * V28 Runner - Binance vs Chainlink Arbitrage Strategy
 * 
 * Detects fast moves on Binance, buys Polymarket shares before Chainlink catches up.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { V28Config, Asset, loadV28Config, initSupabase, DEFAULT_V28_CONFIG } from './config.js';
import { fetchChainlinkPrice } from '../chain.js';
import { getOrderbookDepth, placeOrder, getClient } from '../polymarket.js';
import { startPriceFeedLogger, stopPriceFeedLogger, type PriceFeedCallback } from '../price-feed-ws-logger.js';
import { fetchPositions, type PolymarketPosition } from '../positions-sync.js';
import { config } from '../config.js';

// ============================================
// TYPES
// ============================================

interface MarketInfo {
  asset: Asset;
  slug: string;
  strikePrice: number;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
}

interface PriceState {
  binance: number;
  chainlink: number | null;
  upBestBid: number | null;
  upBestAsk: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  lastUpdate: number;
}

interface PriceTick {
  price: number;
  ts: number;
}

interface V28Signal {
  id?: string;
  run_id: string;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  signal_ts: number;
  binance_price: number;
  binance_delta: number;
  chainlink_price: number | null;
  binance_chainlink_delta: number | null;  // Difference between Binance and Chainlink at trigger
  binance_chainlink_latency_ms: number | null;  // Estimated latency difference
  share_price: number;  // Share price at trigger moment
  market_slug: string | null;
  strike_price: number | null;
  status: 'pending' | 'filled' | 'sold' | 'expired' | 'failed';
  entry_price: number | null;  // Actual buy price
  exit_price: number | null;
  fill_ts: number | null;
  sell_ts: number | null;
  order_type: 'maker' | 'taker' | null;
  entry_fee: number | null;
  exit_fee: number | null;
  total_fees: number | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  tp_price: number | null;
  tp_status: 'pending' | 'filled' | 'cancelled' | null;
  sl_price: number | null;
  sl_status: 'pending' | 'filled' | 'cancelled' | null;
  exit_type: 'tp' | 'sl' | 'timeout' | null;
  trade_size_usd: number;
  shares: number | null;
  notes: string | null;
  config_snapshot: V28Config | null;
  is_live: boolean;
}

// ============================================
// STATE
// ============================================

const RUN_ID = `v28-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let supabase: SupabaseClient | null = null;
let isRunning = false;
let currentConfig: V28Config = DEFAULT_V28_CONFIG;

const priceState: Record<Asset, PriceState> = {
  BTC: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  ETH: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  SOL: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  XRP: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
};

const priceWindows: Record<Asset, PriceTick[]> = {
  BTC: [],
  ETH: [],
  SOL: [],
  XRP: [],
};

const windowStartPrices: Record<Asset, { price: number; ts: number } | null> = {
  BTC: null,
  ETH: null,
  SOL: null,
  XRP: null,
};

const activeSignals = new Map<string, { signal: V28Signal; tpSlInterval: NodeJS.Timeout | null; timeoutTimer: NodeJS.Timeout | null }>();
const marketInfo: Record<Asset, MarketInfo | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

type PositionLock =
  | { status: 'idle' }
  | { status: 'pending'; asset: Asset; acquiredAt: number }
  | { status: 'open'; asset: Asset; signalId: string; acquiredAt: number };

// User requirement: only hold ONE position at a time (global lock).
let positionLock: PositionLock = { status: 'idle' };

let lastMarketRefresh = 0;
let lastConfigReload = 0;
let positionMonitorInterval: NodeJS.Timeout | null = null;

// Track open positions (filled BUYs waiting for SELL)
interface OpenPosition {
  signalId: string;
  asset: Asset;
  tokenId: string;
  entryPrice: number;
  shares: number;
  fillTs: number;
  signal: V28Signal;
}
const openPositions = new Map<string, OpenPosition>();

// Track which token IDs have existing positions from Polymarket API
// Updated by position monitor - prevents duplicate entries
const existingPositionsInActiveMarkets = new Set<string>();

// ============================================
// DATABASE
// ============================================

async function saveSignal(signal: V28Signal): Promise<string | null> {
  if (!supabase) return null;
  
  try {
    if (signal.id) {
      const { data, error } = await supabase
        .from('paper_signals')
        .update(signal as never)
        .eq('id', signal.id)
        .select('id')
        .single();
      
      if (error) {
        console.error('[V28] Failed to update signal:', error.message);
        return signal.id;
      }
      return data?.id ?? signal.id;
    } else {
      const { id, ...signalWithoutId } = signal;
      const { data, error } = await supabase
        .from('paper_signals')
        .insert(signalWithoutId as never)
        .select('id')
        .single();
      
      if (error) {
        console.error('[V28] Failed to insert signal:', error.message);
        return null;
      }
      console.log('[V28] 💾 Signal saved:', data?.id);
      return data?.id ?? null;
    }
  } catch (err) {
    console.error('[V28] Error saving signal:', err);
    return null;
  }
}

async function saveTpSlEvent(
  signalId: string,
  ts: number,
  currentBid: number,
  tpPrice: number | null,
  slPrice: number | null,
  triggered: 'tp' | 'sl' | null
): Promise<void> {
  if (!supabase) return;
  
  try {
    await supabase.from('paper_tp_sl_events').insert({
      signal_id: signalId,
      ts,
      current_bid: currentBid,
      tp_price: tpPrice,
      sl_price: slPrice,
      tp_distance_cents: tpPrice ? (tpPrice - currentBid) * 100 : null,
      sl_distance_cents: slPrice ? (currentBid - slPrice) * 100 : null,
      triggered,
    } as never);
  } catch (err) {
    console.error('[V28] Error saving TP/SL event:', err);
  }
}

/**
 * Cleanup expired signals - marks filled signals as expired when their market ends
 * Also determines win/loss based on market result (if available)
 */
async function cleanupExpiredSignals(): Promise<void> {
  if (!supabase) return;
  
  const now = Date.now();
  
  // Find signals that are still 'filled' (not sold) and check if their market expired
  for (const [signalId, tracked] of activeSignals) {
    const signal = tracked.signal;
    if (signal.status !== 'filled') continue;
    
    // Check if market_slug contains a timestamp we can parse
    const slug = signal.market_slug;
    if (!slug) continue;
    
    // Format: btc-updown-15m-1768233600 - last part is start timestamp
    const match = slug.match(/-(\d+)$/);
    if (!match) continue;
    
    const marketStartTs = parseInt(match[1], 10) * 1000;
    const marketEndTs = marketStartTs + 15 * 60 * 1000; // 15 minutes
    
    if (now > marketEndTs) {
      console.log(`[V28] ⏰ Signal ${signalId} market expired at ${new Date(marketEndTs).toISOString()}`);
      
      // Clear timers
      if (tracked.tpSlInterval) clearInterval(tracked.tpSlInterval);
      if (tracked.timeoutTimer) clearTimeout(tracked.timeoutTimer);
      
      // Mark as expired
      signal.status = 'expired';
      signal.exit_type = 'timeout';
      signal.sell_ts = now;
      
      // Determine result based on direction vs final price
      // For now, mark as expired - result will be determined by settlement
      signal.notes = `⏰ EXPIRED: Market ended before TP hit | Entry@${((signal.entry_price ?? 0) * 100).toFixed(1)}¢ | TP was@${((signal.tp_price ?? 0) * 100).toFixed(1)}¢`;
      
      await saveSignal(signal);
      activeSignals.delete(signalId);
      openPositions.delete(signalId);
      
      // Release position lock
      if (positionLock.status === 'open' && positionLock.signalId === signalId) {
        positionLock = { status: 'idle' };
      }
    }
  }
}

// ============================================
// SIGNAL DETECTION
// ============================================

function handlePriceUpdate(asset: Asset, newPrice: number): void {
  const now = Date.now();
  priceState[asset].binance = newPrice;

  if (!currentConfig.enabled) return;
  if (!currentConfig.assets.includes(asset)) return;

  // HARD RULE: only one active position globally.
  // This also blocks duplicate triggers while a signal is being created (DB save, fill, etc.).
  if (positionLock.status !== 'idle') return;

  // Add tick to rolling window
  const window = priceWindows[asset];
  window.push({ price: newPrice, ts: now });

  // Initialize window start if needed
  if (!windowStartPrices[asset]) {
    windowStartPrices[asset] = { price: newPrice, ts: now };
    return;
  }

  // Clean old ticks outside the window
  const cutoff = now - currentConfig.delta_window_ms;
  while (window.length > 0 && window[0].ts < cutoff) {
    window.shift();
  }

  // Update window start to oldest tick in window
  if (window.length > 0) {
    windowStartPrices[asset] = { price: window[0].price, ts: window[0].ts };
  }

  // Calculate cumulative delta over the window
  const windowStart = windowStartPrices[asset];
  if (!windowStart) return;

  const delta = newPrice - windowStart.price;
  const windowDuration = now - windowStart.ts;

  // Only check when we have a meaningful window (at least 50ms of data)
  if (windowDuration < 50) return;

  // Debug: Log significant deltas (> 50% of threshold)
  if (Math.abs(delta) > currentConfig.min_delta_usd * 0.5) {
    console.log(`[V28] 📈 ${asset} Δ$${delta.toFixed(2)} / $${currentConfig.min_delta_usd} threshold (${windowDuration}ms window)`);
  }

  // Check if cumulative delta exceeds threshold
  if (Math.abs(delta) < currentConfig.min_delta_usd) {
    return;
  }

  // TRIGGER! We have a significant cumulative delta
  const state = priceState[asset];
  const chainlinkNow = state.chainlink;
  const binanceChainlinkGap = chainlinkNow !== null ? (newPrice - chainlinkNow) : null;
  
  console.log(`\n[V28] ══════════════════════════════════════════════════════════════`);
  console.log(`[V28] 🎯 SPIKE DETECTED: ${asset} ${delta > 0 ? '↑ UP' : '↓ DOWN'}`);
  console.log(`[V28] ──────────────────────────────────────────────────────────────`);
  console.log(`[V28] Binance:      $${newPrice.toFixed(2)} (Δ$${delta > 0 ? '+' : ''}${delta.toFixed(2)} in ${windowDuration}ms)`);
  console.log(`[V28] Chainlink:    $${chainlinkNow?.toFixed(2) ?? '?'} (gap: $${binanceChainlinkGap !== null ? (binanceChainlinkGap > 0 ? '+' : '') + binanceChainlinkGap.toFixed(2) : '?'})`);
  console.log(`[V28] Threshold:    $${currentConfig.min_delta_usd} (${((Math.abs(delta) / currentConfig.min_delta_usd) * 100).toFixed(0)}% met)`);
  console.log(`[V28] UP ask/bid:   ${state.upBestAsk ? (state.upBestAsk * 100).toFixed(1) : '?'}¢ / ${state.upBestBid ? (state.upBestBid * 100).toFixed(1) : '?'}¢`);
  console.log(`[V28] DOWN ask/bid: ${state.downBestAsk ? (state.downBestAsk * 100).toFixed(1) : '?'}¢ / ${state.downBestBid ? (state.downBestBid * 100).toFixed(1) : '?'}¢`);
  console.log(`[V28] ══════════════════════════════════════════════════════════════\n`);

  // Check if market is LIVE (started and not expired)
  const market = marketInfo[asset];
  if (!market) {
    console.log(`[V28] No market info for ${asset}, skipping`);
    return;
  }
  
  const now2 = Date.now();
  const startTime = new Date(market.eventStartTime).getTime();
  const endTime = new Date(market.eventEndTime).getTime();
  
  if (now2 < startTime) {
    console.log(`[V28] ⏳ ${asset} market not started yet (starts ${new Date(startTime).toISOString()})`);
    return;
  }
  
  if (now2 > endTime) {
    console.log(`[V28] ⏰ ${asset} market expired (ended ${new Date(endTime).toISOString()})`);
    return;
  }

  const direction: 'UP' | 'DOWN' = delta > 0 ? 'UP' : 'DOWN';

  // NEW FILTER: Restrict direction based on Binance vs Strike price delta
  // Delta between -70 and +70: can trade both UP and DOWN
  // Delta < -70: can only trade DOWN
  // Delta > +70: can only trade UP
  const strikePrice = market.strikePrice;
  if (strikePrice !== null && strikePrice !== undefined) {
    const binanceVsStrikeDelta = newPrice - strikePrice;
    
    if (binanceVsStrikeDelta < -70 && direction === 'UP') {
      console.log(`[V28] 🚫 ${asset} Binance-Strike Δ$${binanceVsStrikeDelta.toFixed(0)} < -70 → only DOWN allowed, skipping UP`);
      return;
    }
    
    if (binanceVsStrikeDelta > 70 && direction === 'DOWN') {
      console.log(`[V28] 🚫 ${asset} Binance-Strike Δ$${binanceVsStrikeDelta.toFixed(0)} > +70 → only UP allowed, skipping DOWN`);
      return;
    }
    
    console.log(`[V28] ✅ ${asset} Binance-Strike Δ$${binanceVsStrikeDelta.toFixed(0)} → ${direction} allowed`);
  }

  // Get share price
  const state = priceState[asset];
  const sharePrice = direction === 'UP'
    ? (state.upBestAsk ?? state.upBestBid)
    : (state.downBestAsk ?? state.downBestBid);

  if (sharePrice === null) {
    console.log(`[V28] No CLOB price for ${asset} ${direction}, skipping`);
    return;
  }

  // Check share price bounds
  if (sharePrice < currentConfig.min_share_price || sharePrice > currentConfig.max_share_price) {
    console.log(`[V28] ${asset} ${direction} share ${(sharePrice * 100).toFixed(1)}¢ outside bounds`);
    return;
  }

  // NEW FILTER: Check Binance vs Chainlink delta is within ±$100
  const chainlinkPrice = priceState[asset].chainlink;
  if (chainlinkPrice !== null) {
    const binanceChainlinkDelta = newPrice - chainlinkPrice;
    if (Math.abs(binanceChainlinkDelta) > 100) {
      console.log(`[V28] ⚠️ ${asset} Binance-Chainlink Δ$${binanceChainlinkDelta.toFixed(2)} outside ±$100 range, skipping`);
      return;
    }
  }

  // Extra safety: avoid duplicate orders for the same asset/side if something slipped through.
  const hasActive = [...activeSignals.values()].some(
    s => s.signal.asset === asset && (s.signal.status === 'pending' || s.signal.status === 'filled')
  );
  if (hasActive) return;

  // NEW CHECK: Don't place new orders if we already have a position in this market (from API)
  // This prevents duplicate entries when signals arrive faster than position sync
  const tokenIdToCheck = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const hasExistingPosition = existingPositionsInActiveMarkets.has(tokenIdToCheck);
  if (hasExistingPosition) {
    console.log(`[V28] ⏸️ ${asset} ${direction}: Already have position in this market, skipping new entry`);
    return;
  }

  // Reset window after trigger to avoid re-triggering on same move
  priceWindows[asset] = [{ price: newPrice, ts: now }];
  windowStartPrices[asset] = { price: newPrice, ts: now };

  // Log decision to proceed
  console.log(`[V28] ✅ PROCEEDING: ${asset} ${direction} @ ${(sharePrice * 100).toFixed(1)}¢ (all checks passed)`);

  // Create signal
  void createSignal(asset, direction, newPrice, delta, sharePrice);
}

async function createSignal(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  binancePrice: number,
  binanceDelta: number,
  sharePrice: number
): Promise<void> {
  // Global single-position lock (prevents rapid duplicate orders while we save/fill)
  if (positionLock.status !== 'idle') return;
  positionLock = { status: 'pending', asset, acquiredAt: Date.now() };

  try {
    const now = Date.now();
    const market = marketInfo[asset];

    // SPEED OPTIMIZATION: Skip Chainlink fetch in hot path (saves ~50-100ms)
    // We'll fetch it async after order placement for logging
    const chainlinkPrice = priceState[asset].chainlink;
    
    // Calculate Binance vs Chainlink delta and estimated latency
    const binanceChainlinkDelta = chainlinkPrice !== null ? binancePrice - chainlinkPrice : null;
    // Estimate latency: ~$10/sec price movement → latency = delta / 10 * 1000ms
    const estimatedLatencyMs = binanceChainlinkDelta !== null 
      ? Math.round(Math.abs(binanceChainlinkDelta) / 10 * 1000) 
      : null;

    const signal: V28Signal = {
      run_id: RUN_ID,
      asset,
      direction,
      signal_ts: now,
      binance_price: binancePrice,
      binance_delta: binanceDelta,
      chainlink_price: chainlinkPrice,
      binance_chainlink_delta: binanceChainlinkDelta,
      binance_chainlink_latency_ms: estimatedLatencyMs,
      share_price: sharePrice,
      market_slug: market?.slug ?? null,
      strike_price: market?.strikePrice ?? null,
      status: 'pending',
      entry_price: null,
      exit_price: null,
      fill_ts: null,
      sell_ts: null,
      order_type: null,
      entry_fee: null,
      exit_fee: null,
      total_fees: null,
      gross_pnl: null,
      net_pnl: null,
      tp_price: null,
      tp_status: null,
      sl_price: null,
      sl_status: null,
      exit_type: null,
      trade_size_usd: currentConfig.trade_size_usd,
      shares: null,
      notes: `${direction} | Δ$${Math.abs(binanceDelta).toFixed(0)} | B-CL Δ$${binanceChainlinkDelta?.toFixed(0) ?? '?'} (~${estimatedLatencyMs ?? '?'}ms) | Trigger@${(sharePrice * 100).toFixed(1)}¢`,
      config_snapshot: currentConfig,
      is_live: currentConfig.is_live,
    };

    console.log(`[V28] 📊 Signal: ${asset} ${direction} @ ${(sharePrice * 100).toFixed(1)}¢ | Δ$${Math.abs(binanceDelta).toFixed(2)}`);

    // Execute fill - either real CLOB order (live) or simulated (paper)
    if (currentConfig.is_live) {
      // SPEED: Place order FIRST, save to DB in parallel (don't wait for save)
      console.log(`[V28] 🔴 LIVE - Executing immediately...`);
      
      // Fire-and-forget DB save (don't block order execution)
      const savePromise = saveSignal(signal).then(id => {
        if (id) signal.id = id;
      });
      
      await executeLiveOrder(signal, market);
      
      // Ensure save completes
      await savePromise;
      positionLock = { status: 'open', asset, signalId: signal.id, acquiredAt: Date.now() };
    } else {
      const signalId = await saveSignal(signal);
      if (!signalId) {
        console.warn('[V28] Signal save failed; releasing lock');
        return;
      }
      signal.id = signalId;
      positionLock = { status: 'open', asset, signalId, acquiredAt: Date.now() };
      setTimeout(() => void simulateFill(signal), 50 + Math.random() * 50);
    }
  } finally {
    // If we never transitioned to open, drop the lock.
    if (positionLock.status === 'pending') {
      positionLock = { status: 'idle' };
    }
  }
}

async function simulateFill(signal: V28Signal): Promise<void> {
  const now = Date.now();
  const fillLatency = now - signal.signal_ts;

  // LOG LATENCY explicitly
  console.log(`[V28] ⏱️ LATENCY: Signal → Fill = ${fillLatency}ms`);

  // Simulate slight slippage
  const slippage = (Math.random() - 0.5) * 0.005;
  const entryPrice = signal.share_price + slippage;
  
  // Calculate shares: min of (trade_size_usd / price) and max_shares
  const rawShares = signal.trade_size_usd / entryPrice;
  const shares = Math.min(rawShares, currentConfig.max_shares);

  // Determine order type (maker if slow, taker if fast)
  const orderType: 'maker' | 'taker' = fillLatency > 100 ? 'maker' : 'taker';
  const entryFee = orderType === 'taker' ? shares * 0.02 : -shares * 0.005;

  // Calculate TP/SL prices
  const tpPrice = currentConfig.tp_enabled ? entryPrice + (currentConfig.tp_cents / 100) : null;
  const slPrice = currentConfig.sl_enabled ? entryPrice - (currentConfig.sl_cents / 100) : null;

  signal.status = 'filled';
  signal.entry_price = entryPrice;
  signal.fill_ts = now;
  signal.order_type = orderType;
  signal.entry_fee = entryFee;
  signal.shares = shares;
  signal.tp_price = tpPrice;
  signal.tp_status = tpPrice ? 'pending' : null;
  signal.sl_price = slPrice;
  signal.sl_status = slPrice ? 'pending' : null;
  // Include latency in notes for DB storage
  signal.notes = `Filled @ ${(entryPrice * 100).toFixed(1)}¢ | Latency: ${fillLatency}ms | TP: ${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ | SL: ${slPrice ? (slPrice * 100).toFixed(1) : '-'}¢`;

  console.log(`[V28] ✅ Filled ${signal.asset} ${signal.direction} @ ${(entryPrice * 100).toFixed(1)}¢ (${fillLatency}ms)`);

  await saveSignal(signal);

  // Start TP/SL monitoring
  const tpSlInterval = startTpSlMonitoring(signal);

  // Set timeout fallback
  const timeoutTimer = setTimeout(() => {
    handleTimeout(signal);
  }, currentConfig.timeout_ms);

  activeSignals.set(signal.id!, { signal, tpSlInterval, timeoutTimer });
}

/**
 * Execute a REAL order on Polymarket CLOB (live mode)
 */
async function executeLiveOrder(signal: V28Signal, market: MarketInfo | undefined): Promise<void> {
  const orderStartTs = Date.now();
  
  if (!market) {
    console.error(`[V28] ❌ No market info for ${signal.asset}`);
    signal.status = 'failed';
    signal.notes = 'No market info available';
    void saveSignal(signal); // Fire-and-forget
    positionLock = { status: 'idle' };
    return;
  }
  
  // Determine token ID based on direction
  const tokenId = signal.direction === 'UP' ? market.upTokenId : market.downTokenId;

  // CRITICAL: Polymarket enforces amount precision:
  // - makerAmount (USDC) max 2 decimals  
  // - takerAmount (shares) max 4 decimals
  // For BUY orders: makerAmount = shares * price (in USDC cents internally)
  // We need: (shares * price) to have at most 2 decimal places
  
  // BUG FIX: Fetch FRESH orderbook before placing order
  // The WebSocket cache can be stale (up to 500ms+ old) which causes pricing issues
  let freshBestAsk: number | null = null;
  try {
    const book = await getOrderbookDepth(tokenId);
    if (book && book.asks && book.asks.length > 0) {
      freshBestAsk = parseFloat(book.asks[0].price);
      console.log(`[V28] 📖 Fresh orderbook: bestAsk=${(freshBestAsk * 100).toFixed(1)}¢ (vs cached=${((signal.direction === 'UP' ? priceState[signal.asset].upBestAsk : priceState[signal.asset].downBestAsk) ?? 0) * 100}¢)`);
    }
  } catch (err) {
    console.warn(`[V28] ⚠️ Failed to fetch fresh orderbook, using cached price`);
  }
  
  // Use fresh orderbook price if available, otherwise fall back to cached
  const state = priceState[signal.asset];
  const cachedBestAsk = signal.direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  const bestAsk = freshBestAsk ?? cachedBestAsk;

  // PRICE FIX: For FOK BUYs we must be AT/ABOVE the real bestAsk.
  // Previously we capped price to max_share_price even when bestAsk > max_share_price,
  // which guarantees a non-fill (FOK) while still “placing” orders.
  const AGGRESSIVE_BUFFER = 0.03; // 3 cents buffer for latency
  const roundUpToTick = (p: number) => Math.ceil(p * 100) / 100;

  let price: number;
  if (bestAsk !== null && bestAsk !== undefined) {
    const bestAskTick = roundUpToTick(bestAsk);

    // If the market is already above our allowed max, skip instead of submitting an unfillable FOK.
    if (bestAskTick > currentConfig.max_share_price) {
      console.warn(
        `[V28] ⚠️ Skip: bestAsk ${(bestAskTick * 100).toFixed(1)}¢ > max_share_price ${(currentConfig.max_share_price * 100).toFixed(1)}¢`
      );
      signal.status = 'failed';
      signal.notes = `Skip: bestAsk ${(bestAskTick * 100).toFixed(1)}¢ > max ${(currentConfig.max_share_price * 100).toFixed(1)}¢`;
      void saveSignal(signal);
      positionLock = { status: 'idle' };
      return;
    }

    // AGGRESSIVE: Pay bestAsk + 3¢ buffer to guarantee fill despite latency & price movement
    price = Math.min(roundUpToTick(bestAskTick + AGGRESSIVE_BUFFER), currentConfig.max_share_price);

    console.log(
      `[V28] 💹 Pricing: bestAsk=${(bestAskTick * 100).toFixed(1)}¢ +3¢ buffer → buy@${(price * 100).toFixed(1)}¢`
    );
  } else {
    // No bestAsk available (thin book). Fall back to trigger price, still respecting max_share_price.
    price = Math.min(Math.round(signal.share_price * 100) / 100, currentConfig.max_share_price);
    console.log(
      `[V28] 💹 Pricing: trigger=${(signal.share_price * 100).toFixed(1)}¢ bestAsk=? → buy@${(price * 100).toFixed(1)}¢ (fallback)`
    );
  }

  if (!Number.isFinite(price) || price <= 0) {
    console.error(`[V28] ❌ Invalid computed price: ${price}`);
    signal.status = 'failed';
    signal.notes = `Invalid computed price: ${price}`;
    void saveSignal(signal);
    positionLock = { status: 'idle' };
    return;
  }

  // SIMPLE FIX: Round shares to 2 decimals so that shares * price always has ≤2 decimals
  // Example: 4.12 shares × $0.72 = $2.9664 → FAILS
  // Instead: 4.00 shares × $0.72 = $2.88 → OK (exactly 2 decimals)
  // The safest is to use whole shares or shares with 2 decimals where shares*price lands on cents
  
  const desiredShares = signal.trade_size_usd / price;
  
  // Round shares to whole numbers for simplicity (guarantees makerAmount has ≤2 decimals)
  // ALSO cap at max_shares from config (default 5)
  const shares = Math.min(Math.floor(desiredShares), currentConfig.max_shares);
  
  if (shares < 1) {
    console.error(`[V28] ❌ Not enough shares: desired=${desiredShares.toFixed(2)} -> ${shares}`);
    signal.status = 'failed';
    signal.notes = 'Not enough shares after rounding';
    void saveSignal(signal);
    positionLock = { status: 'idle' };
    return;
  }
  
  const notionalUsd = shares * price;

  if (!Number.isFinite(shares) || shares <= 0) {
    console.error(`[V28] ❌ Invalid shares after quantization: desired=${desiredShares.toFixed(6)} shares -> ${shares}`);
    signal.status = 'failed';
    signal.notes = 'Invalid shares after quantization';
    void saveSignal(signal);
    positionLock = { status: 'idle' };
    return;
  }

  if (notionalUsd < 1.0) {
    console.error(`[V28] ❌ Order notional too small after quantization: $${notionalUsd.toFixed(2)} (min $1)`);
    signal.status = 'failed';
    signal.notes = `Order notional too small after quantization: $${notionalUsd.toFixed(2)}`;
    void saveSignal(signal);
    positionLock = { status: 'idle' };
    return;
  }

  // ORDER PLACEMENT LOG
  console.log(`[V28] ┌─────────────────────────────────────────────────────────────`);
  console.log(`[V28] │ 📤 PLACING ORDER: ${signal.asset} ${signal.direction}`);
  console.log(`[V28] │ Token:    ${tokenId.slice(0, 20)}...`);
  console.log(`[V28] │ Side:     BUY (FOK)`);
  console.log(`[V28] │ Shares:   ${shares}`);
  console.log(`[V28] │ Price:    ${(price * 100).toFixed(1)}¢`);
  console.log(`[V28] │ Notional: $${notionalUsd.toFixed(2)}`);
  console.log(`[V28] └─────────────────────────────────────────────────────────────`);

  try {
    // SPEED: Use FOK for immediate fill (no waiting for resting orders)
    const result = await placeOrder({
      tokenId,
      side: 'BUY',
      price,
      size: shares,
      orderType: 'FOK', // Fill-Or-Kill for speed
      intent: 'ENTRY',
    });
    
    const orderLatency = Date.now() - orderStartTs;
    const totalLatency = Date.now() - signal.signal_ts;
    
    if (!result.success) {
      console.log(`[V28] ┌─────────────────────────────────────────────────────────────`);
      console.log(`[V28] │ ❌ ORDER FAILED`);
      console.log(`[V28] │ Error:   ${result.error}`);
      console.log(`[V28] │ Latency: ${orderLatency}ms`);
      console.log(`[V28] └─────────────────────────────────────────────────────────────`);
      signal.status = 'failed';
      signal.notes = `Order failed: ${result.error} | Latency: ${orderLatency}ms`;
      await saveSignal(signal);
      positionLock = { status: 'idle' };
      return;
    }
    
    // BUG FIX: Check if order actually filled (size_matched > 0)
    // Polymarket can return status=MATCHED but size_matched=0 for FOK orders that failed to match
    const filledSize = result.filledSize ?? 0;
    if (filledSize <= 0) {
      console.log(`[V28] ┌─────────────────────────────────────────────────────────────`);
      console.log(`[V28] │ ❌ ORDER NOT FILLED (FOK killed)`);
      console.log(`[V28] │ Status:     ${result.status}`);
      console.log(`[V28] │ FilledSize: ${filledSize}`);
      console.log(`[V28] │ Latency:    ${orderLatency}ms`);
      console.log(`[V28] └─────────────────────────────────────────────────────────────`);
      signal.status = 'failed';
      signal.notes = `Order not filled (size_matched=0) despite status=${result.status} | Latency: ${orderLatency}ms`;
      await saveSignal(signal);
      positionLock = { status: 'idle' };
      return;
    }
    
    // Order succeeded - use actual fill price, not expected price
    const entryPrice = result.avgPrice ?? signal.share_price;
    const orderType: 'maker' | 'taker' = result.status === 'filled' ? 'taker' : 'maker';
    const entryFee = orderType === 'taker' ? filledSize * 0.02 : -filledSize * 0.005;
    
    // BUG FIX: TP = entry + 4 CENTS (not 4%)
    // User requirement: tp_cents is the exact amount to add, not a percentage
    const tpCents = currentConfig.tp_cents ?? 4; // Default 4 cents
    const tpPrice = currentConfig.tp_enabled ? entryPrice + (tpCents / 100) : null;
    
    signal.status = 'filled';
    signal.entry_price = entryPrice;
    signal.fill_ts = Date.now();
    signal.order_type = orderType;
    signal.entry_fee = entryFee;
    signal.shares = filledSize;
    signal.tp_price = tpPrice;
    signal.tp_status = tpPrice ? 'pending' : null;
    signal.sl_price = null; // No SL in immediate-sell mode
    signal.sl_status = null;
    
    // Update notes with full trade info including TP price
    const bcDelta = signal.binance_chainlink_delta;
    const latencyMs = signal.binance_chainlink_latency_ms;
    signal.notes = `${signal.direction} | B-CL Δ$${bcDelta?.toFixed(0) ?? '?'} (~${latencyMs ?? '?'}ms) | Entry@${(entryPrice * 100).toFixed(1)}¢ → TP@${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ (+${tpCents}¢)`;
    
    console.log(`[V28] ┌─────────────────────────────────────────────────────────────`);
    console.log(`[V28] │ ✅ ORDER FILLED!`);
    console.log(`[V28] │ Asset:      ${signal.asset} ${signal.direction}`);
    console.log(`[V28] │ Shares:     ${filledSize.toFixed(2)}`);
    console.log(`[V28] │ Entry:      ${(entryPrice * 100).toFixed(1)}¢`);
    console.log(`[V28] │ TP Target:  ${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ (+${tpCents}¢)`);
    console.log(`[V28] │ Order Type: ${orderType.toUpperCase()}`);
    console.log(`[V28] │ Latency:    ${totalLatency}ms (order: ${orderLatency}ms)`);
    console.log(`[V28] └─────────────────────────────────────────────────────────────`);
    
    // ========================================
    // PLACE LIMIT SELL @ TP PRICE (with delay for settlement)
    // ========================================
    if (tpPrice && filledSize > 0) {
      const sellPrice = Math.round(tpPrice * 100) / 100; // tickSize=0.01
      
      // For SELL orders, use shares directly rounded to 2 decimals (simpler approach)
      // The CLOB accepts 2-decimal shares for sell orders
      const sellShares = Math.floor(filledSize * 100) / 100;
      
      if (sellShares >= 1) { // Minimum 1 share
        // RETRY LOOP: Keep trying SELL until position is available
        // After BUY fills, shares need time to be available in wallet
        const maxRetries = 10;
        const retryDelay = 500; // 500ms between retries
        let sellSuccess = false;
        let sellResult: OrderResult | null = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const waitTime = attempt === 1 ? 3000 : retryDelay; // Initial 3s, then 500ms
          console.log(`[V28] ⏳ Attempt ${attempt}/${maxRetries}: Waiting ${waitTime}ms before SELL...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Show TP in cents, not percentage
          const tpCentsAmount = Math.round((sellPrice - entryPrice) * 100);
          console.log(`[V28] 📤 LIMIT SELL ${sellShares.toFixed(2)} @ ${(sellPrice * 100).toFixed(0)}¢ (TP +${tpCentsAmount}¢)`);
          
          sellResult = await placeOrder({
            tokenId,
            side: 'SELL',
            price: sellPrice,
            size: sellShares,
            orderType: 'GTC', // Resting order - waits in book
            intent: 'HEDGE',
          });
          
          if (sellResult.success) {
            sellSuccess = true;
            break;
          }
          
          // Check if error is recoverable (balance/allowance issue)
          const errMsg = sellResult.error?.toLowerCase() ?? '';
          if (errMsg.includes('balance') || errMsg.includes('allowance')) {
            console.log(`[V28] ⚠️ SELL attempt ${attempt} failed (position not ready): ${sellResult.error}`);
            // Continue retrying
          } else {
            // Non-recoverable error, stop retrying
            console.error(`[V28] ❌ SELL failed with non-recoverable error: ${sellResult.error}`);
            break;
          }
        }
        
        if (sellSuccess && sellResult) {
          console.log(`[V28] ✅ LIMIT SELL placed in orderbook @ ${(sellPrice * 100).toFixed(0)}¢`);
          signal.notes = `🔴 LIVE BUY @ ${(entryPrice * 100).toFixed(1)}¢ | SELL @ ${(sellPrice * 100).toFixed(0)}¢ queued | ${totalLatency}ms`;
          
          // If already filled immediately
          if (sellResult.status === 'filled') {
            const actualExitPrice = sellResult.avgPrice ?? sellPrice;
            const exitFee = -sellShares * 0.005; // maker rebate
            const grossPnl = (actualExitPrice - entryPrice) * sellShares;
            const netPnl = grossPnl - (entryFee + exitFee);
            
            signal.status = 'sold';
            signal.exit_price = actualExitPrice;
            signal.sell_ts = Date.now();
            signal.exit_fee = exitFee;
            signal.total_fees = entryFee + exitFee;
            signal.gross_pnl = grossPnl;
            signal.net_pnl = netPnl;
            signal.tp_status = 'filled';
            signal.exit_type = 'tp';
            signal.notes = `🔴 LIVE ✅ TP @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)} | ${totalLatency}ms`;
            console.log(`[V28] ✅ IMMEDIATE SELL FILLED! Net: $${netPnl.toFixed(2)}`);
            
            positionLock = { status: 'idle' };
            await saveSignal(signal);
            return;
          }
          
          // SELL order is resting in book - monitor for fill via timeout only
          const timeoutTimer = setTimeout(() => {
            handleLiveTimeout(signal, tokenId);
          }, currentConfig.timeout_ms);
          
          activeSignals.set(signal.id!, { signal, tpSlInterval: null, timeoutTimer });
          await saveSignal(signal);
          return;
        } else {
          console.error(`[V28] ❌ LIMIT SELL FAILED after ${maxRetries} attempts: ${sellResult?.error}`);
          signal.notes = `🔴 LIVE BUY @ ${(entryPrice * 100).toFixed(1)}¢ | SELL failed - tracking for retry`;
          
          // Track this position for the position monitor to retry
          openPositions.set(signal.id!, {
            signalId: signal.id!,
            asset: signal.asset,
            tokenId,
            entryPrice,
            shares: sellShares,
            fillTs: signal.fill_ts!,
            signal,
          });
          console.log(`[V28] 📋 Added to open positions for monitoring: ${signal.id}`);
        }
      } else {
        console.warn(`[V28] ⚠️ Sell shares too small after rounding: ${filledSize} -> ${sellShares}`);
        signal.notes = `🔴 LIVE BUY @ ${(entryPrice * 100).toFixed(1)}¢ | SELL skipped (shares too small) | ${totalLatency}ms`;
      }
    } else {
      console.warn(`[V28] ⚠️ No TP price or no filled size: tpPrice=${tpPrice}, filledSize=${filledSize}`);
      signal.notes = `🔴 LIVE FILL @ ${(entryPrice * 100).toFixed(1)}¢ | No TP configured | ${totalLatency}ms`;
    }
    
    // Fallback: save signal, set timeout for manual exit
    await saveSignal(signal);
    
    const timeoutTimer = setTimeout(() => {
      handleLiveTimeout(signal, tokenId);
    }, currentConfig.timeout_ms);
    
    activeSignals.set(signal.id!, { signal, tpSlInterval: null, timeoutTimer });
    
  } catch (error: any) {
    console.error(`[V28] ❌ LIVE ORDER EXCEPTION: ${error?.message || error}`);
    signal.status = 'failed';
    signal.notes = `Exception: ${error?.message || 'Unknown error'}`;
    await saveSignal(signal);
    positionLock = { status: 'idle' };
  }
}

/**
 * Monitor TP/SL and place SELL orders when triggered (live mode)
 */
function startLiveTpSlMonitoring(signal: V28Signal, tokenId: string): NodeJS.Timeout | null {
  if (!signal.tp_price && !signal.sl_price) return null;
  
  return setInterval(async () => {
    const state = priceState[signal.asset];
    const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    if (currentBid === null) return;
    
    await saveTpSlEvent(signal.id!, Date.now(), currentBid, signal.tp_price, signal.sl_price, null);
    
    // Check Take-Profit
    if (signal.tp_price && currentBid >= signal.tp_price) {
      await handleLiveExit(signal, tokenId, 'tp', signal.tp_price);
      return;
    }
    
    // Check Stop-Loss
    if (signal.sl_price && currentBid <= signal.sl_price) {
      await handleLiveExit(signal, tokenId, 'sl', signal.sl_price);
      return;
    }
  }, 500);
}

/**
 * Handle exit with real SELL order (live mode)
 */
async function handleLiveExit(signal: V28Signal, tokenId: string, exitType: 'tp' | 'sl' | 'timeout', exitPrice: number): Promise<void> {
  const active = activeSignals.get(signal.id!);
  if (!active) return;
  
  if (active.tpSlInterval) clearInterval(active.tpSlInterval);
  if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  activeSignals.delete(signal.id!);
  
  // Release global lock
  if (positionLock.status === 'open' && positionLock.signalId === signal.id) {
    positionLock = { status: 'idle' };
  }
  
  const rawShares = signal.shares ?? 0;
  const price = Math.round(exitPrice * 100) / 100; // tickSize=0.01
  const pCents = Math.round(price * 100);

  const gcdInt = (a: number, b: number): number => {
    let x = Math.abs(Math.trunc(a));
    let y = Math.abs(Math.trunc(b));
    while (y !== 0) {
      const t = x % y;
      x = y;
      y = t;
    }
    return x;
  };

  const STEP_BASE = 10_000; // 4 decimals for shares
  const stepUnits = STEP_BASE / gcdInt(STEP_BASE, pCents);
  const rawUnits = Math.floor(rawShares * STEP_BASE);
  const sellUnits = Math.floor(rawUnits / stepUnits) * stepUnits;
  const shares = sellUnits / STEP_BASE;

  const notionalUsd = shares * price;

  console.log(`[V28] 📤 Placing SELL order (${exitType}): ${shares.toFixed(4)} shares @ ${(price * 100).toFixed(0)}¢ ($${notionalUsd.toFixed(2)})`);
  
  try {
    const result = await placeOrder({
      tokenId,
      side: 'SELL',
      price,
      size: shares,
      orderType: 'GTC',
      intent: 'HEDGE', // Use HEDGE intent for exits
    });
    
    const actualExitPrice = result.avgPrice ?? exitPrice;
    const exitFee = exitType === 'tp' ? -shares * 0.005 : shares * 0.02;
    const totalFees = (signal.entry_fee ?? 0) + exitFee;
    const grossPnl = (actualExitPrice - (signal.entry_price ?? 0)) * shares;
    const netPnl = grossPnl - totalFees;
    
    signal.status = 'sold';
    signal.exit_price = actualExitPrice;
    signal.sell_ts = Date.now();
    signal.exit_fee = exitFee;
    signal.total_fees = totalFees;
    signal.gross_pnl = grossPnl;
    signal.net_pnl = netPnl;
    signal.tp_status = exitType === 'tp' ? 'filled' : (signal.tp_price ? 'cancelled' : null);
    signal.sl_status = exitType === 'sl' ? 'filled' : (signal.sl_price ? 'cancelled' : null);
    signal.exit_type = exitType;
    
    const emoji = exitType === 'tp' ? '✅' : exitType === 'sl' ? '❌' : '⏱️';
    const label = exitType === 'tp' ? 'TP' : exitType === 'sl' ? 'SL' : 'Timeout';
    signal.notes = `🔴 LIVE ${emoji} ${label} @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}${!result.success ? ` | SELL failed: ${result.error}` : ''}`;
    
    console.log(`[V28] ${emoji} LIVE ${label}: ${signal.asset} ${signal.direction} @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`);
    
  } catch (error: any) {
    console.error(`[V28] ❌ SELL ORDER EXCEPTION: ${error?.message || error}`);
    signal.notes = `${signal.notes} | SELL exception: ${error?.message}`;
  }
  
  await saveTpSlEvent(signal.id!, Date.now(), exitPrice, signal.tp_price, signal.sl_price, exitType === 'timeout' ? null : exitType);
  await saveSignal(signal);
}

/**
 * Handle timeout with real SELL order (live mode)
 */
async function handleLiveTimeout(signal: V28Signal, tokenId: string): Promise<void> {
  const state = priceState[signal.asset];
  const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
  const exitPrice = currentBid ?? (signal.entry_price ?? 0);
  
  await handleLiveExit(signal, tokenId, 'timeout', exitPrice);
}
// Minimum profit in CENTS to trigger a sell (not percentage!)
// User requirement: sell when price is +4¢ above entry
const MIN_PROFIT_CENTS_TO_SELL = 4;

/**
 * Position Monitor - runs every 10s to check REAL positions from Polymarket API
 * and sell if profitable (> 4 cents)
 * 
 * Also updates existingPositionsInActiveMarkets to prevent duplicate entries
 */
async function monitorOpenPositions(): Promise<void> {
  // Fetch real positions from Polymarket API
  const walletAddress = config.polymarket.address;
  if (!walletAddress) {
    console.log(`[V28] ⚠️ No wallet address configured, skipping position monitor`);
    return;
  }

  let positions: PolymarketPosition[];
  try {
    positions = await fetchPositions(walletAddress);
  } catch (err: any) {
    console.error(`[V28] ❌ Failed to fetch positions: ${err?.message || err}`);
    return;
  }

  // Filter to only our active 15m UP/DOWN markets
  const activeTokenIds = new Set<string>();
  const tokenToMarket = new Map<string, { asset: Asset; direction: 'UP' | 'DOWN'; info: MarketInfo }>();
  
  for (const [asset, info] of Object.entries(marketInfo)) {
    if (!info) continue;
    
    // Check if market is still active (not expired)
    const now = Date.now();
    const endTime = new Date(info.eventEndTime).getTime();
    if (now > endTime) {
      console.log(`[V28] ⏰ ${asset} market expired, skipping`);
      continue;
    }
    
    activeTokenIds.add(info.upTokenId);
    activeTokenIds.add(info.downTokenId);
    tokenToMarket.set(info.upTokenId, { asset: asset as Asset, direction: 'UP', info });
    tokenToMarket.set(info.downTokenId, { asset: asset as Asset, direction: 'DOWN', info });
  }

  // CRITICAL: Update the set of token IDs with existing positions
  // This prevents duplicate entries when signals arrive faster than position sync
  existingPositionsInActiveMarkets.clear();
  
  // Filter positions that match our active markets
  const relevantPositions = positions.filter(p => {
    if (!p.asset || !activeTokenIds.has(p.asset)) return false;
    // Only track positions with actual shares
    if (p.size >= 1) {
      existingPositionsInActiveMarkets.add(p.asset);
    }
    return p.size >= 1;
  });
  
  if (relevantPositions.length === 0) {
    // Clear tracked positions for expired markets
    await cleanupExpiredSignals();
    
    // Also check tracked openPositions from our own trades
    if (openPositions.size > 0) {
      console.log(`[V28] 📋 Position monitor: no API positions, checking ${openPositions.size} tracked position(s)...`);
      await monitorTrackedPositions();
    }
    return;
  }

  console.log(`[V28] 📋 Position monitor: found ${relevantPositions.length} real position(s) in active markets`);

  for (const pos of relevantPositions) {
    const marketMatch = tokenToMarket.get(pos.asset);
    if (!marketMatch) continue;

    const { asset, direction, info } = marketMatch;
    const tokenId = pos.asset;
    const shares = pos.size;
    const avgCost = pos.avgPrice;
    const currentPrice = pos.curPrice;
    
    if (shares < 1 || avgCost <= 0) continue;

    // Calculate profit in CENTS (not percentage!)
    const profitCents = Math.round((currentPrice - avgCost) * 100);
    const profitPct = ((currentPrice / avgCost) - 1) * 100;
    const profitUsd = (currentPrice - avgCost) * shares;

    console.log(`[V28] 📊 ${asset} ${direction}: ${shares.toFixed(1)} shares @ ${(avgCost * 100).toFixed(1)}¢ → ${(currentPrice * 100).toFixed(1)}¢ (+${profitCents}¢ / ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}% / $${profitUsd.toFixed(2)})`);

    // Sell when profit >= 4 CENTS (user requirement)
    if (profitCents >= MIN_PROFIT_CENTS_TO_SELL) {
      console.log(`[V28] 💰 PROFIT +${profitCents}¢ >= +${MIN_PROFIT_CENTS_TO_SELL}¢! Selling ${shares.toFixed(1)} shares...`);

      // Get current orderbook for best bid
      const state = priceState[asset];
      const currentBid = direction === 'UP' ? state.upBestBid : state.downBestBid;
      
      // AGGRESSIVE SELL: Use bestBid - 0.5¢ to ensure fill
      const aggressiveSellPrice = currentBid ? Math.round((currentBid - 0.005) * 100) / 100 : Math.round(currentPrice * 100) / 100;
      const sellPrice = Math.max(aggressiveSellPrice, 0.01); // Floor at 1¢
      const sellShares = Math.floor(shares); // Whole shares only

      if (sellShares < 1) {
        console.log(`[V28] ⚠️ Shares too small after rounding: ${shares} -> ${sellShares}`);
        continue;
      }

      console.log(`[V28] 📤 SELL ${sellShares} @ ${(sellPrice * 100).toFixed(0)}¢ (aggressive: bestBid=${currentBid ? (currentBid * 100).toFixed(0) : '?'}¢ - 0.5¢)`);

      try {
        const result = await placeOrder({
          tokenId,
          side: 'SELL',
          price: sellPrice,
          size: sellShares,
          orderType: 'FOK', // Fill-or-kill for immediate exit
          intent: 'HEDGE',
        });

        if (result.success) {
          const actualExitPrice = result.avgPrice ?? sellPrice;
          const netPnl = (actualExitPrice - avgCost) * sellShares;
          console.log(`[V28] ✅ SOLD ${sellShares} ${asset} ${direction} @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`);
          
          // Release position lock if this was our tracked position
          if (positionLock.status === 'open') {
            positionLock = { status: 'idle' };
          }
        } else {
          console.log(`[V28] ⚠️ SELL failed: ${result.error}`);
        }
      } catch (error: any) {
        console.error(`[V28] ❌ SELL exception: ${error?.message || error}`);
      }
    } else if (profitCents > 0) {
      console.log(`[V28] ⏳ Profit +${profitCents}¢ < +${MIN_PROFIT_CENTS_TO_SELL}¢, holding...`);
    } else {
      console.log(`[V28] 📉 Currently at ${profitCents}¢, waiting for profit...`);
    }
  }
}

/**
 * Fallback: Monitor positions we tracked from our own trades
 * (in case API sync is delayed)
 */
async function monitorTrackedPositions(): Promise<void> {
  const now = Date.now();
  
  for (const [signalId, position] of openPositions) {
    const state = priceState[position.asset];
    const market = marketInfo[position.asset];
    if (!market) continue;
    
    // Check if market is expired - stop trying to sell
    const endTime = new Date(market.eventEndTime).getTime();
    if (now > endTime) {
      console.log(`[V28] ⏰ Tracked position ${position.asset} market expired, marking as expired`);
      position.signal.status = 'expired';
      position.signal.exit_type = 'timeout';
      position.signal.sell_ts = now;
      position.signal.notes = `⏰ EXPIRED: Market ended before sell | Entry@${(position.entryPrice * 100).toFixed(1)}¢`;
      await saveSignal(position.signal);
      openPositions.delete(signalId);
      
      if (positionLock.status === 'open' && positionLock.signalId === signalId) {
        positionLock = { status: 'idle' };
      }
      continue;
    }
    
    const currentBid = position.signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
    if (currentBid === null) continue;
    
    // Calculate profit in CENTS
    const profitCents = Math.round((currentBid - position.entryPrice) * 100);
    const profitPct = ((currentBid / position.entryPrice) - 1) * 100;
    
    console.log(`[V28] 📊 Tracked ${position.asset} ${position.signal.direction}: Entry ${(position.entryPrice * 100).toFixed(1)}¢ → Current ${(currentBid * 100).toFixed(1)}¢ (+${profitCents}¢ / ${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%)`);
    
    
    // Sell when profit >= 4 CENTS
    if (profitCents >= MIN_PROFIT_CENTS_TO_SELL) {
      console.log(`[V28] 💰 PROFIT +${profitCents}¢! Selling tracked position...`);
      
      // AGGRESSIVE SELL: Use bestBid - 0.5¢
      const aggressiveSellPrice = Math.round((currentBid - 0.005) * 100) / 100;
      const sellPrice = Math.max(aggressiveSellPrice, 0.01);
      const sellShares = Math.floor(position.shares);
      
      if (sellShares < 1) continue;
      
      try {
        const result = await placeOrder({
          tokenId: position.tokenId,
          side: 'SELL',
          price: sellPrice,
          size: sellShares,
          orderType: 'FOK',
          intent: 'HEDGE',
        });
        
        if (result.success) {
          const actualExitPrice = result.avgPrice ?? sellPrice;
          const exitFee = -sellShares * 0.005;
          const entryFee = position.signal.entry_fee ?? 0;
          const grossPnl = (actualExitPrice - position.entryPrice) * sellShares;
          const netPnl = grossPnl - (entryFee + exitFee);
          
          position.signal.status = 'sold';
          position.signal.exit_price = actualExitPrice;
          position.signal.sell_ts = Date.now();
          position.signal.exit_fee = exitFee;
          position.signal.total_fees = entryFee + exitFee;
          position.signal.gross_pnl = grossPnl;
          position.signal.net_pnl = netPnl;
          position.signal.tp_status = 'filled';
          position.signal.exit_type = 'tp';
          position.signal.notes = `🔴 LIVE ✅ SOLD @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)} (monitor ${profitPct.toFixed(1)}%)`;
          
          await saveSignal(position.signal);
          openPositions.delete(signalId);
          
          if (positionLock.status === 'open' && positionLock.signalId === signalId) {
            positionLock = { status: 'idle' };
          }
          
          console.log(`[V28] ✅ MONITOR SOLD tracked: ${position.asset} ${position.signal.direction} @ ${(actualExitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`);
        } else {
          console.log(`[V28] ⚠️ Tracked SELL failed: ${result.error}`);
        }
      } catch (error: any) {
        console.error(`[V28] ❌ Tracked SELL exception: ${error?.message || error}`);
      }
    }
  }
}

function startTpSlMonitoring(signal: V28Signal): NodeJS.Timeout | null {
  if (!signal.tp_price && !signal.sl_price) return null;
  
  return setInterval(async () => {
    const state = priceState[signal.asset];
    const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    if (currentBid === null) return;
    
    await saveTpSlEvent(signal.id!, Date.now(), currentBid, signal.tp_price, signal.sl_price, null);
    
    // Check Take-Profit
    if (signal.tp_price && currentBid >= signal.tp_price) {
      await handleExit(signal, 'tp', signal.tp_price);
      return;
    }
    
    // Check Stop-Loss
    if (signal.sl_price && currentBid <= signal.sl_price) {
      await handleExit(signal, 'sl', signal.sl_price);
      return;
    }
  }, 500);
}

async function handleExit(signal: V28Signal, exitType: 'tp' | 'sl' | 'timeout', exitPrice: number): Promise<void> {
  const active = activeSignals.get(signal.id!);
  if (!active) return;

  if (active.tpSlInterval) clearInterval(active.tpSlInterval);
  if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  activeSignals.delete(signal.id!);

  // Release global lock (single-position mode)
  if (positionLock.status === 'open' && positionLock.signalId === signal.id) {
    positionLock = { status: 'idle' };
  }

  const now = Date.now();
  const shares = signal.shares ?? 0;
  const entryPrice = signal.entry_price ?? 0;
  const entryFee = signal.entry_fee ?? 0;

  const exitFee = exitType === 'tp' ? -shares * 0.005 : shares * 0.02;
  const totalFees = entryFee + exitFee;
  const grossPnl = (exitPrice - entryPrice) * shares;
  const netPnl = grossPnl - totalFees;

  signal.status = 'sold';
  signal.exit_price = exitPrice;
  signal.sell_ts = now;
  signal.exit_fee = exitFee;
  signal.total_fees = totalFees;
  signal.gross_pnl = grossPnl;
  signal.net_pnl = netPnl;
  signal.tp_status = exitType === 'tp' ? 'filled' : (signal.tp_price ? 'cancelled' : null);
  signal.sl_status = exitType === 'sl' ? 'filled' : (signal.sl_price ? 'cancelled' : null);
  signal.exit_type = exitType;

  const emoji = exitType === 'tp' ? '✅' : exitType === 'sl' ? '❌' : '⏱️';
  const label = exitType === 'tp' ? 'TP' : exitType === 'sl' ? 'SL' : 'Timeout';
  signal.notes = `${emoji} ${label} @ ${(exitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`;

  console.log(`[V28] ${emoji} ${label}: ${signal.asset} ${signal.direction} @ ${(exitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`);

  await saveTpSlEvent(signal.id!, now, exitPrice, signal.tp_price, signal.sl_price, exitType === 'timeout' ? null : exitType);
  await saveSignal(signal);
}

async function handleTimeout(signal: V28Signal): Promise<void> {
  const state = priceState[signal.asset];
  const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
  const exitPrice = currentBid ?? (signal.entry_price ?? 0);
  
  await handleExit(signal, 'timeout', exitPrice);
}

// ============================================
// MARKET FETCHING
// ============================================

async function fetchActiveMarkets(): Promise<void> {
  if (!supabase) return;
  
  console.log('[V28] Fetching active markets...');
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('[V28] Cannot fetch markets: missing Supabase credentials');
      return;
    }
    
    const response = await fetch(`${supabaseUrl}/functions/v1/get-market-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ v26: true }),
    });
    
    if (!response.ok) {
      console.warn(`[V28] Failed to fetch markets: ${response.status}`);
      return;
    }
    
    const data = await response.json();
    const markets = data.markets || [];
    
    let count = 0;
    for (const market of markets) {
      const asset = market.asset?.toUpperCase() as Asset;
      if (!asset || !['BTC', 'ETH', 'SOL', 'XRP'].includes(asset)) continue;
      
      const upTokenId = market.upTokenId;
      const downTokenId = market.downTokenId;
      
      if (!upTokenId || !downTokenId) {
        console.log(`[V28] Skipping ${asset}: missing token IDs`);
        continue;
      }
      
      const info: MarketInfo = {
        asset,
        slug: market.slug,
        strikePrice: market.strikePrice || 0,
        upTokenId,
        downTokenId,
        eventStartTime: market.eventStartTime || market.event_start_time || new Date().toISOString(),
        eventEndTime: market.eventEndTime || market.event_end_time,
      };
      
      // Only add LIVE markets (started but not expired)
      const now = Date.now();
      const startTime = new Date(info.eventStartTime).getTime();
      const endTime = new Date(info.eventEndTime).getTime();
      
      if (now < startTime) {
        console.log(`[V28] ⏳ ${asset}: ${market.slug} not started yet, skipping`);
        continue;
      }
      
      if (now > endTime) {
        console.log(`[V28] ⏰ ${asset}: ${market.slug} expired, skipping`);
        continue;
      }
      
      marketInfo[asset] = info;
      count++;
      console.log(`[V28] ✓ ${asset}: ${market.slug} (strike: $${info.strikePrice}) LIVE`);
    }
    
    console.log(`[V28] Loaded ${count} active markets`);
    
  } catch (err) {
    console.error('[V28] Error fetching markets:', err);
  }
}

function shouldRefreshMarkets(): boolean {
  const now = Date.now();
  
  if (now - lastMarketRefresh > 60_000) {
    return true;
  }
  
  for (const asset of Object.keys(marketInfo) as Asset[]) {
    const info = marketInfo[asset];
    if (!info) continue;
    
    const endTime = new Date(info.eventEndTime).getTime();
    const timeUntilEnd = endTime - now;
    
    if (timeUntilEnd < 30_000) {
      console.log(`[V28] 🔄 ${asset} market expired/expiring (${Math.floor(timeUntilEnd / 1000)}s left)`);
      return true;
    }
  }
  
  return false;
}

// ============================================
// MAIN LOOP
// ============================================

async function runLoop(): Promise<void> {
  while (isRunning) {
    try {
      const now = Date.now();
      
      // Periodically reload config
      if (now - lastConfigReload > 10_000) {
        currentConfig = await loadV28Config(supabase!);
        lastConfigReload = now;
      }
      
      if (!currentConfig.enabled) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      
      // Refresh markets if needed
      if (shouldRefreshMarkets()) {
        console.log('[V28] 🔄 Refreshing markets...');
        await fetchActiveMarkets();
        lastMarketRefresh = Date.now();
      }
      
      // Fallback CLOB fetch if WS is stale
      for (const asset of currentConfig.assets) {
        const state = priceState[asset];
        if (now - state.lastUpdate > 10_000) {
          const market = marketInfo[asset];
          if (market) {
            try {
              const upBook = await getOrderbookDepth(market.upTokenId);
              if (upBook) {
                state.upBestBid = upBook.topBid;
                state.upBestAsk = upBook.topAsk;
              }
              const downBook = await getOrderbookDepth(market.downTokenId);
              if (downBook) {
                state.downBestBid = downBook.topBid;
                state.downBestAsk = downBook.topAsk;
              }
              state.lastUpdate = Date.now();
            } catch (err) {
              // Silent fail
            }
          }
        }
      }
      
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error('[V28] Loop error:', err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ============================================
// PUBLIC API
// ============================================

export async function startV28Runner(): Promise<void> {
  if (isRunning) {
    console.log('[V28] Already running');
    return;
  }
  
  console.log('='.repeat(60));
  console.log('  V28 - Binance vs Chainlink Arbitrage');
  console.log('='.repeat(60));
  console.log(`[V28] Run ID: ${RUN_ID}`);
  
  supabase = initSupabase();
  currentConfig = await loadV28Config(supabase);
  
  console.log(`[V28] Config: enabled=${currentConfig.enabled}, is_live=${currentConfig.is_live}, size=$${currentConfig.trade_size_usd}`);
  console.log(`[V28] Delta threshold: $${currentConfig.min_delta_usd} in ${currentConfig.delta_window_ms}ms window`);
  console.log(`[V28] Share bounds: ${(currentConfig.min_share_price * 100).toFixed(0)}-${(currentConfig.max_share_price * 100).toFixed(0)}¢`);
  console.log(`[V28] TP/SL: ${currentConfig.tp_cents}¢ / ${currentConfig.sl_cents}¢`);
  console.log(`[V28] Assets: ${currentConfig.assets.join(', ')}`);
  console.log('[V28] ✅ LATENCY TRACKING ENABLED - Will log signal→fill in ms');
  console.log('[V28] ✅ SINGLE POSITION LOCK - Max 1 position at a time');
  
  await fetchActiveMarkets();
  
  // Pre-init CLOB client at startup (saves ~100-200ms on first order)
  if (currentConfig.is_live) {
    console.log('[V28] 🔴 LIVE MODE - Pre-initializing CLOB client...');
    try {
      await getClient();
      console.log('[V28] ✅ CLOB client ready');
    } catch (e: any) {
      console.error('[V28] ⚠️ CLOB client init failed:', e?.message);
    }
  }
  
  isRunning = true;
  
  // Start unified price feed with callbacks
  let binanceTickCount = 0;
  let lastStatusLog = Date.now();
  
  const priceFeedCallbacks: PriceFeedCallback = {
    onBinancePrice: (asset: string, price: number, _timestamp: number) => {
      if (['BTC', 'ETH', 'SOL', 'XRP'].includes(asset)) {
        binanceTickCount++;
        handlePriceUpdate(asset as Asset, price);
        
        // Log status every 30 seconds
        const now = Date.now();
        if (now - lastStatusLog > 30_000) {
          const activeMarkets = Object.entries(marketInfo).filter(([_, v]) => v !== null).map(([k]) => k);
          console.log(`[V28] 📊 STATUS: ${binanceTickCount} ticks | Markets: ${activeMarkets.join(',')} | BTC $${priceState.BTC.binance.toFixed(0)} ETH $${priceState.ETH.binance.toFixed(0)}`);
          lastStatusLog = now;
        }
      }
    },
    onPolymarketPrice: (assetOrMarketId: string, upMid: number, downMid: number, _timestamp: number) => {
      for (const [asset, info] of Object.entries(marketInfo)) {
        if (info && (info.slug === assetOrMarketId || asset === assetOrMarketId)) {
          const typedAsset = asset as Asset;
          if (upMid > 0) {
            priceState[typedAsset].upBestBid = upMid - 0.005;
            priceState[typedAsset].upBestAsk = upMid + 0.005;
          }
          if (downMid > 0) {
            priceState[typedAsset].downBestBid = downMid - 0.005;
            priceState[typedAsset].downBestAsk = downMid + 0.005;
          }
          priceState[typedAsset].lastUpdate = Date.now();
        }
      }
    },
  };
  
  console.log('[V28] Starting price feeds (Binance + Polymarket WebSockets)...');
  await startPriceFeedLogger(priceFeedCallbacks);
  
  // Start position monitor (every 10 seconds) - fetches real positions from Polymarket API
  console.log(`[V28] Starting position monitor (10s interval, sell at +${MIN_PROFIT_CENTS_TO_SELL}¢ profit)...`);
  positionMonitorInterval = setInterval(monitorOpenPositions, 10_000);
  
  runLoop();
  
  console.log('[V28] ✅ Started successfully');
}

export async function stopV28Runner(): Promise<void> {
  console.log('[V28] Stopping...');

  isRunning = false;
  await stopPriceFeedLogger();
  
  // Stop position monitor
  if (positionMonitorInterval) {
    clearInterval(positionMonitorInterval);
    positionMonitorInterval = null;
  }

  for (const [_id, active] of activeSignals) {
    if (active.tpSlInterval) clearInterval(active.tpSlInterval);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  }
  activeSignals.clear();
  openPositions.clear();

  positionLock = { status: 'idle' };

  console.log('[V28] Stopped');
}

export function getV28Stats(): {
  isRunning: boolean;
  runId: string;
  config: V28Config;
  activeSignals: number;
  prices: Record<Asset, PriceState>;
  markets: Record<Asset, MarketInfo | null>;
} {
  return {
    isRunning,
    runId: RUN_ID,
    config: currentConfig,
    activeSignals: activeSignals.size,
    prices: priceState,
    markets: marketInfo,
  };
}

// ============================================
// STANDALONE ENTRY
// ============================================

const isMainModule = process.argv[1]?.includes('v28');
if (isMainModule) {
  startV28Runner().catch((err) => {
    console.error('[V28] Fatal error:', err);
    process.exit(1);
  });
  
  process.on('SIGINT', async () => {
    console.log('\n[V28] Shutting down...');
    await stopV28Runner();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n[V28] Received SIGTERM, shutting down...');
    await stopV28Runner();
    process.exit(0);
  });
}
