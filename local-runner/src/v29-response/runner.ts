/**
 * V29 Response-Based Strategy - Main Runner
 * 
 * STRATEGY SUMMARY:
 * 1. Binance tick ≥$6 in 300ms window → SIGNAL
 * 2. Entry: Maker-biased limit order at best_bid + buffer
 * 3. Exit: Response-based (target, exhaustion, adverse, timeout)
 * 4. Asymmetric: UP and DOWN have different parameters
 * 
 * CRITICAL: Exit based on Polymarket price response, NOT fixed time!
 */

// HTTP agent must be imported first
import './http-agent.js';

import 'dotenv/config';
import { randomUUID } from 'crypto';

import { Asset, V29Config, DEFAULT_CONFIG, BINANCE_SYMBOLS } from './config.js';
import type { MarketInfo, PriceState, Signal, ActivePosition, SignalLog, TickLog } from './types.js';
import { checkSignal, addPriceTick, resetSignalState } from './signal-detector.js';
import { checkExit, createPositionTracker, ExitType } from './exit-monitor.js';
import { initDb, loadConfig, saveSignal, queueTick, queueLog, sendHeartbeat, flushAll } from './db.js';

// External dependencies
import { startBinanceFeed, stopBinanceFeed } from '../v29/binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from '../v29/chainlink.js';
import { fetchMarketOrderbook } from '../v29/orderbook.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache } from '../v29/trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, isRunnerActive } from '../v29/lease.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v29r-${Date.now().toString(36)}`;
let isRunning = false;
let config: V29Config = { ...DEFAULT_CONFIG };

// Markets by asset
const markets = new Map<Asset, MarketInfo>();

// Price state by asset
const priceState: Record<Asset, PriceState> = {
  BTC: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  ETH: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  SOL: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  XRP: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
};

// Active positions (one per asset at most)
const activePositions = new Map<Asset, ActivePosition>();

// Cooldowns
const lastExitTime: Record<Asset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };

// Stats
let signalCount = 0;
let tradeCount = 0;
let exitCount = 0;
let totalPnl = 0;

// Intervals
let orderbookPollInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let marketRefreshInterval: NodeJS.Timeout | null = null;

// ============================================
// LOGGING (async, non-blocking)
// ============================================

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29R] ${msg}`);
  queueLog(RUN_ID, 'info', 'system', msg, undefined, data);
}

function logAsset(asset: Asset, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29R] [${asset}] ${msg}`);
  queueLog(RUN_ID, 'info', asset, msg, asset, data);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29R] ❌ ${msg}`, err ?? '');
  queueLog(RUN_ID, 'error', 'error', msg, undefined, err ? { error: String(err) } : undefined);
}

// ============================================
// MARKET LOADING
// ============================================

async function fetchMarkets(): Promise<void> {
  const backendUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const backendKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!backendUrl || !backendKey) {
    log('⚠️ No backend URL configured');
    return;
  }
  
  try {
    const res = await fetch(`${backendUrl}/functions/v1/get-market-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${backendKey}`,
      },
      body: JSON.stringify({ assets: config.assets, v26: true }),
    });
    
    if (!res.ok) {
      log(`Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      const now = Date.now();
      
      for (const m of data.markets) {
        if (!m.asset || !m.upTokenId || !m.downTokenId) continue;
        
        const asset = m.asset as Asset;
        const slug = String(m.slug || '');
        
        // Only 15m markets
        if (!slug.toLowerCase().includes('-15m-')) continue;
        
        let endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();
        if (!Number.isFinite(endMs)) continue;
        if (endMs <= now) continue;
        
        const existingMarket = markets.get(asset);
        const isNewMarket = !existingMarket || existingMarket.slug !== slug;
        
        const marketInfo: MarketInfo = {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          endTime: new Date(endMs),
        };
        
        markets.set(asset, marketInfo);
        
        if (isNewMarket) {
          log(`📊 ${asset} NEW: ${slug}`, { slug, strikePrice: marketInfo.strikePrice });
          
          // Reset signal state for new market
          resetSignalState(asset);
          
          // Clear active position if market changed
          if (activePositions.has(asset)) {
            log(`⚠️ ${asset} position cleared due to market change`);
            activePositions.delete(asset);
          }
          
          // Update pre-signed cache
          void updateMarketCache(asset, m.upTokenId, m.downTokenId);
          
          // Fetch initial orderbook
          void fetchOrderbook(asset, marketInfo);
        }
      }
      
      log(`Active: ${markets.size} markets`);
    }
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function fetchOrderbook(asset: Asset, market: MarketInfo): Promise<void> {
  try {
    const book = await fetchMarketOrderbook(market);
    
    if (book.upBestAsk !== undefined) priceState[asset].upBestAsk = book.upBestAsk;
    if (book.upBestBid !== undefined) priceState[asset].upBestBid = book.upBestBid;
    if (book.downBestAsk !== undefined) priceState[asset].downBestAsk = book.downBestAsk;
    if (book.downBestBid !== undefined) priceState[asset].downBestBid = book.downBestBid;
    priceState[asset].lastOrderbookUpdate = Date.now();
  } catch (err) {
    // Silent fail
  }
}

