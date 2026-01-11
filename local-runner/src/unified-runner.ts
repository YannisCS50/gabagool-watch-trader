#!/usr/bin/env npx ts-node
// ============================================================
// UNIFIED RUNNER - Price Feed Logger + V27 Strategy
// ============================================================
//
// Combines:
// 1. Price Feed WebSocket logging (Binance + Polymarket)
// 2. V27 Delta Mispricing Strategy evaluation
//
// Run: npm run start:all
//
// ============================================================

import { config } from './config.js';
import { testConnection, getBalance, placeOrder, getOrderbookDepth } from './polymarket.js';
import { fetchMarkets, sendHeartbeat, savePriceTicks, saveSnapshotLogs, type PriceTick, getSupabaseClient } from './backend.js';
import { enforceVpnOrExit } from './vpn-check.js';
import { fetchChainlinkPrice } from './chain.js';
import { startPriceFeedLogger, stopPriceFeedLogger, getPriceFeedLoggerStats } from './price-feed-ws-logger.js';
import { V27Runner } from './v27/runner.js';
import { getV27Config, loadV27Config } from './v27/config.js';
import type { V27Market, V27OrderBook, V27SpotData } from './v27/index.js';

// ============================================================
// CONSTANTS
// ============================================================

const RUN_ID = `unified-${Date.now()}`;
const MARKET_POLL_INTERVAL_MS = 30_000; // Check for new markets every 30s
const PRICE_TICK_INTERVAL_MS = 1_000; // Log chainlink price every second
const SNAPSHOT_INTERVAL_MS = 5_000; // Log snapshots every 5 seconds
const HEARTBEAT_INTERVAL_MS = 30_000; // Send heartbeat every 30s
const ORDERBOOK_POLL_INTERVAL_MS = 500; // Poll orderbooks every 500ms for V27

// ============================================================
// STATE
// ============================================================

let isRunning = false;
let v27Runner: V27Runner;

// Price state
let lastBtcPrice: number | null = null;
let lastEthPrice: number | null = null;
let lastSolPrice: number | null = null;
let lastXrpPrice: number | null = null;

// Active markets
const activeMarkets = new Map<string, V27Market>();
let tradesCount = 0;

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

function getAssetPrice(asset: string): number | null {
  switch (asset) {
    case 'BTC': return lastBtcPrice;
    case 'ETH': return lastEthPrice;
    case 'SOL': return lastSolPrice;
    case 'XRP': return lastXrpPrice;
    default: return null;
  }
}

function setAssetPrice(asset: string, price: number): void {
  switch (asset) {
    case 'BTC': lastBtcPrice = price; break;
    case 'ETH': lastEthPrice = price; break;
    case 'SOL': lastSolPrice = price; break;
    case 'XRP': lastXrpPrice = price; break;
  }
}

// ============================================================
// MARKET MANAGEMENT
// ============================================================

async function fetchUpcomingMarkets(): Promise<V27Market[]> {
  try {
    const result = await fetchMarkets({ v26: true }); // Use same endpoint
    
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
      // E.g. "btc-above-97500-jan-11" -> 97500
      let strikePrice = m.strikePrice || 0;
      if (strikePrice === 0 && m.slug) {
        const match = m.slug.match(/(?:above|below)-(\d+(?:\.\d+)?)/i);
        if (match) {
          strikePrice = parseFloat(match[1]);
        }
      }
      
      // Skip if we still can't determine strike price
      if (strikePrice === 0) {
        log(`⚠️ Skipping market with unknown strike: ${m.slug}`);
        continue;
      }

      v27Markets.push({
        id: m.slug,  // Use slug as ID since backend doesn't return separate ID
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
  
  for (const market of markets) {
    if (!config.assets.includes(market.asset)) continue;
    if (activeMarkets.has(market.id)) continue;

    activeMarkets.set(market.id, market);
    v27Runner.registerMarket(market);
    log(`📊 Registered market: ${market.asset} ${market.slug}`);
  }

  // Remove expired markets
  const now = Date.now();
  for (const [id, market] of activeMarkets) {
    if (market.eventEndTime.getTime() < now) {
      activeMarkets.delete(id);
      v27Runner.unregisterMarket(id);
      log(`🏁 Market expired: ${market.asset} ${market.slug}`);
    }
  }
}

// ============================================================
// PRICE LOGGING (Chainlink backup)
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
      const delta = lastBtcPrice !== null ? price - lastBtcPrice : null;
      const deltaPct = lastBtcPrice && delta ? (delta / lastBtcPrice) * 100 : null;
      ticks.push({ asset: 'BTC', price, delta, delta_percent: deltaPct, source: 'chainlink', created_at: now });
      setAssetPrice('BTC', price);
      
      // Feed to V27
      v27Runner.feedSpotPrice('BTC', price, Date.now());
    }

    if (ethResult !== null) {
      const price = ethResult.price;
      const delta = lastEthPrice !== null ? price - lastEthPrice : null;
      const deltaPct = lastEthPrice && delta ? (delta / lastEthPrice) * 100 : null;
      ticks.push({ asset: 'ETH', price, delta, delta_percent: deltaPct, source: 'chainlink', created_at: now });
      setAssetPrice('ETH', price);
      
      // Feed to V27
      v27Runner.feedSpotPrice('ETH', price, Date.now());
    }

    if (ticks.length > 0) {
      await savePriceTicks(ticks);
    }
  } catch (err) {
    // Non-critical
  }
}

