/**
 * V29 Buy-and-Sell Runner
 * 
 * SIMPLE STRATEGY:
 * 1. Binance tick delta → buy shares
 * 2. Track SETTLED entry price per position
 * 3. Sell as soon as bestBid >= entryPrice - 2¢ (profit!)
 * 4. NEVER sell at loss unless position age > 60 seconds
 */

// CRITICAL: Import HTTP agent FIRST to configure axios before any SDK imports
import './http-agent.js';

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog, logTick, queueTick } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, getOrderStatus, setFillContext, clearFillContext, cancelOrder } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, isRunnerActive } from './lease.js';
import { fetchPositions, type PolymarketPosition } from '../positions-sync.js';
import { config as globalConfig } from '../config.js';

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
  orderId?: string;
  takeProfitPrice: number;  // Target sell price = entry + TP cents
}

// Open positions by ID
const openPositions = new Map<string, OpenPosition>();

// ============================================
// STATE
// ============================================

const RUN_ID = `v29-${Date.now().toString(36)}`;
const HEARTBEAT_ID = randomUUID();
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
// Rate-limit noisy force-close skip logs (sell check runs every ~200ms)
const lastForceCloseSkipLogTime: Record<string, number> = {};
const FORCE_CLOSE_SKIP_LOG_COOLDOWN_MS = 30_000;
let lastMarketRefresh = 0;
let lastConfigReload = 0;
let totalPnL = 0;

// Track previous market slugs to detect market changes
const previousMarketSlugs: Record<Asset, string | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Market expiration timers
const marketTimers: Record<Asset, NodeJS.Timeout | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// LOCAL DEDUP CACHE: Prevents blocking DB calls before order placement
// Saves ~100-200ms latency per order by avoiding network round-trip
const localDedupCache = new Set<string>();

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

  const byKey: Record<string, { shares: number; cost: number; count: number }> = {};

  for (const pos of openPositions.values()) {
    const key = `${pos.asset} ${pos.direction}`;
    if (!byKey[key]) byKey[key] = { shares: 0, cost: 0, count: 0 };
    byKey[key].shares += pos.shares;
    byKey[key].cost += pos.totalCost;
    byKey[key].count++;
  }

  return Object.entries(byKey)
    .map(([key, data]) => `${key}: ${data.shares.toFixed(2)} sh ($${data.cost.toFixed(2)})`)
    .join(' | ');
}

// ============================================
// LOAD EXISTING POSITIONS FROM POLYMARKET
// ============================================

/**
 * Load existing positions from Polymarket API and add them to openPositions.
 * This allows selling positions that were opened in previous sessions.
 * 
 * NOTE: Sell is ALWAYS allowed - no price range restrictions!
 */
let positionSyncInFlight = false;

