/**
 * V29 Buy-and-Sell Runner
 * 
 * SIMPLE STRATEGY:
 * 1. Binance tick delta → buy shares
 * 2. Track SETTLED entry price per position
 * 3. Sell as soon as bestBid >= entryPrice - 2¢ (profit!)
 * 4. NEVER sell at loss unless position age > 60 seconds
 */

import 'dotenv/config';
import { v4 as uuid } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog, logTick, queueTick } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, getOrderStatus, setFillContext, clearFillContext } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, isRunnerActive } from './lease.js';

// ============================================
// POSITION TRACKING
// ============================================

interface OpenPosition {
  id: string;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  marketSlug: string;
  tokenId: string;
  shares: number;
  entryPrice: number;  // SETTLED price!
  totalCost: number;
  entryTime: number;   // timestamp when filled
  orderId: string;
}

// Open positions by ID
const openPositions = new Map<string, OpenPosition>();

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

// Stats
let buysCount = 0;
let sellsCount = 0;
let profitableSells = 0;
let lossSells = 0;
// Cooldowns per asset+direction (UP/DOWN are independent markets)
const lastBuyTime: Record<string, number> = {};  // key: "BTC:UP", "BTC:DOWN", etc.
const lastSellTime: Record<string, number> = {};
let lastMarketRefresh = 0;
let lastConfigReload = 0;
let totalPnL = 0;

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
// POSITION HELPERS
// ============================================

function getOpenPositionsForAsset(asset: Asset): OpenPosition[] {
  return Array.from(openPositions.values()).filter(p => p.asset === asset);
}

function getTotalExposure(asset: Asset): { shares: number; cost: number } {
  const positions = getOpenPositionsForAsset(asset);
  return {
    shares: positions.reduce((sum, p) => sum + p.shares, 0),
    cost: positions.reduce((sum, p) => sum + p.totalCost, 0),
  };
}

function getPositionsSummary(): string {
  if (openPositions.size === 0) return 'No open positions';
  
  const byAsset: Record<string, { shares: number; cost: number; count: number }> = {};
  
  for (const pos of openPositions.values()) {
    if (!byAsset[pos.asset]) byAsset[pos.asset] = { shares: 0, cost: 0, count: 0 };
    byAsset[pos.asset].shares += pos.shares;
    byAsset[pos.asset].cost += pos.totalCost;
    byAsset[pos.asset].count++;
  }
  
  return Object.entries(byAsset)
    .map(([asset, data]) => `${asset}: ${data.count} pos, ${data.shares} shares, $${data.cost.toFixed(2)}`)
    .join(' | ');
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
  const state = priceState[asset];
  const market = markets.get(asset);
  const chainlinkPrice = state.chainlink;
  
  // Log EVERY tick to database (queue for batch insert)
  queueTick({
    runId: RUN_ID,
    asset,
    binancePrice: price,
    chainlinkPrice: chainlinkPrice ?? undefined,
    binanceDelta: tickDelta,
    upBestAsk: state.upBestAsk ?? undefined,
    upBestBid: state.upBestBid ?? undefined,
    downBestAsk: state.downBestAsk ?? undefined,
    downBestBid: state.downBestBid ?? undefined,
    alertTriggered: false,
    marketSlug: market?.slug,
    strikePrice: market?.strikePrice,
  });
  
  if (Math.abs(tickDelta) >= config.tick_delta_usd) {
    queueLog(RUN_ID, 'info', 'price', `${asset} binance $${price.toFixed(2)} Δ${tickDelta >= 0 ? '+' : ''}${tickDelta.toFixed(2)} 🎯`, asset, { 
      source: 'binance', 
      price,
      tickDelta, 
    });
  }
  
  // Skip if disabled
  if (!config.enabled) return;
  
  // Buy cooldown per asset+direction (UP/DOWN are independent)
  const cooldownKey = `${asset}:${tickDirection}`;
  if (now - (lastBuyTime[cooldownKey] ?? 0) < config.order_cooldown_ms) return;
  
  // Need previous price
  if (prevPrice === null) return;
  
  // Check tick delta threshold
  if (Math.abs(tickDelta) < config.tick_delta_usd) return;
  
  // Get market
  if (!market || !market.strikePrice) {
    return;
  }
  
  // Use Chainlink for delta calculation, fallback to Binance
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
  
  // Log alert tick
  void logTick({
    runId: RUN_ID,
    asset,
    binancePrice: price,
    chainlinkPrice: chainlinkPrice ?? undefined,
    binanceDelta: tickDelta,
    upBestAsk: state.upBestAsk ?? undefined,
    upBestBid: state.upBestBid ?? undefined,
    downBestAsk: state.downBestAsk ?? undefined,
    downBestBid: state.downBestBid ?? undefined,
    alertTriggered: true,
    signalDirection: tickDirection,
    marketSlug: market.slug,
    strikePrice: market.strikePrice,
  });
  
  log(`🎯 TRIGGER: ${asset} ${tickDirection} | tickΔ$${tickDelta.toFixed(2)} | allowed: ${allowedDirection}`, 'signal', asset);
  
  // Execute buy trade
  void executeBuy(asset, tickDirection, price, tickDelta, priceVsStrikeDelta, market);
}

