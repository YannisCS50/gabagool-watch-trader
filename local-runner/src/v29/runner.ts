/**
 * V29 Accumulator Runner
 * 
 * HEDGE STRATEGY:
 * 1. Binance spike → accumulate shares (buy UP or DOWN)
 * 2. Instead of selling → buy opposite side to lock profit
 * 3. Progressive hedging: hedge more at lower prices
 * 4. No max 1 position - accumulate while delta is favorable
 * 
 * Benefits:
 * - No sell fees
 * - Keep optionality
 * - Lock profit with hedge instead of sell
 */

import 'dotenv/config';
import { v4 as uuid } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal, AccumulatorConfigDerived } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, getOrderStatus, setFillContext, clearFillContext } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, validateLease } from './lease.js';
import { 
  loadAggregatePositions, 
  accumulateShares, 
  checkHedgeOpportunity, 
  executeHedge, 
  getPositionsSummary,
  calculateCPP,
  clearMarketPositions,
  getPosition,
  type AccumulatorConfig,
  DEFAULT_ACCUMULATOR_CONFIG
} from './accumulator.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v29-${Date.now().toString(36)}`;
let isRunning = false;
let config: V29Config = { ...DEFAULT_CONFIG };

// Derived accumulator config (built from V29Config)
function getAccumulatorConfig(): AccumulatorConfig {
  return {
    min_hedge_profit_cents: config.min_hedge_profit_cents,
    max_hedge_price: config.max_hedge_price,
    hedge_tiers: [
      { max_price: config.hedge_tier_1_price, share_pct: config.hedge_tier_1_pct },
      { max_price: config.hedge_tier_2_price, share_pct: config.hedge_tier_2_pct },
      { max_price: config.hedge_tier_3_price, share_pct: config.hedge_tier_3_pct },
    ],
    max_exposure_per_asset: config.max_exposure_per_asset,
    max_cost_per_asset: config.max_cost_per_asset,
  };
}

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

// Stats
let tradesCount = 0;
let hedgeCount = 0;
let lastOrderTime = 0;
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
  
  // Execute accumulation trade
  void executeAccumulation(asset, tickDirection, price, tickDelta, priceVsStrikeDelta, market);
}

// ============================================
// ACCUMULATION EXECUTION
// ============================================

