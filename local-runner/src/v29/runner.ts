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
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache } from './trading.js';
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
  BTC: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  ETH: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  SOL: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  XRP: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
};

// Previous tick price for delta calculation
const prevPrices: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Current position (only one at a time)
let activePosition: Position | null = null;
let activeSignal: Signal | null = null;
let lastOrderTime = 0;
let tradesCount = 0;
let lastMarketRefresh = 0;
let lastConfigReload = 0;

// Track previous market slugs to detect market changes
const previousMarketSlugs: Record<Asset, string | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Market expiration timers - exact scheduling instead of polling
const marketTimers: Record<Asset, NodeJS.Timeout | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// ============================================
// LOGGING
// ============================================

function log(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29] ${msg}`);
  // Queue log to database
  queueLog(RUN_ID, 'info', category, msg, asset, data);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29] ❌ ${msg}`, err ?? '');
  // Queue error to database
  queueLog(RUN_ID, 'error', 'error', msg, undefined, err ? { error: String(err) } : undefined);
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
      // v26 flag allows fetching upcoming markets (90s before start for 15m markets)
      body: JSON.stringify({ assets: config.assets, v26: true }),
    });
    
    if (!res.ok) {
      log(`⚠️ Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      const now = Date.now();
      const EARLY_15M_MS = 90_000; // 90s early entry for 15m markets
      
      for (const m of data.markets) {
        if (!m.asset || !m.upTokenId || !m.downTokenId) continue;
        
        const asset = m.asset as Asset;
        const startMs = new Date(m.eventStartTime || m.event_start_time || '').getTime();
        const endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();
        
        // Skip expired markets
        if (endMs <= now - 60_000) continue;
        
        // Allow 90s early entry for 15m markets
        const slug = String(m.slug || '');
        const is15m = slug.toLowerCase().includes('-15m-');
        const earlyMs = is15m ? EARLY_15M_MS : 60_000;
        
        // Skip if not started yet (with early buffer)
        if (now < startMs - earlyMs) continue;
        
        const previousSlug = previousMarketSlugs[asset];
        const isNewMarket = previousSlug !== slug;
        
        // Update market info
        markets.set(asset, {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          endTime: new Date(endMs),
        });
        
        // If market changed, update pre-signed cache immediately!
        if (isNewMarket && previousSlug !== null) {
          log(`🔁 ${asset} NEW MARKET: ${slug} (was: ${previousSlug}) → updating pre-sign cache`);
          void updateMarketCache(asset, m.upTokenId, m.downTokenId);
        } else if (isNewMarket) {
          log(`📍 ${asset}: ${slug} @ strike $${m.strikePrice ?? m.strike_price ?? 0}`);
        }
        
        previousMarketSlugs[asset] = slug;
        
        // Schedule exact timer for market expiration
        scheduleMarketRefresh(asset, endMs);
      }
      
      log(`Active: ${markets.size} markets`);
    }
    
    lastMarketRefresh = Date.now();
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// SMART MARKET TIMER
// ============================================

/**
 * Schedule exact refresh for when market expires.
 * Instead of polling every 5 seconds, we set a timer for:
 * - 5 seconds before market end (to fetch next market)
 * - Market durations are fixed: 15m or 1h
 */
function scheduleMarketRefresh(asset: Asset, endTimeMs: number): void {
  // Clear existing timer for this asset
  if (marketTimers[asset]) {
    clearTimeout(marketTimers[asset]!);
    marketTimers[asset] = null;
  }
  
  const now = Date.now();
  const timeUntilEnd = endTimeMs - now;
  
  // Schedule refresh 5 seconds before market end
  const refreshIn = Math.max(timeUntilEnd - 5_000, 1_000);
  
  // Don't schedule if market already expired or too far in future (> 2 hours)
  if (timeUntilEnd <= 0 || timeUntilEnd > 2 * 60 * 60 * 1000) {
    return;
  }
  
  log(`⏰ ${asset} timer: refresh in ${Math.floor(refreshIn / 1000)}s (market ends in ${Math.floor(timeUntilEnd / 1000)}s)`, 'market', asset);
  
  marketTimers[asset] = setTimeout(() => {
    log(`🔄 ${asset} market expiring NOW → fetching next market`, 'market', asset);
    void fetchMarkets();
  }, refreshIn);
}

// ============================================
// CHAINLINK PRICE HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  const prev = priceState[asset].chainlink;
  priceState[asset].chainlink = price;
  
  // Only log if price changed significantly
  if (!prev || Math.abs(price - prev) > 0.5) {
    queueLog(RUN_ID, 'info', 'price', `${asset} chainlink $${price.toFixed(2)}`, asset, { source: 'chainlink', price });
  }
}

// ============================================
// PRICE HANDLING
// ============================================

// Rolling price history for delta calculation (last N seconds)
const DELTA_WINDOW_MS = 2000; // 2 second window for delta calculation
const priceHistory: Record<Asset, Array<{ ts: number; price: number }>> = {
  BTC: [], ETH: [], SOL: [], XRP: []
};

function handleBinancePrice(asset: Asset, price: number): void {
  const now = Date.now();
  
  // Update state
  priceState[asset].binance = price;
  
  // Add to price history
  priceHistory[asset].push({ ts: now, price });
  
  // Prune old entries (keep only last DELTA_WINDOW_MS)
  const cutoff = now - DELTA_WINDOW_MS;
  priceHistory[asset] = priceHistory[asset].filter(p => p.ts >= cutoff);
  
  // Skip if disabled
  if (!config.enabled) return;
  
  // Skip if already in a position
  if (activePosition !== null) return;
  
  // Skip if in cooldown
  if (now - lastOrderTime < config.order_cooldown_ms) return;
  
  // Need at least some history to calculate delta
  const history = priceHistory[asset];
  if (history.length < 2) return;
  
  // Calculate delta over the window (oldest price in window vs current)
  const oldestPrice = history[0].price;
  const windowDelta = price - oldestPrice;
  const windowMs = now - history[0].ts;
  
  // Also track tick-to-tick for logging
  const prevPrice = prevPrices[asset];
  prevPrices[asset] = price;
  const tickDelta = prevPrice !== null ? price - prevPrice : 0;
  
  // Log significant movements (window delta > $3)
  if (Math.abs(windowDelta) >= 3) {
    queueLog(RUN_ID, 'info', 'price', `${asset} binance Δ$${windowDelta > 0 ? '+' : ''}${windowDelta.toFixed(2)} over ${windowMs}ms ($${price.toFixed(2)})`, asset, { 
      source: 'binance', 
      windowDelta, 
      windowMs,
      price, 
      threshold: config.tick_delta_usd 
    });
  }
  
  // Check if window delta exceeds threshold (e.g., $6 price move over 2 seconds)
  if (Math.abs(windowDelta) < config.tick_delta_usd) return;
  
  // Get market to check strike price
  const market = markets.get(asset);
  if (!market || !market.strikePrice) {
    log(`⚠️ No market/strike for ${asset}`);
    return;
  }
  
  // Get Chainlink price for delta calculation (fallback to Binance if not available)
  const chainlinkPrice = priceState[asset].chainlink;
  const actualPrice = chainlinkPrice ?? price; // Use Chainlink, fallback to Binance
  const priceSource = chainlinkPrice ? 'chainlink' : 'binance';
  
  // Calculate actual-to-strike delta for direction logic
  const priceVsStrikeDelta = actualPrice - market.strikePrice;
  
  log(`📊 ${asset} delta calc: ${priceSource}=$${actualPrice.toFixed(2)} vs strike=$${market.strikePrice.toFixed(0)} → Δ$${priceVsStrikeDelta.toFixed(0)}`);
  
  // Determine direction based on window movement (not just last tick)
  const moveDirection: 'UP' | 'DOWN' = windowDelta > 0 ? 'UP' : 'DOWN';
  
  // Apply direction filter based on delta_threshold
  let allowedDirection: 'UP' | 'DOWN' | 'BOTH';
  if (priceVsStrikeDelta > config.delta_threshold) {
    allowedDirection = 'UP';
  } else if (priceVsStrikeDelta < -config.delta_threshold) {
    allowedDirection = 'DOWN';
  } else {
    allowedDirection = 'BOTH';
  }
  
  // Check if direction is allowed
  if (allowedDirection !== 'BOTH' && allowedDirection !== moveDirection) {
    log(`⚠️ ${asset} direction ${moveDirection} blocked | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | only ${allowedDirection} allowed`);
    return;
  }
  
  log(`🎯 TRIGGER: ${asset} ${moveDirection} | window Δ$${windowDelta.toFixed(2)} over ${windowMs}ms | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | allowed: ${allowedDirection}`, 'signal', asset, { windowDelta, windowMs, priceVsStrikeDelta, direction: moveDirection });
  
  // Clear price history after triggering to prevent repeated signals
  priceHistory[asset] = [{ ts: now, price }];
  
  // Execute trade
  void executeTrade(asset, moveDirection, price, windowDelta, priceVsStrikeDelta);
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
    binance_delta: tickDelta,
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
    notes: `${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | strikeΔ$${strikeActualDelta.toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  // Save signal first (get ID)
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  // Mark order time
  lastOrderTime = Date.now();
  
  // Place order
  log(`📤 PLACING ORDER: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset, { direction, shares, price: buyPrice });
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
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
    
    log(`✅ FILLED: ${asset} ${direction} ${result.filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ (${latency}ms)`, 'fill', asset, { direction, shares: result.filledSize, price: signal.entry_price, latencyMs: latency });
    
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
    
    log(`📊 Position open: TP=${activePosition.tpPrice ? (activePosition.tpPrice * 100).toFixed(1) + '¢' : 'off'} | SL=${activePosition.slPrice ? (activePosition.slPrice * 100).toFixed(1) + '¢' : 'off'}`, 'order', asset);
    
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
  
  // Initialize pre-signed order cache for maximum speed
  const marketsForCache = Array.from(markets.entries()).map(([asset, m]) => ({
    asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsForCache);
  log('✅ Pre-signed order cache initialized');
  
  // Initial orderbook fetch
  await pollOrderbooks();
  
  // Start Chainlink WebSocket feed
  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink WebSocket feed started');
  
  // Start Binance feed (emit latest price every binance_poll_ms, not every trade)
  startBinanceFeed(config.assets, handleBinancePrice, config.binance_poll_ms, (evt) => {
    if (evt.type === 'open') {
      queueLog(RUN_ID, 'info', 'system', `Binance WS connected`, undefined, { url: evt.url });
    } else if (evt.type === 'close') {
      queueLog(RUN_ID, 'warn', 'system', `Binance WS disconnected`, undefined, { url: evt.url });
    } else {
      queueLog(RUN_ID, 'error', 'error', `Binance WS error: ${evt.message}`, undefined, { url: evt.url });
    }
  });
  log('✅ Binance price feed started');
  
  isRunning = true;
  
  // Orderbook polling
  setInterval(() => {
    void pollOrderbooks();
  }, config.orderbook_poll_ms);
  
  // Market timers are now scheduled exactly per-asset in fetchMarkets()
  // Fallback refresh every 5 minutes (safety net, normally timers handle it)
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
    stopChainlinkFeed();
    stopPreSignedCache();
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