// ============================================
// BUY EXECUTION
// ============================================

async function executeBuy(
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
  
  // Check exposure limits
  const exposure = getTotalExposure(asset);
  
  if (exposure.shares + shares > config.max_exposure_per_asset) {
    log(`🚫 ${asset} exposure limit: ${exposure.shares + shares} > ${config.max_exposure_per_asset}`);
    return;
  }
  
  if (exposure.cost + (shares * buyPrice) > config.max_cost_per_asset) {
    log(`🚫 ${asset} cost limit: $${(exposure.cost + shares * buyPrice).toFixed(2)} > $${config.max_cost_per_asset}`);
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
    notes: `BUY ${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  lastBuyTime[`${asset}:${direction}`] = Date.now();
  
  log(`📤 BUY: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset);
  
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
  
  // Log tick with order + fill info + LATENCY DATA
  const fillTs = Date.now();
  const signalToFillMs = fillTs - signalTs;
  
  void logTick({
    runId: RUN_ID,
    asset,
    binancePrice,
    chainlinkPrice: priceState[asset].chainlink ?? undefined,
    binanceDelta: tickDelta,
    upBestAsk: priceState[asset].upBestAsk ?? undefined,
    upBestBid: priceState[asset].upBestBid ?? undefined,
    downBestAsk: priceState[asset].downBestAsk ?? undefined,
    downBestBid: priceState[asset].downBestBid ?? undefined,
    alertTriggered: true,
    signalDirection: direction,
    orderPlaced: true,
    orderId,
    fillPrice: avgPrice,
    fillSize: filledSize,
    marketSlug: market.slug,
    strikePrice: market.strikePrice,
    // LATENCY TRACKING
    orderLatencyMs: result.latencyMs,
    fillLatencyMs: result.fillLatencyMs,
    signalToFillMs,
    signLatencyMs: result.signLatencyMs,
    postLatencyMs: result.postLatencyMs,
    usedCache: result.usedCache,
  });
  
  // FILLED! Create open position with SETTLED entry price
  const positionId = `${RUN_ID}-${buysCount}`;
  
  const openPos: OpenPosition = {
    id: positionId,
    asset,
    direction,
    marketSlug: market.slug,
    tokenId,
    shares: filledSize,
    entryPrice: avgPrice,  // SETTLED PRICE!
    totalCost: filledSize * avgPrice,
    entryTime: Date.now(),
    orderId,
  };
  
  openPositions.set(positionId, openPos);
  buysCount++;
  
  signal.status = 'filled';
  signal.entry_price = avgPrice;
  signal.shares = filledSize;
  signal.fill_ts = Date.now();
  signal.notes = `BOUGHT ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (settled) - waiting for sell`;
  
  log(`✅ BOUGHT: ${asset} ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (${latency}ms) - target sell: ≥${((avgPrice + config.min_profit_cents / 100) * 100).toFixed(1)}¢`, 'fill', asset);
  
  void saveSignal(signal);
}

// ============================================
// SELL CHECK - AGGREGATE BY ASSET+DIRECTION, SELL ALL AT ONCE
// ============================================

interface AggregatedPosition {
  asset: Asset;
  direction: 'UP' | 'DOWN';
  marketSlug: string;
  tokenId: string;
  totalShares: number;
  totalCost: number;
  weightedEntryPrice: number;
  oldestEntryTime: number;
  positionIds: string[];
}

