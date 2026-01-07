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
import { testConnection, getBalance, placeOrder, cancelOrder, getOrderFillInfo } from '../polymarket.js';
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
import { saveV26Trade, updateV26Trade, hasExistingTrade, getV26Oracle } from './backend.js';

// ============================================================
// CONSTANTS
// ============================================================

const RUN_ID = `v26-${Date.now()}`;
const POLL_INTERVAL_MS = 30_000; // Check for new markets every 30s
// Cancel timeout is calculated dynamically based on market start time

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
// HELPERS
// ============================================================

function normalizeUsdAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);

  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  if (value && typeof value === 'object') {
    const v: any = value;

    if (typeof v.toNumber === 'function') {
      const n = v.toNumber();
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    }

    if (typeof v.toString === 'function') {
      const n = Number(v.toString());
      return Number.isFinite(n) ? n : null;
    }
  }

  return null;
}

function formatUsd(value: unknown): string {
  const n = normalizeUsdAmount(value);
  return n === null ? 'unknown' : n.toFixed(2);
}

// ============================================================
// MARKET FETCHING
// ============================================================

async function fetchUpcomingMarkets(): Promise<V26Market[]> {
  try {
    // V26 mode: request upcoming markets (within 10 minutes)
    const result = await fetchMarkets({ v26: true });
    
    if (!result.success || !result.markets) {
      log('⚠️ No markets returned from backend (v26 mode)');
      return [];
    }

    const now = Date.now();
    const upcoming: V26Market[] = [];

    for (const m of result.markets) {
      // Only enabled assets
      if (!V26_CONFIG.assets.includes(m.asset as any)) continue;
      
      // Must have token IDs
      if (!m.downTokenId) continue;
      
      const startTime = new Date(m.eventStartTime).getTime();
      const endTime = new Date(m.eventEndTime).getTime();
      
      // Market must start in the future (with buffer for order placement)
      if (startTime <= now + 10_000) continue;
      
      // Skip if already processed - use slug:asset as key since we don't have id
      const key = `${m.slug}:${m.asset}`;
      if (completedMarkets.has(key) || scheduledTrades.has(key)) continue;

      upcoming.push({
        id: m.slug, // Use slug as id since MarketToken doesn't have id
        slug: m.slug,
        asset: m.asset,
        eventStartTime: new Date(m.eventStartTime),
        eventEndTime: new Date(m.eventEndTime),
        downTokenId: m.downTokenId,
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

    if (!result?.success || !result.orderId) {
      throw new Error(result?.error || 'No orderId returned');
    }

    scheduled.orderId = result.orderId;
    trade.orderId = result.orderId;
    trade.status = 'placed';
    trade.runId = RUN_ID;

    // If we got immediate fill info, persist it.
    if (result.status === 'filled' || result.status === 'partial') {
      const filledNow = typeof result.filledSize === 'number' ? result.filledSize : 0;
      trade.status = result.status === 'filled' ? 'filled' : 'partial';
      trade.filledShares = filledNow;
      trade.avgFillPrice = trade.price;
    }

    // Save to database
    const dbId = await saveV26Trade(trade);
    if (dbId) trade.id = dbId;

    log(`✅ [${market.asset}] Order placed: ${result.orderId} (status=${result.status ?? 'unknown'})`);

    // If already filled, we can skip cancellation and go straight to settlement.
    if (trade.status === 'filled' && trade.filledShares > 0) {
      scheduleSettlement(market, trade);
      completedMarkets.add(key);
      scheduledTrades.delete(key);
      return;
    }

    // Schedule cancellation: 30s AFTER market start
    const cancelTime = market.eventStartTime.getTime() + (V26_CONFIG.cancelAfterStartSec * 1000);
    const msUntilCancel = Math.max(0, cancelTime - Date.now());

    log(`⏰ [${market.asset}] Cancel scheduled in ${Math.round(msUntilCancel / 1000)}s (30s after market start)`);

    scheduled.cancelTimeout = setTimeout(async () => {
      await checkAndCancelOrder(scheduled);
    }, msUntilCancel);

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
    log(`⏰ [${market.asset}] Checking fill status before cancel...`);

    const before = await getOrderFillInfo(orderId);
    const matchedBefore = before.success ? (before.filledSize ?? 0) : 0;

    if (before.success && matchedBefore > 0) {
      trade.filledShares = matchedBefore;
      trade.avgFillPrice = trade.avgFillPrice ?? trade.price;
      trade.status = before.status === 'partial' ? 'partial' : before.status === 'filled' ? 'filled' : 'partial';

      if (trade.id) {
        await updateV26Trade(trade.id, {
          status: trade.status,
          filledShares: trade.filledShares,
          avgFillPrice: trade.avgFillPrice,
        });
      }

      if (before.status === 'filled') {
        log(`✓ [${market.asset}] Already filled (${matchedBefore}/${before.originalSize ?? V26_CONFIG.shares}); skipping cancel.`);
        scheduleSettlement(market, trade);
        completedMarkets.add(key);
        scheduledTrades.delete(key);
        return;
      }

      log(`✓ [${market.asset}] Partial fill detected (${matchedBefore}/${before.originalSize ?? V26_CONFIG.shares}); will cancel remainder.`);
    }

    // Try to cancel any remainder
    log(`⏰ [${market.asset}] Attempting to cancel order ${V26_CONFIG.cancelAfterStartSec}s after market start`);
    const cancelResult = await cancelOrder(orderId);

    // Re-check after cancel (it may have filled between calls)
    const after = await getOrderFillInfo(orderId);
    const matchedAfter = after.success ? (after.filledSize ?? 0) : matchedBefore;

    if (after.success && matchedAfter > 0) {
      trade.filledShares = matchedAfter;
      trade.avgFillPrice = trade.avgFillPrice ?? trade.price;
      trade.status = after.status === 'filled' ? 'filled' : 'partial';

      if (trade.id) {
        await updateV26Trade(trade.id, {
          status: trade.status,
          filledShares: trade.filledShares,
          avgFillPrice: trade.avgFillPrice,
        });
      }

      log(`✓ [${market.asset}] Post-cancel fill status: ${trade.status} (${matchedAfter}/${after.originalSize ?? V26_CONFIG.shares})`);

      // If fully filled, settle. If partial, we still settle the partial position.
      scheduleSettlement(market, trade);
    } else {
      if (cancelResult.success) {
        log(`✓ [${market.asset}] Order cancelled (no fills detected)`);
        trade.status = 'cancelled';
        if (trade.id) {
          await updateV26Trade(trade.id, { status: 'cancelled' });
        }
      } else {
        // Cancel failed and we couldn't confirm fills: keep it conservative.
        log(`⚠️ [${market.asset}] Cancel failed and fill status unknown: ${cancelResult.error}`);
      }
    }
  } catch (err) {
    logError(`[${market.asset}] Error checking/cancelling order`, err);
  }

  completedMarkets.add(key);
  scheduledTrades.delete(key);
}

// ============================================================
// SETTLEMENT
// ============================================================

function computeV26Result(strikePrice: number, closePrice: number): 'UP' | 'DOWN' {
  // Convention: UP if close strictly above strike, otherwise DOWN.
  // (Edge case close==strike is treated as DOWN)
  return closePrice > strikePrice ? 'UP' : 'DOWN';
}

function scheduleSettlement(market: V26Market, trade: V26Trade): void {
  const bufferMs = 60_000; // give oracle collector time to write close_price
  const settleAtMs = market.eventEndTime.getTime() + bufferMs;
  const msUntil = Math.max(5_000, settleAtMs - Date.now());

  log(`🧾 [${market.asset}] Settlement scheduled in ${Math.round(msUntil / 1000)}s (after market end)`);

  setTimeout(() => {
    void attemptSettlement(market, trade, 0);
  }, msUntil);
}

async function attemptSettlement(market: V26Market, trade: V26Trade, attempt: number): Promise<void> {
  const MAX_ATTEMPTS = 60; // 60 * 30s = 30 minutes
  const RETRY_MS = 30_000;

  if (!trade.id) {
    log(`⚠️ [${market.asset}] Cannot settle trade without db id (market=${market.slug})`);
    return;
  }

  try {
    const oracle = await getV26Oracle(market.slug, market.asset);
    const strike = oracle?.strike_price ?? null;
    const close = oracle?.close_price ?? null;

    if (strike === null || close === null) {
      if (attempt >= MAX_ATTEMPTS) {
        log(`❌ [${market.asset}] Settlement timed out (no strike/close). market=${market.slug}`);
        return;
      }

      log(`⏳ [${market.asset}] Waiting for settlement data (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      setTimeout(() => {
        void attemptSettlement(market, trade, attempt + 1);
      }, RETRY_MS);
      return;
    }

    const result = computeV26Result(strike, close);
    const settledAt = new Date();
    const pnl = calculateV26Pnl({ ...trade, result, settledAt });

    await updateV26Trade(trade.id, { result, pnl, settledAt });

    log(
      `🏁 [${market.asset}] Settled ${market.slug}: strike=${strike.toFixed(2)} close=${close.toFixed(2)} → ${result} | P/L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);

    if (attempt >= MAX_ATTEMPTS) {
      logError(`[${market.asset}] Settlement failed permanently: ${msg}`);
      return;
    }

    log(`⚠️ [${market.asset}] Settlement attempt failed (will retry): ${msg}`);
    setTimeout(() => {
      void attemptSettlement(market, trade, attempt + 1);
    }, RETRY_MS);
  }
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
  const startTime = market.eventStartTime.getTime();
  const secondsUntilStart = (startTime - now) / 1000;

  // Too late: less than minLeadTime before start
  if (secondsUntilStart < V26_CONFIG.minLeadTimeSec) {
    log(`⚠️ [${market.asset}] Too late to schedule (${Math.round(secondsUntilStart)}s until start): ${market.slug}`);
    completedMarkets.add(key);
    return;
  }

  // Within window: place immediately if within maxLeadTime, otherwise schedule
  const placeImmediately = secondsUntilStart <= V26_CONFIG.maxLeadTimeSec;
  const msUntilPlace = placeImmediately ? 0 : (startTime - (V26_CONFIG.maxLeadTimeSec * 1000)) - now;

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

  const startTimeStr = market.eventStartTime.toISOString().slice(11, 16);
  if (placeImmediately) {
    log(`📅 [${market.asset}] Placing NOW for ${startTimeStr} (${Math.round(secondsUntilStart)}s until start)`);
  } else {
    log(`📅 [${market.asset}] Scheduled for ${startTimeStr} (order in ${Math.round(msUntilPlace / 1000)}s)`);
  }
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
  console.log(`  Balance:   $${formatUsd(balance)}`);
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
  log(`💰 Balance: $${formatUsd(balance)}`);

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