async function pollAllOrderbooks(): Promise<void> {
  const promises: Promise<void>[] = [];
  
  for (const [asset, market] of markets) {
    promises.push(fetchOrderbook(asset, market));
  }
  
  await Promise.allSettled(promises);
}

// ============================================
// BINANCE PRICE HANDLER (HOT PATH)
// ============================================

function handleBinancePrice(asset: Asset, price: number, timestamp: number): void {
  if (!isRunning || !isRunnerActive()) return;
  
  const now = Date.now();
  const market = markets.get(asset);
  const state = priceState[asset];
  
  // Update state
  state.binance = price;
  state.binanceTs = timestamp;
  
  // Add to rolling window for signal detection
  addPriceTick(asset, price, now);
  
  // Log tick (async)
  queueTick({
    run_id: RUN_ID,
    asset,
    ts: now,
    binance_price: price,
    up_best_bid: state.upBestBid ?? undefined,
    up_best_ask: state.upBestAsk ?? undefined,
    down_best_bid: state.downBestBid ?? undefined,
    down_best_ask: state.downBestAsk ?? undefined,
    market_slug: market?.slug,
    strike_price: market?.strikePrice,
    signal_triggered: false,
  });
  
  // Check for active position (exit monitoring is done separately)
  if (activePositions.has(asset)) {
    // Position exists - update price and check exit
    checkPositionExit(asset);
    return;
  }
  
  // No active position - check for signal
  checkForSignal(asset);
}

// ============================================
// SIGNAL CHECKING
// ============================================

function checkForSignal(asset: Asset): void {
  const market = markets.get(asset);
  const state = priceState[asset];
  const now = Date.now();
  
  // Check cooldown
  const inCooldown = (now - lastExitTime[asset]) < config.cooldown_after_exit_ms;
  
  // Check exposure
  let currentExposure = 0;
  for (const pos of activePositions.values()) {
    currentExposure += pos.totalCost;
  }
  
  const result = checkSignal(
    asset,
    config,
    state,
    market,
    activePositions.has(asset),
    inCooldown,
    currentExposure,
    RUN_ID,
    (msg, data) => logAsset(asset, msg, data)
  );
  
  if (!result.triggered) {
    // Log skip reasons for analysis
    if (result.skipReason && result.skipReason !== 'delta_too_small' && result.skipReason !== 'disabled') {
      logAsset(asset, `SKIP: ${result.skipReason} ${result.skipDetails ?? ''}`, {
        skipReason: result.skipReason,
        skipDetails: result.skipDetails,
      });
    }
    return;
  }
  
  // Signal triggered!
  signalCount++;
  
  const signal = result.signal!;
  
  // Execute entry (async, non-blocking)
  void executeEntry(asset, signal, market!);
}

// ============================================
// ENTRY EXECUTION
// ============================================

