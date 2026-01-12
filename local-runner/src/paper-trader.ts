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
let isRunning = false;
let currentConfig: PaperTradingConfig = DEFAULT_CONFIG;

const priceState: Record<Asset, PriceState> = {
  BTC: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  ETH: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  SOL: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
  XRP: { binance: 0, chainlink: null, upBestBid: null, upBestAsk: null, downBestBid: null, downBestAsk: null, lastUpdate: 0 },
};

const prevPrices: Record<Asset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
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

async function saveSignal(signal: PaperSignal): Promise<string | null> {
  if (!supabase) return null;
  
  try {
    const { data, error } = await supabase
      .from('paper_signals')
      .upsert(signal as never, { onConflict: 'id' })
      .select('id')
      .single();
    
    if (error) {
      console.error('[PaperTrader] Failed to save signal:', error.message);
      return null;
    }
    
    return data?.id ?? null;
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

function handlePriceUpdate(asset: Asset, newPrice: number): void {
  const prev = prevPrices[asset];
  prevPrices[asset] = newPrice;
  priceState[asset].binance = newPrice;
  
  if (prev === 0) return;
  if (!currentConfig.enabled) return;
  
  const delta = newPrice - prev;
  
  // Check if delta is significant
  if (Math.abs(delta) < currentConfig.min_delta_usd) return;
  
  const direction: 'UP' | 'DOWN' = delta > 0 ? 'UP' : 'DOWN';
  
  // Get share price
  const state = priceState[asset];
  const sharePrice = direction === 'UP' 
    ? (state.upBestAsk ?? state.upBestBid) 
    : (state.downBestAsk ?? state.downBestBid);
  
  if (sharePrice === null) {
    console.log(`[PaperTrader] No CLOB price for ${asset} ${direction}, skipping`);
    return;
  }
  
  // Check share price bounds
  if (sharePrice < currentConfig.min_share_price || sharePrice > currentConfig.max_share_price) {
    console.log(`[PaperTrader] ${asset} ${direction} share ${(sharePrice * 100).toFixed(1)}¢ outside bounds`);
    return;
  }
  
  // Check if we already have an active signal for this asset
  const hasActive = [...activeSignals.values()].some(
    s => s.signal.asset === asset && (s.signal.status === 'pending' || s.signal.status === 'filled')
  );
  if (hasActive) return;
  
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
  const chainlinkPrice = await fetchChainlinkPrice(asset);
  
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

async function runLoop(): Promise<void> {
  while (isRunning) {
    try {
      // Reload config periodically
      currentConfig = await loadConfig();
      
      if (!currentConfig.enabled) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
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
  
  // Load config
  currentConfig = await loadConfig();
  console.log(`[PaperTrader] Config loaded: enabled=${currentConfig.enabled}, is_live=${currentConfig.is_live}, size=$${currentConfig.trade_size_usd}`);
  
  isRunning = true;
  
  // Connect to Binance
  connectBinance();
  
  // Start main loop
  runLoop();
  
  console.log('[PaperTrader] Started successfully');
}

export async function stopPaperTrader(): Promise<void> {
  console.log('[PaperTrader] Stopping...');
  
  isRunning = false;
  
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
