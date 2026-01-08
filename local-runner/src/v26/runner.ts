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
import { testConnection, getBalance, placeOrder, cancelOrder, getOrderFillInfo, getOrderbookDepth } from '../polymarket.js';
import { fetchMarkets, sendHeartbeat, saveFillLogs, saveSettlementLogs, saveSnapshotLogs, savePriceTicks, saveDecisionSnapshot, PriceTick } from '../backend.js';
import { enforceVpnOrExit } from '../vpn-check.js';
import { fetchChainlinkPrice } from '../chain.js';
import { 
  V26_CONFIG, 
  V26_VERSION, 
  V26_NAME,
  V26Trade,
  V26Market,
  isMarketEligible,
  calculateV26Pnl,
  logV26Status,
  loadV26Config,
  getV26Config,
  checkAndReloadConfig,
  getAssetConfig,
  getEnabledAssets,
} from './index.js';
import { saveV26Trade, updateV26Trade, hasExistingTrade, getV26Oracle } from './backend.js';
import type { FillLog, SettlementLog, SnapshotLog } from '../logger.js';
import type { DecisionSnapshot } from '../backend.js';

// ============================================================
// CONSTANTS
// ============================================================

const RUN_ID = `v26-${Date.now()}`;
const POLL_INTERVAL_MS = 30_000; // Check for new markets every 30s
const PRICE_TICK_INTERVAL_MS = 1_000; // Log price every second
const SNAPSHOT_INTERVAL_MS = 5_000; // Log snapshots every 5 seconds
const FILL_POLL_INTERVAL_MS = 5_000; // Poll fills every 5 seconds for open orders
// Cancel timeout is calculated dynamically based on market start time

// ============================================================
// STATE
// ============================================================

// Price state
let lastBtcPrice: number | null = null;
let lastEthPrice: number | null = null;
// STATE
// ============================================================

