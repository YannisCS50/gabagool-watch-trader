/**
 * Paper Trader Module v1.0.0
 * 
 * Runs alongside the main strategy to:
 * - Detect arbitrage signals based on Binance price deltas
 * - Simulate trades with TP/SL monitoring
 * - Log everything to database for analysis
 * - Optionally execute real trades when is_live=true
 * 
 * Database tables used:
 * - paper_signals: All detected signals and their outcomes
 * - paper_tp_sl_events: TP/SL check events for analysis
 * - paper_price_snapshots: Periodic price snapshots
 * - paper_trading_config: Runtime configuration
 */

import WebSocket from 'ws';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { getOrderbookDepth } from './polymarket.js';
import { fetchChainlinkPrice } from './chain.js';

// ============================================
// TYPES
// ============================================

type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

interface PaperTradingConfig {
  id: string;
  enabled: boolean;
  is_live: boolean;
  trade_size_usd: number;
  min_delta_usd: number;
  min_share_price: number;
  max_share_price: number;
  tp_cents: number;
  tp_enabled: boolean;
  sl_cents: number;
  sl_enabled: boolean;
  timeout_ms: number;
  assets: Asset[];
}

interface PaperSignal {
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
  config_snapshot: PaperTradingConfig | null;
  is_live: boolean;
}

interface MarketInfo {
  asset: Asset;
  slug: string;
  strikePrice: number;
  upTokenId: string;
  downTokenId: string;
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

// ============================================
// CONSTANTS
// ============================================

const RUN_ID = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';

// Rolling window for delta accumulation
// We need to detect the move fast enough to place order before Chainlink catches up
// Chainlink latency is ~1000-1500ms, so we use a 300ms window to leave ~700-1200ms for order execution
const DELTA_WINDOW_MS = 300;

const ASSET_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

const DEFAULT_CONFIG: PaperTradingConfig = {
  id: 'default',
  enabled: true,
  is_live: false,
  trade_size_usd: 5,
  min_delta_usd: 10,
  min_share_price: 0.35,
  max_share_price: 0.65,
  tp_cents: 3,
  tp_enabled: true,
  sl_cents: 3,
  sl_enabled: true,
  timeout_ms: 15000,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
};

// ============================================
// STATE
// ============================================

let supabase: SupabaseClient | null = null;
let binanceWs: WebSocket | null = null;
let configSubscription: { unsubscribe: () => void } | null = null;
let isRunning = false;
let currentConfig: PaperTradingConfig = DEFAULT_CONFIG;

const priceState: Record<Asset, PriceState> = {
  BTC: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  ETH: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  SOL: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  XRP: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
};

// Rolling window state for each asset
interface PriceTick {
  price: number;
  ts: number;
}

const priceWindows: Record<Asset, PriceTick[]> = {
  BTC: [],
  ETH: [],
  SOL: [],
  XRP: [],
};

// Track window start price for delta calculation
const windowStartPrices: Record<Asset, { price: number; ts: number } | null> = {
  BTC: null,
  ETH: null,
  SOL: null,
  XRP: null,
};

const activeSignals = new Map<string, { signal: PaperSignal; tpSlInterval: NodeJS.Timeout | null; timeoutTimer: NodeJS.Timeout | null }>();
const marketInfo: Record<Asset, MarketInfo | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// ============================================
// DATABASE
// ============================================

function initSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }
  
  return createClient(url, key);
}

