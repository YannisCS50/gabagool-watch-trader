// ============================================================
// V35 RUNNER - SKIP TO NEXT MARKET
// ============================================================
// Version: V35.4.0 - "Skip to Next Market"
// 
// CRITICAL INVARIANTS:
// 1. Circuit Breaker is now MARKET-SPECIFIC (not global)
// 2. When a market is banned, bot SKIPS to next 15-minute cycle
// 3. NO manual intervention required - auto-recovery
// 4. Each 15-minute market is COMPLETELY INDEPENDENT
// 5. NO shares carry over between markets
// 6. New markets ALWAYS start at 0 shares (upQty=0, downQty=0)
//
// V35.4.0 CRITICAL FIX:
// - Circuit breaker bans ONLY the problematic market
// - Bot continues running, waits for next market cycle
// - Automatic ban clearing when markets expire
// - strategy_enabled flag is NO LONGER touched on trip
// ============================================================

import '../config.js'; // Load env first
import WebSocket from 'ws';
import os from 'os';
import { 
  getV35Config, 
  loadV35Config, 
  setV35ConfigOverrides,
  printV35Config,
  V35_VERSION,
  V35_CODENAME,
  type V35Mode 
} from './config.js';
import type { 
  V35Market, 
  V35MarketMetrics, 
  V35PortfolioMetrics,
  V35Asset,
  V35Fill,
} from './types.js';
import { createEmptyMarket, calculateMarketMetrics } from './types.js';
import { QuotingEngine } from './quoting-engine.js';
import { getV35SidePricing } from './market-pricing.js';
import { discoverMarkets, filterByAssets } from './market-discovery.js';
import { syncOrders, cancelAllOrders, updateOrderbook, reconcileOrders, cancelSideOrders } from './order-manager.js';
import { processFillWithHedge, logMarketFillStats } from './fill-tracker.js';
import { getHedgeManager, resetHedgeManager } from './hedge-manager.js';
import { getCircuitBreaker, initCircuitBreaker, resetCircuitBreaker } from './circuit-breaker.js';
import { getProactiveRebalancer, resetProactiveRebalancer } from './proactive-rebalancer.js';
import { getEmergencyRecovery, resetEmergencyRecovery, analyzeRecovery, setRecoveryConfig } from './emergency-recovery.js';
import { sendV35Heartbeat, sendV35Offline, saveV35Settlement, saveV35Fill, saveV35OrderbookSnapshots, saveV35InventorySnapshot, type V35InventorySnapshot } from './backend.js';
import type { V35OrderbookSnapshot } from './types.js';
import { ensureValidCredentials, getBalance, getOpenOrders } from '../polymarket.js';
import { checkVpnRequired } from '../vpn-check.js';
import { acquireLeaseOrHalt, releaseLease, renewLease } from '../runner-lease.js';
import { setRunnerIdentity } from '../order-guard.js';
import { startBinanceFeed, stopBinanceFeed, getBinanceFeed } from './binance-feed.js';
import { startUserWebSocket, stopUserWebSocket, setTokenToMarketMap, isUserWsConnected, clearOrderIds, getOrderTrackingStats, registerOurOrderIds } from './user-ws.js';
// CRITICAL: Position cache for real-time position sync from Polymarket API
import { 
  startPositionCache, 
  stopPositionCache, 
  getCachedPosition, 
  forceRefresh as refreshPositionCache,
  registerMarketForCache,
  unregisterMarketFromCache,
} from '../position-cache.js';

// ============================================================
// CONSTANTS
// ============================================================

const VERSION = V35_VERSION;
const RUNNER_ID = process.env.RUNNER_ID || `v35-${os.hostname()}`;
const RUN_ID = `v35_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ============================================================
// STATE
// ============================================================

const markets = new Map<string, V35Market>();
const tokenToMarket = new Map<string, { slug: string; side: 'UP' | 'DOWN' }>();
let quotingEngine: QuotingEngine;
let running = false;
let paused = false;
let balance = 0;
let clobSocket: WebSocket | null = null;

// Orderbook snapshot buffer (batched logging)
const orderbookBuffer: V35OrderbookSnapshot[] = [];
const ORDERBOOK_LOG_INTERVAL_MS = 5000; // Flush every 5 seconds
const MAX_ORDERBOOK_BUFFER = 100; // Max before force flush

// Order reconciliation timing
let lastReconcileTime = 0;
const RECONCILE_INTERVAL_MS = 30_000; // Reconcile with Polymarket API every 30s

// ============================================================
// LOGGING HELPERS
// ============================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string, err?: any): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ❌ ${msg}`, err?.message || err || '');
}

// ============================================================
// ORDERBOOK SNAPSHOT LOGGING
// ============================================================

function queueOrderbookSnapshot(market: V35Market): void {
  const now = Date.now();
  const secondsToExpiry = Math.max(0, (market.expiry.getTime() - now) / 1000);
  
  // Calculate combined metrics
  const combinedAsk = (market.upBestAsk > 0 && market.downBestAsk > 0)
    ? market.upBestAsk + market.downBestAsk
    : null;
  const combinedMid = (market.upBestBid > 0 && market.downBestBid > 0 && 
                       market.upBestAsk > 0 && market.downBestAsk > 0)
    ? ((market.upBestBid + market.upBestAsk) / 2 + (market.downBestBid + market.downBestAsk) / 2)
    : null;
  const edge = combinedAsk && combinedAsk < 1.0 ? 1.0 - combinedAsk : null;
  
  const snapshot: V35OrderbookSnapshot = {
    ts: now,
    marketSlug: market.slug,
    asset: market.asset,
    upBestBid: market.upBestBid || null,
    upBestAsk: market.upBestAsk || null,
    downBestBid: market.downBestBid || null,
    downBestAsk: market.downBestAsk || null,
    combinedAsk,
    combinedMid,
    edge,
    // Full depth: we store top 5 levels from tracked orders as proxy
    // In production, CLOB WebSocket should provide full book
    upBids: [],
    upAsks: [],
    downBids: [],
    downAsks: [],
    spotPrice: null, // TODO: integrate Chainlink feed
    strikePrice: null, // TODO: parse from market slug
    secondsToExpiry: Math.round(secondsToExpiry),
  };
  
  orderbookBuffer.push(snapshot);
  
  // Force flush if buffer is full
  if (orderbookBuffer.length >= MAX_ORDERBOOK_BUFFER) {
    flushOrderbookBuffer().catch(err => logError('Force flush failed:', err));
  }
}

