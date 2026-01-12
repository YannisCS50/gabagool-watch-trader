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
  share_price: number;
  market_slug: string | null;
  strike_price: number | null;
  status: 'pending' | 'filled' | 'sold' | 'expired' | 'failed';
  entry_price: number | null;
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
  console.log(`[V28] 🎯 TRIGGER: ${asset} Δ$${delta.toFixed(2)} over ${windowDuration}ms`);

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

  // Extra safety: avoid duplicate orders for the same asset/side if something slipped through.
  const hasActive = [...activeSignals.values()].some(
    s => s.signal.asset === asset && (s.signal.status === 'pending' || s.signal.status === 'filled')
  );
  if (hasActive) return;

  // Reset window after trigger to avoid re-triggering on same move
  priceWindows[asset] = [{ price: newPrice, ts: now }];
  windowStartPrices[asset] = { price: newPrice, ts: now };

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

    const signal: V28Signal = {
      run_id: RUN_ID,
      asset,
      direction,
      signal_ts: now,
      binance_price: binancePrice,
      binance_delta: binanceDelta,
      chainlink_price: chainlinkPrice,
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
      notes: `V28 Signal: ${direction} | Δ$${Math.abs(binanceDelta).toFixed(2)} | Share ${(sharePrice * 100).toFixed(1)}¢`,
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
  const shares = signal.trade_size_usd / entryPrice;

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
  const shares = signal.trade_size_usd / signal.share_price;
  
  // SPEED: Minimal logging (save ~5-10ms)
  console.log(`[V28] 📤 BUY ${shares.toFixed(1)} @ ${(signal.share_price * 100).toFixed(1)}¢`);
  
  try {
    // SPEED: Use FOK for immediate fill (no waiting for resting orders)
    const result = await placeOrder({
      tokenId,
      side: 'BUY',
      price: signal.share_price,
      size: shares,
      orderType: 'FOK', // Fill-Or-Kill for speed
      intent: 'ENTRY',
    });
    
    const orderLatency = Date.now() - orderStartTs;
    const totalLatency = Date.now() - signal.signal_ts;
    
    if (!result.success) {
      console.error(`[V28] ❌ LIVE ORDER FAILED: ${result.error}`);
      signal.status = 'failed';
      signal.notes = `Order failed: ${result.error} | Latency: ${orderLatency}ms`;
      await saveSignal(signal);
      positionLock = { status: 'idle' };
      return;
    }
    
    // Order succeeded
    const entryPrice = result.avgPrice ?? signal.share_price;
    const filledSize = result.filledSize ?? shares;
    const orderType: 'maker' | 'taker' = result.status === 'filled' ? 'taker' : 'maker';
    const entryFee = orderType === 'taker' ? filledSize * 0.02 : -filledSize * 0.005;
    
    // Calculate TP/SL prices
    const tpPrice = currentConfig.tp_enabled ? entryPrice + (currentConfig.tp_cents / 100) : null;
    const slPrice = currentConfig.sl_enabled ? entryPrice - (currentConfig.sl_cents / 100) : null;
    
    signal.status = 'filled';
    signal.entry_price = entryPrice;
    signal.fill_ts = Date.now();
    signal.order_type = orderType;
    signal.entry_fee = entryFee;
    signal.shares = filledSize;
    signal.tp_price = tpPrice;
    signal.tp_status = tpPrice ? 'pending' : null;
    signal.sl_price = slPrice;
    signal.sl_status = slPrice ? 'pending' : null;
    signal.notes = `🔴 LIVE FILL @ ${(entryPrice * 100).toFixed(1)}¢ | Order: ${orderLatency}ms | Total: ${totalLatency}ms | TP: ${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ | SL: ${slPrice ? (slPrice * 100).toFixed(1) : '-'}¢`;
    
    console.log(`[V28] ⏱️ LATENCY: Signal → Order = ${totalLatency}ms (order took ${orderLatency}ms)`);
    console.log(`[V28] ✅ LIVE FILL: ${signal.asset} ${signal.direction} @ ${(entryPrice * 100).toFixed(1)}¢ | ${filledSize.toFixed(2)} shares`);
    
    await saveSignal(signal);
    
    // Start TP/SL monitoring (will place SELL orders when triggered)
    const tpSlInterval = startLiveTpSlMonitoring(signal, tokenId);
    
    // Set timeout fallback
    const timeoutTimer = setTimeout(() => {
      handleLiveTimeout(signal, tokenId);
    }, currentConfig.timeout_ms);
    
    activeSignals.set(signal.id!, { signal, tpSlInterval, timeoutTimer });
    
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
  
  const shares = signal.shares ?? 0;
  
  console.log(`[V28] 📤 Placing SELL order (${exitType}): ${shares.toFixed(2)} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
  
  try {
    const result = await placeOrder({
      tokenId,
      side: 'SELL',
      price: exitPrice,
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
  
  runLoop();
  
  console.log('[V28] ✅ Started successfully');
}

export async function stopV28Runner(): Promise<void> {
  console.log('[V28] Stopping...');

  isRunning = false;
  await stopPriceFeedLogger();

  for (const [_id, active] of activeSignals) {
    if (active.tpSlInterval) clearInterval(active.tpSlInterval);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  }
  activeSignals.clear();

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