async function loadConfig(): Promise<PaperTradingConfig> {
  if (!supabase) return DEFAULT_CONFIG;
  
  try {
    const { data, error } = await supabase
      .from('paper_trading_config')
      .select('*')
      .limit(1)
      .single();
    
    if (error || !data) {
      console.log('[PaperTrader] No config found, using defaults');
      return DEFAULT_CONFIG;
    }
    
    return {
      id: data.id,
      enabled: data.enabled ?? true,
      is_live: data.is_live ?? false,
      trade_size_usd: data.trade_size_usd ?? 5,
      min_delta_usd: data.min_delta_usd ?? 10,
      min_share_price: data.min_share_price ?? 0.35,
      max_share_price: data.max_share_price ?? 0.65,
      tp_cents: data.tp_cents ?? 3,
      tp_enabled: data.tp_enabled ?? true,
      sl_cents: data.sl_cents ?? 3,
      sl_enabled: data.sl_enabled ?? true,
      timeout_ms: data.timeout_ms ?? 15000,
      assets: data.assets ?? ['BTC', 'ETH', 'SOL', 'XRP'],
    };
  } catch (err) {
    console.error('[PaperTrader] Failed to load config:', err);
    return DEFAULT_CONFIG;
  }
}

function subscribeToConfigChanges(): void {
  if (!supabase) return;
  
  console.log('[PaperTrader] 🔄 Subscribing to config changes...');
  
  const channel = supabase
    .channel('paper_trading_config_changes')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'paper_trading_config',
      },
      (payload) => {
        console.log('[PaperTrader] 📨 Config update received');
        
        const newData = payload.new as Record<string, unknown>;
        const oldEnabled = currentConfig.enabled;
        const oldIsLive = currentConfig.is_live;
        
        currentConfig = {
          id: String(newData.id ?? currentConfig.id),
          enabled: Boolean(newData.enabled ?? currentConfig.enabled),
          is_live: Boolean(newData.is_live ?? currentConfig.is_live),
          trade_size_usd: Number(newData.trade_size_usd ?? currentConfig.trade_size_usd),
          min_delta_usd: Number(newData.min_delta_usd ?? currentConfig.min_delta_usd),
          min_share_price: Number(newData.min_share_price ?? currentConfig.min_share_price),
          max_share_price: Number(newData.max_share_price ?? currentConfig.max_share_price),
          tp_cents: Number(newData.tp_cents ?? currentConfig.tp_cents),
          tp_enabled: Boolean(newData.tp_enabled ?? currentConfig.tp_enabled),
          sl_cents: Number(newData.sl_cents ?? currentConfig.sl_cents),
          sl_enabled: Boolean(newData.sl_enabled ?? currentConfig.sl_enabled),
          timeout_ms: Number(newData.timeout_ms ?? currentConfig.timeout_ms),
          assets: (newData.assets as Asset[]) ?? currentConfig.assets,
        };
        
        // Log significant changes
        if (oldEnabled !== currentConfig.enabled) {
          console.log(`[PaperTrader] ${currentConfig.enabled ? '▶️ ENABLED' : '⏸️ DISABLED'}`);
        }
        if (oldIsLive !== currentConfig.is_live) {
          console.log(`[PaperTrader] ${currentConfig.is_live ? '🔴 LIVE MODE ACTIVATED' : '📝 PAPER MODE'}`);
        }
        
        console.log(`[PaperTrader] Config updated: enabled=${currentConfig.enabled}, is_live=${currentConfig.is_live}, trade_size=$${currentConfig.trade_size_usd}`);
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[PaperTrader] ✅ Config subscription active');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('[PaperTrader] ❌ Config subscription failed');
      }
    });
  
  configSubscription = { unsubscribe: () => supabase?.removeChannel(channel) };
}

async function saveSignal(signal: PaperSignal): Promise<string | null> {
  if (!supabase) return null;
  
  try {
    // If signal has an ID, update it; otherwise insert new
    if (signal.id) {
      const { data, error } = await supabase
        .from('paper_signals')
        .update(signal as never)
        .eq('id', signal.id)
        .select('id')
        .single();
      
      if (error) {
        console.error('[PaperTrader] Failed to update signal:', error.message);
        return signal.id;
      }
      
      return data?.id ?? signal.id;
    } else {
      // Insert new signal without id (let DB generate it)
      const { id, ...signalWithoutId } = signal;
      const { data, error } = await supabase
        .from('paper_signals')
        .insert(signalWithoutId as never)
        .select('id')
        .single();
      
      if (error) {
        console.error('[PaperTrader] Failed to insert signal:', error.message, error);
        return null;
      }
      
      console.log('[PaperTrader] 💾 Signal saved to DB:', data?.id);
      return data?.id ?? null;
    }
  } catch (err) {
    console.error('[PaperTrader] Error saving signal:', err);
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
    console.error('[PaperTrader] Error saving TP/SL event:', err);
  }
}