async function executeAccumulation(
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
  
  // Check exposure limits before placing order
  const accConfig = getAccumulatorConfig();
  const existingPos = getPosition(asset, direction, market.slug);
  const currentShares = existingPos?.totalShares || 0;
  const currentCost = existingPos?.totalCost || 0;
  
  if (currentShares + shares > accConfig.max_exposure_per_asset) {
    log(`🚫 ${asset} ${direction} exposure limit: ${currentShares + shares} > ${accConfig.max_exposure_per_asset}`);
    return;
  }
  
  if (currentCost + (shares * buyPrice) > accConfig.max_cost_per_asset) {
    log(`🚫 ${asset} ${direction} cost limit: $${(currentCost + shares * buyPrice).toFixed(2)} > $${accConfig.max_cost_per_asset}`);
    return;
  }
  
  // Create signal for logging
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
    notes: `ACCUMULATE ${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  lastOrderTime = Date.now();
  
  log(`📤 ACCUMULATE: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset);
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  
  // Set fill context for burst logging
  setFillContext({
    runId: RUN_ID,
    signalId: signal.id,
    marketSlug: market.slug,
  });
  
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
  // Clear context after order
  clearFillContext();
  
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
  let avgPrice = buyPrice;
  
  while (Date.now() - startWait < FILL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const status = await getOrderStatus(orderId);
    if (status.filled || status.filledSize > 0) {
      filled = true;
      filledSize = status.filledSize || shares;
      avgPrice = status.avgPrice || buyPrice;
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
  
  // FILLED! Add to aggregate position
  signal.status = 'filled';
  signal.entry_price = avgPrice;
  signal.shares = filledSize;
  signal.fill_ts = Date.now();
  signal.notes = `Accumulated ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢`;
  
  tradesCount++;
  
  log(`✅ ACCUMULATED: ${asset} ${direction} +${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (${latency}ms)`, 'fill', asset);
  
  // Add to aggregate position
  const accResult = await accumulateShares(RUN_ID, asset, direction, market, filledSize, avgPrice, accConfig);
  
  if (accResult.success) {
    const pos = accResult.position;
    log(`📊 ${asset} ${direction} TOTAL: ${pos.totalShares} @ avg ${(pos.avgEntryPrice * 100).toFixed(1)}¢ ($${pos.totalCost.toFixed(2)})`);
    
    // Show CPP if we have both sides
    const cppInfo = calculateCPP(asset, market.slug);
    if (cppInfo && cppInfo.pairedShares > 0) {
      log(`🔒 ${asset} CPP: ${cppInfo.cpp.toFixed(1)}¢ | Paired: ${cppInfo.pairedShares} | Unpaired: ${cppInfo.unpairedShares}`);
    }
  }
  
  void saveSignal(signal);
}

// ============================================
// HEDGE MONITORING
// ============================================

async function checkAndExecuteHedges(): Promise<void> {
  if (!config.enabled) return;
  
  const accConfig = getAccumulatorConfig();
  
  for (const asset of config.assets) {
    const market = markets.get(asset);
    if (!market) continue;
    
    const state = priceState[asset];
    
    // Check for hedge opportunity
    const hedgeOpp = checkHedgeOpportunity(asset, market, state, accConfig);
    
    if (hedgeOpp && hedgeOpp.shouldHedge) {
      log(`🛡️ HEDGE OPPORTUNITY: ${asset} ${hedgeOpp.hedgeSide} ${hedgeOpp.hedgeShares} @ ${(hedgeOpp.hedgePrice * 100).toFixed(1)}¢ | ${hedgeOpp.reason}`);
      
      // Don't spam hedges
      if (Date.now() - lastOrderTime < config.order_cooldown_ms) {
        log(`⏳ Hedge cooldown - waiting`);
        continue;
      }
      
      lastOrderTime = Date.now();
      
      const result = await executeHedge(
        RUN_ID,
        asset,
        hedgeOpp.hedgeSide,
        market,
        hedgeOpp.hedgeShares,
        hedgeOpp.hedgePrice + (config.price_buffer_cents / 100), // Add buffer
        accConfig
      );
      
      if (result.success) {
        hedgeCount++;
        log(`✅ HEDGED: ${asset} ${hedgeOpp.hedgeSide} +${result.filledShares} @ ${(result.avgPrice * 100).toFixed(1)}¢`);
        
        // Log new CPP
        const cppInfo = calculateCPP(asset, market.slug);
        if (cppInfo) {
          const profitCents = 100 - cppInfo.cpp;
          log(`🔒 ${asset} NEW CPP: ${cppInfo.cpp.toFixed(1)}¢ (+${profitCents.toFixed(1)}¢/share) | Paired: ${cppInfo.pairedShares}`);
        }
      } else {
        log(`❌ Hedge failed: ${result.error}`);
      }
    }
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
  log('🚀 V29 Accumulator Runner starting...');
  log(`📋 Run ID: ${RUN_ID}`);
  
  // Init DB first (needed for lease)
  initDb();
  log('✅ DB initialized');
  
  // ============================================
  // RUNNER LEASE - ONLY 1 RUNNER AT A TIME
  // ============================================
  const leaseAcquired = await acquireLease(RUN_ID);
  if (!leaseAcquired) {
    logError('❌ FAILED TO ACQUIRE LEASE - Another runner is already active!');
    logError('   Stop the other runner first, or wait for it to timeout (30s).');
    process.exit(1);
  }
  log('🔒 Lease acquired - this is the ONLY active runner');
  
  // VPN check
  const vpnOk = await verifyVpnConnection();
  if (!vpnOk) {
    await releaseLease(RUN_ID);
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
  
  // Load config - merge with defaults to ensure all fields exist
  const loadedConfig = await loadV29Config();
  if (loadedConfig) {
    config = { ...DEFAULT_CONFIG, ...loadedConfig };
    log(`✅ Config loaded: enabled=${config.enabled}, shares=${config.shares_per_trade}, hedge_profit=${config.min_hedge_profit_cents}¢`);
  } else {
    log(`⚠️ Using defaults: shares=${config.shares_per_trade}, hedge_profit=${config.min_hedge_profit_cents}¢`);
  }
  
  // Load existing aggregate positions from previous runs
  await loadAggregatePositions(RUN_ID);
  
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
  
  // Hedge check interval - check for hedge opportunities
  const hedgeInterval = setInterval(() => {
    void checkAndExecuteHedges();
  }, config.hedge_check_ms);
  
  // Market refresh every 2 minutes
  const marketRefreshInterval = setInterval(() => {
    void fetchMarkets();
  }, 2 * 60 * 1000);
  
  // Config reload every 30 seconds
  const configReloadInterval = setInterval(async () => {
    const newConfig = await loadV29Config();
    if (newConfig) {
      const changed = JSON.stringify(config) !== JSON.stringify({ ...DEFAULT_CONFIG, ...newConfig });
      if (changed) {
        config = { ...DEFAULT_CONFIG, ...newConfig };
        log(`🔧 Config updated: enabled=${config.enabled}, shares=${config.shares_per_trade}, hedge_profit=${config.min_hedge_profit_cents}¢`);
      }
    }
  }, 30_000);
  
  // Heartbeat every 10 seconds - include position summary
  const heartbeatInterval = setInterval(() => {
    const summary = getPositionsSummary();
    void sendHeartbeat(RUN_ID, 'trading', {
      trades: tradesCount,
      hedges: hedgeCount,
      markets: markets.size,
      positions: summary,
    });
  }, 10_000);
  
  // Log position summary every 30 seconds
  const summaryInterval = setInterval(() => {
    const summary = getPositionsSummary();
    if (summary) {
      log(`📊 Positions: ${summary}`);
    }
  }, 30_000);
  
  log('🎯 V29 Accumulator Runner READY');
  log(`   Strategy: Accumulate + Progressive Hedge`);
  log(`   Shares: ${config.shares_per_trade} | Min Hedge Profit: ${config.min_hedge_profit_cents}¢`);
  log(`   Max Exposure: ${config.max_exposure_per_asset} shares | Max Cost: $${config.max_cost_per_asset}`);
  log(`   Hedge Tiers: <${(config.hedge_tier_1_price * 100).toFixed(0)}¢ → ${(config.hedge_tier_1_pct * 100).toFixed(0)}% | <${(config.hedge_tier_2_price * 100).toFixed(0)}¢ → ${(config.hedge_tier_2_pct * 100).toFixed(0)}% | <${(config.hedge_tier_3_price * 100).toFixed(0)}¢ → ${(config.hedge_tier_3_pct * 100).toFixed(0)}%`);
  
  // Handle shutdown - release lease!
  const cleanup = async () => {
    log('🛑 Shutting down...');
    isRunning = false;
    clearInterval(orderbookInterval);
    clearInterval(hedgeInterval);
    clearInterval(marketRefreshInterval);
    clearInterval(configReloadInterval);
    clearInterval(heartbeatInterval);
    clearInterval(summaryInterval);
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    
    // CRITICAL: Release lease so another runner can start
    await releaseLease(RUN_ID);
    log('🔓 Lease released');
    
    // Final position summary
    const summary = getPositionsSummary();
    if (summary) {
      log(`📊 Final Positions: ${summary}`);
    }
    
    process.exit(0);
  };
  
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}

main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