async function flushOrderbookBuffer(): Promise<void> {
  if (orderbookBuffer.length === 0) return;
  
  const snapshots = [...orderbookBuffer];
  orderbookBuffer.length = 0; // Clear buffer
  
  const success = await saveV35OrderbookSnapshots(snapshots);
  if (success) {
    log(`📊 Flushed ${snapshots.length} orderbook snapshots`);
  }
}

// ============================================================
// WEBSOCKET MANAGEMENT
// ============================================================

function buildTokenMap(): void {
  tokenToMarket.clear();
  for (const market of markets.values()) {
    tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'UP' });
    tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'DOWN' });
  }
  
  // Also update the User WebSocket token map for fill tracking
  const userWsMap = new Map<string, { slug: string; side: 'UP' | 'DOWN'; asset: string }>();
  for (const market of markets.values()) {
    userWsMap.set(market.upTokenId, { slug: market.slug, side: 'UP', asset: market.asset });
    userWsMap.set(market.downTokenId, { slug: market.slug, side: 'DOWN', asset: market.asset });
  }
  setTokenToMarketMap(userWsMap);
}

function connectToClob(): void {
  const tokenIds = Array.from(tokenToMarket.keys());
  if (tokenIds.length === 0) {
    log('⚠️ No tokens to subscribe');
    return;
  }

  log(`🔌 Connecting to CLOB with ${tokenIds.length} tokens...`);
  // IMPORTANT:
  // Use a local socket reference inside event handlers.
  // Otherwise, if connectToClob() is called again while the previous socket is still CONNECTING,
  // the previous socket's 'open' handler may fire but attempt to send on the NEW global clobSocket
  // (still CONNECTING) -> "WebSocket is not open: readyState 0".
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  clobSocket = ws;

  ws.on('open', () => {
    // Ignore stale sockets
    if (ws !== clobSocket) {
      try { ws.close(); } catch {}
      return;
    }

    log('✅ Connected to Polymarket CLOB WebSocket');
    try {
      ws.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
    } catch (err) {
      logError('CLOB subscribe send failed:', err);
    }
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString());
      processWsEvent(event);
    } catch {}
  });

  ws.on('error', (error) => {
    logError('CLOB WebSocket error:', error);
  });

  ws.on('close', () => {
    // Only the currently-active socket should trigger reconnect logic
    if (ws !== clobSocket) return;

    log('🔌 CLOB disconnected, reconnecting in 5s...');
    setTimeout(() => {
      if (running) connectToClob();
    }, 5000);
  });
}

function processWsEvent(data: any): void {
  const eventType = data.event_type;

  if (eventType === 'book') {
    const assetId = data.asset_id;
    const marketInfo = tokenToMarket.get(assetId);
    if (!marketInfo) return;

    const market = markets.get(marketInfo.slug);
    if (!market) return;

    const asks = (data.asks || []) as any[];
    const bids = (data.bids || []) as any[];

    const parsePrice = (level: any): number | null => {
      const raw = Array.isArray(level) ? level[0] : level?.price;
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    };

    let bestBid: number | null = null;
    let bestAsk: number | null = null;

    for (const level of bids) {
      const p = parsePrice(level);
      if (p !== null && (bestBid === null || p > bestBid)) bestBid = p;
    }
    for (const level of asks) {
      const p = parsePrice(level);
      if (p !== null && (bestAsk === null || p < bestAsk)) bestAsk = p;
    }

    if (marketInfo.side === 'UP') {
      if (bestBid !== null) market.upBestBid = bestBid;
      if (bestAsk !== null) market.upBestAsk = bestAsk;
    } else {
      if (bestBid !== null) market.downBestBid = bestBid;
      if (bestAsk !== null) market.downBestAsk = bestAsk;
    }
    market.lastUpdated = new Date();
  }

  // IMPORTANT: Do NOT infer fills from the public market WebSocket.
  // We persist fills exclusively from the authenticated User WebSocket to prevent
  // double-counting (same fill arriving via multiple channels) and DB duplication.
  //
  // The public feed can still be useful for generic market telemetry, but it should
  // not drive our own fill/inventory accounting.
}

// ============================================================
// FILL HANDLER (from User WebSocket) - WITH ACTIVE HEDGING
// ============================================================

/**
 * Handle fills received from the authenticated User WebSocket
 * TRIGGERS ACTIVE HEDGE via HedgeManager
 * V35.3.1: Also logs inventory snapshots after each fill cycle
 */
