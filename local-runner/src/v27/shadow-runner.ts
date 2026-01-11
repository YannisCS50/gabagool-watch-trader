#!/usr/bin/env npx ts-node
// ============================================================
// V27 SHADOW RUNNER - Continuous Shadow Trading Engine
// ============================================================
//
// This runner operates the V27 Shadow Engine which:
// 1. Runs CONTINUOUSLY - no pause, no silence
// 2. Evaluates EVERY market EVERY 500ms
// 3. Logs EVERY evaluation to the database
// 4. Tracks post-signal outcomes at 5s, 10s, 15s
// 5. Simulates hedges and calculates CPP
//
// CRITICAL: This must generate logs even when NO signals occur.
// Silence = failure.
//
// Run: npm run v27 (or npm run shadow)
// ============================================================

import { config } from '../config.js';
import { testConnection, getBalance, getOrderbookDepth } from '../polymarket.js';
import { fetchMarkets, sendHeartbeat, savePriceTicks, getSupabaseClient, type PriceTick } from '../backend.js';
import { enforceVpnOrExit } from '../vpn-check.js';
import { fetchChainlinkPrice } from '../chain.js';
import { startPriceFeedLogger, stopPriceFeedLogger, getPriceFeedLoggerStats, type PriceFeedCallback } from '../price-feed-ws-logger.js';
import { ShadowEngine } from './shadow-engine.js';
import { getV27Config, loadV27Config } from './config.js';
import type { V27Market, V27OrderBook } from './index.js';

// ============================================================
// CONSTANTS
// ============================================================

const RUN_ID = `shadow-${Date.now()}`;
const MARKET_POLL_INTERVAL_MS = 30_000; // Check for new markets every 30s
const PRICE_TICK_INTERVAL_MS = 1_000; // Log chainlink price every second
const ORDERBOOK_POLL_INTERVAL_MS = 500; // Poll orderbooks every 500ms (CRITICAL)
const HEARTBEAT_INTERVAL_MS = 30_000; // Send heartbeat every 30s
const STATS_LOG_INTERVAL_MS = 60_000; // Log stats every minute

// ============================================================
// STATE
// ============================================================

let isRunning = false;
let shadowEngine: ShadowEngine;

// Price state (from WebSocket feeds)
const spotPrices: Map<string, { price: number; ts: number; source: string }> = new Map();

// Active markets
const activeMarkets = new Map<string, V27Market>();

// Orderbook cache (updated every 500ms)
const orderbookCache = new Map<string, V27OrderBook>();

// ============================================================
// LOGGING
// ============================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err?: any): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ❌ ${msg}`, err || '');
}

// ============================================================
// HELPERS
// ============================================================

function normalizeUsdAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ============================================================
// PRICE FEED CALLBACKS
// ============================================================

function onBinancePrice(asset: string, price: number): void {
  const ts = Date.now();
  spotPrices.set(asset, { price, ts, source: 'binance' });
  shadowEngine.feedSpotPrice(asset, price, ts, 'binance');
}

function onPolymarketPrice(marketId: string, upMid: number, downMid: number): void {
  // Update orderbook cache with mid prices
  const existing = orderbookCache.get(marketId);
  if (existing) {
    existing.upMid = upMid;
    existing.downMid = downMid;
    existing.timestamp = Date.now();
  }
}

function onTakerFill(asset: string, size: number, side: 'UP' | 'DOWN', price: number): void {
  shadowEngine.feedTakerFill(asset, size, side, price);
}

// ============================================================
// MARKET MANAGEMENT
// ============================================================

async function fetchUpcomingMarkets(): Promise<V27Market[]> {
  try {
    const result = await fetchMarkets({ v26: true });
    
    if (!result.success || !result.markets) {
      return [];
    }

    const v27Markets: V27Market[] = [];
    const now = new Date();

    for (const m of result.markets) {
      const eventStart = new Date(m.eventStartTime);
      const eventEnd = new Date(m.eventEndTime);
      
      // Only include markets that haven't ended
      if (eventEnd <= now) continue;

      // Extract strike price from market slug or question
      let strikePrice = m.strikePrice || 0;
      if (strikePrice === 0 && m.slug) {
        const match = m.slug.match(/(?:above|below)-(\d+(?:\.\d+)?)/i);
        if (match) {
          strikePrice = parseFloat(match[1]);
        }
      }
      
      if (strikePrice === 0) {
        log(`⚠️ Skipping market with unknown strike: ${m.slug}`);
        continue;
      }

      v27Markets.push({
        id: m.id,
        slug: m.slug,
        asset: m.asset,
        strikePrice,
        eventStartTime: eventStart,
        eventEndTime: eventEnd,
        upTokenId: m.upTokenId,
        downTokenId: m.downTokenId,
      });
    }

    return v27Markets;
  } catch (err) {
    logError('Failed to fetch markets', err);
    return [];
  }
}

