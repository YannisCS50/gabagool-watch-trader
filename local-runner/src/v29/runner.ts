/**
 * V29 Simple Live Runner
 * 
 * Clean implementation:
 * 1. Tick-to-tick delta detection (same as UI)
 * 2. Realtime orderbook pricing (no pre-signed cache)
 * 3. Direct GTC orders at bestAsk + buffer
 * 4. Simple TP/SL monitoring
 */

import 'dotenv/config';
import { v4 as uuid } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal, Position } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v29-${Date.now().toString(36)}`;
let isRunning = false;
let config: V29Config = { ...DEFAULT_CONFIG };

// Markets by asset
const markets = new Map<Asset, MarketInfo>();

// Price state by asset
const priceState: Record<Asset, PriceState> = {
  BTC: { binance: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  ETH: { binance: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  SOL: { binance: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  XRP: { binance: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
};

// Previous tick price for delta calculation
const prevPrices: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Current position (only one at a time)
let activePosition: Position | null = null;
let activeSignal: Signal | null = null;
let lastOrderTime = 0;
let tradesCount = 0;

// ============================================
// LOGGING
// ============================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29] ${msg}`);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29] ❌ ${msg}`, err ?? '');
}

// ============================================
// MARKET LOADING
// ============================================

async function fetchMarkets(): Promise<void> {
  const backendUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const backendKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!backendUrl || !backendKey) {
    log('⚠️ No backend URL/key configured');
    return;
  }
  
  try {
    const res = await fetch(`${backendUrl}/functions/v1/get-market-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${backendKey}`,
      },
      body: JSON.stringify({ assets: config.assets }),
    });
    
    if (!res.ok) {
      log(`⚠️ Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      markets.clear();
      
      for (const m of data.markets) {
        if (m.asset && m.upTokenId && m.downTokenId) {
          markets.set(m.asset as Asset, {
            slug: m.slug,
            asset: m.asset,
            strikePrice: m.strikePrice,
            upTokenId: m.upTokenId,
            downTokenId: m.downTokenId,
            endTime: new Date(m.endTime),
          });
        }
      }
      
      log(`Loaded ${markets.size} markets`);
    }
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// PRICE HANDLING
// ============================================

function handleBinancePrice(asset: Asset, price: number): void {
  const prevPrice = prevPrices[asset];
  prevPrices[asset] = price;
  priceState[asset].binance = price;
  
  // Skip if disabled or no previous price
  if (!config.enabled || prevPrice === null) return;
  
  // Skip if already in a position
  if (activePosition !== null) return;
  
  // Skip if in cooldown
  const now = Date.now();
  if (now - lastOrderTime < config.order_cooldown_ms) return;
  
  // Calculate tick-to-tick delta (Binance price change between ticks)
  const tickDelta = price - prevPrice;
  
  // Log significant deltas (> 50% threshold)
  if (Math.abs(tickDelta) > config.tick_delta_usd * 0.5) {
    log(`📈 ${asset} tick Δ$${tickDelta > 0 ? '+' : ''}${tickDelta.toFixed(2)} / $${config.tick_delta_usd} threshold`);
  }
  
  // Check if tick delta exceeds threshold (e.g., $6 price move)
  if (Math.abs(tickDelta) < config.tick_delta_usd) return;
  
  // Get market to check strike price
  const market = markets.get(asset);
  if (!market || !market.strikePrice) {
    log(`⚠️ No market/strike for ${asset}`);
    return;
  }
  
  // Calculate actual-to-strike delta for direction logic
  // delta = actual (binance/chainlink) - strike
  // positive = actual price is ABOVE strike (likely to settle UP)
  // negative = actual price is BELOW strike (likely to settle DOWN)
  const priceVsStrikeDelta = price - market.strikePrice;
  
  // Determine direction based on tick movement
  const tickDirection: 'UP' | 'DOWN' = tickDelta > 0 ? 'UP' : 'DOWN';
  
  // Apply direction filter based on delta_threshold
  // If actual price is way ABOVE strike (+70): only trade UP (will likely settle UP)
  // If actual price is way BELOW strike (-70): only trade DOWN (will likely settle DOWN)
  // If within ±70 of strike: trade both directions
  
  let allowedDirection: 'UP' | 'DOWN' | 'BOTH';
  if (priceVsStrikeDelta > config.delta_threshold) {
    // Actual is way ABOVE strike - only trade UP
    allowedDirection = 'UP';
  } else if (priceVsStrikeDelta < -config.delta_threshold) {
    // Actual is way BELOW strike - only trade DOWN
    allowedDirection = 'DOWN';
  } else {
    // Within threshold range - trade both
    allowedDirection = 'BOTH';
  }
  
  // Check if tick direction is allowed
  if (allowedDirection !== 'BOTH' && allowedDirection !== tickDirection) {
    log(`⚠️ ${asset} direction ${tickDirection} blocked | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | only ${allowedDirection} allowed`);
    return;
  }
  
  log(`🎯 TRIGGER: ${asset} ${tickDirection} | tick Δ$${tickDelta.toFixed(2)} | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | allowed: ${allowedDirection}`);
  
  // Execute trade
  void executeTrade(asset, tickDirection, price, tickDelta, priceVsStrikeDelta);
}