async function handleFillFromUserWs(fill: V35Fill): Promise<void> {
  const market = markets.get(fill.marketSlug);
  if (!market) {
    log(`⚠️ Fill for unknown market: ${fill.marketSlug}`);
    return;
  }

  log(`🎯 [UserWS] FILL: ${fill.side} ${fill.size.toFixed(0)} @ $${fill.price.toFixed(2)} in ${fill.marketSlug.slice(-25)}`);
  
  // Process fill WITH active hedging
  const { processed, hedgeResult } = await processFillWithHedge(fill, market);
  
  if (processed) {
    // Persist original fill to database
    saveV35Fill(fill).catch(err => {
      logError('Failed to save fill:', err);
    });
    
    // If hedge was successful, also persist the hedge fill
    if (hedgeResult?.hedged && hedgeResult.filledQty && hedgeResult.avgPrice) {
      const hedgeSide = fill.side === 'UP' ? 'DOWN' : 'UP';
      const hedgeFill: V35Fill = {
        orderId: `HEDGE_${fill.orderId}`,
        tokenId: hedgeSide === 'UP' ? market.upTokenId : market.downTokenId,
        side: hedgeSide,
        price: hedgeResult.avgPrice,
        size: hedgeResult.filledQty,
        timestamp: new Date(),
        marketSlug: market.slug,
        asset: market.asset,
      };
      saveV35Fill(hedgeFill).catch(err => {
        logError('Failed to save hedge fill:', err);
      });
    }
    
    // Remove the filled order from our tracking (if we know about it)
    const currentOrders = fill.side === 'UP' ? market.upOrders : market.downOrders;
    if (fill.orderId && currentOrders.has(fill.orderId)) {
      currentOrders.delete(fill.orderId);
    }
    
    // V35.3.1: Log inventory snapshot after each fill cycle
    const unpaired = Math.abs(market.upQty - market.downQty);
    const paired = Math.min(market.upQty, market.downQty);
    const avgUp = market.upQty > 0 ? market.upCost / market.upQty : null;
    const avgDown = market.downQty > 0 ? market.downCost / market.downQty : null;
    const pairCost = (avgUp !== null && avgDown !== null) ? avgUp + avgDown : null;
    
    // Determine state based on imbalance
    let state: 'BALANCED' | 'WARNING' | 'CRITICAL' = 'BALANCED';
    if (unpaired >= 35) state = 'CRITICAL';
    else if (unpaired >= 20) state = 'WARNING';
    
    const snapshot: V35InventorySnapshot = {
      marketSlug: market.slug,
      asset: market.asset,
      upShares: market.upQty,
      downShares: market.downQty,
      avgUpCost: avgUp,
      avgDownCost: avgDown,
      pairedShares: paired,
      unpairedShares: unpaired,
      unpairedNotionalUsd: unpaired * 0.50, // Rough estimate at midpoint
      pairCost,
      state,
      triggerType: hedgeResult?.hedged ? 'HEDGE' : 'FILL',
    };
    
    saveV35InventorySnapshot(snapshot).catch(err => {
      logError('Failed to save inventory snapshot:', err);
    });
  }
}

// ============================================================
// MARKET MANAGEMENT
// ============================================================

async function refreshMarkets(): Promise<void> {
  const config = getV35Config();
  
  // Check if we have room for more markets
  if (markets.size >= config.maxMarkets) {
    log(`📊 At max markets (${markets.size}/${config.maxMarkets})`);
    return;
  }
  
  // Discover new markets - use stopBeforeExpirySec directly (no extra margin)
  // The market processing loop will handle the stop-before-expiry logic
  const minExpiry = config.stopBeforeExpirySec;
  log(`🔍 Searching for markets with >= ${minExpiry}s to expiry...`);
  const discovered = await discoverMarkets(minExpiry);
  log(`📋 Discovery returned ${discovered.length} markets`);
  
  const assets: V35Asset[] = ['BTC']; // Only BTC allowed
  const filtered = filterByAssets(discovered, assets);
  log(`🎯 After BTC filter: ${filtered.length} markets`);
  
  if (filtered.length === 0) {
    log(`⚠️ No BTC markets found! Available assets: ${discovered.map(m => m.asset).join(', ')}`);
  }
  
  let added = 0;
  // Add new markets (up to max)
  for (const m of filtered) {
    if (markets.size >= config.maxMarkets) {
      log(`📊 Skipping ${m.slug}: at max markets`);
      break;
    }
    if (markets.has(m.slug)) {
      log(`📊 Skipping ${m.slug}: already tracked`);
      continue;
    }
    
    const market = createEmptyMarket(
      m.slug,
      m.conditionId,
      m.upTokenId,
      m.downTokenId,
      m.asset,
      m.expiry
    );
    
    // CRITICAL: Register market with position cache for real-time position tracking
    registerMarketForCache(m.slug, m.conditionId, m.upTokenId, m.downTokenId);
    
    // CRITICAL V35.1.2: Check if we have PRE-EXISTING positions in this market
    // This happens when runner restarts mid-market
    const existingPos = getCachedPosition(m.slug);
    if (existingPos) {
      const existingImbalance = Math.abs(existingPos.upShares - existingPos.downShares);
      if (existingImbalance >= config.maxUnpairedShares) {
        log(`🚨 REFUSING TO TRADE ${m.slug}: Pre-existing imbalance of ${existingImbalance.toFixed(1)} shares > max ${config.maxUnpairedShares}`);
        log(`   UP: ${existingPos.upShares.toFixed(1)}, DOWN: ${existingPos.downShares.toFixed(1)}`);
        log(`   ⚠️ Close this position manually before the bot will trade this market`);
        continue; // Skip this market entirely
      }
      // Sync existing positions to internal state
      market.upQty = existingPos.upShares;
      market.downQty = existingPos.downShares;
      market.upCost = existingPos.upCost;
      market.downCost = existingPos.downCost;
      log(`📊 Synced existing position for ${m.slug}: UP=${existingPos.upShares.toFixed(1)} DOWN=${existingPos.downShares.toFixed(1)}`);
    }
    
    markets.set(m.slug, market);
    log(`➕ Added market: ${m.slug} (${m.asset}, expires ${m.expiry.toISOString()})`);
    added++;
  }
  
  // Rebuild token map and reconnect if new markets were added
  if (added > 0) {
    buildTokenMap();

    // IMPORTANT: On restarts we lose local order maps, but remote open orders may still exist.
    // Reconcile immediately after adding markets so syncOrders doesn't place duplicates.
    if (!config.dryRun) {
      try {
        log('🔄 Reconcile after market discovery (prevent order stacking)...');
        const { cleaned, added: remoteAdded } = await reconcileOrders(markets, config.dryRun);
        lastReconcileTime = Date.now();
        if (cleaned > 0 || remoteAdded > 0) {
          log(`🔄 Discovery reconcile: cleaned=${cleaned} added=${remoteAdded}`);
        }
      } catch (err: any) {
        logError('Discovery reconcile failed (will retry in main loop):', err);
      }
    }

    // Reconnect WS with new tokens
    if (clobSocket) {
      clobSocket.close();
    }
    connectToClob();
  }
}