async function refreshMarkets(): Promise<void> {
  const markets = await fetchUpcomingMarkets();
  const config = getV27Config();
  
  let newCount = 0;
  
  for (const market of markets) {
    if (!config.assets.includes(market.asset)) continue;
    if (activeMarkets.has(market.id)) continue;

    activeMarkets.set(market.id, market);
    shadowEngine.registerMarket(market);
    newCount++;
    log(`📊 Registered market: ${market.asset} ${market.slug}`);
  }

  // Remove expired markets
  const now = Date.now();
  let expiredCount = 0;
  
  for (const [id, market] of activeMarkets) {
    if (market.eventEndTime.getTime() < now) {
      activeMarkets.delete(id);
      orderbookCache.delete(id);
      shadowEngine.unregisterMarket(id);
      expiredCount++;
      log(`🏁 Market expired: ${market.asset} ${market.slug}`);
    }
  }
  
  if (newCount > 0 || expiredCount > 0) {
    log(`📈 Markets: ${activeMarkets.size} active (+${newCount} / -${expiredCount})`);
  }
}

// ============================================================
// CHAINLINK PRICE LOGGING (backup)
// ============================================================

async function logChainlinkPrices(): Promise<void> {
  try {
    const [btcResult, ethResult] = await Promise.all([
      fetchChainlinkPrice('BTC'),
      fetchChainlinkPrice('ETH'),
    ]);

    const ticks: PriceTick[] = [];
    const now = new Date().toISOString();

    if (btcResult !== null) {
      const price = btcResult.price;
      ticks.push({ asset: 'BTC', price, delta: null, delta_percent: null, source: 'chainlink', created_at: now });
      
      // Only use Chainlink if we don't have Binance data
      if (!spotPrices.has('BTC') || Date.now() - spotPrices.get('BTC')!.ts > 5000) {
        spotPrices.set('BTC', { price, ts: Date.now(), source: 'chainlink' });
        shadowEngine.feedSpotPrice('BTC', price, Date.now(), 'chainlink');
      }
    }

    if (ethResult !== null) {
      const price = ethResult.price;
      ticks.push({ asset: 'ETH', price, delta: null, delta_percent: null, source: 'chainlink', created_at: now });
      
      if (!spotPrices.has('ETH') || Date.now() - spotPrices.get('ETH')!.ts > 5000) {
        spotPrices.set('ETH', { price, ts: Date.now(), source: 'chainlink' });
        shadowEngine.feedSpotPrice('ETH', price, Date.now(), 'chainlink');
      }
    }

    if (ticks.length > 0) {
      await savePriceTicks(ticks);
    }
  } catch (err) {
    // Non-critical
  }
}

// ============================================================
// ORDERBOOK POLLING & EVALUATION (CRITICAL - Every 500ms)
// ============================================================

async function pollOrderbooksAndEvaluate(): Promise<void> {
  if (!isRunning) return;
  
  const config = getV27Config();
  if (!config.enabled) return;

  // Evaluate ALL active markets
  for (const [marketId, market] of activeMarkets) {
    try {
      // Fetch orderbook for both sides
      const [upDepth, downDepth] = await Promise.all([
        market.upTokenId ? getOrderbookDepth(market.upTokenId) : null,
        getOrderbookDepth(market.downTokenId),
      ]);

      if (!downDepth) continue;

      const book: V27OrderBook = {
        upBid: upDepth?.topBid ?? 0,
        upAsk: upDepth?.topAsk ?? 1,
        upMid: upDepth ? (upDepth.topBid + upDepth.topAsk) / 2 : 0.5,
        upDepthBid: upDepth?.bidDepth ?? 0,
        upDepthAsk: upDepth?.askDepth ?? 0,
        downBid: downDepth.topBid ?? 0,
        downAsk: downDepth.topAsk ?? 1,
        downMid: (downDepth.topBid + downDepth.topAsk) / 2,
        downDepthBid: downDepth.bidDepth ?? 0,
        downDepthAsk: downDepth.askDepth ?? 0,
        spreadUp: upDepth ? (upDepth.topAsk - upDepth.topBid) : 0,
        spreadDown: downDepth.topAsk - downDepth.topBid,
        timestamp: Date.now(),
      };

      // Cache orderbook
      orderbookCache.set(marketId, book);
      
      // Feed to shadow engine
      shadowEngine.feedOrderBook(marketId, book);
      
      // Update any active post-signal tracking
      shadowEngine.updateTrackingWithOrderbook(marketId, book);

      // EVALUATE - this is the core loop
      await shadowEngine.evaluate(marketId, book);
      
    } catch (err) {
      // Non-critical, continue with other markets
    }
  }
}

