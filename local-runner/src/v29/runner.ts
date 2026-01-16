/**
 * V29 Pair-Instead-of-Sell Runner
 * 
 * STRATEGY:
 * 1. Binance tick delta → buy shares (UP or DOWN)
 * 2. Track UNPAIRED positions waiting for hedge opportunity
 * 3. When opposite side is cheap enough (combined < target), BUY opposite to LOCK profit
 * 4. Paired shares = guaranteed profit at settlement (no selling needed!)
 * 
 * ADVANTAGES:
 * - No slippage risk on exit (buying is often easier than selling)
 * - Profit is LOCKED once paired (guaranteed $1 payout per pair)
 * - Natural settlement - capital freed at market expiry
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
import { startOrderbookWs, stopOrderbookWs, updateMarkets as updateOrderbookWsMarkets, isOrderbookWsConnected, getOrderbookWsStats } from './orderbook-ws.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog, logTick, queueTick, upsertAggregatePosition, addHedgeToPosition, getAllPositionsForMarket, clearPositionsForMarket } from './db.js';
import { placeBuyOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, getOrderStatus, setFillContext, clearFillContext, cancelOrder, logBurstStats } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, isRunnerActive } from './lease.js';
import { fetchPositions, type PolymarketPosition } from '../positions-sync.js';
import { config as globalConfig } from '../config.js';
import { startUserChannel, stopUserChannel, type TradeEvent, isUserChannelConnected } from './user-ws.js';
import { startPriceFeedLogger, stopPriceFeedLogger, isPriceFeedLoggerRunning } from '../price-feed-ws-logger.js';
// V30 Fair Value model for smart direction filtering
import { EmpiricalFairValue, getFairValueModel } from '../v30/fair-value.js';

// Fair value model instance (shared with V30)
let fairValueModel: EmpiricalFairValue;


// ============================================
// POSITION TRACKING - UNPAIRED/PAIRED
// ============================================

interface UnpairedPosition {
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
}

interface PairedPosition {
  id: string;
  asset: Asset;
  marketSlug: string;
  upTokenId: string;
  downTokenId: string;
  shares: number;
  upEntryPrice: number;
  downEntryPrice: number;
  combinedCost: number;      // UP + DOWN cost per share
  lockedProfit: number;      // 1 - combinedCost (per share)
  pairedAt: number;
}

// Unpaired positions by ID (waiting for hedge)
const unpairedPositions = new Map<string, UnpairedPosition>();

// Paired positions by ID (locked profit, waiting for settlement)
const pairedPositions = new Map<string, PairedPosition>();

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
let pairsCount = 0;
let totalLockedProfit = 0;  // Total locked profit from pairing

// Cooldowns per asset+direction
const lastBuyTime: Record<string, number> = {};
const lastPairTime: Record<string, number> = {};
let lastMarketRefresh = 0;
let lastConfigReload = 0;

// Track previous market slugs to detect market changes
const previousMarketSlugs: Record<Asset, string | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Market expiration timers
const marketTimers: Record<Asset, NodeJS.Timeout | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// LOCAL DEDUP CACHE
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

function getUnpairedPositionsForAsset(asset: Asset): UnpairedPosition[] {
  return Array.from(unpairedPositions.values()).filter(p => p.asset === asset);
}

function getUnpairedByDirection(asset: Asset, direction: 'UP' | 'DOWN'): UnpairedPosition[] {
  return Array.from(unpairedPositions.values()).filter(p => p.asset === asset && p.direction === direction);
}

function getTotalUnpairedExposure(asset: Asset): { shares: number; cost: number } {
  const positions = getUnpairedPositionsForAsset(asset);
  return {
    shares: positions.reduce((sum, p) => sum + p.shares, 0),
    cost: positions.reduce((sum, p) => sum + p.totalCost, 0),
  };
}

function getPositionsSummary(): string {
  const unpairedCount = unpairedPositions.size;
  const pairedCount = pairedPositions.size;
  
  if (unpairedCount === 0 && pairedCount === 0) return 'No positions';

  const unpairedByKey: Record<string, { shares: number; cost: number }> = {};
  for (const pos of unpairedPositions.values()) {
    const key = `${pos.asset} ${pos.direction}`;
    if (!unpairedByKey[key]) unpairedByKey[key] = { shares: 0, cost: 0 };
    unpairedByKey[key].shares += pos.shares;
    unpairedByKey[key].cost += pos.totalCost;
  }

  const pairedByAsset: Record<string, { shares: number; profit: number }> = {};
  for (const pos of pairedPositions.values()) {
    if (!pairedByAsset[pos.asset]) pairedByAsset[pos.asset] = { shares: 0, profit: 0 };
    pairedByAsset[pos.asset].shares += pos.shares;
    pairedByAsset[pos.asset].profit += pos.lockedProfit * pos.shares;
  }

  const unpairedStr = Object.entries(unpairedByKey)
    .map(([key, data]) => `${key}: ${data.shares.toFixed(0)}sh`)
    .join(', ');
  
  const pairedStr = Object.entries(pairedByAsset)
    .map(([asset, data]) => `${asset}: ${data.shares.toFixed(0)}sh (+$${data.profit.toFixed(2)})`)
    .join(', ');

  return `UNPAIRED: ${unpairedStr || 'none'} | PAIRED: ${pairedStr || 'none'}`;
}

// ============================================
// LOAD EXISTING POSITIONS FROM POLYMARKET
// ============================================

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

    // Aggregate positions by market+direction
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

    // Check for pairable positions (both UP and DOWN in same market)
    for (const [asset, market] of markets) {
      const upKey = `${market.slug}:UP`;
      const downKey = `${market.slug}:DOWN`;
      const upAgg = aggregates.get(upKey);
      const downAgg = aggregates.get(downKey);

      if (upAgg && downAgg) {
        // We have both sides! Check if they're already paired
        const pairedShares = Math.min(upAgg.shares, downAgg.shares);
        if (pairedShares >= 1) {
          const upAvg = upAgg.shares > 0 ? upAgg.cost / upAgg.shares : 0;
          const downAvg = downAgg.shares > 0 ? downAgg.cost / downAgg.shares : 0;
          const combinedCost = upAvg + downAvg;
          const lockedProfit = 1 - combinedCost;

          // Create paired position
          const pairId = `wallet-pair:${asset}:${Date.now()}`;
          pairedPositions.set(pairId, {
            id: pairId,
            asset,
            marketSlug: market.slug,
            upTokenId: market.upTokenId,
            downTokenId: market.downTokenId,
            shares: pairedShares,
            upEntryPrice: upAvg,
            downEntryPrice: downAvg,
            combinedCost,
            lockedProfit,
            pairedAt: Date.now(),
          });

          if (!quiet) {
            log(`   🔗 PAIRED from wallet: ${asset} ${pairedShares.toFixed(0)} sh @ ${(combinedCost * 100).toFixed(1)}¢ = +${(lockedProfit * 100).toFixed(1)}¢/sh`);
          }

          // Reduce aggregates by paired amount
          upAgg.shares -= pairedShares;
          downAgg.shares -= pairedShares;
        }
      }
    }

    // Add remaining unpaired positions
    let loadedCount = 0;
    for (const [key, agg] of aggregates) {
      if (agg.shares < 1) continue;  // Skip tiny positions

      const tokenId = agg.direction === 'UP' ? agg.market.upTokenId : agg.market.downTokenId;
      const avgPrice = agg.cost / agg.shares;

      // Check if we already track this
      let inMemoryShares = 0;
      for (const [, pos] of unpairedPositions) {
        if (pos.marketSlug === agg.market.slug && pos.direction === agg.direction) {
          inMemoryShares += pos.shares;
        }
      }

      const difference = agg.shares - inMemoryShares;
      if (difference >= 1) {
        const positionId = `wallet:${key}:${Date.now()}`;
        unpairedPositions.set(positionId, {
          id: positionId,
          asset: agg.asset,
          direction: agg.direction,
          marketSlug: agg.market.slug,
          tokenId,
          shares: difference,
          entryPrice: avgPrice,
          totalCost: difference * avgPrice,
          entryTime: Date.now() - 30_000,  // Assume old position
          orderId: `wallet-${positionId}`,
        });

        loadedCount++;
        if (!quiet) {
          log(`   📋 UNPAIRED from wallet: ${agg.asset} ${agg.direction} ${difference.toFixed(0)} sh @ ${(avgPrice * 100).toFixed(1)}¢`);
        }
      }
    }

    if (!quiet) {
      log(`✅ Wallet sync: ${loadedCount} unpaired, ${pairedPositions.size} paired positions`);
    }
  } catch (err) {
    if (!quiet) logError('Failed to load existing positions', err);
  } finally {
    positionSyncInFlight = false;
  }
}

// ============================================
// LOAD POSITIONS FROM DATABASE (v29_positions table)
// ============================================

async function loadPositionsFromDb(): Promise<void> {
  log('💾 Loading positions from database...');
  
  let dbPositionsLoaded = 0;
  
  for (const [asset, market] of markets) {
    try {
      const dbPositions = await getAllPositionsForMarket(market.slug);
      
      if (dbPositions.length === 0) continue;
      
      for (const dbPos of dbPositions) {
        // Skip if already hedged (paired)
        if (dbPos.isFullyHedged) {
          // This is a paired position - add to pairedPositions
          const oppositeDbPos = dbPositions.find(
            p => p.marketSlug === dbPos.marketSlug && p.side !== dbPos.side
          );
          
          if (oppositeDbPos) {
            const pairedShares = Math.min(dbPos.totalShares, oppositeDbPos.totalShares);
            if (pairedShares >= 1) {
              const upPos = dbPos.side === 'UP' ? dbPos : oppositeDbPos;
              const downPos = dbPos.side === 'DOWN' ? dbPos : oppositeDbPos;
              
              const pairId = `db-pair:${asset}:${dbPos.id}`;
              if (!pairedPositions.has(pairId)) {
                const combinedCost = upPos.avgEntryPrice + downPos.avgEntryPrice;
                pairedPositions.set(pairId, {
                  id: pairId,
                  asset,
                  marketSlug: market.slug,
                  upTokenId: market.upTokenId,
                  downTokenId: market.downTokenId,
                  shares: pairedShares,
                  upEntryPrice: upPos.avgEntryPrice,
                  downEntryPrice: downPos.avgEntryPrice,
                  combinedCost,
                  lockedProfit: 1 - combinedCost,
                  pairedAt: new Date(dbPos.updatedAt).getTime(),
                });
                dbPositionsLoaded++;
                log(`   🔗 DB PAIRED: ${asset} ${pairedShares.toFixed(0)} sh`, 'db', asset);
              }
            }
          }
          continue;
        }
        
        // Unpaired position
        if (dbPos.totalShares < 1) continue;
        
        const direction = dbPos.side as 'UP' | 'DOWN';
        const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
        
        // Check if we already have this in memory
        let existingShares = 0;
        for (const [, pos] of unpairedPositions) {
          if (pos.marketSlug === market.slug && pos.direction === direction) {
            existingShares += pos.shares;
          }
        }
        
        const diff = dbPos.totalShares - existingShares;
        if (diff >= 1) {
          const positionId = `db:${asset}:${direction}:${dbPos.id}`;
          unpairedPositions.set(positionId, {
            id: positionId,
            asset,
            direction,
            marketSlug: market.slug,
            tokenId,
            shares: diff,
            entryPrice: dbPos.avgEntryPrice,
            totalCost: diff * dbPos.avgEntryPrice,
            entryTime: new Date(dbPos.createdAt).getTime(),
            orderId: `db-${dbPos.id}`,
          });
          dbPositionsLoaded++;
          log(`   📋 DB UNPAIRED: ${asset} ${direction} ${diff.toFixed(0)} sh @ ${(dbPos.avgEntryPrice * 100).toFixed(1)}¢`, 'db', asset);
        }
      }
    } catch (err) {
      logError(`Failed to load DB positions for ${asset}`, err);
    }
  }
  
  log(`✅ DB sync: loaded ${dbPositionsLoaded} positions from v29_positions`);
}

// ============================================
// REAL-TIME TRADE HANDLER (User Channel WebSocket)
// ============================================

function handleUserChannelTrade(event: TradeEvent): void {
  if (event.status !== 'CONFIRMED' && event.status !== 'MINED') return;
  
  const tokenId = event.asset_id;
  const side = event.side;
  const size = parseFloat(event.size) || 0;
  const price = parseFloat(event.price) || 0;
  
  if (size <= 0) return;
  
  // Find which asset/market this trade belongs to
  let matchedAsset: Asset | null = null;
  let matchedMarket: MarketInfo | null = null;
  let matchedDirection: 'UP' | 'DOWN' | null = null;
  
  for (const [asset, market] of markets) {
    if (market.upTokenId === tokenId) {
      matchedAsset = asset;
      matchedMarket = market;
      matchedDirection = 'UP';
      break;
    }
    if (market.downTokenId === tokenId) {
      matchedAsset = asset;
      matchedMarket = market;
      matchedDirection = 'DOWN';
      break;
    }
  }
  
  if (!matchedAsset || !matchedMarket || !matchedDirection) return;
  
  log(`🔔 RT Trade: ${matchedAsset} ${matchedDirection} ${side} ${size} @ ${(price * 100).toFixed(1)}¢`, 'fill', matchedAsset);
  
  if (side === 'BUY') {
    // Check if this is a pairing buy (buying opposite side)
    const oppositeDirection = matchedDirection === 'UP' ? 'DOWN' : 'UP';
    const unpairedOpposite = getUnpairedByDirection(matchedAsset, oppositeDirection);
    
    if (unpairedOpposite.length > 0) {
      // This could be a pairing buy! Let checkAndExecutePairs handle it
      log(`   ℹ️ Buy detected - pairing check will run shortly`, 'fill', matchedAsset);
    }
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

        // ONLY 15m markets
        const is15m = slug.toLowerCase().includes('-15m-');
        if (!is15m) continue;

        let startMs = new Date(m.eventStartTime || m.event_start_time || '').getTime();
        let endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();

        if (!Number.isFinite(startMs)) startMs = now;
        if (!Number.isFinite(endMs)) continue;

        if (endMs <= now - 60_000) continue;

        const earlyMs = EARLY_15M_MS;
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

        // VALIDATE token IDs
        const upTokenId = m.upTokenId;
        const downTokenId = m.downTokenId;
        
        if (!upTokenId || upTokenId.length < 70 || !/^\d+$/.test(upTokenId)) {
          log(`⚠️ ${asset} INVALID upTokenId`, 'error', asset);
          continue;
        }
        if (!downTokenId || downTokenId.length < 70 || !/^\d+$/.test(downTokenId)) {
          log(`⚠️ ${asset} INVALID downTokenId`, 'error', asset);
          continue;
        }

        const marketInfo: MarketInfo = {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId,
          downTokenId,
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

          // Fetch orderbook
          try {
            const book = await fetchMarketOrderbook(marketInfo);
            if (markets.get(asset)?.slug === slug) {
              if (book.upBestAsk !== undefined) priceState[asset].upBestAsk = book.upBestAsk;
              if (book.upBestBid !== undefined) priceState[asset].upBestBid = book.upBestBid;
              if (book.downBestAsk !== undefined) priceState[asset].downBestAsk = book.downBestAsk;
              if (book.downBestBid !== undefined) priceState[asset].downBestBid = book.downBestBid;
              log(`📖 ${asset} orderbook ready`, 'market', asset);
            }
          } catch (err) {
            log(`⚠️ ${asset} orderbook fetch failed`, 'error', asset);
          }
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
  
  if (timeUntilEnd <= 0 || timeUntilEnd > 2 * 60 * 60 * 1000) return;
  
  const refreshIn = Math.max(timeUntilEnd - 10_000, 1_000);
  
  marketTimers[asset] = setTimeout(() => {
    log(`🔄 ${asset} market expiring → fetching next`, 'market', asset);
    void fetchMarkets();
  }, refreshIn);
}

// ============================================
// CHAINLINK PRICE HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  priceState[asset].chainlink = price;
}

// ============================================
// BINANCE PRICE HANDLER
// ============================================

function handleBinancePrice(asset: Asset, price: number, _timestamp: number): void {
  if (!isRunnerActive()) return;

  const now = Date.now();
  
  priceState[asset].binance = price;
  
  const prevPrice = lastBinancePrice[asset];
  lastBinancePrice[asset] = price;
  
  const tickDelta = prevPrice !== null ? price - prevPrice : 0;
  const state = priceState[asset];
  const market = markets.get(asset);
  const chainlinkPrice = state.chainlink;
  
  // Log tick
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
  
  if (!config.enabled) return;
  if (prevPrice === null) return;
  if (Math.abs(tickDelta) < config.tick_delta_usd) return;
  if (!market || !market.strikePrice) return;
  
  const actualPrice = chainlinkPrice ?? price;
  const priceVsStrikeDelta = actualPrice - market.strikePrice;
  
  log(`📊 ${asset} TRIGGER: tickΔ=$${tickDelta.toFixed(2)} | Δstrike=$${priceVsStrikeDelta.toFixed(0)}`);
  
  const tickDirection: 'UP' | 'DOWN' = tickDelta > 0 ? 'UP' : 'DOWN';
  
  // Cooldown
  const cooldownKey = `${asset}:${tickDirection}`;
  if (now - (lastBuyTime[cooldownKey] ?? 0) < config.order_cooldown_ms) return;
  
  // === SMART DIRECTION FILTER ===
  let allowedDirection: 'UP' | 'DOWN' | 'BOTH' = 'BOTH';
  let smartDirectionUsed = false;
  
  if (config.smart_direction_enabled && fairValueModel) {
    const secRemaining = Math.max(0, (market.endTime.getTime() - now) / 1000);
    const fairValue = fairValueModel.getFairP(asset, priceVsStrikeDelta, secRemaining);
    
    if (fairValue.samples >= config.smart_direction_min_samples) {
      smartDirectionUsed = true;
      
      if (fairValue.p_up >= config.smart_direction_threshold) {
        allowedDirection = 'UP';
        log(`🧠 SMART: P(UP)=${(fairValue.p_up * 100).toFixed(0)}% → only UP`);
      } else if (fairValue.p_down >= config.smart_direction_threshold) {
        allowedDirection = 'DOWN';
        log(`🧠 SMART: P(DOWN)=${(fairValue.p_down * 100).toFixed(0)}% → only DOWN`);
      }
    }
  }
  
  // Fallback
  if (!smartDirectionUsed) {
    if (priceVsStrikeDelta > config.delta_threshold) {
      allowedDirection = 'UP';
    } else if (priceVsStrikeDelta < -config.delta_threshold) {
      allowedDirection = 'DOWN';
    }
  }
  
  if (allowedDirection !== 'BOTH' && allowedDirection !== tickDirection) {
    log(`⚠️ ${asset} ${tickDirection} blocked | only ${allowedDirection} allowed`);
    return;
  }
  
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
  
  log(`🎯 TRIGGER: ${asset} ${tickDirection}`, 'signal', asset);
  
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
  if (!isRunnerActive()) {
    log(`🛑 BLOCKED: Buy attempt - runner no longer active`);
    return;
  }

  const signalTs = Date.now();
  const signalBucket = Math.floor(signalTs / 1000);
  const dedupKey = `${asset}-${direction}-${strikeActualDelta.toFixed(2)}-${signalBucket}`;
  
  // Get orderbook
  const state = priceState[asset];
  let bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!bestAsk || bestAsk <= 0) {
    try {
      const freshBook = await Promise.race([
        fetchMarketOrderbook(market),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300))
      ]);
      
      if (freshBook) {
        if (freshBook.upBestAsk) state.upBestAsk = freshBook.upBestAsk;
        if (freshBook.upBestBid) state.upBestBid = freshBook.upBestBid;
        if (freshBook.downBestAsk) state.downBestAsk = freshBook.downBestAsk;
        if (freshBook.downBestBid) state.downBestBid = freshBook.downBestBid;
        
        bestAsk = direction === 'UP' ? freshBook.upBestAsk ?? null : freshBook.downBestAsk ?? null;
      }
    } catch {
      // Continue with null
    }
  }
  
  if (!bestAsk || bestAsk <= 0) {
    log(`⚠️ No orderbook for ${asset} ${direction}`);
    return;
  }
  
  // Price range check
  if (bestAsk < config.min_share_price || bestAsk > config.max_share_price) {
    log(`🚫 ${asset} ${direction} ask ${(bestAsk * 100).toFixed(1)}¢ out of range`);
    return;
  }
  
  // Calculate shares with delta trap
  let shares = config.shares_per_trade;
  
  if (config.delta_trap_enabled) {
    const absDelta = Math.abs(strikeActualDelta);
    const favoredDirection: 'UP' | 'DOWN' = strikeActualDelta >= 0 ? 'UP' : 'DOWN';
    const isFavored = direction === favoredDirection;
    
    if (absDelta >= config.delta_trap_min_delta) {
      const scalingProgress = Math.min(
        (absDelta - config.delta_trap_min_delta) / 
        (config.delta_trap_full_scale_delta - config.delta_trap_min_delta),
        1.0
      );
      
      if (isFavored) {
        const multiplier = 1.0 + scalingProgress * (config.delta_trap_max_multiplier - 1.0);
        shares = Math.max(5, Math.round(config.shares_per_trade * multiplier));
        log(`🎯 DELTA TRAP: ${asset} ${direction} FAVORED | ${multiplier.toFixed(2)}x → ${shares} shares`);
      } else {
        const multiplier = 1.0 - scalingProgress * (1.0 - config.delta_trap_min_multiplier);
        shares = Math.max(5, Math.round(config.shares_per_trade * multiplier));
      }
    }
  }
  
  // Check exposure limits
  const exposure = getTotalUnpairedExposure(asset);
  
  if (exposure.shares + shares > config.max_exposure_per_asset) {
    log(`🚫 ${asset} exposure limit: ${exposure.shares + shares} > ${config.max_exposure_per_asset}`);
    return;
  }
  
  if (exposure.cost + (shares * bestAsk) > config.max_cost_per_asset) {
    log(`🚫 ${asset} cost limit exceeded`);
    return;
  }
  
  // Dedup check
  if (localDedupCache.has(dedupKey)) {
    log(`🛑 DUPLICATE: ${dedupKey}`);
    return;
  }
  localDedupCache.add(dedupKey);
  setTimeout(() => localDedupCache.delete(dedupKey), 30_000);
  
  // Signal for logging
  const signal: Signal = {
    run_id: RUN_ID,
    asset,
    direction,
    binance_price: binancePrice,
    binance_delta: tickDelta,
    share_price: bestAsk,
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
    signal_key: dedupKey,
    notes: `BUY ${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)}`,
  };
  
  void saveSignal(signal).then(id => { if (id) signal.id = id; });
  
  lastBuyTime[`${asset}:${direction}`] = Date.now();
  
  const priceBuffer = config.price_buffer_cents / 100;
  const buyPrice = Math.ceil((bestAsk + priceBuffer) * 100) / 100;
  
  log(`📤 BUY: ${asset} ${direction} ${shares} @ ${(buyPrice * 100).toFixed(1)}¢`, 'order', asset);
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  
  setFillContext({ runId: RUN_ID, signalId: signal.id, marketSlug: market.slug });
  
  const orderStartTs = Date.now();
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
  clearFillContext();
  
  const fillTs = Date.now();
  const orderLatencyMs = fillTs - orderStartTs;
  
  if (!result.success) {
    signal.status = 'failed';
    signal.notes = result.error ?? 'Unknown error';
    log(`❌ FAILED: ${result.error ?? 'Unknown'} (${orderLatencyMs}ms)`);
    void saveSignal(signal);
    return;
  }
  
  const filledSize = result.filledSize ?? shares;
  const avgPrice = result.avgPrice ?? buyPrice;
  
  if (filledSize <= 0) {
    signal.status = 'no_fill';
    log(`⚠️ FOK order returned 0 shares`);
    void saveSignal(signal);
    return;
  }
  
  // Create unpaired position
  const positionId = `${RUN_ID}-${buysCount}`;
  
  const newPos: UnpairedPosition = {
    id: positionId,
    asset,
    direction,
    marketSlug: market.slug,
    tokenId,
    shares: filledSize,
    entryPrice: avgPrice,
    totalCost: filledSize * avgPrice,
    entryTime: fillTs,
    orderId: result.orderId ?? undefined,
  };
  
  unpairedPositions.set(positionId, newPos);
  buysCount++;
  
  signal.status = 'filled';
  signal.entry_price = avgPrice;
  signal.shares = filledSize;
  signal.fill_ts = fillTs;
  signal.notes = `BOUGHT ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (${orderLatencyMs}ms) - awaiting pair`;
  
  log(`✅ BOUGHT: ${asset} ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ (${orderLatencyMs}ms) - UNPAIRED`, 'fill', asset);
  
  void saveSignal(signal);
  
  // 🔥 PERSIST TO DATABASE - write position to v29_positions table
  try {
    const persisted = await upsertAggregatePosition(
      RUN_ID,
      asset,
      direction,
      market.slug,
      tokenId,
      filledSize,
      filledSize * avgPrice
    );
    if (persisted) {
      log(`💾 DB: Persisted ${asset} ${direction} ${filledSize}sh to v29_positions`, 'db', asset);
    }
  } catch (dbErr) {
    logError(`Failed to persist position to DB`, dbErr);
  }
}

// ============================================
// PAIRING CHECK - BUY OPPOSITE SIDE TO LOCK PROFIT
// ============================================

async function checkAndExecutePairs(): Promise<void> {
  if (!isRunnerActive()) return;
  if (!config.enabled) return;
  if (unpairedPositions.size === 0) return;
  
  const now = Date.now();
  
  // Group unpaired positions by asset + direction
  const byAssetDirection = new Map<string, UnpairedPosition[]>();
  
  for (const pos of unpairedPositions.values()) {
    const key = `${pos.asset}:${pos.direction}`;
    const list = byAssetDirection.get(key) ?? [];
    list.push(pos);
    byAssetDirection.set(key, list);
  }
  
  // For each group, check if we can pair
  for (const [key, positions] of byAssetDirection) {
    const [assetStr, directionStr] = key.split(':');
    const asset = assetStr as Asset;
    const direction = directionStr as 'UP' | 'DOWN';
    const oppositeDirection: 'UP' | 'DOWN' = direction === 'UP' ? 'DOWN' : 'UP';
    
    const market = markets.get(asset);
    if (!market || market.slug !== positions[0].marketSlug) continue;
    
    const state = priceState[asset];
    
    // Get best ask for opposite side
    const oppositeAsk = oppositeDirection === 'UP' ? state.upBestAsk : state.downBestAsk;
    if (!oppositeAsk || oppositeAsk <= 0) continue;
    
    // Calculate weighted average entry price for our side
    const totalShares = positions.reduce((sum, p) => sum + p.shares, 0);
    const totalCost = positions.reduce((sum, p) => sum + p.totalCost, 0);
    const avgEntryPrice = totalCost / totalShares;
    
    // Combined price if we pair now
    const combinedPrice = avgEntryPrice + oppositeAsk + (config.price_buffer_cents / 100);
    const profitPerShare = 1 - combinedPrice;
    const profitCents = profitPerShare * 100;
    
    // Check if oldest position is past force-pair threshold
    const oldestEntry = Math.min(...positions.map(p => p.entryTime));
    const ageSec = (now - oldestEntry) / 1000;
    const isForceMode = ageSec >= config.force_pair_after_sec;
    
    const minProfit = isForceMode ? config.min_force_pair_profit_cents : config.min_pair_profit_cents;
    
    if (profitCents < minProfit) {
      // Not profitable enough to pair
      if (isForceMode && profitCents > 0) {
        log(`⏳ ${asset} ${direction}: combined ${(combinedPrice * 100).toFixed(1)}¢ = ${profitCents.toFixed(1)}¢ profit (force mode, min ${minProfit}¢)`);
      }
      continue;
    }
    
    // Check cooldown
    const cooldownKey = `pair:${asset}`;
    if (now - (lastPairTime[cooldownKey] ?? 0) < config.order_cooldown_ms) continue;
    
    // PAIR TIME! Buy opposite side
    const oppositeTokenId = oppositeDirection === 'UP' ? market.upTokenId : market.downTokenId;
    const buyPrice = Math.ceil((oppositeAsk + config.price_buffer_cents / 100) * 100) / 100;
    
    // Buy enough shares to pair with smallest position (for simplicity, pair all)
    const sharesToPair = Math.max(5, Math.floor(totalShares));
    
    log(`🔗 PAIRING: ${asset} ${direction} → buy ${sharesToPair} ${oppositeDirection} @ ${(buyPrice * 100).toFixed(1)}¢ | combined ${(combinedPrice * 100).toFixed(1)}¢ = +${profitCents.toFixed(1)}¢/sh${isForceMode ? ' (FORCE)' : ''}`, 'pair', asset);
    
    lastPairTime[cooldownKey] = now;
    
    setFillContext({ runId: RUN_ID, marketSlug: market.slug });
    
    const result = await placeBuyOrder(oppositeTokenId, buyPrice, sharesToPair, asset, oppositeDirection);
    
    clearFillContext();
    
    if (!result.success) {
      log(`❌ PAIR FAILED: ${result.error ?? 'Unknown'}`, 'error', asset);
      continue;
    }
    
    const filledSize = result.filledSize ?? sharesToPair;
    const avgHedgePrice = result.avgPrice ?? buyPrice;
    
    if (filledSize <= 0) {
      log(`⚠️ PAIR: No fill`, 'error', asset);
      continue;
    }
    
    // Successfully paired! Create paired position and remove from unpaired
    const actualCombined = avgEntryPrice + avgHedgePrice;
    const actualProfit = 1 - actualCombined;
    
    const pairId = `${RUN_ID}-pair-${pairsCount}`;
    
    pairedPositions.set(pairId, {
      id: pairId,
      asset,
      marketSlug: market.slug,
      upTokenId: market.upTokenId,
      downTokenId: market.downTokenId,
      shares: filledSize,
      upEntryPrice: direction === 'UP' ? avgEntryPrice : avgHedgePrice,
      downEntryPrice: direction === 'DOWN' ? avgEntryPrice : avgHedgePrice,
      combinedCost: actualCombined,
      lockedProfit: actualProfit,
      pairedAt: now,
    });
    
    pairsCount++;
    totalLockedProfit += actualProfit * filledSize;
    
    // Remove paired shares from unpaired positions
    let remainingToRemove = filledSize;
    for (const pos of positions) {
      if (remainingToRemove <= 0) break;
      
      const removeAmount = Math.min(pos.shares, remainingToRemove);
      pos.shares -= removeAmount;
      pos.totalCost -= removeAmount * pos.entryPrice;
      remainingToRemove -= removeAmount;
      
      if (pos.shares < 0.5) {
        unpairedPositions.delete(pos.id);
      }
    }
    
    log(`✅ PAIRED: ${asset} ${filledSize} sh @ ${(actualCombined * 100).toFixed(1)}¢ = LOCKED +$${(actualProfit * filledSize).toFixed(3)} (+${(actualProfit * 100).toFixed(1)}¢/sh)`, 'pair', asset);
    
    // 🔥 PERSIST HEDGE TO DATABASE - update the original position with hedge info
    try {
      // First, upsert the hedge side position
      await upsertAggregatePosition(
        RUN_ID,
        asset,
        oppositeDirection,
        market.slug,
        oppositeTokenId,
        filledSize,
        filledSize * avgHedgePrice
      );
      
      // Then mark the original side as hedged
      const origPos = await import('./db.js').then(db => 
        db.getAggregatePosition(asset, direction, market.slug)
      );
      if (origPos) {
        await addHedgeToPosition(
          origPos.id,
          filledSize,
          filledSize * avgHedgePrice,
          true // is_fully_hedged
        );
        log(`💾 DB: Persisted hedge for ${asset} to v29_positions`, 'db', asset);
      }
    } catch (dbErr) {
      logError(`Failed to persist hedge to DB`, dbErr);
    }
  }
}

// ============================================
// REAL-TIME ORDERBOOK HANDLER (WebSocket)
// ============================================

function handleRealtimeOrderbook(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  bestBid: number | null,
  bestAsk: number | null,
  _timestamp: number
): void {
  const state = priceState[asset];
  
  if (direction === 'UP') {
    if (bestBid !== null) state.upBestBid = bestBid;
    if (bestAsk !== null) state.upBestAsk = bestAsk;
  } else {
    if (bestBid !== null) state.downBestBid = bestBid;
    if (bestAsk !== null) state.downBestAsk = bestAsk;
  }
  state.lastUpdate = Date.now();
  
  // Real-time pairing check when opposite ask drops
  // This is the key advantage - we react instantly to cheap opposite-side prices!
  if (bestAsk !== null && unpairedPositions.size > 0) {
    // Check if any unpaired positions on opposite side could be paired now
    const oppositeDirection = direction === 'UP' ? 'DOWN' : 'UP';
    const unpairedOpposite = getUnpairedByDirection(asset, oppositeDirection);
    
    if (unpairedOpposite.length > 0) {
      // There are positions waiting for a cheap price on THIS side - check immediately
      void checkAndExecutePairs();
    }
  }
}

// ============================================
// ORDERBOOK POLLING (FALLBACK)
// ============================================

async function pollOrderbooks(): Promise<void> {
  if (isOrderbookWsConnected()) return;
  
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
  log('🚀 V29 Pair-Instead-of-Sell Runner starting...');
  log(`📋 Run ID: ${RUN_ID}`);
  
  initDb();
  log('✅ DB initialized');
  
  const registered = await acquireLease(RUN_ID, { force: process.env.FORCE_TAKEOVER === '1' });
  if (!registered) {
    logError('❌ Failed to register runner');
    process.exit(1);
  }
  log('🔒 Registered as active runner');
  
  const vpnOk = await verifyVpnConnection();
  if (!vpnOk) {
    await releaseLease(RUN_ID);
    logError('VPN verification failed!');
    process.exit(1);
  }
  log('✅ VPN OK');
  
  try {
    await testConnection();
    log('✅ Polymarket connection OK');
  } catch (err) {
    logError('Polymarket connection failed!', err);
    process.exit(1);
  }
  
  try {
    const balance = await getBalance();
    log(`💰 Balance: $${balance.toFixed(2)}`);
  } catch (err) {
    logError('Balance check failed', err);
  }
  
  // Load config
  const loadedConfig = await loadV29Config();
  if (loadedConfig) {
    config = { ...DEFAULT_CONFIG, ...loadedConfig };
    log(`✅ Config loaded: enabled=${config.enabled}, shares=${config.shares_per_trade}`);
  }
  
  fairValueModel = getFairValueModel();
  log(`✅ Fair value model initialized`);
  
  await fetchMarkets();
  
  if (markets.size === 0) {
    logError('No markets found!');
    process.exit(1);
  }
  
  // Init pre-signed cache
  const marketsList = Array.from(markets.values()).map(m => ({
    asset: m.asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsList);
  
  // Load existing positions from database first (persisted state)
  await loadPositionsFromDb();
  
  // Then sync with wallet (real-time truth from Polymarket)
  await loadExistingPositions();

  isRunning = true;

  // Start feeds
  startBinanceFeed(config.assets, handleBinancePrice, config.binance_poll_ms);
  log('✅ Binance feed started');

  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink feed started');

  const userChannelStarted = startUserChannel(handleUserChannelTrade);
  if (userChannelStarted) {
    log('✅ User Channel started');
  }

  try {
    await startPriceFeedLogger();
    log('✅ Price Feed Logger started');
  } catch (err) {
    log(`⚠️ Price Feed Logger failed: ${(err as Error).message}`);
  }

  // Start real-time orderbook
  startOrderbookWs(handleRealtimeOrderbook);
  updateOrderbookWsMarkets(markets);
  log('✅ Real-time Orderbook WebSocket started');

  // Intervals
  const orderbookInterval = setInterval(() => void pollOrderbooks(), config.orderbook_poll_ms);
  const pairInterval = setInterval(() => void checkAndExecutePairs(), config.pair_check_ms);
  const positionSyncInterval = setInterval(() => void loadExistingPositions({ quiet: true }), 120_000);
  const marketRefreshInterval = setInterval(async () => {
    await fetchMarkets();
    updateOrderbookWsMarkets(markets);
  }, 30 * 1000);
  const configReloadInterval = setInterval(async () => {
    const newConfig = await loadV29Config();
    if (newConfig) {
      config = { ...DEFAULT_CONFIG, ...newConfig };
    }
  }, 30_000);
  const heartbeatInterval = setInterval(async () => {
    const balance = await getBalance().catch(() => 0);
    void sendHeartbeat(HEARTBEAT_ID, RUN_ID, 'trading', balance, unpairedPositions.size + pairedPositions.size, buysCount);
  }, 10_000);
  const summaryInterval = setInterval(() => {
    const summary = getPositionsSummary();
    log(`📊 ${summary} | Buys: ${buysCount} | Pairs: ${pairsCount} | Locked: +$${totalLockedProfit.toFixed(2)}`);
  }, 30_000);
  const burstStatsInterval = setInterval(() => logBurstStats(), 60_000);

  log('🎯 V29 Pair-Instead-of-Sell Runner READY');
  log(`   Strategy: Buy on tick → Wait for cheap opposite → PAIR to lock profit`);
  log(`   Pairing target: combined < ${(config.max_combined_price * 100).toFixed(0)}¢ (= ${((1 - config.max_combined_price) * 100).toFixed(0)}¢ profit)`);
  log(`   Force-pair after: ${config.force_pair_after_sec}s (accept ${config.min_force_pair_profit_cents}¢ profit)`);

  // Cleanup
  const cleanup = async () => {
    log('🛑 Shutting down...');
    isRunning = false;
    clearInterval(orderbookInterval);
    clearInterval(pairInterval);
    clearInterval(positionSyncInterval);
    clearInterval(marketRefreshInterval);
    clearInterval(configReloadInterval);
    clearInterval(heartbeatInterval);
    clearInterval(summaryInterval);
    clearInterval(burstStatsInterval);
    stopBinanceFeed();
    stopChainlinkFeed();
    stopUserChannel();
    stopPreSignedCache();
    stopOrderbookWs();
    await stopPriceFeedLogger();
    
    logBurstStats();
    await releaseLease(RUN_ID);
    log('🔓 Registration released');
    
    log(`📊 Final: Buys=${buysCount} Pairs=${pairsCount} Locked=+$${totalLockedProfit.toFixed(2)}`);
    
    process.exit(0);
  };
  
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}

main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
