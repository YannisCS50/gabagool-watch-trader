#!/usr/bin/env npx ts-node
// ============================================================
// V26 LOVEABLE RUNNER - STANDALONE PRE-MARKET DOWN TRADER
// ============================================================
//
// Run: npx ts-node src/v26/runner.ts
// Or:  npm run v26
//
// This is the ONLY strategy that runs. All other strategies are disabled.
// ============================================================

import { config } from '../config.js';
import { testConnection, getBalance, placeOrder, cancelOrder } from '../polymarket.js';
import { fetchMarkets } from '../backend.js';
import { enforceVpnOrExit } from '../vpn-check.js';
import { 
  V26_CONFIG, 
  V26_VERSION, 
  V26_NAME,
  V26Trade,
  V26Market,
  isMarketEligible,
  calculateV26Pnl,
  logV26Status,
} from './index.js';
import { saveV26Trade, updateV26Trade, hasExistingTrade } from './backend.js';

// ============================================================
// CONSTANTS
// ============================================================

const RUN_ID = `v26-${Date.now()}`;
const POLL_INTERVAL_MS = 30_000; // Check for new markets every 30s
const ORDER_TIMEOUT_MS = V26_CONFIG.cancelAfterSec * 1000;

// ============================================================
// STATE
// ============================================================

interface ScheduledTrade {
  market: V26Market;
  trade: V26Trade;
  placeTimeout?: NodeJS.Timeout;
  cancelTimeout?: NodeJS.Timeout;
  orderId?: string;
}

const scheduledTrades = new Map<string, ScheduledTrade>();
const completedMarkets = new Set<string>();

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
// MARKET FETCHING
// ============================================================

async function fetchUpcomingMarkets(): Promise<V26Market[]> {
  try {
    const markets = await fetchMarkets();
    const now = Date.now();
    const upcoming: V26Market[] = [];

    for (const m of markets) {
      // Only enabled assets
      if (!V26_CONFIG.assets.includes(m.asset as any)) continue;
      
      // Must have token IDs
      if (!m.down_token_id) continue;
      
      const startTime = new Date(m.event_start_time).getTime();
      const endTime = new Date(m.event_end_time).getTime();
      
      // Market must start in the future (with buffer for order placement)
      if (startTime <= now + 10_000) continue;
      
      // Skip if already processed
      const key = `${m.id}:${m.asset}`;
      if (completedMarkets.has(key) || scheduledTrades.has(key)) continue;

      upcoming.push({
        id: m.id,
        slug: m.slug,
        asset: m.asset,
        eventStartTime: new Date(m.event_start_time),
        eventEndTime: new Date(m.event_end_time),
        downTokenId: m.down_token_id,
      });
    }

    return upcoming;
  } catch (err) {
    logError('Failed to fetch markets', err);
    return [];
  }
}

// ============================================================
// ORDER EXECUTION
// ============================================================

async function placeV26Order(scheduled: ScheduledTrade): Promise<void> {
  const { market, trade } = scheduled;
  const key = `${market.id}:${market.asset}`;
  
  log(`🎯 [${market.asset}] Placing V26 order: ${V26_CONFIG.shares} shares @ $${V26_CONFIG.price}`);
  
  try {
    // Check if we already have a trade for this market
    const exists = await hasExistingTrade(market.id, market.asset);
    if (exists) {
      log(`⚠️ [${market.asset}] Already have trade for this market, skipping`);
      completedMarkets.add(key);
      scheduledTrades.delete(key);
      return;
    }

    // Place the order
    const result = await placeOrder({
      tokenId: market.downTokenId,
      side: 'BUY',
      price: V26_CONFIG.price,
      size: V26_CONFIG.shares,
    });

    if (!result || !result.orderID) {
      throw new Error('No order ID returned');
    }

    scheduled.orderId = result.orderID;
    trade.orderId = result.orderID;
    trade.status = 'placed';
    trade.runId = RUN_ID;

    // Save to database
    const dbId = await saveV26Trade(trade);
    if (dbId) trade.id = dbId;

    log(`✅ [${market.asset}] Order placed: ${result.orderID}`);

    // Schedule cancellation if not filled
    scheduled.cancelTimeout = setTimeout(async () => {
      await checkAndCancelOrder(scheduled);
    }, ORDER_TIMEOUT_MS);

  } catch (err) {
    logError(`[${market.asset}] Failed to place order`, err);
    trade.status = 'cancelled';
    trade.errorMessage = String(err);
    await saveV26Trade(trade);
    completedMarkets.add(key);
    scheduledTrades.delete(key);
  }
}

async function checkAndCancelOrder(scheduled: ScheduledTrade): Promise<void> {
  const { market, trade, orderId } = scheduled;
  const key = `${market.id}:${market.asset}`;

  if (!orderId) {
    completedMarkets.add(key);
    scheduledTrades.delete(key);
    return;
  }

  try {
    // Try to cancel the order - if it fails, it was likely already filled
    log(`⏰ [${market.asset}] Attempting to cancel order after ${V26_CONFIG.cancelAfterSec}s`);
    const cancelResult = await cancelOrder(orderId);

    if (cancelResult.success) {
      log(`✓ [${market.asset}] Order cancelled (was not filled)`);
      trade.status = 'cancelled';
      if (trade.id) {
        await updateV26Trade(trade.id, { status: 'cancelled' });
      }
    } else {
      // Cancel failed - order was likely already filled
      log(`✓ [${market.asset}] Cancel failed (order likely filled): ${cancelResult.error}`);
      trade.status = 'filled';
      trade.filledShares = V26_CONFIG.shares;
      trade.avgFillPrice = V26_CONFIG.price;
      
      if (trade.id) {
        await updateV26Trade(trade.id, { 
          status: 'filled',
          filledShares: trade.filledShares,
          avgFillPrice: trade.avgFillPrice,
        });
      }
    }
  } catch (err) {
    logError(`[${market.asset}] Error checking/cancelling order`, err);
  }

  completedMarkets.add(key);
  scheduledTrades.delete(key);
}