function cleanupExpiredMarkets(): void {
  const now = Date.now();
  const circuitBreaker = getCircuitBreaker();
  let removed = 0;
  
  for (const [slug, market] of markets.entries()) {
    if (market.expiry.getTime() < now) {
      // Market expired - log settlement
      const metrics = calculateMarketMetrics(market);
      
      log(`🏁 SETTLED ${slug.slice(-35)}`);
      log(`   Paired: ${metrics.paired.toFixed(0)} | Combined: $${metrics.combinedCost.toFixed(3)} | Locked: $${metrics.lockedProfit.toFixed(2)}`);
      
      // V35.4.0: Clear any ban for this market (it's expired, we'll get a new one)
      circuitBreaker.clearMarketBan(slug);
      
      // Determine winning side (we don't know actual outcome, so log as unknown)
      saveV35Settlement({
        marketSlug: slug,
        asset: market.asset,
        upQty: market.upQty,
        downQty: market.downQty,
        upCost: market.upCost,
        downCost: market.downCost,
        paired: metrics.paired,
        unpaired: metrics.unpaired,
        combinedCost: metrics.combinedCost,
        lockedProfit: metrics.lockedProfit,
        winningSide: null, // Unknown at expiry time
        pnl: metrics.lockedProfit, // Best estimate
      }).catch(() => {});
      
      // Remove from token map
      tokenToMarket.delete(market.upTokenId);
      tokenToMarket.delete(market.downTokenId);
      
      // CRITICAL: Unregister from position cache
      unregisterMarketFromCache(market.conditionId, market.upTokenId, market.downTokenId);
      
      markets.delete(slug);
      removed++;
    }
  }
  
  if (removed > 0) {
    log(`🗑️ Removed ${removed} expired markets`);
    
    // V35.4.0: Check if circuit breaker can be fully reset (no more banned markets)
    const bannedMarkets = circuitBreaker.getBannedMarkets();
    if (bannedMarkets.length === 0 && circuitBreaker.isTripped()) {
      log(`✅ All banned markets expired - circuit breaker auto-reset`);
      circuitBreaker.reset();
    }
  }
}

// ============================================================
// MARKET PROCESSING - V35.3.0 CIRCUIT BREAKER INTEGRATED
// ============================================================