async function checkAndExecuteSells(): Promise<void> {
  if (!config.enabled) return;
  if (openPositions.size === 0) return;
  
  const now = Date.now();
  
  // STEP 1: Aggregate positions by asset+direction
  const aggregated = new Map<string, AggregatedPosition>();
  
  for (const [posId, pos] of openPositions) {
    const key = `${pos.asset}:${pos.direction}`;
    
    if (!aggregated.has(key)) {
      aggregated.set(key, {
        asset: pos.asset,
        direction: pos.direction,
        marketSlug: pos.marketSlug,
        tokenId: pos.tokenId,
        totalShares: 0,
        totalCost: 0,
        weightedEntryPrice: 0,
        oldestEntryTime: pos.entryTime,
        positionIds: [],
      });
    }
    
    const agg = aggregated.get(key)!;
    agg.totalShares += pos.shares;
    agg.totalCost += pos.totalCost;
    agg.positionIds.push(posId);
    if (pos.entryTime < agg.oldestEntryTime) {
      agg.oldestEntryTime = pos.entryTime;
    }
  }
  
  // Calculate weighted average entry price
  for (const agg of aggregated.values()) {
    agg.weightedEntryPrice = agg.totalCost / agg.totalShares;
  }
  
  // STEP 2: Check each aggregated position for sell
  for (const [key, agg] of aggregated) {
    const market = markets.get(agg.asset);
    if (!market || market.slug !== agg.marketSlug) {
      continue;
    }

    const state = priceState[agg.asset];
    const positionAgeMs = now - agg.oldestEntryTime;
    const positionAgeSec = positionAgeMs / 1000;

    // Best bid (needed to exit). If we are past max-hold, force a fresh book fetch.
    let bestBid = agg.direction === 'UP' ? state.upBestBid : state.downBestBid;

    if (!bestBid || bestBid <= 0) {
      if (positionAgeSec < config.max_hold_before_loss_sell_sec) continue;

      // Past max-hold: try a fresh fetch
      try {
        const book = await fetchMarketOrderbook(market);
        if (book.upBestBid !== undefined) state.upBestBid = book.upBestBid;
        if (book.downBestBid !== undefined) state.downBestBid = book.downBestBid;
        if (book.upBestAsk !== undefined) state.upBestAsk = book.upBestAsk;
        if (book.downBestAsk !== undefined) state.downBestAsk = book.downBestAsk;
        if (book.lastUpdate !== undefined) state.lastUpdate = book.lastUpdate;
      } catch {
        // ignore
      }

      bestBid = agg.direction === 'UP' ? state.upBestBid : state.downBestBid;

      // Still no bid: emergency exit at 1¢
      if (!bestBid || bestBid <= 0) {
        bestBid = 0.01;
      }
    }

    // === SELL RULES ===
    // 1) Profit-taking: sell when we can realize >= min_profit_cents (based on weighted avg entry)
    // 2) Hard max-hold: once oldest position age >= max_hold_before_loss_sell_sec, SELL ALL
    let shouldSell = false;
    let sellReason = '';
    let aggressiveDiscountCents = 0;

    const profitCentsIfSellAtBid = (bestBid - agg.weightedEntryPrice) * 100;

    if (profitCentsIfSellAtBid >= config.min_profit_cents) {
      shouldSell = true;
      sellReason = `PROFIT +${profitCentsIfSellAtBid.toFixed(1)}¢`;
      aggressiveDiscountCents = 0;
    } else if (positionAgeSec >= config.max_hold_before_loss_sell_sec) {
      shouldSell = true;
      aggressiveDiscountCents = 2;
      const effectiveSellPrice = Math.max(0.01, bestBid - aggressiveDiscountCents / 100);
      const profitCentsEffective = (effectiveSellPrice - agg.weightedEntryPrice) * 100;
      sellReason = `MAX_HOLD (${positionAgeSec.toFixed(0)}s) ${profitCentsEffective >= 0 ? '+' : ''}${profitCentsEffective.toFixed(1)}¢`;
    }

    if (!shouldSell) continue;

    // Sell cooldown per asset+direction
    const sellCooldownKey = key;
    if (now - (lastSellTime[sellCooldownKey] ?? 0) < config.order_cooldown_ms) continue;

    log(
      `💰 SELL ALL: ${agg.asset} ${agg.direction} ${agg.totalShares} shares @ ${(bestBid * 100).toFixed(1)}¢ | ${sellReason} | ${agg.positionIds.length} positions`,
      'sell',
      agg.asset
    );

    lastSellTime[sellCooldownKey] = now;

    // Execute sell for ALL shares at once
    const result = await placeSellOrder(
      agg.tokenId,
      bestBid,
      agg.totalShares,
      agg.asset,
      agg.direction,
      aggressiveDiscountCents
    );

    if (result.success) {
      const actualSellPrice = result.avgPrice || bestBid;
      const actualProfit = (actualSellPrice - agg.weightedEntryPrice) * agg.totalShares;

      totalPnL += actualProfit;
      sellsCount++;

      if (actualProfit >= 0) {
        profitableSells++;
      } else {
        lossSells++;
      }

      log(
        `✅ SOLD ALL: ${agg.asset} ${agg.direction} ${agg.totalShares} @ ${(actualSellPrice * 100).toFixed(1)}¢ | P&L: ${actualProfit >= 0 ? '+' : ''}$${actualProfit.toFixed(3)} | Total: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`,
        'sell',
        agg.asset
      );

      // Remove ALL positions for this asset+direction
      for (const posId of agg.positionIds) {
        openPositions.delete(posId);
      }
    } else {
      log(`❌ Sell failed: ${result.error}`, 'error', agg.asset);
    }
  }
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function pollOrderbooks(): Promise<void> {
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
  log('🚀 V29 Buy-and-Sell Runner starting...');
  log(`📋 Run ID: ${RUN_ID}`);
  
  // Init DB first (needed for lease)
  initDb();
  log('✅ DB initialized');
  
  // ============================================
  // RUNNER REGISTRATION - TAKEOVER ANY EXISTING
  // ============================================
  const registered = await acquireLease(RUN_ID);
  if (!registered) {
    logError('❌ Failed to register runner');
    process.exit(1);
  }
  log('🔒 Registered as active runner (any previous runner will auto-shutdown)');
  
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
    log(`✅ Config loaded: enabled=${config.enabled}, shares=${config.shares_per_trade}, min_profit=${config.min_profit_cents}¢`);
  } else {
    log(`⚠️ Using defaults: shares=${config.shares_per_trade}, min_profit=${config.min_profit_cents}¢`);
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
  
  // Sell check interval - check for sell opportunities
  const sellInterval = setInterval(() => {
    void checkAndExecuteSells();
  }, config.sell_check_ms);
  
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
        log(`🔧 Config updated: enabled=${config.enabled}, shares=${config.shares_per_trade}, min_profit=${config.min_profit_cents}¢`);
      }
    }
  }, 30_000);
  
  // Heartbeat every 10 seconds - include position summary
  const heartbeatInterval = setInterval(() => {
    const summary = getPositionsSummary();
    void sendHeartbeat(RUN_ID, 'trading', {
      buys: buysCount,
      sells: sellsCount,
      profitable: profitableSells,
      lossy: lossSells,
      totalPnL: totalPnL.toFixed(2),
      openPositions: openPositions.size,
      markets: markets.size,
      positions: summary,
    });
  }, 10_000);
  
  // Log position summary every 30 seconds
  const summaryInterval = setInterval(() => {
    const summary = getPositionsSummary();
    log(`📊 Positions: ${summary} | P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | Buys: ${buysCount} | Sells: ${sellsCount} (${profitableSells}✅/${lossSells}❌)`);
  }, 30_000);
  
  log('🎯 V29 Buy-and-Sell Runner READY');
  log(`   Strategy: Buy → Sell with ${config.min_profit_cents}¢ profit target`);
  log(`   Shares: ${config.shares_per_trade} | Max Exposure: ${config.max_exposure_per_asset}`);
  log(`   Loss sell: only after ${config.max_hold_before_loss_sell_sec}s, max ${config.stop_loss_cents}¢ loss`);
  
  // Handle shutdown - release lease!
  const cleanup = async () => {
    log('🛑 Shutting down...');
    isRunning = false;
    clearInterval(orderbookInterval);
    clearInterval(sellInterval);
    clearInterval(marketRefreshInterval);
    clearInterval(configReloadInterval);
    clearInterval(heartbeatInterval);
    clearInterval(summaryInterval);
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    
    // Release registration so we're not in the DB anymore
    await releaseLease(RUN_ID);
    log('🔓 Registration released');
    
    // Final summary
    log(`📊 Final: Buys=${buysCount} Sells=${sellsCount} P&L=${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
    
    process.exit(0);
  };
  
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}

main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
