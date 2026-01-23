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
  V35Asset 
} from './types.js';
import { createEmptyMarket, calculateMarketMetrics } from './types.js';
import { QuotingEngine } from './quoting-engine.js';
import { discoverMarkets, filterByAssets } from './market-discovery.js';
import { syncOrders, cancelAllOrders, updateOrderbook } from './order-manager.js';
import { processFill, logMarketFillStats } from './fill-tracker.js';
import { sendV35Heartbeat, sendV35Offline, saveV35Settlement } from './backend.js';
import { ensureValidCredentials, getBalance } from '../polymarket.js';
import { checkVpnRequired } from '../vpn-check.js';

// ============================================================
// CONSTANTS
// ============================================================

const VERSION = 'V35.0.0';
const RUN_ID = `v35_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ============================================================
// STATE
// ============================================================

const markets = new Map<string, V35Market>();
let quotingEngine: QuotingEngine;
let running = false;
let paused = false;
let balance = 0;

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
  const assets: V35Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
  const filtered = filterByAssets(discovered, assets);
  
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
  }
}

function cleanupExpiredMarkets(): void {
  const now = Date.now();
  
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
      
      markets.delete(slug);
    }
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
  
  const config = getV35Config();
  for (const market of markets.values()) {
    await cancelAllOrders(market, config.dryRun);
  }
  
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
  
  // VPN check
  const vpnOk = await checkVpnRequired();
  if (!vpnOk) {
    logError('VPN check failed - exiting');
    process.exit(1);
  }
  
  // Validate credentials
  if (!config.dryRun) {
    log('🔐 Validating API credentials...');
    const credsOk = await ensureValidCredentials();
    if (!credsOk) {
      logError('Credential validation failed - exiting');
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
  
  // Start running
  running = true;
  
  // Set up intervals
  const marketRefreshInterval = setInterval(() => {
    refreshMarkets().catch(err => logError('Market refresh failed:', err));
  }, 60000); // Every minute
  
  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(err => logError('Heartbeat failed:', err));
  }, 10000); // Every 10 seconds
  
  // Handle shutdown
  const shutdown = async () => {
    console.log('\n');
    clearInterval(marketRefreshInterval);
    clearInterval(heartbeatInterval);
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

main().catch(err => {
  logError('Fatal error:', err);
  process.exit(1);
});