async function savePriceSnapshot(asset: Asset): Promise<void> {
  if (!supabase) return;
  
  const state = priceState[asset];
  const market = marketInfo[asset];
  
  try {
    await supabase.from('paper_price_snapshots').insert({
      ts: Date.now(),
      asset,
      binance_price: state.binance,
      chainlink_price: state.chainlink,
      up_best_bid: state.upBestBid,
      up_best_ask: state.upBestAsk,
      down_best_bid: state.downBestBid,
      down_best_ask: state.downBestAsk,
      market_slug: market?.slug ?? null,
      strike_price: market?.strikePrice ?? null,
    } as never);
  } catch (err) {
    console.error('[PaperTrader] Error saving price snapshot:', err);
  }
}

// ============================================
// BINANCE WEBSOCKET
// ============================================

function connectBinance(): void {
  const streams = currentConfig.assets.map(a => `${ASSET_SYMBOLS[a]}@aggTrade`).join('/');
  const url = `${BINANCE_WS_URL}/${streams}`;
  
  console.log(`[PaperTrader] Connecting to Binance: ${url}`);
  
  binanceWs = new WebSocket(url);
  
  binanceWs.on('open', () => {
    console.log('[PaperTrader] Binance WebSocket connected');
  });
  
  binanceWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.e === 'aggTrade') {
        const symbol = msg.s.toLowerCase();
        const price = parseFloat(msg.p);
        
        for (const [asset, sym] of Object.entries(ASSET_SYMBOLS)) {
          if (sym === symbol) {
            handlePriceUpdate(asset as Asset, price);
            break;
          }
        }
      }
    } catch (err) {
      // Ignore parse errors
    }
  });
  
  binanceWs.on('close', () => {
    console.log('[PaperTrader] Binance WebSocket closed, reconnecting in 2s...');
    setTimeout(() => {
      if (isRunning) connectBinance();
    }, 2000);
  });
  
  binanceWs.on('error', (err) => {
    console.error('[PaperTrader] Binance WebSocket error:', err.message);
  });
}

// ============================================
// POLYMARKET CLOB PRICES
// ============================================

async function fetchClobPrices(asset: Asset): Promise<void> {
  const market = marketInfo[asset];
  if (!market) return;
  
  try {
    // Fetch orderbook for UP token
    const upBook = await getOrderbookDepth(market.upTokenId);
    if (upBook) {
      priceState[asset].upBestBid = upBook.topBid;
      priceState[asset].upBestAsk = upBook.topAsk;
    }
    
    // Fetch orderbook for DOWN token
    const downBook = await getOrderbookDepth(market.downTokenId);
    if (downBook) {
      priceState[asset].downBestBid = downBook.topBid;
      priceState[asset].downBestAsk = downBook.topAsk;
    }
    
    priceState[asset].lastUpdate = Date.now();
  } catch (err) {
    console.error(`[PaperTrader] Failed to fetch CLOB prices for ${asset}:`, err);
  }
}

// ============================================
// SIGNAL DETECTION
// ============================================

async function logDecision(
  asset: Asset,
  eventType: string,
  reason: string,
  binancePrice: number | null,
  sharePrice: number | null,
  deltaUsd: number | null
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('paper_trader_logs').insert({
      ts: Date.now(),
      run_id: RUN_ID,
      asset,
      event_type: eventType,
      reason,
      binance_price: binancePrice,
      share_price: sharePrice,
      delta_usd: deltaUsd,
      config_snapshot: currentConfig,
    } as never);
  } catch (err) {
    // Silent fail - don't block trading for logging
  }
}