// ============================================================
// SCHEDULING
// ============================================================

function scheduleMarket(market: V26Market): void {
  const key = `${market.id}:${market.asset}`;
  
  if (scheduledTrades.has(key) || completedMarkets.has(key)) {
    return;
  }

  const now = Date.now();
  const placeTime = market.eventStartTime.getTime() - (V26_CONFIG.placeOrderBeforeStartSec * 1000);
  const msUntilPlace = placeTime - now;

  if (msUntilPlace < 0) {
    log(`⚠️ [${market.asset}] Too late to schedule: ${market.slug}`);
    completedMarkets.add(key);
    return;
  }

  const trade: V26Trade = {
    asset: market.asset,
    marketId: market.id,
    marketSlug: market.slug,
    eventStartTime: market.eventStartTime,
    eventEndTime: market.eventEndTime,
    side: 'DOWN',
    price: V26_CONFIG.price,
    shares: V26_CONFIG.shares,
    status: 'pending',
    filledShares: 0,
    runId: RUN_ID,
  };

  const scheduled: ScheduledTrade = { market, trade };

  scheduled.placeTimeout = setTimeout(async () => {
    await placeV26Order(scheduled);
  }, msUntilPlace);

  scheduledTrades.set(key, scheduled);

  const startTime = market.eventStartTime.toISOString().slice(11, 16);
  log(`📅 [${market.asset}] Scheduled for ${startTime} (in ${Math.round(msUntilPlace / 1000)}s)`);
}

// ============================================================
// MAIN LOOP
// ============================================================

async function pollMarkets(): Promise<void> {
  const markets = await fetchUpcomingMarkets();
  
  for (const market of markets) {
    scheduleMarket(market);
  }
}

async function printStatus(): Promise<void> {
  const balance = await getBalance();
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  📊 V26 STATUS @ ${new Date().toISOString().slice(11, 19)}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Scheduled: ${scheduledTrades.size} markets`);
  console.log(`  Completed: ${completedMarkets.size} markets`);
  console.log(`  Balance:   $${balance?.toFixed(2) ?? 'unknown'}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

// ============================================================
// STARTUP
// ============================================================

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        🎯 V26 LOVEABLE - PRE-MARKET DOWN TRADER              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Version:  ${V26_VERSION.padEnd(49)}║`);
  console.log(`║  Strategy: ${V26_NAME.slice(0, 49).padEnd(49)}║`);
  console.log(`║  Run ID:   ${RUN_ID.padEnd(49)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Side:     DOWN @ $${V26_CONFIG.price}`.padEnd(66) + '║');
  console.log(`║  Shares:   ${V26_CONFIG.shares} per trade`.padEnd(66) + '║');
  console.log(`║  Assets:   ${V26_CONFIG.assets.join(', ')}`.padEnd(66) + '║');
  console.log(`║  Timeout:  ${V26_CONFIG.cancelAfterSec}s after market start`.padEnd(66) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // VPN check
  if (config.vpn.required) {
    log('🔒 Checking VPN...');
    await enforceVpnOrExit();
    log('✅ VPN OK');
  }

  // Test Polymarket connection
  log('🔌 Testing Polymarket connection...');
  const connected = await testConnection();
  if (!connected) {
    logError('Failed to connect to Polymarket');
    process.exit(1);
  }
  log('✅ Polymarket connected');

  // Get initial balance
  const balance = await getBalance();
  const balanceNum = typeof balance === 'string' ? parseFloat(balance) : balance;
  log(`💰 Balance: $${balanceNum ? balanceNum.toFixed(2) : 'unknown'}`);

  // Start polling loop
  log('🚀 Starting V26 strategy...');
  log('');

  // Initial poll
  await pollMarkets();
  await printStatus();

  // Poll every 30 seconds
  setInterval(async () => {
    await pollMarkets();
  }, POLL_INTERVAL_MS);

  // Print status every 5 minutes
  setInterval(async () => {
    await printStatus();
  }, 5 * 60 * 1000);

  // Keep process alive
  log('👀 Watching for markets... (Ctrl+C to stop)');
}

// Handle shutdown
process.on('SIGINT', () => {
  log('');
  log('🛑 Shutting down V26...');
  
  // Cancel all scheduled timeouts
  for (const [key, scheduled] of scheduledTrades) {
    if (scheduled.placeTimeout) clearTimeout(scheduled.placeTimeout);
    if (scheduled.cancelTimeout) clearTimeout(scheduled.cancelTimeout);
  }
  
  log(`📊 Final stats: ${completedMarkets.size} markets processed`);
  process.exit(0);
});

// Run
main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