async function processMarket(market: V35Market): Promise<void> {
  const config = getV35Config();
  const circuitBreaker = getCircuitBreaker();
  const now = Date.now();
  const secondsToExpiry = (market.expiry.getTime() - now) / 1000;
  
  // =========================================================================
  // V35.4.0: CHECK IF THIS SPECIFIC MARKET IS BANNED
  // =========================================================================
  // If this market is banned, skip it and wait for next cycle
  // Other markets can still trade normally
  // =========================================================================
  if (circuitBreaker.isMarketBanned(market.slug)) {
    log(`⏭️ SKIPPING banned market: ${market.slug.slice(-25)}`);
    log(`   → Waiting for market to expire, then next cycle starts fresh`);
    await cancelAllOrders(market, config.dryRun);
    return;
  }
  
  // =========================================================================
  // CONSERVATIVE POSITION SYNC (preserved from V35.2.0)
  // =========================================================================
  const cachedPos = getCachedPosition(market.slug);
  if (cachedPos) {
    const localUp = market.upQty;
    const localDown = market.downQty;
    const apiUp = cachedPos.upShares;
    const apiDown = cachedPos.downShares;
    
    // Log drift for debugging
    if (Math.abs(localUp - apiUp) > 1 || Math.abs(localDown - apiDown) > 1) {
      log(`⚠️ POSITION DRIFT: Local (UP=${localUp.toFixed(0)} DOWN=${localDown.toFixed(0)}) vs API (UP=${apiUp.toFixed(0)} DOWN=${apiDown.toFixed(0)})`);
      log(`   → Using CONSERVATIVE max`);
    }
    
    // Only UPDATE if API is HIGHER (we learned about fills we missed)
    if (apiUp > localUp) {
      market.upQty = apiUp;
      market.upCost = cachedPos.upCost;
      log(`📈 API shows more UP shares than local: ${localUp.toFixed(0)} → ${apiUp.toFixed(0)}`);
    }
    if (apiDown > localDown) {
      market.downQty = apiDown;
      market.downCost = cachedPos.downCost;
      log(`📈 API shows more DOWN shares than local: ${localDown.toFixed(0)} → ${apiDown.toFixed(0)}`);
    }
  }
  
  // =========================================================================
  // V35.3.0: CIRCUIT BREAKER SAFETY CHECK
  // =========================================================================
  // This is the AUTHORITATIVE safety check. All limits are enforced here.
  // V35.3.8 FIX: Even when tripped, allow PROACTIVE HEDGING to reduce imbalance!
  // =========================================================================
  const safetyCheck = await circuitBreaker.checkMarket(market, config.dryRun);
  
  // Stop quoting if too close to expiry
  if (secondsToExpiry < config.stopBeforeExpirySec) {
    log(`⏱️ ${market.slug.slice(-25)}: STOP (${secondsToExpiry.toFixed(0)}s to expiry)`);
    await cancelAllOrders(market, config.dryRun);
    return;
  }
  
  // =========================================================================
  // V35.3.8: PROACTIVE REBALANCER - RUNS EVEN WHEN CIRCUIT BREAKER IS TRIPPED
  // =========================================================================
  // This is CRITICAL: when the circuit breaker trips due to imbalance, the ONLY
  // way to reduce that imbalance is to BUY on the lagging side. The proactive
  // rebalancer does exactly that - it hedges the unbalanced position.
  // =========================================================================
  const rebalancer = getProactiveRebalancer();
  const rebalanceResult = await rebalancer.checkAndRebalance(market);
  
  if (rebalanceResult.attempted && rebalanceResult.hedged) {
    log(`🔄 PROACTIVE HEDGE: ${rebalanceResult.hedgeQty?.toFixed(0)} ${rebalanceResult.hedgeSide} @ $${rebalanceResult.hedgePrice?.toFixed(3)}`);
    // Update local position if we executed a hedge
    if (rebalanceResult.hedgeSide === 'UP') {
      market.upQty += rebalanceResult.hedgeQty || 0;
      market.upCost += (rebalanceResult.hedgeQty || 0) * (rebalanceResult.hedgePrice || 0);
    } else if (rebalanceResult.hedgeSide === 'DOWN') {
      market.downQty += rebalanceResult.hedgeQty || 0;
      market.downCost += (rebalanceResult.hedgeQty || 0) * (rebalanceResult.hedgePrice || 0);
    }
    // Re-check circuit breaker after hedging to see if we've recovered
    const recheckSafety = await circuitBreaker.checkMarket(market, config.dryRun);
    if (!recheckSafety.shouldStop && safetyCheck.shouldStop) {
      log(`✅ CIRCUIT BREAKER RECOVERED after proactive hedge!`);
    }
  }
  
  // =========================================================================
  // V35.5.0: EMERGENCY RECOVERY MODE - MINIMIZE LOSS WHEN PROFITABLE HEDGE ISN'T POSSIBLE
  // =========================================================================
  // If proactive rebalancer couldn't hedge (combined cost would be > $1.00),
  // check if we should still recover to MINIMIZE MAX LOSS.
  // This buys on the losing side even at a loss to lock in a smaller guaranteed loss.
  // =========================================================================
  const unpaired = Math.abs(market.upQty - market.downQty);
  if (!rebalanceResult.hedged && unpaired >= 20) { // Only when significantly imbalanced
    const emergencyRecovery = getEmergencyRecovery();
    const recoveryResult = await emergencyRecovery.checkAndRecover(market);
    
    if (recoveryResult.attempted) {
      if (recoveryResult.success) {
        log(`🚨 EMERGENCY RECOVERY executed: ${recoveryResult.analysis?.sharesToBuy.toFixed(0)} shares bought`);
        log(`   Max loss reduced by: $${(-(recoveryResult.analysis?.lossReduction || 0)).toFixed(2)}`);
        // Update local position
        const trailingSide = recoveryResult.analysis?.leadingSide === 'UP' ? 'DOWN' : 'UP';
        if (trailingSide === 'UP') {
          market.upQty += recoveryResult.filledQty || 0;
          market.upCost += (recoveryResult.filledQty || 0) * (recoveryResult.analysis?.buyPrice || 0);
        } else {
          market.downQty += recoveryResult.filledQty || 0;
          market.downCost += (recoveryResult.filledQty || 0) * (recoveryResult.analysis?.buyPrice || 0);
        }
      } else if (recoveryResult.analysis) {
        log(`⏳ Emergency recovery analyzed: ${recoveryResult.reason}`);
        log(`   Current max loss: $${recoveryResult.analysis.currentMaxLoss.toFixed(2)}`);
        log(`   Would lock in: $${recoveryResult.analysis.lockedLossAfterRecovery.toFixed(2)}`);
      }
    }
  }
  
  // NOW check if circuit breaker should halt further processing (new quotes)
  if (safetyCheck.shouldStop && !rebalanceResult.hedged) {
    log(`🚨 ${market.slug.slice(-25)}: CIRCUIT BREAKER HALT - ${safetyCheck.reason}`);
    log(`   💡 Proactive rebalancer checked - hedge not yet viable`);
    return; // Do not place new quotes, but we tried to hedge
  }
  
  // Update orderbook
  await updateOrderbook(market, config.dryRun);
  
  // Queue orderbook snapshot for logging
  queueOrderbookSnapshot(market);
  
  // Note: Proactive rebalancer was already called above (before circuit breaker check)
  
  // Calculate metrics
  const metrics = calculateMarketMetrics(market);
  
  // Log status
  const ratio = (metrics.upQty > 0 && metrics.downQty > 0)
    ? (metrics.upQty > metrics.downQty ? metrics.upQty / metrics.downQty : metrics.downQty / metrics.upQty)
    : 0;
  const ratioWarn = ratio > config.maxImbalanceRatio ? ` 🔴RATIO:${ratio.toFixed(1)}:1` : '';
  
  // Get momentum state for this asset
  const binanceFeed = getBinanceFeed();
  const momentum = binanceFeed.getMomentum(market.asset);
  const trend = binanceFeed.getTrendDirection(market.asset);
  const trendIndicator = trend === 'UP' ? '📈' : trend === 'DOWN' ? '📉' : '➡️';
  
  log(
    `📊 ${market.slug.slice(-25)} | ` +
    `UP:${metrics.upQty.toFixed(0)} DOWN:${metrics.downQty.toFixed(0)} | ` +
    `Cost:$${(metrics.upCost + metrics.downCost).toFixed(0)} | ` +
    `CPP:$${metrics.combinedCost.toFixed(3)} | ` +
    `${trendIndicator}${momentum.toFixed(2)}%${ratioWarn}`
  );
  
  // Sync orders if not paused
  if (!paused) {
    // =========================================================================
    // V35.3.0: Use circuit breaker decision for quote blocking
    // =========================================================================
    const allowUpQuotes = !safetyCheck.shouldBlockUp;
    const allowDownQuotes = !safetyCheck.shouldBlockDown;
    
    if (safetyCheck.reason) {
      log(`   🛡️ Safety: ${safetyCheck.reason} | UP=${allowUpQuotes ? '✅' : '🚫'} DOWN=${allowDownQuotes ? '✅' : '🚫'}`);
    }
    
    // Generate quotes only for allowed sides
    const upQuotes = allowUpQuotes ? quotingEngine.generateQuotes('UP', market) : [];
    const downQuotes = allowDownQuotes ? quotingEngine.generateQuotes('DOWN', market) : [];
    
    // Debug: log quote generation
    const imbalance = Math.abs(market.upQty - market.downQty);
    if ((upQuotes.length === 0 && allowUpQuotes) || (downQuotes.length === 0 && allowDownQuotes)) {
      log(`⚠️ Quote generation: UP=${upQuotes.length}${allowUpQuotes ? '' : '(blocked)'} DOWN=${downQuotes.length}${allowDownQuotes ? '' : '(blocked)'}`);
      log(`   bestAsk: UP=$${market.upBestAsk?.toFixed(2)} DOWN=$${market.downBestAsk?.toFixed(2)}`);
      log(`   inventory: UP=${market.upQty} DOWN=${market.downQty} (imbalance=${imbalance.toFixed(0)})`);
    }
    
    const upResult = await syncOrders(market, 'UP', upQuotes, config.dryRun);
    const downResult = await syncOrders(market, 'DOWN', downQuotes, config.dryRun);
    
    if (upResult.placed > 0 || downResult.placed > 0) {
      log(`📝 Orders placed: UP=${upResult.placed} DOWN=${downResult.placed}`);
    }
  }
}