// ============================================================
// ORDERBOOK POLLING & V27 EVALUATION
// ============================================================

async function pollOrderbooksAndEvaluate(): Promise<void> {
  const config = getV27Config();
  if (!config.enabled) return;

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

      // Feed orderbook to V27
      v27Runner.feedOrderBook(marketId, book);

      // Get spot price
      const spotPrice = getAssetPrice(market.asset);
      if (spotPrice === null) continue;

      const spot: V27SpotData = {
        price: spotPrice,
        timestamp: Date.now(),
        source: 'chainlink',
      };

      // Evaluate for trading opportunity
      await v27Runner.evaluate(marketId, spot, book);
    } catch (err) {
      // Non-critical, continue with other markets
    }
  }
}

// ============================================================
// HEARTBEAT
// ============================================================

async function sendUnifiedHeartbeat(): Promise<void> {
  try {
    const balance = await getBalance();
    const balanceTotal = normalizeUsdAmount((balance as any)?.usdc) ?? normalizeUsdAmount(balance) ?? 0;
    
    const stats = v27Runner.getStats();
    const loggerStats = getPriceFeedLoggerStats();

    await sendHeartbeat({
      runner_id: RUN_ID,
      runner_type: 'v27',
      last_heartbeat: new Date().toISOString(),
      status: 'online',
      markets_count: activeMarkets.size,
      positions_count: v27Runner.getPositionCount(),
      trades_count: stats.tradesEntered,
      balance: balanceTotal,
      version: 'unified-v27',
    });

    // Log status
    const config = getV27Config();
    log(`💓 Heartbeat | Markets: ${activeMarkets.size} | Positions: ${v27Runner.getPositionCount()} | Shadow: ${config.shadowMode}`);
    log(`   📊 Logger: Binance=${loggerStats.binance.connected ? '✅' : '❌'} PM=${loggerStats.polymarket.connected ? '✅' : '❌'} CLOB=${loggerStats.clob.connected ? '✅' : '❌'} | Total ticks: ${loggerStats.totalLogged}`);
  } catch (err) {
    logError('Heartbeat failed', err);
  }
}

// ============================================================
// ORDER EXECUTION
// ============================================================

async function executeOrder(
  marketId: string,
  tokenId: string,
  side: 'BUY',
  price: number,
  shares: number
): Promise<{ orderId: string; filled: boolean; avgFillPrice?: number }> {
  const config = getV27Config();
  
  if (config.shadowMode) {
    log(`🔮 [SHADOW] Would place ${side} ${shares} @ $${price.toFixed(3)} for ${marketId}`);
    return { orderId: `shadow-${Date.now()}`, filled: false };
  }

  log(`📝 Placing ${side} order: ${shares} shares @ $${price.toFixed(3)}`);
  
  const result = await placeOrder({
    tokenId,
    side,
    price,
    size: shares,
    orderType: 'GTC',
  });

  tradesCount++;
  
  return {
    orderId: result.orderId || `order-${Date.now()}`,
    filled: result.status === 'FILLED',
    avgFillPrice: result.avgFillPrice,
  };
}

// ============================================================
// MAIN LOOP
// ============================================================

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  🚀 UNIFIED RUNNER - Price Logger + V27 Strategy             ║');
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

  // 4. Initialize V27 runner with Supabase client for logging
  loadV27Config();
  const supabaseClient = getSupabaseClient();
  v27Runner = new V27Runner(RUN_ID, supabaseClient);
  v27Runner.initialize();
  v27Runner.setOrderCallback(executeOrder);
  v27Runner.start();

  // 5. Start price feed logger (Binance + Polymarket WebSockets)
  log('Starting price feed logger...');
  await startPriceFeedLogger();
  log('✅ Price feed logger started');

  // 6. Initial market fetch
  await refreshMarkets();

  // 7. Start all intervals
  isRunning = true;

  // Market refresh
  setInterval(refreshMarkets, MARKET_POLL_INTERVAL_MS);

  // Chainlink price logging (backup)
  setInterval(logChainlinkPrices, PRICE_TICK_INTERVAL_MS);

  // Orderbook polling + V27 evaluation
  setInterval(pollOrderbooksAndEvaluate, ORDERBOOK_POLL_INTERVAL_MS);

  // Heartbeat
  setInterval(sendUnifiedHeartbeat, HEARTBEAT_INTERVAL_MS);
  await sendUnifiedHeartbeat();

  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║  ✅ Unified runner is LIVE                                    ║');
  log('║  Price feeds: Binance WS + Polymarket RTDS + CLOB             ║');
  log('║  Strategy: V27 Delta Mispricing (Shadow Mode by default)      ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');

  // Handle shutdown
  const shutdown = async () => {
    log('Shutting down...');
    isRunning = false;
    v27Runner.stop();
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