async function executeEntry(asset: Asset, signal: Signal, market: MarketInfo): Promise<void> {
  const state = priceState[asset];
  const direction = signal.direction;
  
  const bestBid = direction === 'UP' ? state.upBestBid : state.downBestBid;
  const bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!bestBid || !bestAsk) {
    signal.status = 'failed';
    signal.skip_reason = 'no_orderbook_at_entry';
    void saveSignalLog(signal, state);
    return;
  }
  
  // Calculate entry price (maker-biased)
  const buffer = config.entry_price_buffer_cents / 100;
  const entryPrice = Math.round((bestBid + buffer) * 100) / 100;
  
  // Validate slippage
  if (entryPrice > bestAsk + (config.max_entry_slippage_cents / 100)) {
    signal.status = 'skipped';
    signal.skip_reason = 'slippage_too_high';
    void saveSignalLog(signal, state);
    return;
  }
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const shares = config.shares_per_trade;
  
  logAsset(asset, `📤 ENTRY: ${direction} ${shares} @ ${(entryPrice * 100).toFixed(1)}¢`, {
    signalId: signal.id,
    entryPrice,
    shares,
  });
  
  signal.order_submit_ts = Date.now();
  
  try {
    const result = await placeBuyOrder(tokenId, entryPrice, shares, asset, direction);
    
    if (!result.success) {
      signal.status = 'failed';
      signal.skip_reason = result.error ?? 'order_failed';
      void saveSignalLog(signal, state);
      logAsset(asset, `❌ ENTRY FAILED: ${result.error}`);
      return;
    }
    
    const filledSize = result.filledSize ?? shares;
    const avgPrice = result.avgPrice ?? entryPrice;
    
    if (filledSize <= 0) {
      signal.status = 'failed';
      signal.skip_reason = 'no_fill';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Create active position
    const position = createPositionTracker(
      signal,
      asset,
      direction,
      market.slug,
      tokenId,
      filledSize,
      avgPrice,
      result.orderId
    );
    
    activePositions.set(asset, position);
    tradeCount++;
    
    signal.status = 'filled';
    signal.entry_price = avgPrice;
    signal.shares = filledSize;
    signal.fill_ts = Date.now();
    signal.order_id = result.orderId;
    
    logAsset(asset, `✅ FILLED: ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ | latency=${Date.now() - signal.signal_ts}ms`, {
      signalId: signal.id,
      filledSize,
      avgPrice,
      latency: Date.now() - signal.signal_ts,
    });
    
    void saveSignalLog(signal, state);
    
    // Start exit monitoring
    startExitMonitor(asset, position);
    
  } catch (err) {
    signal.status = 'failed';
    signal.skip_reason = String(err);
    void saveSignalLog(signal, state);
    logError(`Entry error for ${asset}`, err);
  }
}

// ============================================
// EXIT MONITORING (CRITICAL)
// ============================================

function startExitMonitor(asset: Asset, position: ActivePosition): void {
  // Clear any existing monitor
  if (position.monitorInterval) {
    clearInterval(position.monitorInterval);
  }
  
  // Schedule price tracking for analytics
  schedulePriceTracking(asset, position);
  
  // Start exit check loop
  position.monitorInterval = setInterval(() => {
    checkPositionExit(asset);
  }, config.exit_monitor_interval_ms);
}

function checkPositionExit(asset: Asset): void {
  const position = activePositions.get(asset);
  if (!position) return;
  
  const state = priceState[asset];
  
  const decision = checkExit(
    position,
    config,
    state,
    (msg, data) => logAsset(asset, msg, data)
  );
  
  if (decision.shouldExit) {
    void executeExit(asset, position, decision.type!, decision.reason ?? '', decision.unrealizedPnl ?? 0);
  }
}

// ============================================
// EXIT EXECUTION
// ============================================