function handlePriceUpdate(asset: Asset, newPrice: number): void {
  const now = Date.now();
  priceState[asset].binance = newPrice;
  
  if (!currentConfig.enabled) return;
  
  // Add tick to rolling window
  const window = priceWindows[asset];
  window.push({ price: newPrice, ts: now });
  
  // Initialize window start if needed
  if (!windowStartPrices[asset]) {
    windowStartPrices[asset] = { price: newPrice, ts: now };
    return;
  }
  
  // Clean old ticks outside the window
  const cutoff = now - DELTA_WINDOW_MS;
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
  
  // Check if cumulative delta exceeds threshold
  if (Math.abs(delta) < currentConfig.min_delta_usd) {
    // Only log significant deltas (>$2) to avoid spam
    if (Math.abs(delta) >= 2) {
      logDecision(asset, 'skip_delta', `Window delta $${Math.abs(delta).toFixed(2)} over ${windowDuration}ms < min $${currentConfig.min_delta_usd}`, newPrice, null, delta);
    }
    return;
  }
  
  // TRIGGER! We have a significant cumulative delta
  console.log(`[PaperTrader] 🎯 TRIGGER: ${asset} cumulative Δ$${delta.toFixed(2)} over ${windowDuration}ms window`);
  
  const direction: 'UP' | 'DOWN' = delta > 0 ? 'UP' : 'DOWN';
  
  // Get share price
  const state = priceState[asset];
  const sharePrice = direction === 'UP' 
    ? (state.upBestAsk ?? state.upBestBid) 
    : (state.downBestAsk ?? state.downBestBid);
  
  if (sharePrice === null) {
    console.log(`[PaperTrader] No CLOB price for ${asset} ${direction}, skipping`);
    logDecision(asset, 'skip_no_clob', `No CLOB price for ${direction}`, newPrice, null, delta);
    return;
  }
  
  // Check share price bounds
  if (sharePrice < currentConfig.min_share_price || sharePrice > currentConfig.max_share_price) {
    console.log(`[PaperTrader] ${asset} ${direction} share ${(sharePrice * 100).toFixed(1)}¢ outside bounds [${(currentConfig.min_share_price * 100).toFixed(0)}-${(currentConfig.max_share_price * 100).toFixed(0)}¢]`);
    logDecision(asset, 'skip_bounds', `Share ${(sharePrice * 100).toFixed(1)}¢ outside [${(currentConfig.min_share_price * 100).toFixed(0)}-${(currentConfig.max_share_price * 100).toFixed(0)}¢]`, newPrice, sharePrice, delta);
    return;
  }
  
  // Check if we already have an active signal for this asset
  const hasActive = [...activeSignals.values()].some(
    s => s.signal.asset === asset && (s.signal.status === 'pending' || s.signal.status === 'filled')
  );
  if (hasActive) {
    logDecision(asset, 'skip_active', 'Already has active signal', newPrice, sharePrice, delta);
    return;
  }
  
  // Reset window after trigger to avoid re-triggering on same move
  priceWindows[asset] = [{ price: newPrice, ts: now }];
  windowStartPrices[asset] = { price: newPrice, ts: now };
  
  // Create signal
  createSignal(asset, direction, newPrice, delta, sharePrice);
}

async function createSignal(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  binancePrice: number,
  binanceDelta: number,
  sharePrice: number
): Promise<void> {
  const now = Date.now();
  const market = marketInfo[asset];

  // chain.ts may return either a number or an object like { price, timestamp }.
  // Our DB column `paper_signals.chainlink_price` is numeric, so normalize here.
  const rawChainlink = await fetchChainlinkPrice(asset);
  const chainlinkPrice =
    typeof rawChainlink === 'number'
      ? rawChainlink
      : rawChainlink && typeof rawChainlink === 'object' && typeof (rawChainlink as any).price === 'number'
        ? Number((rawChainlink as any).price)
        : null;

  const signal: PaperSignal = {
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
    notes: `Signal: ${direction} | Binance Δ$${Math.abs(binanceDelta).toFixed(2)} | Share ${(sharePrice * 100).toFixed(1)}¢`,
    config_snapshot: currentConfig,
    is_live: currentConfig.is_live,
  };

  console.log(`[PaperTrader] 📊 Signal: ${asset} ${direction} @ ${(sharePrice * 100).toFixed(1)}¢ | Δ$${Math.abs(binanceDelta).toFixed(2)}`);
  
  // Save to database
  const signalId = await saveSignal(signal);
  if (signalId) {
    signal.id = signalId;
  }
  
  // Simulate fill after small delay
  setTimeout(() => simulateFill(signal), 50 + Math.random() * 50);
}