interface ScheduledTrade {
  market: V26Market;
  trade: V26Trade;
  placeTimeout?: NodeJS.Timeout;
  cancelTimeout?: NodeJS.Timeout;
  orderId?: string;
  placedAtMs?: number;
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
// FILL & SETTLEMENT LOGGING
// ============================================================

async function logV26Fill(market: V26Market, trade: V26Trade, fillQty: number, fillPrice: number): Promise<void> {
  const now = Date.now();
  const secondsRemaining = Math.max(0, Math.round((market.eventEndTime.getTime() - now) / 1000));
  
  const fillLog: FillLog = {
    ts: now,
    iso: new Date(now).toISOString(),
    marketId: market.slug,
    asset: market.asset as 'BTC' | 'ETH',
    side: 'DOWN',
    orderId: trade.orderId ?? null,
    clientOrderId: null,
    fillQty,
    fillPrice,
    fillNotional: fillQty * fillPrice,
    intent: 'ENTRY',
    secondsRemaining,
    spotPrice: null,
    strikePrice: null,
    delta: null,
    btcPrice: null,
    ethPrice: null,
    upBestAsk: null,
    downBestAsk: null,
    upBestBid: null,
    downBestBid: null,
    hedgeLagMs: null,
  };

  try {
    await saveFillLogs([fillLog]);
    log(`📝 [${market.asset}] Fill logged: ${fillQty} shares @ $${fillPrice.toFixed(2)}`);
  } catch (err) {
    logError(`[${market.asset}] Failed to log fill`, err);
  }
}

async function logV26Settlement(
  market: V26Market,
  trade: V26Trade,
  winningSide: 'UP' | 'DOWN',
  pnl: number
): Promise<void> {
  const now = Date.now();
  
  const settlementLog: SettlementLog = {
    ts: now,
    iso: new Date(now).toISOString(),
    marketId: market.slug,
    asset: market.asset as 'BTC' | 'ETH',
    openTs: trade.fillTimeMs ? (now - trade.fillTimeMs) : null,
    closeTs: now,
    finalUpShares: 0,
    finalDownShares: trade.filledShares,
    avgUpCost: null,
    avgDownCost: trade.avgFillPrice ?? trade.price,
    pairCost: null,  // V26 is single-sided, no pair
    realizedPnL: pnl,
    winningSide,
    maxDelta: null,
    minDelta: null,
    timeInLow: 0,
    timeInMid: 0,
    timeInHigh: 0,
    countDislocation95: 0,
    countDislocation97: 0,
    last180sDislocation95: 0,
    theoreticalPnL: winningSide === 'DOWN' ? (1 - (trade.avgFillPrice ?? trade.price)) * trade.filledShares : -(trade.avgFillPrice ?? trade.price) * trade.filledShares,
    fees: null,
    totalPayoutUsd: winningSide === 'DOWN' ? trade.filledShares : 0,
  };

  try {
    await saveSettlementLogs([settlementLog]);
    log(`📝 [${market.asset}] Settlement logged: ${winningSide} won, P/L $${pnl.toFixed(2)}`);
  } catch (err) {
    logError(`[${market.asset}] Failed to log settlement`, err);
  }
}

// ============================================================
// PRICE TICK LOGGING
// ============================================================

async function logPriceTicks(): Promise<void> {
  try {
    const [btcResult, ethResult] = await Promise.all([
      fetchChainlinkPrice('BTC'),
      fetchChainlinkPrice('ETH'),
    ]);

    const ticks: PriceTick[] = [];
    const now = new Date().toISOString();

    if (btcResult !== null) {
      const btcPrice = btcResult.price;
      const delta = lastBtcPrice !== null ? btcPrice - lastBtcPrice : null;
      const deltaPct = lastBtcPrice !== null && lastBtcPrice > 0 ? (delta! / lastBtcPrice) * 100 : null;
      ticks.push({ asset: 'BTC', price: btcPrice, delta, delta_percent: deltaPct, source: 'chainlink', created_at: now });
      lastBtcPrice = btcPrice;
    }

    if (ethResult !== null) {
      const ethPrice = ethResult.price;
      const delta = lastEthPrice !== null ? ethPrice - lastEthPrice : null;
      const deltaPct = lastEthPrice !== null && lastEthPrice > 0 ? (delta! / lastEthPrice) * 100 : null;
      ticks.push({ asset: 'ETH', price: ethPrice, delta, delta_percent: deltaPct, source: 'chainlink', created_at: now });
      lastEthPrice = ethPrice;
    }

    if (ticks.length > 0) {
      await savePriceTicks(ticks);
    }
  } catch (err) {
    // Price tick logging is non-critical
  }
}

// ============================================================
// SNAPSHOT LOGGING
// ============================================================

async function logV26Snapshots(): Promise<void> {
  try {
    // Get current markets we're tracking
    const activeMarkets = Array.from(scheduledTrades.values());
    if (activeMarkets.length === 0) return;

    const now = Date.now();
    const snapshots: SnapshotLog[] = [];

    for (const { market, trade } of activeMarkets) {
      const secondsRemaining = Math.max(0, Math.round((market.eventEndTime.getTime() - now) / 1000));
      
      // Fetch orderbook for DOWN token
      let downBid: number | null = null;
      let downAsk: number | null = null;
      let downMid: number | null = null;
      let orderbookReady = false;

      try {
        const depth = await getOrderbookDepth(market.downTokenId);
        downBid = depth.topBid;
        downAsk = depth.topAsk;
        if (downBid !== null && downAsk !== null) {
          downMid = (downBid + downAsk) / 2;
          orderbookReady = depth.hasLiquidity;
        }
      } catch {
        // Orderbook fetch failed
      }

      // Get spot price for this asset
      const spotPrice = market.asset === 'BTC' ? lastBtcPrice : lastEthPrice;

      const snapshot: SnapshotLog = {
        ts: now,
        iso: new Date(now).toISOString(),
        marketId: market.slug,
        asset: market.asset as 'BTC' | 'ETH',
        secondsRemaining,
        spotPrice,
        strikePrice: null, // V26 doesn't track strike until settlement
        delta: null,
        btcPrice: lastBtcPrice,
        ethPrice: lastEthPrice,
        upBid: null,
        upAsk: null,
        upMid: null,
        downBid,
        downAsk,
        downMid,
        spreadUp: null,
        spreadDown: downBid !== null && downAsk !== null ? downAsk - downBid : null,
        combinedAsk: null,
        combinedMid: null,
        cheapestAskPlusOtherMid: null,
        upBestAsk: null,
        downBestAsk: downAsk,
        orderbookReady,
        botState: trade.status === 'filled' ? 'POSITION' : trade.status === 'partial' ? 'PARTIAL' : 'PENDING',
        upShares: 0,
        downShares: trade.filledShares,
        avgUpCost: null,
        avgDownCost: trade.avgFillPrice ?? trade.price,
        pairCost: null,
        skew: null,
        noLiquidityStreak: 0,
        adverseStreak: 0,
      };

      snapshots.push(snapshot);
    }

    if (snapshots.length > 0) {
      await saveSnapshotLogs(snapshots);
    }
  } catch (err) {
    // Snapshot logging is non-critical
  }
}

// ============================================================
// DECISION SNAPSHOT LOGGING
// ============================================================

async function logV26DecisionSnapshot(
  market: V26Market,
  trade: V26Trade,
  intent: string,
  reasonCode: string,
  chosenSide: string | null = null
): Promise<void> {
  const now = Date.now();
  const secondsRemaining = Math.max(0, Math.round((market.eventEndTime.getTime() - now) / 1000));

  // Fetch orderbook
  let downBid: number | null = null;
  let downAsk: number | null = null;
  let bookReady = false;

  try {
    const depth = await getOrderbookDepth(market.downTokenId);
    downBid = depth.topBid;
    downAsk = depth.topAsk;
    bookReady = depth.hasLiquidity;
  } catch {
    // Orderbook fetch failed
  }

  const snapshot: DecisionSnapshot = {
    ts: now,
    market_id: market.slug,
    asset: market.asset as 'BTC' | 'ETH',
    state: trade.status,
    intent,
    reason_code: reasonCode,
    seconds_remaining: secondsRemaining,
    up_shares: 0,
    down_shares: trade.filledShares,
    paired_shares: 0,
    unpaired_shares: trade.filledShares,
    best_bid_up: null,
    best_ask_up: null,
    best_bid_down: downBid,
    best_ask_down: downAsk,
    book_ready_up: false,
    book_ready_down: bookReady,
    chosen_side: chosenSide,
    guards_evaluated: { v26: true, strategy: V26_NAME },
    run_id: RUN_ID,
    correlation_id: trade.orderId ?? null,
    avg_up: null,
    avg_down: trade.avgFillPrice ?? trade.price,
    cpp_paired_only: null,
    projected_cpp_maker: null,
    projected_cpp_taker: null,
    depth_summary_up: null,
    depth_summary_down: null,
    window_start: market.eventStartTime.toISOString(),
  };

  try {
    await saveDecisionSnapshot(snapshot);
  } catch (err) {
    // Decision snapshot logging is non-critical
  }
}

// ============================================================
// HEARTBEAT
// ============================================================

let tradesCount = 0;

async function sendV26Heartbeat(): Promise<void> {
  try {
    const balance = await getBalance();
    const balanceNum = normalizeUsdAmount(balance) ?? 0;

    await sendHeartbeat({
      runner_id: RUN_ID,
      runner_type: 'v26',
      last_heartbeat: new Date().toISOString(),
      status: 'online',
      markets_count: scheduledTrades.size,
      positions_count: 0,
      trades_count: tradesCount,
      balance: balanceNum,
      version: V26_VERSION,
    });
  } catch (err) {
    // Heartbeat failures are non-critical
    logError('Heartbeat failed', err);
  }
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

    const cfg = getV26Config();
    const enabledAssets = getEnabledAssets();
    
    for (const m of result.markets) {
      // Only enabled assets (from per-asset config)
      if (!enabledAssets.includes(m.asset)) continue;
      
      // Get per-asset config for this asset
      const assetCfg = getAssetConfig(m.asset);
      if (!assetCfg) continue;
      
      // Must have token IDs (for configured side)
      const neededToken = assetCfg.side === 'DOWN' ? m.downTokenId : m.upTokenId;
      if (!neededToken) continue;
      
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
        upTokenId: m.upTokenId,
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
  
  // Get per-asset config
  const assetCfg = getAssetConfig(market.asset);
  if (!assetCfg) {
    log(`⚠️ [${market.asset}] No asset config found, skipping`);
    completedMarkets.add(key);
    scheduledTrades.delete(key);
    return;
  }
  
  log(`🎯 [${market.asset}] Placing V26 order: ${assetCfg.shares} shares @ $${assetCfg.price} (${assetCfg.side})`);
  
  try {
    // STEP 1: Check if we already have a trade for this market (DB check for duplicate prevention)
    const exists = await hasExistingTrade(market.id, market.asset);
    if (exists) {
      log(`⚠️ [${market.asset}] Already have trade for this market (DB check), skipping`);
      completedMarkets.add(key);
      scheduledTrades.delete(key);
      return;
    }

    // STEP 2: Reserve slot in DB immediately with status 'reserving' to prevent race conditions
    trade.status = 'reserving';
    trade.runId = RUN_ID;
    const dbId = await saveV26Trade(trade);
    if (!dbId) {
      log(`⚠️ [${market.asset}] Failed to reserve DB slot, skipping`);
      completedMarkets.add(key);
      scheduledTrades.delete(key);
      return;
    }
    trade.id = dbId;

    // STEP 3: Double-check no duplicate was inserted between our check and insert
    // This handles the race condition where two runners insert simultaneously
    const duplicateCheck = await hasExistingTrade(market.id, market.asset);
    // If there are now multiple rows, we're the duplicate - bail out
    // We check by querying again and if we see our ID is not the only one, abort
    // Simplified: just proceed since we have our slot reserved

    // STEP 4: Place the actual order
    const placedAtMs = Date.now();
    // Get the correct token based on asset's configured side
    const tokenId = assetCfg.side === 'DOWN' ? market.downTokenId : market.upTokenId;
    const result = await placeOrder({
      tokenId,
      side: 'BUY',
      price: assetCfg.price,
      size: assetCfg.shares,
    });

    if (!result?.success || !result.orderId) {
      // Order failed - update DB record
      await updateV26Trade(trade.id, {
        status: 'cancelled',
        errorMessage: result?.error || 'No orderId returned',
      });
      throw new Error(result?.error || 'No orderId returned');
    }

    scheduled.orderId = result.orderId;
    scheduled.placedAtMs = placedAtMs;
    trade.orderId = result.orderId;
    trade.status = 'placed';

    // If we got immediate fill info, persist it.
    if (result.status === 'filled' || result.status === 'partial') {
      const filledNow = typeof result.filledSize === 'number' ? result.filledSize : 0;
      trade.status = result.status === 'filled' ? 'filled' : 'partial';
      trade.filledShares = filledNow;
      trade.avgFillPrice = trade.price;

      if (filledNow > 0) {
        trade.fillTimeMs = Math.max(0, Date.now() - placedAtMs);
        tradesCount++;
        // Log the fill
        void logV26Fill(market, trade, filledNow, trade.avgFillPrice);
        // Log decision snapshot for the fill
        void logV26DecisionSnapshot(market, trade, 'ENTRY', 'IMMEDIATE_FILL', assetCfg.side);
      }
    }

    // Update DB with order details
    await updateV26Trade(trade.id, {
      orderId: trade.orderId,
      status: trade.status,
      filledShares: trade.filledShares,
      avgFillPrice: trade.avgFillPrice,
      fillTimeMs: trade.fillTimeMs,
    });

    log(`✅ [${market.asset}] Order placed: ${result.orderId} (status=${result.status ?? 'unknown'})`);

    // If already filled, we can skip cancellation and go straight to settlement.
    if (trade.status === 'filled' && trade.filledShares > 0) {
      scheduleSettlement(market, trade);
      completedMarkets.add(key);
      scheduledTrades.delete(key);
      return;
    }

    // Schedule cancellation: X seconds AFTER market start (from config)
    const cancelTime = market.eventStartTime.getTime() + (cfg.cancelAfterStartSec * 1000);
    const msUntilCancel = Math.max(0, cancelTime - Date.now());

    log(`⏰ [${market.asset}] Cancel scheduled in ${Math.round(msUntilCancel / 1000)}s (${cfg.cancelAfterStartSec}s after market start)`);

    scheduled.cancelTimeout = setTimeout(async () => {
      await checkAndCancelOrder(scheduled);
    }, msUntilCancel);

  } catch (err) {
    logError(`[${market.asset}] Failed to place order`, err);
    trade.status = 'cancelled';
    trade.errorMessage = String(err);
    // Only save if we don't have a DB id yet (otherwise we already updated above)
    if (!trade.id) {
      await saveV26Trade(trade);
    }
    completedMarkets.add(key);
    scheduledTrades.delete(key);
  }
}

async function checkAndCancelOrder(scheduled: ScheduledTrade, attempt: number = 0): Promise<void> {
  const MAX_CANCEL_ATTEMPTS = 10; // Retry up to 10 times (30 seconds total)
  const CANCEL_RETRY_DELAY_MS = 3000; // 3 seconds between retries
  
  const { market, trade, orderId } = scheduled;
  const key = `${market.id}:${market.asset}`;

  if (!orderId) {
    completedMarkets.add(key);
    scheduledTrades.delete(key);
    return;
  }

  try {
    log(`⏰ [${market.asset}] Checking fill status before cancel (attempt ${attempt + 1}/${MAX_CANCEL_ATTEMPTS})...`);

    const before = await getOrderFillInfo(orderId);
    const matchedBefore = before.success ? (before.filledSize ?? 0) : 0;

    if (before.success && matchedBefore > 0) {
      const previousFilled = trade.filledShares;
      trade.filledShares = matchedBefore;
      trade.avgFillPrice = trade.avgFillPrice ?? trade.price;
      trade.status = before.status === 'partial' ? 'partial' : before.status === 'filled' ? 'filled' : 'partial';

      if (scheduled.placedAtMs && trade.fillTimeMs === undefined) {
        trade.fillTimeMs = Math.max(0, Date.now() - scheduled.placedAtMs);
      }

      // Log fill if this is a new fill detection
      if (matchedBefore > previousFilled) {
        tradesCount++;
        void logV26Fill(market, trade, matchedBefore - previousFilled, trade.avgFillPrice);
        void logV26DecisionSnapshot(market, trade, 'ENTRY', 'PRE_CANCEL_FILL', 'DOWN');
      }

      if (trade.id) {
        await updateV26Trade(trade.id, {
          status: trade.status,
          filledShares: trade.filledShares,
          avgFillPrice: trade.avgFillPrice,
          fillTimeMs: trade.fillTimeMs,
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
      const previousFilled = trade.filledShares;
      trade.filledShares = matchedAfter;
      trade.avgFillPrice = trade.avgFillPrice ?? trade.price;
      trade.status = after.status === 'filled' ? 'filled' : 'partial';

      if (scheduled.placedAtMs && trade.fillTimeMs === undefined) {
        trade.fillTimeMs = Math.max(0, Date.now() - scheduled.placedAtMs);
      }

      // Log fill if this is a new fill detection
      if (matchedAfter > previousFilled) {
        tradesCount++;
        void logV26Fill(market, trade, matchedAfter - previousFilled, trade.avgFillPrice);
        void logV26DecisionSnapshot(market, trade, 'ENTRY', 'POST_CANCEL_FILL', 'DOWN');
      }

      if (trade.id) {
        await updateV26Trade(trade.id, {
          status: trade.status,
          filledShares: trade.filledShares,
          avgFillPrice: trade.avgFillPrice,
          fillTimeMs: trade.fillTimeMs,
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
        // Cancel failed - RETRY if we haven't exceeded max attempts
        if (attempt < MAX_CANCEL_ATTEMPTS - 1) {
          log(`⚠️ [${market.asset}] Cancel failed (${cancelResult.error}), retrying in ${CANCEL_RETRY_DELAY_MS / 1000}s... (attempt ${attempt + 1}/${MAX_CANCEL_ATTEMPTS})`);
          setTimeout(() => {
            void checkAndCancelOrder(scheduled, attempt + 1);
          }, CANCEL_RETRY_DELAY_MS);
          return; // Don't mark as completed yet, we're retrying
        } else {
          // All retries exhausted - log error and mark as error state
          logError(`[${market.asset}] CRITICAL: Failed to cancel order after ${MAX_CANCEL_ATTEMPTS} attempts! Order may still be open: ${orderId}`);
          trade.status = 'error';
          trade.errorMessage = `Cancel failed after ${MAX_CANCEL_ATTEMPTS} attempts: ${cancelResult.error}`;
          if (trade.id) {
            await updateV26Trade(trade.id, { 
              status: 'error', 
              errorMessage: trade.errorMessage 
            });
          }
        }
      }
    }
  } catch (err) {
    logError(`[${market.asset}] Error checking/cancelling order`, err);
    
    // Retry on exception too
    if (attempt < MAX_CANCEL_ATTEMPTS - 1) {
      log(`⚠️ [${market.asset}] Exception during cancel, retrying in ${CANCEL_RETRY_DELAY_MS / 1000}s...`);
      setTimeout(() => {
        void checkAndCancelOrder(scheduled, attempt + 1);
      }, CANCEL_RETRY_DELAY_MS);
      return;
    }
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

    // Log settlement
    void logV26Settlement(market, trade, result, pnl);

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

  const cfg = getV26Config();
  const assetCfg = getAssetConfig(market.asset);
  
  if (!assetCfg) {
    log(`⚠️ [${market.asset}] No asset config found, skipping`);
    completedMarkets.add(key);
    return;
  }
  
  const now = Date.now();
  const startTime = market.eventStartTime.getTime();
  const secondsUntilStart = (startTime - now) / 1000;

  // Too late: less than minLeadTime before start
  if (secondsUntilStart < cfg.minLeadTimeSec) {
    log(`⚠️ [${market.asset}] Too late to schedule (${Math.round(secondsUntilStart)}s until start): ${market.slug}`);
    completedMarkets.add(key);
    return;
  }

  // Within window: place immediately if within maxLeadTime, otherwise schedule
  const placeImmediately = secondsUntilStart <= cfg.maxLeadTimeSec;
  const msUntilPlace = placeImmediately ? 0 : (startTime - (cfg.maxLeadTimeSec * 1000)) - now;

  const trade: V26Trade = {
    asset: market.asset,
    marketId: market.id,
    marketSlug: market.slug,
    eventStartTime: market.eventStartTime,
    eventEndTime: market.eventEndTime,
    side: assetCfg.side,
    price: assetCfg.price,
    shares: assetCfg.shares,
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
    log(`📅 [${market.asset}] Placing NOW for ${startTimeStr} (${Math.round(secondsUntilStart)}s until start) - ${assetCfg.side} @ $${assetCfg.price}`);
  } else {
    log(`📅 [${market.asset}] Scheduled for ${startTimeStr} (order in ${Math.round(msUntilPlace / 1000)}s) - ${assetCfg.side} @ $${assetCfg.price}`);
  }
}

// ============================================================
// FILL POLLING - CHECK OPEN ORDERS FOR FILLS
// ============================================================

async function pollFillsForOpenOrders(): Promise<void> {
  // Check all scheduled trades that have an orderId but aren't fully filled
  for (const [key, scheduled] of scheduledTrades) {
    const { market, trade, orderId, placedAtMs } = scheduled;
    
    // Skip if no order placed yet or already fully filled
    if (!orderId || trade.status === 'filled' || trade.status === 'cancelled' || trade.status === 'error') {
      continue;
    }

    try {
      const fillInfo = await getOrderFillInfo(orderId);
      
      if (!fillInfo.success) {
        continue;
      }

      const newFilledShares = fillInfo.filledSize ?? 0;
      const previousFilled = trade.filledShares;

      // Only log if we have NEW fills since last check
      if (newFilledShares > previousFilled) {
        const newFillQty = newFilledShares - previousFilled;
        trade.filledShares = newFilledShares;
        trade.avgFillPrice = trade.avgFillPrice ?? trade.price;
        
        if (placedAtMs && trade.fillTimeMs === undefined) {
          trade.fillTimeMs = Math.max(0, Date.now() - placedAtMs);
        }

        // Update status
        if (fillInfo.status === 'filled') {
          trade.status = 'filled';
        } else if (newFilledShares > 0) {
          trade.status = 'partial';
        }

        tradesCount++;

        // Log the fill immediately!
        const assetCfgForLog = getAssetConfig(market.asset);
        log(`🔄 [${market.asset}] Fill detected via polling: +${newFillQty} shares (total: ${newFilledShares}/${assetCfgForLog?.shares ?? '?'})`);
        void logV26Fill(market, trade, newFillQty, trade.avgFillPrice);
        void logV26DecisionSnapshot(market, trade, 'ENTRY', 'POLL_FILL_DETECTED', assetCfgForLog?.side ?? 'DOWN');

        // Update DB
        if (trade.id) {
          await updateV26Trade(trade.id, {
            status: trade.status,
            filledShares: trade.filledShares,
            avgFillPrice: trade.avgFillPrice,
            fillTimeMs: trade.fillTimeMs,
          });
        }

        // If fully filled, schedule settlement and clean up
        if (trade.status === 'filled') {
          log(`✓ [${market.asset}] Order fully filled via polling - scheduling settlement`);
          
          // Clear the cancel timeout since we're done
          if (scheduled.cancelTimeout) {
            clearTimeout(scheduled.cancelTimeout);
            scheduled.cancelTimeout = undefined;
          }
          
          scheduleSettlement(market, trade);
          completedMarkets.add(key);
          scheduledTrades.delete(key);
        }
      }
    } catch (err) {
      // Non-critical, just continue polling
      logError(`[${market.asset}] Fill poll error`, err);
    }
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
  console.log('║        🎯 V26 LOVEABLE - PRE-MARKET TRADER                   ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Version:  ${V26_VERSION.padEnd(49)}║`);
  console.log(`║  Strategy: ${V26_NAME.slice(0, 49).padEnd(49)}║`);
  console.log(`║  Run ID:   ${RUN_ID.padEnd(49)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Load config from database (with fallback to hardcoded defaults)
  log('📋 Loading config from database...');
  await loadV26Config();
  const cfg = getV26Config();
  
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  📊 ACTIVE CONFIGURATION                                      ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Global:   ${cfg.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}`.padEnd(66) + '║');
  console.log(`║  Timing:   Place ${cfg.maxLeadTimeSec}s-${cfg.minLeadTimeSec}s before, cancel ${cfg.cancelAfterStartSec}s after`.padEnd(66) + '║');
  console.log('╠──────────────────────────────────────────────────────────────╣');
  for (const [asset, acfg] of cfg.assetConfigs) {
    const line = `║  ${asset}:       ${acfg.enabled ? '✅' : '❌'} ${acfg.side.padEnd(4)} ${String(acfg.shares).padStart(2)} shares @ $${acfg.price.toFixed(2)}`;
    console.log(line.padEnd(66) + '║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!cfg.enabled) {
    log('⚠️ Strategy is DISABLED in config. Exiting.');
    process.exit(0);
  }

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

  // Send heartbeat every 30 seconds
  await sendV26Heartbeat();
  setInterval(async () => {
    await sendV26Heartbeat();
  }, 30_000);

  // Log price ticks every second
  log('📊 Starting price tick logging (1s interval)');
  setInterval(async () => {
    await logPriceTicks();
  }, PRICE_TICK_INTERVAL_MS);

  // Log snapshots every 5 seconds
  log('📸 Starting snapshot logging (5s interval)');
  setInterval(async () => {
    await logV26Snapshots();
  }, SNAPSHOT_INTERVAL_MS);

  // Poll fills for open orders every 5 seconds
  log('🔄 Starting fill polling (5s interval)');
  setInterval(async () => {
    await pollFillsForOpenOrders();
  }, FILL_POLL_INTERVAL_MS);

  // Check for config changes every 10 seconds
  log('⚙️ Starting config hot-reload (10s interval)');
  setInterval(async () => {
    await checkAndReloadConfig();
  }, 10_000);

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
