// ============================================================
// V35 RUNNER
// ============================================================
// Passive Dual-Outcome Market Maker for Polymarket 15-min options
// 
// STRATEGY:
// 1. Discover active 15-min up/down markets
// 2. Place limit BUY orders on a grid for both UP and DOWN sides
// 3. When retail traders hit our orders, we accumulate both sides
// 4. At settlement: one side pays $1.00, other pays $0.00
// 5. If combined cost < $1.00 -> GUARANTEED profit
//
// USAGE:
//   npm run v35              # Safe mode (default)
//   V35_MODE=moderate npm run v35
//   V35_MODE=production npm run v35
//   V35_DRY_RUN=true npm run v35
// ============================================================

import '../config.js'; // Load env first
import WebSocket from 'ws';
import os from 'os';
import { 
  getV35Config, 
  loadV35Config, 
  setV35ConfigOverrides,
  printV35Config,
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
import { discoverMarkets, filterByAssets } from './market-discovery.js';
import { syncOrders, cancelAllOrders, updateOrderbook } from './order-manager.js';
import { processFill, logMarketFillStats } from './fill-tracker.js';
import { sendV35Heartbeat, sendV35Offline, saveV35Settlement, saveV35Fill } from './backend.js';
import { ensureValidCredentials, getBalance, getOpenOrders } from '../polymarket.js';
import { checkVpnRequired } from '../vpn-check.js';
import { acquireLeaseOrHalt, releaseLease, renewLease } from '../runner-lease.js';
import { setRunnerIdentity } from '../order-guard.js';

// ============================================================
// CONSTANTS
// ============================================================

const VERSION = 'V35.0.1';
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
// WEBSOCKET MANAGEMENT
// ============================================================

function buildTokenMap(): void {
  tokenToMarket.clear();
  for (const market of markets.values()) {
    tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'UP' });
    tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'DOWN' });
  }
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
}

// ============================================================
// MARKET MANAGEMENT
// ============================================================

async function refreshMarkets(): Promise<void> {
  const config = getV35Config();
  
  // Check if we have room for more markets
  if (markets.size >= config.maxMarkets) {
    return;
  }
  
  // Discover new markets
  const discovered = await discoverMarkets(config.stopBeforeExpirySec + 60);
  const assets: V35Asset[] = ['BTC']; // Only BTC allowed
  const filtered = filterByAssets(discovered, assets);
  
  let added = 0;
  // Add new markets (up to max)
  for (const m of filtered) {
    if (markets.size >= config.maxMarkets) break;
    if (markets.has(m.slug)) continue;
    
    const market = createEmptyMarket(
      m.slug,
      m.conditionId,
      m.upTokenId,
      m.downTokenId,
      m.asset,
      m.expiry
    );
    
    markets.set(m.slug, market);
    log(`➕ Added market: ${m.slug.slice(-35)} (${m.asset})`);
    added++;
  }
  
  // Rebuild token map and reconnect if new markets were added
  if (added > 0) {
    buildTokenMap();
    // Reconnect WS with new tokens
    if (clobSocket) {
      clobSocket.close();
    }
    connectToClob();
  }
}

function cleanupExpiredMarkets(): void {
  const now = Date.now();
  let removed = 0;
  
  for (const [slug, market] of markets.entries()) {
    if (market.expiry.getTime() < now) {
      // Market expired - log settlement
      const metrics = calculateMarketMetrics(market);
      
      log(`🏁 SETTLED ${slug.slice(-35)}`);
      log(`   Paired: ${metrics.paired.toFixed(0)} | Combined: $${metrics.combinedCost.toFixed(3)} | Locked: $${metrics.lockedProfit.toFixed(2)}`);
      
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
      
      markets.delete(slug);
      removed++;
    }
  }
  
  if (removed > 0) {
    log(`🗑️ Removed ${removed} expired markets`);
  }
}

// ============================================================
// MARKET PROCESSING
// ============================================================

async function processMarket(market: V35Market): Promise<void> {
  const config = getV35Config();
  const now = Date.now();
  const secondsToExpiry = (market.expiry.getTime() - now) / 1000;
  
  // Stop quoting if too close to expiry
  if (secondsToExpiry < config.stopBeforeExpirySec) {
    log(`⏱️ ${market.slug.slice(-25)}: STOP (${secondsToExpiry.toFixed(0)}s to expiry)`);
    await cancelAllOrders(market, config.dryRun);
    return;
  }
  
  // Update orderbook
  await updateOrderbook(market, config.dryRun);
  
  // Calculate metrics
  const metrics = calculateMarketMetrics(market);
  
  // Check notional limit
  if (market.upCost + market.downCost >= config.maxNotionalPerMarket) {
    log(`⚠️ ${market.slug.slice(-25)}: MAX NOTIONAL REACHED`);
  }
  
  // Log status
  const skewWarn = metrics.skew > config.skewThreshold ? ' ⚠️→UP' 
                 : metrics.skew < -config.skewThreshold ? ' ⚠️→DOWN' 
                 : '';
  
  log(
    `📊 ${market.slug.slice(-25)} | ` +
    `UP:${metrics.upQty.toFixed(0)} DOWN:${metrics.downQty.toFixed(0)} | ` +
    `Cost:$${(metrics.upCost + metrics.downCost).toFixed(0)} | ` +
    `Combined:$${metrics.combinedCost.toFixed(3)}${skewWarn}`
  );
  
  // Sync orders if not paused
  if (!paused) {
    const upQuotes = quotingEngine.generateQuotes('UP', market);
    const downQuotes = quotingEngine.generateQuotes('DOWN', market);
    
    await syncOrders(market, 'UP', upQuotes, config.dryRun);
    await syncOrders(market, 'DOWN', downQuotes, config.dryRun);
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

async function mainLoop(): Promise<void> {
  const config = getV35Config();
  
  while (running) {
    try {
      // Check total exposure
      const p = getPortfolioMetrics();
      if (p.totalCost >= config.maxTotalExposure) {
        log(`⚠️ MAX TOTAL EXPOSURE REACHED: $${p.totalCost.toFixed(0)}`);
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
  
  // Close WebSocket
  if (clobSocket) {
    clobSocket.close();
    clobSocket = null;
  }
  
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
    }
  }
  
  // Initialize quoting engine
  quotingEngine = new QuotingEngine();
  
  // Initial market discovery
  log('🔍 Discovering markets...');
  await refreshMarkets();
  log(`📊 Found ${markets.size} markets to trade`);
  
  // Build token map and connect to WebSocket
  buildTokenMap();
  if (tokenToMarket.size > 0 && !config.dryRun) {
    connectToClob();
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
  
  // Handle shutdown
  const shutdown = async () => {
    console.log('\n');
    clearInterval(marketRefreshInterval);
    clearInterval(heartbeatInterval);
    clearInterval(leaseRenewInterval);
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