// ============================================
// TRADE EXECUTION
// ============================================

async function executeTrade(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  binancePrice: number,
  tickDelta: number,
  strikeActualDelta: number
): Promise<void> {
  const signalTs = Date.now();
  
  // Get market
  const market = markets.get(asset);
  if (!market) {
    log(`⚠️ No market for ${asset}`);
    return;
  }
  
  // Get current orderbook for this direction
  const state = priceState[asset];
  const bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!bestAsk || bestAsk <= 0) {
    log(`⚠️ No orderbook for ${asset} ${direction}`);
    return;
  }
  
  // Calculate price with buffer
  const priceBuffer = config.price_buffer_cents / 100;
  const buyPrice = Math.min(
    Math.ceil((bestAsk + priceBuffer) * 100) / 100,
    config.max_share_price
  );
  
  // Skip if price too low (min_share_price check)
  if (buyPrice < config.min_share_price) {
    log(`⚠️ Price ${(buyPrice * 100).toFixed(1)}¢ < min ${(config.min_share_price * 100).toFixed(1)}¢`);
    return;
  }
  
  // Skip if price too high
  if (buyPrice > config.max_share_price) {
    log(`⚠️ Price ${(buyPrice * 100).toFixed(1)}¢ > max ${(config.max_share_price * 100).toFixed(1)}¢`);
    return;
  }
  
  // Calculate shares
  const rawShares = config.trade_size_usd / buyPrice;
  const shares = Math.min(Math.floor(rawShares), config.max_shares);
  
  if (shares < 1) {
    log(`⚠️ Shares < 1`);
    return;
  }
  
  // Create signal
  const signal: Signal = {
    run_id: RUN_ID,
    asset,
    direction,
    binance_price: binancePrice,
    binance_delta: delta,
    share_price: buyPrice,
    market_slug: market.slug,
    strike_price: market.strikePrice,
    status: 'pending',
    signal_ts: signalTs,
    entry_price: null,
    exit_price: null,
    shares: null,
    order_id: null,
    fill_ts: null,
    close_ts: null,
    exit_type: null,
    gross_pnl: null,
    net_pnl: null,
    fees: null,
    notes: `${direction} | Δ$${Math.abs(delta).toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  // Save signal first (get ID)
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  // Mark order time
  lastOrderTime = Date.now();
  
  // Place order
  log(`📤 PLACING ORDER: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`);
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const result = await placeBuyOrder(tokenId, buyPrice, shares);
  
  const latency = Date.now() - signalTs;
  
  if (result.success && result.filledSize && result.filledSize > 0) {
    // SUCCESS!
    signal.status = 'filled';
    signal.entry_price = result.avgPrice ?? buyPrice;
    signal.shares = result.filledSize;
    signal.order_id = result.orderId ?? null;
    signal.fill_ts = Date.now();
    signal.notes = `Filled ${result.filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ | Latency: ${latency}ms`;
    
    tradesCount++;
    
    log(`✅ FILLED: ${asset} ${direction} ${result.filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ (${latency}ms)`);
    
    // Create position
    activePosition = {
      signalId: signal.id!,
      asset,
      direction,
      tokenId,
      entryPrice: signal.entry_price,
      shares: result.filledSize,
      tpPrice: config.tp_enabled ? signal.entry_price + (config.tp_cents / 100) : null,
      slPrice: config.sl_enabled ? signal.entry_price - (config.sl_cents / 100) : null,
      startTime: Date.now(),
    };
    activeSignal = signal;
    
    log(`📊 Position open: TP=${activePosition.tpPrice ? (activePosition.tpPrice * 100).toFixed(1) + '¢' : 'off'} | SL=${activePosition.slPrice ? (activePosition.slPrice * 100).toFixed(1) + '¢' : 'off'}`);
    
    // Start monitoring
    startPositionMonitor();
  } else {
    // FAILED
    signal.status = 'failed';
    signal.notes = `${result.error ?? 'Unknown error'} | Latency: ${latency}ms`;
    
    log(`❌ FAILED: ${result.error ?? 'Unknown'} (${latency}ms)`);
  }
  
  // Update signal in DB
  void saveSignal(signal);
}

// ============================================
// POSITION MONITORING (TP/SL)
// ============================================

let monitorInterval: NodeJS.Timeout | null = null;

function startPositionMonitor(): void {
  if (monitorInterval) return;
  
  monitorInterval = setInterval(() => {
    checkPositionExit();
  }, 500);
}

function stopPositionMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

function checkPositionExit(): void {
  if (!activePosition || !activeSignal) return;
  
  const pos = activePosition;
  const sig = activeSignal;
  const state = priceState[pos.asset];
  
  // Get current bid (what we can sell at)
  const currentBid = pos.direction === 'UP' ? state.upBestBid : state.downBestBid;
  
  if (!currentBid) return;
  
  // Check TP
  if (pos.tpPrice && currentBid >= pos.tpPrice) {
    log(`🎯 TP HIT: ${pos.asset} ${pos.direction} | Bid ${(currentBid * 100).toFixed(1)}¢ >= TP ${(pos.tpPrice * 100).toFixed(1)}¢`);
    void closePosition('TP', currentBid);
    return;
  }
  
  // Check SL
  if (pos.slPrice && currentBid <= pos.slPrice) {
    log(`🛑 SL HIT: ${pos.asset} ${pos.direction} | Bid ${(currentBid * 100).toFixed(1)}¢ <= SL ${(pos.slPrice * 100).toFixed(1)}¢`);
    void closePosition('SL', currentBid);
    return;
  }
  
  // Check timeout
  const elapsed = Date.now() - pos.startTime;
  if (elapsed >= config.timeout_ms) {
    log(`⏰ TIMEOUT: ${pos.asset} ${pos.direction} after ${(elapsed / 1000).toFixed(1)}s`);
    void closePosition('TIMEOUT', currentBid);
    return;
  }
}

async function closePosition(exitType: 'TP' | 'SL' | 'TIMEOUT' | 'MANUAL', exitPrice: number): Promise<void> {
  if (!activePosition || !activeSignal) return;
  
  const pos = activePosition;
  const sig = activeSignal;
  
  stopPositionMonitor();
  
  // Place sell order
  const result = await placeSellOrder(pos.tokenId, exitPrice, pos.shares);
  
  const actualExitPrice = result.success ? (result.avgPrice ?? exitPrice) : exitPrice;
  
  // Calculate PnL
  const grossPnl = (actualExitPrice - pos.entryPrice) * pos.shares;
  const fees = pos.shares * 0.02; // Estimate 2% taker fee
  const netPnl = grossPnl - fees;
  
  // Update signal
  sig.status = 'closed';
  sig.exit_price = actualExitPrice;
  sig.close_ts = Date.now();
  sig.exit_type = exitType;
  sig.gross_pnl = grossPnl;
  sig.net_pnl = netPnl;
  sig.fees = fees;
  sig.notes = `${exitType} @ ${(actualExitPrice * 100).toFixed(1)}¢ | PnL: $${netPnl.toFixed(2)}`;
  
  log(`📉 CLOSED: ${pos.asset} ${pos.direction} | ${exitType} @ ${(actualExitPrice * 100).toFixed(1)}¢ | PnL: $${netPnl.toFixed(2)}`);
  
  void saveSignal(sig);
  
  // Clear position
  activePosition = null;
  activeSignal = null;
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function pollOrderbooks(): Promise<void> {
  const books = await fetchAllOrderbooks(markets);
  
  for (const [asset, book] of books) {
    if (book.upBestAsk !== undefined) priceState[asset].upBestAsk = book.upBestAsk;
    if (book.upBestBid !== undefined) priceState[asset].upBestBid = book.upBestBid;
    if (book.downBestAsk !== undefined) priceState[asset].downBestAsk = book.downBestAsk;
    if (book.downBestBid !== undefined) priceState[asset].downBestBid = book.downBestBid;
    if (book.lastUpdate !== undefined) priceState[asset].lastUpdate = book.lastUpdate;
  }
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    V29 SIMPLE LIVE RUNNER                     ║
║  Clean tick-to-tick delta detection • Realtime orderbooks     ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  log(`Run ID: ${RUN_ID}`);
  
  // Check VPN
  const vpnResult = await verifyVpnConnection();
  if (!vpnResult.passed) {
    logError(`VPN check failed: ${vpnResult.error} - Cloudflare may block requests`);
  } else {
    log(`✅ VPN OK: ${vpnResult.ip} (${vpnResult.provider})`);
  }
  
  // Test Polymarket connection
  const connected = await testConnection();
  if (!connected) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');
  
  // Get balance
  const balance = await getBalance();
  log(`💰 Balance: $${balance.toFixed(2)}`);
  
  // Init DB
  initDb();
  
  // Load config from DB (v29_config table)
  const dbConfig = await loadV29Config();
  if (dbConfig) {
    config = {
      ...config,
      enabled: dbConfig.enabled,
      tick_delta_usd: dbConfig.tick_delta_usd ?? 6,
      delta_threshold: dbConfig.delta_threshold ?? 70,
      min_share_price: dbConfig.min_share_price ?? 0.30,
      max_share_price: dbConfig.max_share_price,
      trade_size_usd: dbConfig.trade_size_usd,
      max_shares: dbConfig.max_shares,
      price_buffer_cents: dbConfig.price_buffer_cents,
      assets: dbConfig.assets as Asset[],
      tp_enabled: dbConfig.tp_enabled,
      tp_cents: dbConfig.tp_cents,
      sl_enabled: dbConfig.sl_enabled,
      sl_cents: dbConfig.sl_cents,
      timeout_ms: dbConfig.timeout_ms,
      binance_poll_ms: dbConfig.binance_poll_ms,
      orderbook_poll_ms: dbConfig.orderbook_poll_ms,
      order_cooldown_ms: dbConfig.order_cooldown_ms,
    };
    log('✅ Loaded config from v29_config table');
  } else {
    log('⚠️ Using default config (no v29_config found)');
  }
  
  if (!config.enabled) {
    log('❌ Trading is DISABLED in config. Exiting.');
    process.exit(0);
  }
  
  log(`Config: tick_delta=$${config.tick_delta_usd} | delta_threshold=±$${config.delta_threshold} | price=${(config.min_share_price * 100).toFixed(0)}-${(config.max_share_price * 100).toFixed(0)}¢ | TP=${config.tp_cents}¢`);
  
  // Fetch markets
  await fetchMarkets();
  
  // Initial orderbook fetch
  await pollOrderbooks();
  
  // Start Binance feed
  startBinanceFeed(config.assets, handleBinancePrice);
  log('✅ Binance price feed started');
  
  isRunning = true;
  
  // Orderbook polling
  setInterval(() => {
    void pollOrderbooks();
  }, config.orderbook_poll_ms);
  
  // Market refresh (every 5 minutes)
  setInterval(() => {
    void fetchMarkets();
  }, 5 * 60 * 1000);
  
  // Heartbeat (every 30 seconds)
  setInterval(async () => {
    const bal = await getBalance();
    void sendHeartbeat(RUN_ID, 'running', bal, activePosition ? 1 : 0, tradesCount);
  }, 30_000);
  
  // Initial heartbeat
  void sendHeartbeat(RUN_ID, 'starting', balance, 0, 0);
  
  // Graceful shutdown
  const shutdown = (): void => {
    log('Shutting down...');
    isRunning = false;
    stopBinanceFeed();
    stopPositionMonitor();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  log('🚀 V29 Runner started - watching for price spikes...');
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