// ============================================================
// PORTFOLIO SUMMARY
// ============================================================

function getPortfolioMetrics(): V35PortfolioMetrics {
  const config = getV35Config();
  
  let totalUpQty = 0;
  let totalDownQty = 0;
  let totalCost = 0;
  let totalPaired = 0;
  let totalUnpaired = 0;
  let totalLockedProfit = 0;
  let marketsAtLimit = 0;
  
  for (const market of markets.values()) {
    const metrics = calculateMarketMetrics(market);
    totalUpQty += metrics.upQty;
    totalDownQty += metrics.downQty;
    totalCost += metrics.upCost + metrics.downCost;
    totalPaired += metrics.paired;
    totalUnpaired += metrics.unpaired;
    totalLockedProfit += metrics.lockedProfit;
    
    if (metrics.unpaired >= config.maxUnpairedImbalance * 0.9) {
      marketsAtLimit++;
    }
  }
  
  return {
    totalUpQty,
    totalDownQty,
    totalCost,
    totalPaired,
    totalUnpaired,
    totalLockedProfit,
    marketCount: markets.size,
    exposureUsedPct: config.maxTotalExposure > 0 
      ? (totalCost / config.maxTotalExposure) * 100 
      : 0,
    marketsAtImbalanceLimit: marketsAtLimit,
  };
}

function logPortfolioSummary(): void {
  if (markets.size === 0) return;
  
  const p = getPortfolioMetrics();
  const config = getV35Config();
  
  log(
    `📈 PORTFOLIO | ` +
    `Markets:${p.marketCount} | ` +
    `Paired:${p.totalPaired.toFixed(0)} | ` +
    `Exposure:${p.exposureUsedPct.toFixed(0)}% | ` +
    `Locked:$${p.totalLockedProfit.toFixed(2)}`
  );
}

// ============================================================
// HEARTBEAT
// ============================================================

async function sendHeartbeat(): Promise<void> {
  const config = getV35Config();
  const p = getPortfolioMetrics();
  
  try {
    // Update balance
    const balanceResult = await getBalance();
    if (typeof balanceResult.balance === 'number') {
      balance = balanceResult.balance;
    }
  } catch {
    // Ignore balance errors
  }
  
  // V35.3.2: Log order tracking stats to verify filtering is working
  const orderStats = getOrderTrackingStats();
  if (orderStats.fillsReceived > 0) {
    const rejectPct = orderStats.fillsRejected > 0 
      ? ((orderStats.fillsRejected / orderStats.fillsReceived) * 100).toFixed(0)
      : '0';
    log(`🔐 Order Filter Stats: ${orderStats.trackedOrders} tracked | Accepted: ${orderStats.fillsAccepted} | Rejected: ${orderStats.fillsRejected} (${rejectPct}% from other traders)`);
  }
  
  await sendV35Heartbeat({
    runnerId: RUN_ID,
    mode: config.mode,
    dryRun: config.dryRun,
    marketsCount: p.marketCount,
    totalPaired: p.totalPaired,
    totalUnpaired: p.totalUnpaired,
    totalLockedProfit: p.totalLockedProfit,
    balance,
  });
}

// ============================================================
// MAIN LOOP
// ============================================================

// Track last balance check time
let lastBalanceCheckTime = 0;
const BALANCE_CHECK_INTERVAL_MS = 60_000; // Check balance every 60 seconds
const MIN_BALANCE_REQUIRED = 5; // Minimum $5 USDC to operate