async function executeExit(
  asset: Asset,
  position: ActivePosition,
  exitType: ExitType,
  exitReason: string,
  unrealizedPnl: number
): Promise<void> {
  // Stop monitoring
  if (position.monitorInterval) {
    clearInterval(position.monitorInterval);
    position.monitorInterval = undefined;
  }
  
  const state = priceState[asset];
  const market = markets.get(asset);
  const signal = position.signal;
  
  const bestBid = position.direction === 'UP' ? state.upBestBid : state.downBestBid;
  
  if (!bestBid || !market) {
    logAsset(asset, `⚠️ EXIT: No bid available, position stuck`);
    activePositions.delete(asset);
    lastExitTime[asset] = Date.now();
    return;
  }
  
  // Sell at market (use bid)
  const sellPrice = Math.floor(bestBid * 100) / 100;
  
  logAsset(asset, `📤 EXIT: ${position.direction} ${position.shares} @ ${(sellPrice * 100).toFixed(1)}¢ | type=${exitType}`, {
    positionId: position.id,
    exitType,
    exitReason,
    sellPrice,
  });
  
  try {
    const result = await placeSellOrder(
      position.tokenId,
      sellPrice,
      position.shares,
      asset,
      position.direction
    );
    
    const exitTs = Date.now();
    const holdTimeMs = exitTs - position.entryTime;
    
    let actualExitPrice = sellPrice;
    let soldShares = position.shares;
    
    if (result.success) {
      actualExitPrice = result.avgPrice ?? sellPrice;
      soldShares = result.filledSize ?? position.shares;
    }
    
    // Calculate P&L
    const grossPnl = (actualExitPrice - position.entryPrice) * soldShares;
    const fees = soldShares * actualExitPrice * 0.001; // ~0.1% fee estimate
    const netPnl = grossPnl - fees;
    
    // Update stats
    exitCount++;
    totalPnl += netPnl;
    
    // Update signal
    signal.status = 'exited';
    signal.exit_price = actualExitPrice;
    signal.exit_ts = exitTs;
    signal.exit_type = exitType;
    signal.exit_reason = exitReason;
    signal.gross_pnl = grossPnl;
    signal.fees = fees;
    signal.net_pnl = netPnl;
    
    void saveSignalLog(signal, state);
    
    logAsset(asset, `✅ EXITED: ${position.direction} | type=${exitType} | hold=${holdTimeMs}ms | PnL=${(netPnl * 100).toFixed(2)}¢`, {
      positionId: position.id,
      exitType,
      holdTimeMs,
      grossPnl,
      netPnl,
    });
    
    // Remove position
    activePositions.delete(asset);
    lastExitTime[asset] = exitTs;
    
  } catch (err) {
    logError(`Exit error for ${asset}`, err);
    
    // Still remove position to avoid stuck state
    activePositions.delete(asset);
    lastExitTime[asset] = Date.now();
  }
}

// ============================================
// PRICE TRACKING FOR ANALYTICS
// ============================================

function schedulePriceTracking(asset: Asset, position: ActivePosition): void {
  const signal = position.signal;
  const state = priceState[asset];
  
  // Track price at +1s, +2s, +3s, +5s
  const trackAt = [1000, 2000, 3000, 5000];
  
  for (const delay of trackAt) {
    setTimeout(() => {
      const currentBid = position.direction === 'UP' ? state.upBestBid : state.downBestBid;
      
      if (currentBid) {
        if (delay === 1000) signal.price_at_1s = currentBid;
        if (delay === 2000) signal.price_at_2s = currentBid;
        if (delay === 3000) signal.price_at_3s = currentBid;
        if (delay === 5000) signal.price_at_5s = currentBid;
      }
    }, delay);
  }
}

// ============================================
// SAVE SIGNAL LOG
// ============================================

async function saveSignalLog(signal: Signal, state: PriceState): Promise<void> {
  const logRecord: SignalLog = {
    id: signal.id,
    run_id: RUN_ID,
    asset: signal.asset,
    direction: signal.direction,
    
    binance_price: signal.binance_price,
    binance_delta: signal.binance_delta,
    binance_ts: signal.binance_ts,
    
    share_price_t0: signal.share_price_t0,
    spread_t0: signal.spread_t0,
    best_bid_t0: (signal.direction === 'UP' ? state.upBestBid : state.downBestBid) ?? 0,
    best_ask_t0: (signal.direction === 'UP' ? state.upBestAsk : state.downBestAsk) ?? 0,
    
    market_slug: signal.market_slug,
    strike_price: signal.strike_price,
    
    status: signal.status,
    skip_reason: signal.skip_reason,
    entry_price: signal.entry_price,
    exit_price: signal.exit_price,
    shares: signal.shares,
    
    signal_ts: signal.signal_ts,
    decision_ts: signal.decision_ts,
    fill_ts: signal.fill_ts,
    exit_ts: signal.exit_ts,
    
    exit_type: signal.exit_type,
    exit_reason: signal.exit_reason,
    
    gross_pnl: signal.gross_pnl,
    fees: signal.fees,
    net_pnl: signal.net_pnl,
    
    price_at_1s: signal.price_at_1s,
    price_at_2s: signal.price_at_2s,
    price_at_3s: signal.price_at_3s,
    price_at_5s: signal.price_at_5s,
    
    decision_latency_ms: signal.decision_ts - signal.signal_ts,
    order_latency_ms: signal.order_submit_ts ? signal.order_submit_ts - signal.decision_ts : undefined,
    fill_latency_ms: signal.fill_ts && signal.order_submit_ts ? signal.fill_ts - signal.order_submit_ts : undefined,
    exit_latency_ms: signal.exit_ts && signal.fill_ts ? signal.exit_ts - signal.fill_ts : undefined,
  };
  
  await saveSignal(logRecord);
}