async function loadExistingPositions(opts: { quiet?: boolean } = {}): Promise<void> {
  const { quiet = false } = opts;

  if (positionSyncInFlight) return;
  positionSyncInFlight = true;

  const walletAddress = globalConfig.polymarket.address;
  if (!walletAddress) {
    if (!quiet) log('⚠️ No wallet address configured, skipping position load');
    positionSyncInFlight = false;
    return;
  }

  if (markets.size === 0) {
    if (!quiet) log('⚠️ Markets not loaded yet, skipping position load');
    positionSyncInFlight = false;
    return;
  }

  if (!quiet) log('📥 Loading positions from Polymarket (wallet truth)...');

  try {
    const positions = await fetchPositions(walletAddress);

    // Only positions that match our CURRENT active markets (by slug)
    const slugToMarket = new Map<string, { asset: Asset; market: MarketInfo }>();
    for (const [asset, market] of markets) {
      slugToMarket.set(market.slug, { asset, market });
    }

    const aggregates = new Map<string, {
      asset: Asset;
      direction: 'UP' | 'DOWN';
      market: MarketInfo;
      shares: number;
      cost: number;
    }>();

    for (const p of positions) {
      if (!p.eventSlug) continue;
      const m = slugToMarket.get(p.eventSlug);
      if (!m) continue;
      if (p.size <= 0.0001) continue;

      const outcome = (p.outcome || '').toLowerCase();
      const direction: 'UP' | 'DOWN' = (outcome === 'up' || outcome === 'yes') ? 'UP' : 'DOWN';

      const key = `${m.market.slug}:${direction}`;
      const prev = aggregates.get(key);
      const addShares = Number(p.size) || 0;
      const addCost = Number(p.initialValue) || (Number(p.avgPrice) * addShares);

      aggregates.set(key, {
        asset: m.asset,
        direction,
        market: m.market,
        shares: (prev?.shares ?? 0) + addShares,
        cost: (prev?.cost ?? 0) + addCost,
      });
    }

    // Remove stale wallet-derived positions first
    const keepWalletKeys = new Set<string>();
    for (const [key] of aggregates) keepWalletKeys.add(`wallet:${key}`);

    for (const [posId] of openPositions) {
      if (!posId.startsWith('wallet:')) continue;
      if (!keepWalletKeys.has(posId)) openPositions.delete(posId);
    }

    // Upsert wallet-derived positions into openPositions
    let loadedCount = 0;
    for (const [key, agg] of aggregates) {
      const positionId = `wallet:${key}`;

      // Remove any in-memory positions for the same market+direction to avoid double-counting
      for (const [posId, pos] of openPositions) {
        if (pos.marketSlug === agg.market.slug && pos.direction === agg.direction && pos.asset === agg.asset) {
          openPositions.delete(posId);
        }
      }

      const avgPrice = agg.shares > 0 ? agg.cost / agg.shares : 0;
      const tokenId = agg.direction === 'UP' ? agg.market.upTokenId : agg.market.downTokenId;

      openPositions.set(positionId, {
        id: positionId,
        asset: agg.asset,
        direction: agg.direction,
        marketSlug: agg.market.slug,
        tokenId,
        shares: agg.shares,
        entryPrice: avgPrice,
        totalCost: agg.cost,
        entryTime: Date.now() - 30_000,
        orderId: `wallet-${positionId}`,
      });

      loadedCount++;

      if (!quiet) {
        log(`   📋 Wallet: ${agg.asset} ${agg.direction} ${agg.shares.toFixed(2)} sh @ ${(avgPrice * 100).toFixed(1)}¢ (${agg.market.slug})`);
      }
    }

    if (!quiet) {
      if (loadedCount === 0) {
        log(`   No matching positions for active markets (wallet has ${positions.length} total positions).`);
        const sample = positions
          .filter(p => p.size > 0.0001)
          .slice(0, 3)
          .map(p => `${p.eventSlug ?? 'no-slug'} / ${p.outcome} / ${p.size}`)
          .join(' | ');
        if (sample) log(`   Sample wallet positions: ${sample}`);
      }
      log(`✅ Wallet sync done: ${loadedCount} active positions loaded`);
    }
  } catch (err) {
    if (!quiet) logError('Failed to load existing positions', err);
  } finally {
    positionSyncInFlight = false;
  }
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
  // CRITICAL: Skip processing if we're no longer the active runner
  if (!isRunnerActive()) {
    return; // Silent skip - takeover detected, shutting down
  }

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
  
  // Buy cooldown per asset+direction (UP/DOWN are independent)
  const cooldownKey = `${asset}:${tickDirection}`;
  if (now - (lastBuyTime[cooldownKey] ?? 0) < config.order_cooldown_ms) return;
  
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
  // CRITICAL: Check local flag (fast path - no DB call)
  if (!isRunnerActive()) {
    log(`🛑 BLOCKED: Buy attempt for ${asset} ${direction} - runner no longer active`);
    return;
  }

  // signalTs is when we START processing - used for dedup key
  const signalTs = Date.now();
  
  // Generate deterministic signal ID to prevent duplicate orders from multiple runners
  // Round timestamp to nearest second to catch same-tick races
  const signalBucket = Math.floor(signalTs / 1000);
  const dedupKey = `${asset}-${direction}-${strikeActualDelta.toFixed(2)}-${signalBucket}`;
  
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
  
  // === COUNTER-SCALPING PREVENTION ===
  // Don't buy opposite direction if we already have a position in this market
  if (config.prevent_counter_scalping) {
    const oppositeDirection = direction === 'UP' ? 'DOWN' : 'UP';
    const oppositePositions = Array.from(openPositions.values()).filter(
      p => p.marketSlug === market.slug && p.direction === oppositeDirection
    );
    
    if (oppositePositions.length > 0) {
      const totalOppositeShares = oppositePositions.reduce((sum, p) => sum + p.shares, 0);
      log(`🛑 COUNTER-SCALP BLOCKED: Already have ${totalOppositeShares.toFixed(2)} ${oppositeDirection} shares in ${market.slug} - won't buy ${direction}`, 'guard', asset);
      return;
    }
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
  
  // RACE PREVENTION: Local in-memory dedup (avoid DB call before order)
  // This is a fast local check - DB dedup happens async after fill
  if (localDedupCache.has(dedupKey)) {
    log(`🛑 DUPLICATE: Signal ${dedupKey} already in local cache`);
    return;
  }
  localDedupCache.add(dedupKey);
  // Expire from cache after 30s to prevent memory leak
  setTimeout(() => localDedupCache.delete(dedupKey), 30_000);
  
  // Create signal for logging - signal_ts is when we STARTED processing (for dedup)
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
    signal_ts: signalTs,  // Used for dedup + ordering
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
    signal_key: dedupKey, // Add signal key for deduplication
    notes: `BUY ${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  // Fire-and-forget signal save - DON'T await before order placement!
  // This saves ~100-200ms latency per order
  void saveSignal(signal).then(id => { if (id) signal.id = id; });
  
  lastBuyTime[`${asset}:${direction}`] = Date.now();
  
  log(`📤 BUY: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset);
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  
  // Set fill context for burst logging
  setFillContext({
    runId: RUN_ID,
    signalId: signal.id,
    marketSlug: market.slug,
  });
  
  // ⏱️ LATENCY: Start timer RIGHT BEFORE the API call - this is the TRUE order latency
  const orderStartTs = Date.now();
  
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
  // Clear context after order
  clearFillContext();
  
  // TIMING: fillTs is NOW - right after placeBuyOrder returns
  // FOK orders fill instantly, so this is the true fill time
  const fillTs = Date.now();
  const orderLatencyMs = fillTs - orderStartTs;  // TRUE order latency (API call only)
  
  if (!result.success) {
    signal.status = 'failed';
    signal.notes = `${result.error ?? 'Unknown error'}`;
    log(`❌ FAILED: ${result.error ?? 'Unknown'} (${orderLatencyMs}ms)`);
    void saveSignal(signal);
    return;
  }
  
  const orderId = result.orderId;
  
  // FOK orders: if success=true, it's already filled!
  // No need to poll - use the filledSize from result directly
  const filledSize = result.filledSize ?? shares;
  const avgPrice = result.avgPrice ?? buyPrice;
  
  if (filledSize <= 0) {
    signal.status = 'no_fill';
    signal.notes = `FOK returned 0 shares`;
    log(`⚠️ FOK order returned 0 shares (${orderLatencyMs}ms)`);
    void saveSignal(signal);
    return;
  }
  
  signal.order_id = orderId ?? null;
  
  // Log tick with REAL latency data
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
    orderId: orderId ?? undefined,
    fillPrice: avgPrice,
    fillSize: filledSize,
    marketSlug: market.slug,
    strikePrice: market.strikePrice,
    // LATENCY TRACKING - orderLatencyMs = TRUE API call latency
    orderLatencyMs: orderLatencyMs,
    fillLatencyMs: result.fillLatencyMs,
    signalToFillMs: orderLatencyMs,  // Use orderLatencyMs as the key metric
    signLatencyMs: result.signLatencyMs,
    postLatencyMs: result.postLatencyMs,
    usedCache: result.usedCache,
  });
  
  // FILLED! Create open position with SETTLED entry price
  const positionId = `${RUN_ID}-${buysCount}`;
  
  // Calculate take-profit target price (entry + profit target)
  const takeProfitPrice = Math.round((avgPrice + config.min_profit_cents / 100) * 100) / 100;
  
  const openPos: OpenPosition = {
    id: positionId,
    asset,
    direction,
    marketSlug: market.slug,
    tokenId,
    shares: filledSize,
    entryPrice: avgPrice,  // SETTLED PRICE!
    totalCost: filledSize * avgPrice,
    entryTime: fillTs,  // Use actual fill time
    orderId: orderId ?? undefined,
    takeProfitPrice,  // Will monitor and sell when price hits this
  };
  
  openPositions.set(positionId, openPos);
  buysCount++;
  
  signal.status = 'filled';
  signal.entry_price = avgPrice;
  signal.shares = filledSize;
  signal.fill_ts = fillTs;
  signal.signal_ts = orderStartTs;
  signal.notes = `BOUGHT ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ in ${orderLatencyMs}ms`;
  
  log(`✅ BOUGHT: ${asset} ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (${orderLatencyMs}ms) - TP target: ${(takeProfitPrice * 100).toFixed(1)}¢`, 'fill', asset);
  
  void saveSignal(signal);
  // No GTC order - we monitor price and fire sell when TP hit
}