async function mainLoop(): Promise<void> {
  const config = getV35Config();
  
  while (running) {
    try {
      // Check total exposure
      const p = getPortfolioMetrics();
      if (p.totalCost >= config.maxTotalExposure) {
        log(`⚠️ MAX TOTAL EXPOSURE REACHED: $${p.totalCost.toFixed(0)}`);
      }
      
      const now = Date.now();
      
      // =================================================================
      // PERIODIC BALANCE CHECK - Pause if insufficient funds
      // =================================================================
      if (now - lastBalanceCheckTime > BALANCE_CHECK_INTERVAL_MS && !config.dryRun) {
        try {
          const balanceResult = await getBalance();
          if (typeof balanceResult.balance === 'number') {
            balance = balanceResult.balance;
            
            // Auto-pause if balance too low
            if (balance < MIN_BALANCE_REQUIRED && !paused) {
              log(`⚠️ INSUFFICIENT BALANCE: $${balance.toFixed(2)} < $${MIN_BALANCE_REQUIRED} minimum`);
              log(`   PAUSING trading. Add USDC to resume.`);
              paused = true;
            }
            // Auto-resume if balance recovered
            else if (balance >= MIN_BALANCE_REQUIRED && paused) {
              log(`✅ Balance recovered: $${balance.toFixed(2)} — RESUMING trading`);
              paused = false;
            }
          } else if (balanceResult.error) {
            log(`⚠️ Balance check error: ${balanceResult.error}`);
          }
        } catch (err: any) {
          log(`⚠️ Balance check failed: ${err?.message}`);
        }
        lastBalanceCheckTime = now;
      }
      
      // =================================================================
      // ORDER RECONCILIATION - Sync local tracking with Polymarket API
      // Runs every 30 seconds to prevent order stacking from missed fills
      // =================================================================
      if (now - lastReconcileTime > RECONCILE_INTERVAL_MS && !config.dryRun) {
        log('🔄 Running order reconciliation...');
        const { cleaned, added } = await reconcileOrders(markets, config.dryRun);
        lastReconcileTime = now;
        if (cleaned > 0 || added > 0) {
          log(`🔄 Reconciliation complete: ${cleaned} stale orders cleaned, ${added} missing orders added`);
        }
      }
      
      // Process each market
      for (const market of markets.values()) {
        await processMarket(market);
      }
      
      // Cleanup expired markets
      cleanupExpiredMarkets();
      
      // Log portfolio summary
      logPortfolioSummary();
      
      // Wait for next cycle
      await sleep(config.refreshIntervalMs);
      
    } catch (err: any) {
      logError('Main loop error:', err);
      await sleep(10000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// CONTROL METHODS
// ============================================================

function pause(): void {
  paused = true;
  log('⏸️ PAUSED - Cancelling all orders...');
  
  const config = getV35Config();
  for (const market of markets.values()) {
    cancelAllOrders(market, config.dryRun).catch(() => {});
  }
}

function resume(): void {
  paused = false;
  log('▶️ RESUMED - Quoting active');
}

async function stop(): Promise<void> {
  log('🛑 STOPPING...');
  running = false;
  
  // Close WebSockets
  if (clobSocket) {
    clobSocket.close();
    clobSocket = null;
  }
  
  // Stop User WebSocket
  stopUserWebSocket();
  
  // Stop Binance feed
  stopBinanceFeed();
  
  // Stop position cache
  stopPositionCache();
  
  const config = getV35Config();
  for (const market of markets.values()) {
    await cancelAllOrders(market, config.dryRun);
  }
  
  // Release runner lease
  await releaseLease(RUNNER_ID);
  
  await sendV35Offline(RUN_ID);
  log('🛑 STOPPED');
}

// ============================================================
// STARTUP
// ============================================================

async function main(): Promise<void> {
  console.log('\n' + '='.repeat(65));
  console.log(`  V35 PASSIVE DUAL-OUTCOME MARKET MAKER — ${VERSION}`);
  console.log('='.repeat(65) + '\n');
  
  // Load config from environment
  const mode = (process.env.V35_MODE || 'safe') as V35Mode;
  loadV35Config(mode);
  
  // Apply overrides from environment
  if (process.env.V35_DRY_RUN === 'true') {
    setV35ConfigOverrides({ dryRun: true });
  }
  if (process.env.V35_MAX_MARKETS) {
    setV35ConfigOverrides({ maxMarkets: parseInt(process.env.V35_MAX_MARKETS, 10) });
  }
  
  const config = getV35Config();
  printV35Config(config);
  
  if (config.dryRun) {
    log('🧪 DRY RUN MODE - No real orders will be placed');
  }
  
  // Set runner identity for order-guard (authorizes V35 to place orders)
  setRunnerIdentity('v35');
  
  // VPN check (exits if VPN not connected)
  await checkVpnRequired();
  
  // Acquire exclusive runner lease (prevents multiple runners)
  const forceLease = process.env.FORCE_LEASE === '1' || process.env.FORCE_TAKEOVER === '1';
  if (forceLease) {
    log('⚡ FORCE_LEASE detected - will override existing lease');
  }
  log('🔒 Acquiring exclusive runner lease...');
  const leaseAcquired = await acquireLeaseOrHalt(RUNNER_ID, forceLease);
  if (!leaseAcquired) {
    logError('Another runner holds the lease. Use FORCE_LEASE=1 to override.');
    process.exit(1);
  }
  log('✅ Exclusive runner lease acquired');
  
  // Validate credentials
  if (!config.dryRun) {
    log('🔐 Validating API credentials...');
    const credsOk = await ensureValidCredentials();
    if (!credsOk) {
      logError('Credential validation failed - exiting');
      await releaseLease(RUNNER_ID);
      process.exit(1);
    }
    log('✅ Credentials validated');
    
    // Get initial balance
    const balanceResult = await getBalance();
    if (typeof balanceResult.balance === 'number') {
      balance = balanceResult.balance;
      log(`💰 Balance: $${balance.toFixed(2)}`);
      
      // CRITICAL: Pause if balance is too low to place any orders
      const MIN_BALANCE_REQUIRED = 5; // Minimum $5 USDC to operate
      if (balance < MIN_BALANCE_REQUIRED) {
        log(`⚠️ INSUFFICIENT BALANCE: $${balance.toFixed(2)} < $${MIN_BALANCE_REQUIRED} minimum`);
        log(`   The bot will start PAUSED. Add USDC to resume trading.`);
        paused = true;
      }
    } else if (balanceResult.error) {
      logError(`Balance check failed: ${balanceResult.error}`);
    }
  }
  
  // Initialize quoting engine
  quotingEngine = new QuotingEngine();

  // Wire HedgeManager -> immediate order cancellations when hedging is not viable / fails.
  // This prevents runaway one-sided inventory accumulation between market loop ticks.
  const hedgeManager = getHedgeManager();
  hedgeManager.on('cancelSide', async ({ marketSlug, side }: { marketSlug: string; side: 'UP' | 'DOWN' }) => {
    const m = markets.get(marketSlug);
    if (!m) return;
    const cfg = getV35Config();
    log(`🛑 [HedgeManager] cancelSide: cancelling ${side} orders for ${marketSlug.slice(-25)}`);
    try {
      await cancelSideOrders(m, side, cfg.dryRun);
    } catch (err: any) {
      logError(`[HedgeManager] cancelSideOrders failed (${side})`, err);
    }
  });
  
  // Start Binance price feed for momentum detection
  if (config.enableMomentumFilter) {
    log('📊 Starting Binance price feed for momentum detection...');
    startBinanceFeed();
    // Give it a moment to connect
    await sleep(2000);
  }
  
  // =========================================================================
  // V35.1.2: CRITICAL STARTUP SEQUENCE
  // 1. Start position cache FIRST
  // 2. Wait for initial fetch to complete
  // 3. Only THEN discover markets (so we know pre-existing exposure)
  // =========================================================================
  log('🔄 Starting position cache (Polymarket API position sync)...');
  startPositionCache();
  // Give cache time to complete initial fetch - CRITICAL for position validation
  log('⏳ Waiting for position cache initial fetch (2s)...');
  await sleep(2000);
  
  // Now discover markets - the discovery will check pre-existing positions
  log('🔍 Discovering markets (will validate pre-existing positions)...');
  await refreshMarkets();
  log(`📊 Found ${markets.size} markets to trade (markets with excessive imbalance are excluded)`);
  
  if (markets.size === 0) {
    log('⚠️ No tradeable markets found. This could mean:');
    log('   - No active 15-min markets exist right now');
    log('   - All markets have pre-existing imbalance > maxUnpaired');
    log('   - Will retry on next market refresh cycle');
  }
  
  // Build token map and connect to WebSockets
  buildTokenMap();

  // CRITICAL STARTUP HYGIENE:
  // If the runner restarts, remote orders can still be open while our local maps are empty.
  // Reconciling BEFORE the first processMarket() prevents duplicating the entire grid.
  if (!config.dryRun && tokenToMarket.size > 0) {
    try {
      log('🔄 Initial order reconciliation (startup, prevent order stacking)...');
      const { cleaned, added } = await reconcileOrders(markets, config.dryRun);
      lastReconcileTime = Date.now();
      if (cleaned > 0 || added > 0) {
        log(`🔄 Startup reconcile: cleaned=${cleaned} added=${added}`);
      }
    } catch (err: any) {
      // If reconciliation fails, it's safer to PAUSE than to potentially place a duplicate full grid.
      paused = true;
      logError('Startup reconciliation FAILED — PAUSING to avoid order stacking. Fix network/API and resume.', err);
    }
  }

  if (tokenToMarket.size > 0 && !config.dryRun) {
    // Connect to public CLOB WebSocket for orderbook updates
    connectToClob();
    
    // Start authenticated User WebSocket for reliable fill tracking
    log('🔐 Starting authenticated User WebSocket for fill tracking...');
    startUserWebSocket(handleFillFromUserWs);
  }
  
  // Start running
  running = true;
  
  // Set up intervals
  const marketRefreshInterval = setInterval(() => {
    refreshMarkets().catch(err => logError('Market refresh failed:', err));
  }, 60000); // Every minute
  
  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(err => logError('Heartbeat failed:', err));
  }, 10000); // Every 10 seconds
  
  // Renew lease every 30 seconds
  const leaseRenewInterval = setInterval(() => {
    renewLease(RUNNER_ID).catch(err => logError('Lease renewal failed:', err));
  }, 30000);
  
  // Flush orderbook snapshots every 5 seconds
  const orderbookFlushInterval = setInterval(() => {
    flushOrderbookBuffer().catch(err => logError('Orderbook flush failed:', err));
  }, ORDERBOOK_LOG_INTERVAL_MS);
  
  // Handle shutdown
  const shutdown = async () => {
    console.log('\n');
    clearInterval(marketRefreshInterval);
    clearInterval(heartbeatInterval);
    clearInterval(leaseRenewInterval);
    clearInterval(orderbookFlushInterval);
    // Final flush before shutdown
    await flushOrderbookBuffer();
    await stop();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  // Initial heartbeat
  await sendHeartbeat();
  
  // Run main loop
  log('🚀 Starting main loop...');
  await mainLoop();
}

// ============================================================
// ENTRY POINT
// ============================================================

main().catch(async (err) => {
  logError('Fatal error:', err);
  await releaseLease(RUNNER_ID);
  process.exit(1);
});