async function simulateFill(signal: PaperSignal): Promise<void> {
  const now = Date.now();
  const fillLatency = now - signal.signal_ts;
  
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
  
  // Update signal
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
  signal.notes = `Filled @ ${(entryPrice * 100).toFixed(1)}¢ | TP: ${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ | SL: ${slPrice ? (slPrice * 100).toFixed(1) : '-'}¢`;
  
  console.log(`[PaperTrader] ✅ Filled ${signal.asset} ${signal.direction} @ ${(entryPrice * 100).toFixed(1)}¢ | TP: ${tpPrice ? (tpPrice * 100).toFixed(1) : '-'}¢ | SL: ${slPrice ? (slPrice * 100).toFixed(1) : '-'}¢`);
  
  // Save updated signal
  await saveSignal(signal);
  
  // Start TP/SL monitoring
  const tpSlInterval = startTpSlMonitoring(signal);
  
  // Set timeout fallback
  const timeoutTimer = setTimeout(() => {
    handleTimeout(signal);
  }, currentConfig.timeout_ms);
  
  activeSignals.set(signal.id!, { signal, tpSlInterval, timeoutTimer });
}

function startTpSlMonitoring(signal: PaperSignal): NodeJS.Timeout | null {
  if (!signal.tp_price && !signal.sl_price) return null;
  
  return setInterval(async () => {
    const state = priceState[signal.asset];
    const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    if (currentBid === null) return;
    
    // Log TP/SL event
    await saveTpSlEvent(
      signal.id!,
      Date.now(),
      currentBid,
      signal.tp_price,
      signal.sl_price,
      null
    );
    
    console.log(`[PaperTrader] TP/SL check: ${signal.asset} bid=${(currentBid * 100).toFixed(1)}¢ | TP=${signal.tp_price ? (signal.tp_price * 100).toFixed(1) : '-'}¢ | SL=${signal.sl_price ? (signal.sl_price * 100).toFixed(1) : '-'}¢`);
    
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

async function handleExit(signal: PaperSignal, exitType: 'tp' | 'sl' | 'timeout', exitPrice: number): Promise<void> {
  const active = activeSignals.get(signal.id!);
  if (!active) return;
  
  // Clear timers
  if (active.tpSlInterval) clearInterval(active.tpSlInterval);
  if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  activeSignals.delete(signal.id!);
  
  const now = Date.now();
  const shares = signal.shares ?? 0;
  const entryPrice = signal.entry_price ?? 0;
  const entryFee = signal.entry_fee ?? 0;
  
  // Exit fee: maker rebate for TP, taker fee for SL/timeout
  const exitFee = exitType === 'tp' ? -shares * 0.005 : shares * 0.02;
  const totalFees = entryFee + exitFee;
  const grossPnl = (exitPrice - entryPrice) * shares;
  const netPnl = grossPnl - totalFees;
  
  // Update signal
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
  
  console.log(`[PaperTrader] ${emoji} ${label}: ${signal.asset} ${signal.direction} @ ${(exitPrice * 100).toFixed(1)}¢ | Net: $${netPnl.toFixed(2)}`);
  
  // Save TP/SL trigger event
  await saveTpSlEvent(signal.id!, now, exitPrice, signal.tp_price, signal.sl_price, exitType === 'timeout' ? null : exitType);
  
  // Save final signal state
  await saveSignal(signal);
}

async function handleTimeout(signal: PaperSignal): Promise<void> {
  const state = priceState[signal.asset];
  const currentBid = signal.direction === 'UP' ? state.upBestBid : state.downBestBid;
  const exitPrice = currentBid ?? (signal.entry_price ?? 0);
  
  await handleExit(signal, 'timeout', exitPrice);
}

// ============================================
// MARKET INFO FETCHING
// ============================================

async function fetchMarketInfo(): Promise<void> {
  console.log('[PaperTrader] Fetching market info...');
  
  // This would need to call the backend to get current markets
  // For now, we'll rely on the CLOB prices being fetched periodically
  // The actual market info should come from the main runner's market data
}

// ============================================
// MAIN LOOP
// ============================================

// Track when we last refreshed markets
let lastMarketRefresh = 0;
const MARKET_REFRESH_INTERVAL_MS = 60_000; // Refresh every 60 seconds

// Track when we last reloaded config
let lastConfigReload = 0;
const CONFIG_RELOAD_INTERVAL_MS = 10_000; // Reload config every 10 seconds as fallback

// Check if any market is expiring soon or has expired
function shouldRefreshMarkets(): boolean {
  const now = Date.now();
  
  // Refresh if we haven't in a while
  if (now - lastMarketRefresh > MARKET_REFRESH_INTERVAL_MS) {
    return true;
  }
  
  // Check if any active market is expired or expiring within 30 seconds
  for (const asset of Object.keys(marketInfo) as Asset[]) {
    const info = marketInfo[asset];
    if (!info) continue;
    
    const endTime = new Date(info.eventEndTime).getTime();
    const timeUntilEnd = endTime - now;
    
    // If market ended or ends within 30 seconds, refresh
    if (timeUntilEnd < 30_000) {
      console.log(`[PaperTrader] 🔄 ${asset} market expired/expiring (${Math.floor(timeUntilEnd / 1000)}s left), refreshing...`);
      return true;
    }
  }
  
  return false;
}

async function runLoop(): Promise<void> {
  while (isRunning) {
    try {
      const now = Date.now();
      
      // Periodically reload config as fallback (realtime may not work in Node.js)
      if (now - lastConfigReload > CONFIG_RELOAD_INTERVAL_MS) {
        const oldDelta = currentConfig.min_delta_usd;
        const oldMinShare = currentConfig.min_share_price;
        const oldMaxShare = currentConfig.max_share_price;
        
        currentConfig = await loadConfig();
        lastConfigReload = now;
        
        // Log if config changed
        if (oldDelta !== currentConfig.min_delta_usd || 
            oldMinShare !== currentConfig.min_share_price || 
            oldMaxShare !== currentConfig.max_share_price) {
          console.log(`[PaperTrader] 📋 Config reloaded: delta=$${currentConfig.min_delta_usd}, shares=${(currentConfig.min_share_price * 100).toFixed(0)}-${(currentConfig.max_share_price * 100).toFixed(0)}¢`);
        }
      }
      
      if (!currentConfig.enabled) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      
      // Check if we need to refresh markets (expired or periodic)
      if (shouldRefreshMarkets()) {
        console.log('[PaperTrader] 🔄 Refreshing markets...');
        await fetchActiveMarkets();
        lastMarketRefresh = Date.now();
      }
      
      // Fetch CLOB prices for all assets
      for (const asset of currentConfig.assets) {
        await fetchClobPrices(asset);
      }
      
      // Save price snapshots every 10 seconds
      if (Date.now() % 10000 < 2000) {
        for (const asset of currentConfig.assets) {
          await savePriceSnapshot(asset);
        }
      }
      
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error('[PaperTrader] Loop error:', err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ============================================
// PUBLIC API
// ============================================

export async function startPaperTrader(): Promise<void> {
  if (isRunning) {
    console.log('[PaperTrader] Already running');
    return;
  }
  
  console.log('[PaperTrader] Starting...');
  console.log(`[PaperTrader] Run ID: ${RUN_ID}`);
  
  // Initialize Supabase
  supabase = initSupabase();
  
  // Load initial config
  currentConfig = await loadConfig();
  console.log(`[PaperTrader] Config loaded: enabled=${currentConfig.enabled}, is_live=${currentConfig.is_live}, size=$${currentConfig.trade_size_usd}`);
  
  // Fetch active markets for standalone mode
  await fetchActiveMarkets();
  
  // Subscribe to config changes for hot-reload
  subscribeToConfigChanges();
  
  isRunning = true;
  
  // Connect to Binance
  connectBinance();
  
  // Start main loop
  runLoop();
  
  console.log('[PaperTrader] Started successfully (hot-reload enabled)');
}

// ============================================
// MARKET FETCHING
// ============================================

async function fetchActiveMarkets(): Promise<void> {
  if (!supabase) return;
  
  console.log('[PaperTrader] Fetching active markets...');
  
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.warn('[PaperTrader] Cannot fetch markets: missing Supabase credentials');
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
      console.warn(`[PaperTrader] Failed to fetch markets: ${response.status}`);
      return;
    }
    
    const data = await response.json();
    const markets = data.markets || [];
    
    let count = 0;
    for (const market of markets) {
      const asset = market.asset?.toUpperCase() as Asset;
      if (!asset || !['BTC', 'ETH', 'SOL', 'XRP'].includes(asset)) continue;
      
      // Edge function returns upTokenId/downTokenId directly
      const upTokenId = market.upTokenId;
      const downTokenId = market.downTokenId;
      
      if (!upTokenId || !downTokenId) {
        console.log(`[PaperTrader] Skipping ${asset}: missing token IDs`);
        continue;
      }
      
      const info: MarketInfo = {
        asset,
        slug: market.slug,
        strikePrice: market.strikePrice || 0,
        upTokenId,
        downTokenId,
        eventEndTime: market.eventEndTime,
      };
      
      marketInfo[asset] = info;
      count++;
      console.log(`[PaperTrader] ✓ ${asset}: ${market.slug} (strike: $${info.strikePrice})`);
    }
    
    console.log(`[PaperTrader] Loaded ${count} active markets`);
    
  } catch (err) {
    console.error('[PaperTrader] Error fetching markets:', err);
  }
}

export async function stopPaperTrader(): Promise<void> {
  console.log('[PaperTrader] Stopping...');
  
  isRunning = false;
  
  // Unsubscribe from config changes
  if (configSubscription) {
    configSubscription.unsubscribe();
    configSubscription = null;
  }
  
  // Close Binance WebSocket
  if (binanceWs) {
    binanceWs.close();
    binanceWs = null;
  }
  
  // Clear all active signals
  for (const [id, active] of activeSignals) {
    if (active.tpSlInterval) clearInterval(active.tpSlInterval);
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
  }
  activeSignals.clear();
  
  console.log('[PaperTrader] Stopped');
}

export function getPaperTraderStats(): {
  isRunning: boolean;
  runId: string;
  config: PaperTradingConfig;
  activeSignals: number;
  prices: Record<Asset, PriceState>;
} {
  return {
    isRunning,
    runId: RUN_ID,
    config: currentConfig,
    activeSignals: activeSignals.size,
    prices: priceState,
  };
}

export function setMarketInfo(asset: Asset, info: MarketInfo): void {
  marketInfo[asset] = info;
  console.log(`[PaperTrader] Market info set for ${asset}: ${info.slug}`);
}

// Feature flag for paper trader
export const FEATURE_PAPER_TRADER = process.env.FEATURE_PAPER_TRADER === 'true';

// ============================================
// STANDALONE ENTRY POINT
// ============================================

// Run as standalone if executed directly
const isMainModule = process.argv[1]?.includes('paper-trader');
if (isMainModule) {
  console.log('='.repeat(50));
  console.log('  PAPER TRADER - Standalone Mode');
  console.log('='.repeat(50));
  
  startPaperTrader().catch((err) => {
    console.error('[PaperTrader] Fatal error:', err);
    process.exit(1);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[PaperTrader] Shutting down...');
    await stopPaperTrader();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n[PaperTrader] Received SIGTERM, shutting down...');
    await stopPaperTrader();
    process.exit(0);
  });
}