// ============================================
// CHAINLINK HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  priceState[asset].chainlink = price;
}

// ============================================
// HEARTBEAT
// ============================================

async function sendStatusHeartbeat(): Promise<void> {
  const positionsData: Record<string, unknown> = {};
  
  for (const [asset, pos] of activePositions) {
    positionsData[asset] = {
      direction: pos.direction,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      holdTime: Date.now() - pos.entryTime,
    };
  }
  
  await sendHeartbeat(RUN_ID, isRunning ? 'running' : 'stopped', {
    signals: signalCount,
    trades: tradeCount,
    exits: exitCount,
    totalPnl,
    activePositions: activePositions.size,
    positions: positionsData,
    markets: markets.size,
    config: {
      signal_delta_usd: config.signal_delta_usd,
      up_target: config.up.target_profit_cents_min,
      down_target: config.down.target_profit_cents_min,
    },
  });
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  log('🚀 V29 Response-Based Strategy Starting...');
  
  // Initialize DB
  initDb();
  
  // Load config from DB
  const dbConfig = await loadConfig();
  if (dbConfig) {
    config = { ...DEFAULT_CONFIG, ...dbConfig } as V29Config;
    log(`Config loaded from DB`);
  }
  
  // VPN check
  const vpnOk = await verifyVpnConnection();
  if (!vpnOk) {
    log('⚠️ VPN check failed - continuing anyway');
  }
  
  // Test Polymarket connection
  const pmOk = await testConnection();
  if (!pmOk) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');
  
  // Acquire lease
  const leaseOk = await acquireLease(RUN_ID, 'v29-response');
  if (!leaseOk) {
    logError('Failed to acquire lease');
    process.exit(1);
  }
  log('✅ Lease acquired');
  
  // Get balance
  const balance = await getBalance();
  log(`💰 Balance: $${balance.toFixed(2)}`);
  
  // Fetch markets
  await fetchMarkets();
  
  // Initialize pre-signed cache
  const marketsForCache = Array.from(markets.values()).map(m => ({
    asset: m.asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsForCache);
  
  isRunning = true;
  
  // Start Binance feed (zero latency mode)
  startBinanceFeed(
    config.assets,
    handleBinancePrice,
    config.binance_buffer_ms
  );
  log('✅ Binance feed started');
  
  // Start Chainlink feed
  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink feed started');
  
  // Start orderbook polling
  orderbookPollInterval = setInterval(pollAllOrderbooks, config.orderbook_poll_ms);
  
  // Start market refresh
  marketRefreshInterval = setInterval(fetchMarkets, 60_000);
  
  // Start heartbeat
  heartbeatInterval = setInterval(sendStatusHeartbeat, 10_000);
  
  log('🟢 V29 Response-Based Strategy RUNNING');
  log(`   Signal: Δ≥$${config.signal_delta_usd} in ${config.signal_window_ms}ms`);
  log(`   UP: target ${config.up.target_profit_cents_min}-${config.up.target_profit_cents_max}¢, max ${config.up.max_hold_seconds}s`);
  log(`   DOWN: target ${config.down.target_profit_cents_min}-${config.down.target_profit_cents_max}¢, max ${config.down.max_hold_seconds}s`);
  
  // Send initial heartbeat
  await sendStatusHeartbeat();
  
  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    isRunning = false;
    
    // Clear intervals
    if (orderbookPollInterval) clearInterval(orderbookPollInterval);
    if (marketRefreshInterval) clearInterval(marketRefreshInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    // Clear position monitors
    for (const pos of activePositions.values()) {
      if (pos.monitorInterval) clearInterval(pos.monitorInterval);
    }
    
    // Stop feeds
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    
    // Release lease
    await releaseLease();
    
    // Flush logs
    await flushAll();
    
    log('Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