// ============================================================
// HEARTBEAT
// ============================================================

async function sendShadowHeartbeat(): Promise<void> {
  try {
    const balance = await getBalance();
    const balanceTotal = normalizeUsdAmount((balance as any)?.usdc) ?? normalizeUsdAmount(balance) ?? 0;
    
    const stats = shadowEngine.getStats();
    const loggerStats = getPriceFeedLoggerStats();

    await sendHeartbeat({
      runner_id: RUN_ID,
      runner_type: 'v27-shadow',
      last_heartbeat: new Date().toISOString(),
      status: 'online',
      markets_count: activeMarkets.size,
      positions_count: stats.activeTrackings,
      trades_count: stats.candidateSignals,
      balance: balanceTotal,
      version: 'shadow-v27',
    });

    log(`💓 Heartbeat | Markets: ${activeMarkets.size} | Evals: ${stats.totalEvaluations} | Signals: ${stats.signalsDetected} | Clean: ${stats.cleanSignals}`);
    log(`   📊 Feeds: Binance=${loggerStats.binance.connected ? '✅' : '❌'} PM=${loggerStats.polymarket.connected ? '✅' : '❌'} CLOB=${loggerStats.clob.connected ? '✅' : '❌'} | Ticks: ${loggerStats.totalLogged}`);
  } catch (err) {
    logError('Heartbeat failed', err);
  }
}

// ============================================================
// MAIN LOOP
// ============================================================

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🔮 V27 SHADOW TRADING ENGINE                                 ║');
  console.log('║  Continuous evaluation • Full logging • No real trades       ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Run ID: ${RUN_ID.slice(0, 50).padEnd(53)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // 1. VPN check (if required)
  await enforceVpnOrExit();

  // 2. Test Polymarket connection
  log('Testing Polymarket connection...');
  const connected = await testConnection();
  if (!connected) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');

  // 3. Get initial balance
  const balance = await getBalance();
  log(`💰 Balance: $${normalizeUsdAmount(balance) ?? 'unknown'}`);

  // 4. Initialize Shadow Engine with Supabase client
  loadV27Config({ shadowMode: true }); // Force shadow mode
  const supabaseClient = getSupabaseClient();
  shadowEngine = new ShadowEngine(RUN_ID, supabaseClient);

  // 5. Start price feed logger with callbacks
  log('Starting price feed logger...');
  await startPriceFeedLogger({
    onBinancePrice,
    onPolymarketPrice,
    onTakerFill,
  });
  log('✅ Price feed logger started');

  // 6. Initial market fetch
  await refreshMarkets();

  // 7. Start all intervals
  isRunning = true;

  // Market refresh every 30s
  setInterval(refreshMarkets, MARKET_POLL_INTERVAL_MS);

  // Chainlink price logging every 1s (backup)
  setInterval(logChainlinkPrices, PRICE_TICK_INTERVAL_MS);

  // CRITICAL: Orderbook polling + evaluation every 500ms
  setInterval(pollOrderbooksAndEvaluate, ORDERBOOK_POLL_INTERVAL_MS);

  // Heartbeat every 30s
  setInterval(sendShadowHeartbeat, HEARTBEAT_INTERVAL_MS);
  await sendShadowHeartbeat();

  // Stats logging every 60s
  setInterval(() => {
    shadowEngine.printStats();
  }, STATS_LOG_INTERVAL_MS);

  log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ SHADOW ENGINE IS LIVE                                     ║');
  console.log('║                                                               ║');
  console.log('║  • Evaluating every 500ms per market                          ║');
  console.log('║  • Logging EVERY evaluation to database                       ║');
  console.log('║  • Tracking post-signal outcomes at 5s, 10s, 15s              ║');
  console.log('║  • Simulating hedges and calculating CPP                      ║');
  console.log('║                                                               ║');
  console.log('║  NO REAL ORDERS WILL BE PLACED                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Handle shutdown
  const shutdown = async () => {
    log('Shutting down...');
    isRunning = false;
    shadowEngine.printStats();
    stopPriceFeedLogger();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run
main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
