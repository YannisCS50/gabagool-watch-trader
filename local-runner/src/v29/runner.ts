/**
 * V29 Simple Live Runner
 * 
 * SIMPLE STRATEGY:
 * 1. Binance spike → buy 5 shares
 * 2. 4¢ profit → sell
 * 3. 10 sec timeout → market sell
 * 4. MAX 1 position at a time (no stacking)
 * 5. Delta rules: -75/+75
 */

import 'dotenv/config';
import { v4 as uuid } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal, Position } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, getOrderStatus } from './trading.js';
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

// Track previous price per asset for tick-to-tick delta
const lastBinancePrice: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// SINGLE POSITION - only one at a time!
interface ActivePosition {
  signalId: string;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  tokenId: string;
  entryPrice: number;
  shares: number;
  entryTime: number;
  marketSlug: string;
}

let activePosition: ActivePosition | null = null;
let lastOrderTime = 0;
let tradesCount = 0;
let lastMarketRefresh = 0;
let lastConfigReload = 0;

// Track previous market slugs to detect market changes
const previousMarketSlugs: Record<Asset, string | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Market expiration timers
const marketTimers: Record<Asset, NodeJS.Timeout | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// ============================================
// LOGGING
// ============================================

function log(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29] ${msg}`);
  queueLog(RUN_ID, 'info', category, msg, asset, data);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29] ❌ ${msg}`, err ?? '');
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
      body: JSON.stringify({ assets: config.assets, v26: true }),
    });
    
    if (!res.ok) {
      log(`⚠️ Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      const now = Date.now();
      const EARLY_15M_MS = 90_000;

      type MarketCandidate = {
        m: any;
        slug: string;
        startMs: number;
        endMs: number;
        actuallyStarted: boolean;
      };

      const candidatesByAsset = new Map<Asset, MarketCandidate[]>();

      for (const m of data.markets) {
        if (!m.asset || !m.upTokenId || !m.downTokenId) continue;

        const asset = m.asset as Asset;
        const slug = String(m.slug || '');

        let startMs = new Date(m.eventStartTime || m.event_start_time || '').getTime();
        let endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();

        if (!Number.isFinite(startMs)) startMs = now;
        if (!Number.isFinite(endMs)) continue;

        if (endMs <= now - 60_000) continue;

        const is15m = slug.toLowerCase().includes('-15m-');
        const earlyMs = is15m ? EARLY_15M_MS : 60_000;

        if (now < startMs - earlyMs) continue;

        const entry: MarketCandidate = {
          m,
          slug,
          startMs,
          endMs,
          actuallyStarted: now >= startMs,
        };

        const list = candidatesByAsset.get(asset) ?? [];
        list.push(entry);
        candidatesByAsset.set(asset, list);
      }

      for (const [asset, list] of candidatesByAsset) {
        if (list.length === 0) continue;

        const started = list.filter(x => x.actuallyStarted);
        const chosen = (started.length > 0)
          ? started.sort((a, b) => b.startMs - a.startMs)[0]
          : list.sort((a, b) => a.startMs - b.startMs)[0];

        const m = chosen.m;
        const slug = chosen.slug;

        const previousSlug = previousMarketSlugs[asset];
        const isNewMarket = previousSlug !== slug;

        const marketInfo: MarketInfo = {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          endTime: new Date(chosen.endMs),
        };

        markets.set(asset, marketInfo);

        if (isNewMarket) {
          log(`🔁 ${asset} NEW MARKET: ${slug}`, 'market', asset);

          priceState[asset] = {
            ...priceState[asset],
            upBestAsk: null,
            upBestBid: null,
            downBestAsk: null,
            downBestBid: null,
            lastUpdate: 0,
          };

          void updateMarketCache(asset, m.upTokenId, m.downTokenId);

          void fetchMarketOrderbook(marketInfo).then(book => {
            if (markets.get(asset)?.slug !== slug) return;
            if (book.upBestAsk !== undefined) priceState[asset].upBestAsk = book.upBestAsk;
            if (book.upBestBid !== undefined) priceState[asset].upBestBid = book.upBestBid;
            if (book.downBestAsk !== undefined) priceState[asset].downBestAsk = book.downBestAsk;
            if (book.downBestBid !== undefined) priceState[asset].downBestBid = book.downBestBid;
            if (book.lastUpdate !== undefined) priceState[asset].lastUpdate = book.lastUpdate;
            log(`📖 ${asset} orderbook: UP ask ${book.upBestAsk ? (book.upBestAsk * 100).toFixed(1) : 'n/a'}¢ | DOWN ask ${book.downBestAsk ? (book.downBestAsk * 100).toFixed(1) : 'n/a'}¢`, 'market', asset);
          });
        } else if (previousSlug === null) {
          log(`📍 ${asset}: ${slug} @ strike $${marketInfo.strikePrice ?? 0}`, 'market', asset);
        }

        previousMarketSlugs[asset] = slug;
        scheduleMarketRefresh(asset, chosen.endMs);
      }

      log(`Active: ${markets.size} markets`);
    }
    
    lastMarketRefresh = Date.now();
  } catch (err) {
    logError('Market fetch error', err);
  }
}

function scheduleMarketRefresh(asset: Asset, endTimeMs: number): void {
  if (marketTimers[asset]) {
    clearTimeout(marketTimers[asset]!);
    marketTimers[asset] = null;
  }
  
  const now = Date.now();
  const timeUntilEnd = endTimeMs - now;
  const refreshIn = Math.max(timeUntilEnd - 5_000, 1_000);
  
  if (timeUntilEnd <= 0 || timeUntilEnd > 2 * 60 * 60 * 1000) {
    return;
  }
  
  log(`⏰ ${asset} timer: refresh in ${Math.floor(refreshIn / 1000)}s`, 'market', asset);
  
  marketTimers[asset] = setTimeout(() => {
    log(`🔄 ${asset} market expiring → fetching next`, 'market', asset);
    void fetchMarkets();
  }, refreshIn);
}

// ============================================
// CHAINLINK PRICE HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  const prev = priceState[asset].chainlink;
  priceState[asset].chainlink = price;
  
  if (prev && Math.abs(price - prev) >= 10) {
    queueLog(RUN_ID, 'info', 'price', `${asset} chainlink $${price.toFixed(2)}`, asset, { source: 'chainlink', price });
  }
}

// ============================================
// BINANCE PRICE HANDLER
// ============================================

function handleBinancePrice(asset: Asset, price: number, _timestamp: number): void {
  const now = Date.now();
  
  priceState[asset].binance = price;
  
  const prevPrice = lastBinancePrice[asset];
  lastBinancePrice[asset] = price;
  
  const tickDelta = prevPrice !== null ? price - prevPrice : 0;
  
  if (Math.abs(tickDelta) >= config.tick_delta_usd) {
    queueLog(RUN_ID, 'info', 'price', `${asset} binance $${price.toFixed(2)} Δ${tickDelta >= 0 ? '+' : ''}${tickDelta.toFixed(2)} 🎯`, asset, { 
      source: 'binance', 
      price,
      tickDelta, 
    });
  }
  
  // Skip if disabled
  if (!config.enabled) return;
  
  // === CORE RULE: ONLY 1 POSITION AT A TIME ===
  if (activePosition !== null) return;
  
  // Cooldown
  if (now - lastOrderTime < config.order_cooldown_ms) return;
  
  // Need previous price
  if (prevPrice === null) return;
  
  // Check tick delta threshold
  if (Math.abs(tickDelta) < config.tick_delta_usd) return;
  
  // Get market
  const market = markets.get(asset);
  if (!market || !market.strikePrice) {
    return;
  }
  
  // Use Chainlink for delta calculation, fallback to Binance
  const chainlinkPrice = priceState[asset].chainlink;
  const actualPrice = chainlinkPrice ?? price;
  
  // Calculate price vs strike delta
  const priceVsStrikeDelta = actualPrice - market.strikePrice;
  
  log(`📊 ${asset} TRIGGER: tickΔ=$${tickDelta.toFixed(2)} | price=$${actualPrice.toFixed(2)} vs strike=$${market.strikePrice.toFixed(0)} → Δ$${priceVsStrikeDelta.toFixed(0)}`);
  
  // Direction based on tick movement
  const tickDirection: 'UP' | 'DOWN' = tickDelta > 0 ? 'UP' : 'DOWN';
  
  // Apply direction filter (delta threshold = 75)
  let allowedDirection: 'UP' | 'DOWN' | 'BOTH';
  if (priceVsStrikeDelta > config.delta_threshold) {
    allowedDirection = 'UP';
  } else if (priceVsStrikeDelta < -config.delta_threshold) {
    allowedDirection = 'DOWN';
  } else {
    allowedDirection = 'BOTH';
  }
  
  if (allowedDirection !== 'BOTH' && allowedDirection !== tickDirection) {
    log(`⚠️ ${asset} ${tickDirection} blocked | Δ$${priceVsStrikeDelta.toFixed(0)} | only ${allowedDirection} allowed`);
    return;
  }
  
  log(`🎯 TRIGGER: ${asset} ${tickDirection} | tickΔ$${tickDelta.toFixed(2)} | allowed: ${allowedDirection}`, 'signal', asset);
  
  // Execute trade
  void executeTrade(asset, tickDirection, price, tickDelta, priceVsStrikeDelta, market);
}

// ============================================
// TRADE EXECUTION
// ============================================

async function executeTrade(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  binancePrice: number,
  tickDelta: number,
  strikeActualDelta: number,
  market: MarketInfo
): Promise<void> {
  const signalTs = Date.now();
  
  // Get orderbook
  const state = priceState[asset];
  const bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!bestAsk || bestAsk <= 0) {
    log(`⚠️ No orderbook for ${asset} ${direction}`);
    return;
  }
  
  // Price range check
  if (bestAsk < config.min_share_price) {
    log(`🚫 ${asset} ${direction} ask ${(bestAsk * 100).toFixed(1)}¢ < min ${(config.min_share_price * 100).toFixed(1)}¢`);
    return;
  }
  
  if (bestAsk > config.max_share_price) {
    log(`🚫 ${asset} ${direction} ask ${(bestAsk * 100).toFixed(1)}¢ > max ${(config.max_share_price * 100).toFixed(1)}¢`);
    return;
  }
  
  // Calculate price with buffer
  const priceBuffer = config.price_buffer_cents / 100;
  const buyPrice = Math.ceil((bestAsk + priceBuffer) * 100) / 100;
  const shares = config.shares_per_trade;
  
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
    notes: `${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  lastOrderTime = Date.now();
  
  log(`📤 BUY: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset);
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
  const latency = Date.now() - signalTs;
  
  if (!result.success) {
    signal.status = 'failed';
    signal.notes = `${result.error ?? 'Unknown error'}`;
    log(`❌ FAILED: ${result.error ?? 'Unknown'}`);
    void saveSignal(signal);
    return;
  }
  
  const orderId = result.orderId;
  if (!orderId) {
    signal.status = 'failed';
    signal.notes = `No order ID returned`;
    log(`❌ FAILED: No order ID`);
    void saveSignal(signal);
    return;
  }
  
  signal.order_id = orderId;
  log(`📋 Order placed: ${orderId} - waiting for fill...`);
  
  // Wait for fill (max 5 seconds)
  const FILL_TIMEOUT_MS = 5000;
  const startWait = Date.now();
  let filled = false;
  let filledSize = 0;
  
  while (Date.now() - startWait < FILL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const status = await getOrderStatus(orderId);
    if (status.filled || status.filledSize > 0) {
      filled = true;
      filledSize = status.filledSize || shares;
      break;
    }
    
    if (status.status === 'CANCELLED' || status.status === 'DEAD') {
      log(`⚠️ Order ${orderId} was ${status.status}`);
      break;
    }
  }
  
  if (!filled || filledSize <= 0) {
    signal.status = 'timeout';
    signal.notes = `Not filled in 5s`;
    log(`⏰ Order not filled - cancelling`);
    void saveSignal(signal);
    return;
  }
  
  // FILLED! Set active position
  signal.status = 'filled';
  signal.entry_price = result.avgPrice ?? buyPrice;
  signal.shares = filledSize;
  signal.fill_ts = Date.now();
  signal.notes = `Filled ${filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢`;
  
  tradesCount++;
  
  log(`✅ FILLED: ${asset} ${direction} ${filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ (${latency}ms)`, 'fill', asset);
  
  // Set the single active position
  activePosition = {
    signalId: signal.id!,
    asset,
    direction,
    tokenId,
    entryPrice: signal.entry_price,
    shares: filledSize,
    entryTime: Date.now(),
    marketSlug: market.slug,
  };
  
  void saveSignal(signal);
  
  // Start position monitor
  monitorPosition(signal);
}

// ============================================
// POSITION MONITORING
// ============================================

async function monitorPosition(signal: Signal): Promise<void> {
  if (!activePosition) return;
  
  const { asset, direction, tokenId, entryPrice, shares, entryTime } = activePosition;
  const targetSellPrice = entryPrice + (config.take_profit_cents / 100);
  const timeoutMs = config.timeout_seconds * 1000;
  
  log(`📊 Monitoring: Entry=${(entryPrice * 100).toFixed(1)}¢ | Target=${(targetSellPrice * 100).toFixed(1)}¢ (+${config.take_profit_cents}¢) | Timeout=${config.timeout_seconds}s`);
  
  let sellRetries = 0;
  let sold = false;
  
  while (!sold && activePosition) {
    const elapsed = Date.now() - entryTime;
    const state = priceState[asset];
    const currentBid = direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    // Check for take profit
    if (currentBid && currentBid >= targetSellPrice) {
      log(`💰 TP HIT: ${asset} ${direction} bid ${(currentBid * 100).toFixed(1)}¢ >= target ${(targetSellPrice * 100).toFixed(1)}¢`);
      
      const result = await placeSellOrder(tokenId, currentBid, shares);
      
      if (result.success) {
        sold = true;
        const profit = (currentBid - entryPrice) * shares;
        
        signal.status = 'closed';
        signal.exit_type = 'take_profit';
        signal.exit_price = currentBid;
        signal.close_ts = Date.now();
        signal.gross_pnl = profit;
        signal.net_pnl = profit - 0.02; // ~2¢ fees estimate
        signal.notes = `TP +${(profit * 100).toFixed(1)}¢`;
        
        log(`✅ SOLD TP: ${asset} ${direction} +${(profit * 100).toFixed(1)}¢`, 'close', asset);
        
        activePosition = null;
        void saveSignal(signal);
        return;
      } else {
        sellRetries++;
        log(`⚠️ Sell failed (${sellRetries}/${config.max_sell_retries}): ${result.error}`);
      }
    }
    
    // Check timeout
    if (elapsed >= timeoutMs) {
      log(`⏰ TIMEOUT: ${asset} ${direction} after ${config.timeout_seconds}s → market sell`);
      
      // Try selling at current bid
      while (sellRetries < config.max_sell_retries) {
        const currentBid = direction === 'UP' ? priceState[asset].upBestBid : priceState[asset].downBestBid;
        
        if (currentBid && currentBid > 0) {
          const result = await placeSellOrder(tokenId, currentBid, shares);
          
          if (result.success) {
            sold = true;
            const profit = (currentBid - entryPrice) * shares;
            
            signal.status = 'closed';
            signal.exit_type = 'timeout';
            signal.exit_price = currentBid;
            signal.close_ts = Date.now();
            signal.gross_pnl = profit;
            signal.net_pnl = profit - 0.02;
            signal.notes = `Timeout ${profit >= 0 ? '+' : ''}${(profit * 100).toFixed(1)}¢`;
            
            log(`✅ SOLD TIMEOUT: ${asset} ${direction} ${profit >= 0 ? '+' : ''}${(profit * 100).toFixed(1)}¢`, 'close', asset);
            
            activePosition = null;
            void saveSignal(signal);
            return;
          }
        }
        
        sellRetries++;
        log(`⚠️ Sell retry ${sellRetries}/${config.max_sell_retries}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Force sell at any price (market order simulation - use low bid)
      log(`🚨 FORCE SELL: Max retries reached`);
      
      const lowBid = 0.01; // Essentially market sell
      const result = await placeSellOrder(tokenId, lowBid, shares);
      
      const profit = (lowBid - entryPrice) * shares;
      
      signal.status = 'closed';
      signal.exit_type = 'force_sell';
      signal.exit_price = result.avgPrice ?? lowBid;
      signal.close_ts = Date.now();
      signal.gross_pnl = profit;
      signal.net_pnl = profit - 0.02;
      signal.notes = `Force sell ${profit >= 0 ? '+' : ''}${(profit * 100).toFixed(1)}¢`;
      
      log(`✅ FORCE SOLD: ${asset} ${direction} ${profit >= 0 ? '+' : ''}${(profit * 100).toFixed(1)}¢`, 'close', asset);
      
      activePosition = null;
      void saveSignal(signal);
      return;
    }
    
    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function pollOrderbooks(): Promise<void> {
  const now = Date.now();
  
  for (const asset of config.assets) {
    const market = markets.get(asset);
    if (!market) continue;
    
    const book = await fetchMarketOrderbook(market);
    
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
  log('🚀 V29 Simple Runner starting...');
  log(`📋 Run ID: ${RUN_ID}`);
  
  // VPN check
  const vpnOk = await verifyVpnConnection();
  if (!vpnOk) {
    logError('VPN verification failed! Exiting.');
    process.exit(1);
  }
  log('✅ VPN OK');
  
  // Test Polymarket connection
  try {
    await testConnection();
    log('✅ Polymarket connection OK');
  } catch (err) {
    logError('Polymarket connection failed!', err);
    process.exit(1);
  }
  
  // Get balance
  try {
    const balance = await getBalance();
    log(`💰 Balance: $${balance.toFixed(2)}`);
  } catch (err) {
    logError('Balance check failed', err);
  }
  
  // Init DB
  await initDb();
  log('✅ DB initialized');
  
  // Load config
  const loadedConfig = await loadV29Config();
  if (loadedConfig) {
    config = loadedConfig;
    log(`✅ Config loaded: enabled=${config.enabled}, shares=${config.shares_per_trade}, TP=${config.take_profit_cents}¢, timeout=${config.timeout_seconds}s`);
  } else {
    log(`⚠️ Using defaults: shares=${config.shares_per_trade}, TP=${config.take_profit_cents}¢`);
  }
  
  // Fetch markets
  await fetchMarkets();
  
  if (markets.size === 0) {
    logError('No markets found! Exiting.');
    process.exit(1);
  }
  
  // Init pre-signed cache
  const marketsList = Array.from(markets.values()).map(m => ({
    asset: m.asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsList);
  
  isRunning = true;
  
  // Start Binance feed
  startBinanceFeed(config.assets, handleBinancePrice, config.binance_poll_ms);
  log('✅ Binance feed started');
  
  // Start Chainlink feed
  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink feed started');
  
  // Orderbook polling
  const orderbookInterval = setInterval(() => {
    void pollOrderbooks();
  }, config.orderbook_poll_ms);
  
  // Market refresh every 2 minutes
  const marketRefreshInterval = setInterval(() => {
    void fetchMarkets();
  }, 2 * 60 * 1000);
  
  // Config reload every 30 seconds
  const configReloadInterval = setInterval(async () => {
    const newConfig = await loadV29Config();
    if (newConfig) {
      const changed = JSON.stringify(config) !== JSON.stringify(newConfig);
      if (changed) {
        config = newConfig;
        log(`🔧 Config updated: enabled=${config.enabled}, shares=${config.shares_per_trade}, TP=${config.take_profit_cents}¢`);
      }
    }
  }, 30_000);
  
  // Heartbeat every 10 seconds
  const heartbeatInterval = setInterval(() => {
    void sendHeartbeat(RUN_ID, activePosition ? 'trading' : 'idle', {
      trades: tradesCount,
      hasPosition: activePosition !== null,
      markets: markets.size,
    });
  }, 10_000);
  
  log('🎯 V29 Simple Runner READY');
  log(`   Strategy: Buy ${config.shares_per_trade} shares → TP ${config.take_profit_cents}¢ → Timeout ${config.timeout_seconds}s`);
  log(`   Max 1 position at a time`);
  
  // Handle shutdown
  const cleanup = () => {
    log('🛑 Shutting down...');
    isRunning = false;
    clearInterval(orderbookInterval);
    clearInterval(marketRefreshInterval);
    clearInterval(configReloadInterval);
    clearInterval(heartbeatInterval);
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