// ============================================
// SELL CHECK - PRICE MONITORING + INSTANT TP SELL
// ============================================
// Strategy:
// 1. Monitor bestBid for each position
// 2. When bestBid >= takeProfitPrice → FIRE MARKET SELL IMMEDIATELY
// 3. STOP-LOSS: if price drops too much → market sell
// 4. FORCE CLOSE: if position too old → aggressive sell
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
  // CRITICAL: Check local flag (fast path - no DB call)
  if (!isRunnerActive()) {
    return; // Silent skip - takeover detected, shutting down
  }

  if (!config.enabled) return;
  if (openPositions.size === 0) return;
  
  const now = Date.now();
  
  // ========================================
  // PHASE 1: TAKE-PROFIT + STOP-LOSS MONITORING
  // ========================================
  // For each position, check if bestBid hits TP or SL
  for (const [posId, pos] of openPositions) {
    const positionAgeSec = (now - pos.entryTime) / 1000;
    
    // Skip if too old (will be force closed in phase 2)
    if (positionAgeSec >= config.force_close_after_sec) continue;
    
    const market = markets.get(pos.asset);
    if (!market || market.slug !== pos.marketSlug) continue;
    
    const state = priceState[pos.asset];
    const bestBid = pos.direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    if (!bestBid || bestBid <= 0) continue;
    
    const profitCents = (bestBid - pos.entryPrice) * 100;
    const cooldownKey = `${pos.asset}:${pos.direction}`;
    
    // TAKE-PROFIT: bestBid >= takeProfitPrice → SELL NOW!
    if (bestBid >= pos.takeProfitPrice) {
      if (now - (lastSellTime[cooldownKey] ?? 0) < config.order_cooldown_ms) continue;
      
      log(
        `🎯 TP HIT: ${pos.asset} ${pos.direction} ${pos.shares} @ bid ${(bestBid * 100).toFixed(1)}¢ >= TP ${(pos.takeProfitPrice * 100).toFixed(1)}¢ | +${profitCents.toFixed(1)}¢`,
        'sell',
        pos.asset
      );
      
      lastSellTime[cooldownKey] = now;
      
      // Fire market sell at current bid
      const result = await placeSellOrder(
        pos.tokenId,
        bestBid,
        pos.shares,
        pos.asset,
        pos.direction,
        1 // Small discount for fast fill
      );
      
      if (result.success) {
        const actualSellPrice = result.avgPrice || bestBid;
        const actualProfit = (actualSellPrice - pos.entryPrice) * pos.shares;
        const holdTimeMs = now - pos.entryTime;
        
        totalPnL += actualProfit;
        sellsCount++;
        if (actualProfit > 0) profitableSells++;
        else lossSells++;
        
        log(
          `💰 TP SOLD: ${pos.asset} ${pos.direction} ${pos.shares} @ ${(actualSellPrice * 100).toFixed(1)}¢ | P&L: ${actualProfit >= 0 ? '+' : ''}$${actualProfit.toFixed(3)} | hold: ${(holdTimeMs / 1000).toFixed(1)}s`,
          'sell',
          pos.asset
        );
        
        void logTick({
          runId: RUN_ID,
          asset: pos.asset,
          orderPlaced: true,
          orderId: result.orderId,
          fillPrice: actualSellPrice,
          fillSize: result.filledSize || pos.shares,
          marketSlug: pos.marketSlug,
          signalDirection: pos.direction,
        });
        
        openPositions.delete(posId);
      }
      continue;
    }
    
    // STOP-LOSS: Exit immediately if loss exceeds threshold
    if (profitCents <= -config.stop_loss_cents) {
      if (now - (lastSellTime[cooldownKey] ?? 0) < config.order_cooldown_ms) continue;
      
      log(
        `🛑 STOP-LOSS: ${pos.asset} ${pos.direction} ${pos.shares} @ ${(bestBid * 100).toFixed(1)}¢ | ${profitCents.toFixed(1)}¢ | ${positionAgeSec.toFixed(0)}s`,
        'sell',
        pos.asset
      );
      
      lastSellTime[cooldownKey] = now;
      
      const result = await placeSellOrder(
        pos.tokenId,
        bestBid,
        pos.shares,
        pos.asset,
        pos.direction,
        2 // Aggressive discount for stop-loss
      );
      
      if (result.success) {
        const actualSellPrice = result.avgPrice || bestBid;
        const actualProfit = (actualSellPrice - pos.entryPrice) * pos.shares;
        
        totalPnL += actualProfit;
        sellsCount++;
        lossSells++;
        
        log(
          `✅ STOP-LOSS EXECUTED: ${pos.asset} ${pos.direction} ${pos.shares} @ ${(actualSellPrice * 100).toFixed(1)}¢ | P&L: $${actualProfit.toFixed(3)}`,
          'sell',
          pos.asset
        );
        
        openPositions.delete(posId);
      }
      continue;
    }
  }
  
  // ========================================
  // PHASE 2: Force close aggregated (≥ 20s)
  // ========================================
  // First, aggregate all positions that are past the force_close threshold
  const toForceClose = new Map<string, AggregatedPosition>();
  
  for (const [posId, pos] of openPositions) {
    const positionAgeSec = (now - pos.entryTime) / 1000;
    
    // Only aggregate positions past force_close threshold
    if (positionAgeSec < config.force_close_after_sec) continue;
    
    const key = `${pos.asset}:${pos.direction}`;
    
    if (!toForceClose.has(key)) {
      toForceClose.set(key, {
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
    
    const agg = toForceClose.get(key)!;
    agg.totalShares += pos.shares;
    agg.totalCost += pos.totalCost;
    agg.positionIds.push(posId);
    if (pos.entryTime < agg.oldestEntryTime) {
      agg.oldestEntryTime = pos.entryTime;
    }
  }
  
  // Calculate weighted average and execute force close
  for (const [key, agg] of toForceClose) {
    agg.weightedEntryPrice = agg.totalCost / agg.totalShares;
    
    const market = markets.get(agg.asset);
    
    // CRITICAL: Skip positions from expired/different markets
    // These are stale wallet positions that should be removed from tracking
    if (!market || market.slug !== agg.marketSlug) {
      log(`🗑️ Removing stale positions from ${agg.marketSlug} (current: ${market?.slug ?? 'none'}) - ${agg.totalShares} shares`, 'system', agg.asset);
      for (const posId of agg.positionIds) {
        openPositions.delete(posId);
      }
      continue;
    }
    
    // Also skip if market has expired
    if (market.endTime && market.endTime.getTime() < now) {
      log(`🗑️ Removing positions from expired market ${agg.marketSlug} - ${agg.totalShares} shares`, 'system', agg.asset);
      for (const posId of agg.positionIds) {
        openPositions.delete(posId);
      }
      continue;
    }
    
    const state = priceState[agg.asset];
    let bestBid = agg.direction === 'UP' ? state.upBestBid : state.downBestBid;
    
    // Force fetch if no bid
    if (!bestBid || bestBid <= 0) {
      try {
        const book = await fetchMarketOrderbook(market);
        if (book.upBestBid !== undefined) state.upBestBid = book.upBestBid;
        if (book.downBestBid !== undefined) state.downBestBid = book.downBestBid;
        if (book.upBestAsk !== undefined) state.upBestAsk = book.upBestAsk;
        if (book.downBestAsk !== undefined) state.downBestAsk = book.downBestAsk;
      } catch { /* ignore */ }
      
      bestBid = agg.direction === 'UP' ? state.upBestBid : state.downBestBid;
      
      // Emergency: sell at 1¢ if still no bid
      if (!bestBid || bestBid <= 0) {
        bestBid = 0.01;
      }
    }
    
    // SKIP: Polymarket min order size is 1 share (avoid endless "Shares < 1" spam)
    if (agg.totalShares < 1) {
      if (now - (lastForceCloseSkipLogTime[key] ?? 0) >= FORCE_CLOSE_SKIP_LOG_COOLDOWN_MS) {
        log(`⏭️ SKIP FORCE CLOSE: ${agg.asset} ${agg.direction} ${agg.totalShares.toFixed(4)} shares (<1) - cannot place order`, 'sell', agg.asset);
        lastForceCloseSkipLogTime[key] = now;
      }
      continue;
    }

    // SKIP: Shares at 99¢+ or ≤1¢ don't need force close - they'll settle at $1 or $0
    if (bestBid >= 0.99 || bestBid <= 0.01) {
      if (now - (lastForceCloseSkipLogTime[key] ?? 0) >= FORCE_CLOSE_SKIP_LOG_COOLDOWN_MS) {
        log(`⏭️ SKIP FORCE CLOSE: ${agg.asset} ${agg.direction} @ ${(bestBid * 100).toFixed(0)}¢ - will settle naturally`, 'sell', agg.asset);
        lastForceCloseSkipLogTime[key] = now;
      }
      continue;
    }
    
    // Sell cooldown
    if (now - (lastSellTime[key] ?? 0) < config.order_cooldown_ms) continue;
    
    const profitCents = (bestBid - agg.weightedEntryPrice) * 100;
    const oldestAgeSec = (now - agg.oldestEntryTime) / 1000;
    
    log(
      `🔥 FORCE CLOSE: ${agg.asset} ${agg.direction} ${agg.totalShares} shares @ ${(bestBid * 100).toFixed(1)}¢ | ${profitCents >= 0 ? '+' : ''}${profitCents.toFixed(1)}¢ | ${agg.positionIds.length} pos | ${oldestAgeSec.toFixed(0)}s old`,
      'sell',
      agg.asset
    );
    
    lastSellTime[key] = now;
    
    // Aggressive discount for force close (2¢ below best bid to guarantee fill)
    const result = await placeSellOrder(
      agg.tokenId,
      bestBid,
      agg.totalShares,
      agg.asset,
      agg.direction,
      2 // 2¢ aggressive discount
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
      
      const holdTimeMs = Date.now() - agg.oldestEntryTime;
      
      log(
        `✅ CLOSED: ${agg.asset} ${agg.direction} ${agg.totalShares} @ ${(actualSellPrice * 100).toFixed(1)}¢ | P&L: ${actualProfit >= 0 ? '+' : ''}$${actualProfit.toFixed(3)} | hold: ${(holdTimeMs / 1000).toFixed(1)}s | sellLatency: ${result.latencyMs}ms`,
        'sell',
        agg.asset
      );
      
      // Log sell tick with latency data
      void logTick({
        runId: RUN_ID,
        asset: agg.asset,
        orderPlaced: true,
        orderId: result.orderId,
        fillPrice: actualSellPrice,
        fillSize: result.filledSize || agg.totalShares,
        marketSlug: agg.marketSlug,
        orderLatencyMs: result.latencyMs,
        signalDirection: agg.direction,
      });
      
      // Remove all closed positions
      for (const posId of agg.positionIds) {
        openPositions.delete(posId);
      }
    } else {
      // BALANCE ERROR = position doesn't exist anymore, remove from tracking
      const errMsg = result.error || 'Unknown error';
      if (errMsg.includes('balance') || errMsg.includes('allowance') || errMsg.includes('insufficient')) {
        log(`⚠️ Position gone (${errMsg}) - removing from tracking`, 'warn', agg.asset);
        for (const posId of agg.positionIds) {
          openPositions.delete(posId);
        }
      } else if (errMsg.includes('min size') || errMsg.includes('invalid amount')) {
        // Min order size error - position is too small, remove it
        log(`⚠️ Position too small to sell (${errMsg}) - removing ${agg.totalShares} shares`, 'warn', agg.asset);
        for (const posId of agg.positionIds) {
          openPositions.delete(posId);
        }
      } else {
        log(`❌ Force close failed: ${errMsg}`, 'error', agg.asset);
      }
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
  // RUNNER REGISTRATION - NO TAKEOVER BY DEFAULT
  // ============================================
  const registered = await acquireLease(RUN_ID, { force: process.env.FORCE_TAKEOVER === '1' });
  if (!registered) {
    logError('❌ Failed to register runner (another runner is active)');
    process.exit(1);
  }
  log('🔒 Registered as active runner');
  
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
    log(`✅ Config loaded: enabled=${config.enabled}, shares=${config.shares_per_trade}, counter-scalp-block=${config.prevent_counter_scalping}`);
  } else {
    log(`⚠️ Using defaults: shares=${config.shares_per_trade}, counter-scalp-block=${config.prevent_counter_scalping}`);
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
  
  // Load existing positions from Polymarket (so they can be sold!)
  await loadExistingPositions();

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

  // Reconcile positions from wallet every 45s (prevents "ghost positions" / missing positions)
  const positionSyncInterval = setInterval(() => {
    void loadExistingPositions({ quiet: true });
  }, 45_000);

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
        log(`🔧 Config updated: enabled=${config.enabled}, shares=${config.shares_per_trade}, counter-scalp-block=${config.prevent_counter_scalping}`);
      }
    }
  }, 30_000);

  // Heartbeat every 10 seconds
  const heartbeatInterval = setInterval(async () => {
    const balance = await getBalance().catch(() => 0);
    void sendHeartbeat(HEARTBEAT_ID, RUN_ID, 'trading', balance, openPositions.size, buysCount);
  }, 10_000);

  // Log position summary every 30 seconds
  const summaryInterval = setInterval(() => {
    const summary = getPositionsSummary();
    log(`📊 Positions: ${summary} | P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | Buys: ${buysCount} | Sells: ${sellsCount} (${profitableSells}✅/${lossSells}❌)`);
  }, 30_000);

  log('🎯 V29 Buy-and-Sell Runner READY');
  log(`   Strategy: Buy → Profit-take (≥${config.min_profit_cents}¢) → Force close (${config.force_close_after_sec}s)`);
  log(`   Shares: ${config.shares_per_trade} | Max Exposure: ${config.max_exposure_per_asset}`);
  log(`   Aggregation: after ${config.aggregate_after_sec}s | Force close: after ${config.force_close_after_sec}s`);

  // Handle shutdown - release lease!
  const cleanup = async () => {
    log('🛑 Shutting down...');
    isRunning = false;
    clearInterval(orderbookInterval);
    clearInterval(sellInterval);
    clearInterval(positionSyncInterval);
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
