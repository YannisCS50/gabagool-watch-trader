/**
 * V29 Response-Based Strategy - Main Runner
 * 
 * STRATEGY SUMMARY:
 * 1. Binance tick ≥$6 in 300ms window → SIGNAL
 * 2. Entry: Maker-biased limit order at best_bid + buffer
 * 3. Exit: Response-based (target, exhaustion, adverse, timeout)
 * 4. Asymmetric: UP and DOWN have different parameters
 * 
 * CRITICAL: Exit based on Polymarket price response, NOT fixed time!
 */

// HTTP agent must be imported first
import './http-agent.js';

import 'dotenv/config';
import { randomUUID } from 'crypto';

import { Asset, V29Config, DEFAULT_CONFIG, BINANCE_SYMBOLS } from './config.js';
import type { MarketInfo, PriceState, Signal, ActivePosition, SignalLog, TickLog } from './types.js';
import { checkSignal, processTick, resetSignalState } from './signal-detector.js';
import { checkExit, createPositionTracker, ExitType } from './exit-monitor.js';
import { initDb, loadConfig, saveSignal, queueTick, queueLog, sendHeartbeat, flushAll } from './db.js';

// External dependencies
import { startBinanceFeed, stopBinanceFeed } from '../v29/binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from '../v29/chainlink.js';
import { fetchMarketOrderbook } from '../v29/orderbook.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache } from '../v29/trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { config as pmConfig } from '../config.js';
import { acquireLease, releaseLease, isRunnerActive } from '../v29/lease.js';
import { setRunnerIdentity } from '../order-guard.js';
import { fetchPositions } from '../positions-sync.js';
import { startUserChannel, stopUserChannel, isUserChannelConnected, type TradeEvent, type OrderEvent } from '../v29/user-ws.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v29r-${Date.now().toString(36)}`;
let isRunning = false;
let config: V29Config = { ...DEFAULT_CONFIG };

// Markets by asset
const markets = new Map<Asset, MarketInfo>();

// Price state by asset
const priceState: Record<Asset, PriceState> = {
  BTC: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  ETH: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  SOL: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
  XRP: { binance: null, binanceTs: 0, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastOrderbookUpdate: 0 },
};

// Active positions (one per asset at most)
const activePositions = new Map<Asset, ActivePosition>();

// Prevent duplicate/concurrent ENTRY attempts per asset (critical to avoid order spam)
const entryInFlight = new Set<Asset>();

// Prevent duplicate/concurrent exit attempts per asset
const exitInFlight = new Set<Asset>();
const nextExitAttemptAt: Record<Asset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };

// Cooldowns
const lastExitTime: Record<Asset, number> = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };

// Stats
let signalCount = 0;
let tradeCount = 0;
let exitCount = 0;
let totalPnl = 0;

// Intervals
let orderbookPollInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let marketRefreshInterval: NodeJS.Timeout | null = null;
let configRefreshInterval: NodeJS.Timeout | null = null;
let positionSyncInterval: NodeJS.Timeout | null = null;

// ============================================
// LOGGING (async, non-blocking)
// ============================================

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29R] ${msg}`);
  queueLog(RUN_ID, 'info', 'system', msg, undefined, data);
}

function logAsset(asset: Asset, msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29R] [${asset}] ${msg}`);
  queueLog(RUN_ID, 'info', asset, msg, asset, data);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29R] ❌ ${msg}`, err ?? '');
  queueLog(RUN_ID, 'error', 'error', msg, undefined, err ? { error: String(err) } : undefined);
}

// ============================================
// MARKET LOADING
// ============================================

async function fetchMarkets(): Promise<void> {
  const backendUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const backendKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  
  if (!backendUrl || !backendKey) {
    log('⚠️ No backend URL configured');
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
      log(`Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      const now = Date.now();
      
      for (const m of data.markets) {
        if (!m.asset || !m.upTokenId || !m.downTokenId) continue;
        
        const asset = m.asset as Asset;
        const slug = String(m.slug || '');
        
        // Only 15m markets
        if (!slug.toLowerCase().includes('-15m-')) continue;
        
        // Check end time - skip expired markets
        let endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();
        if (!Number.isFinite(endMs)) continue;
        if (endMs <= now) continue;
        
        // CRITICAL: Check start time - only trade ACTIVE markets, not future ones
        let startMs = new Date(m.eventStartTime || m.event_start_time || m.startTime || '').getTime();
        if (Number.isFinite(startMs) && startMs > now) {
          // Market hasn't started yet - skip
          continue;
        }
        
        const existingMarket = markets.get(asset);
        const isNewMarket = !existingMarket || existingMarket.slug !== slug;
        
        const marketInfo: MarketInfo = {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          startTime: new Date(startMs || now),
          endTime: new Date(endMs),
        };
        
        markets.set(asset, marketInfo);
        
        if (isNewMarket) {
          log(`📊 ${asset} NEW: ${slug}`, { slug, strikePrice: marketInfo.strikePrice });
          
          // Reset signal state for new market
          resetSignalState(asset);
          
          // Clear active position if market changed
          if (activePositions.has(asset)) {
            log(`⚠️ ${asset} position cleared due to market change`);
            activePositions.delete(asset);
          }
          
          // Update pre-signed cache
          void updateMarketCache(asset, m.upTokenId, m.downTokenId);
          
          // Fetch initial orderbook
          void fetchOrderbook(asset, marketInfo);
        }
      }
      
      log(`Active: ${markets.size} markets`);
    }
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function fetchOrderbook(asset: Asset, market: MarketInfo): Promise<void> {
  try {
    const book = await fetchMarketOrderbook(market);

    let didUpdate = false;

    if (book.upBestAsk !== undefined) {
      priceState[asset].upBestAsk = book.upBestAsk;
      didUpdate = true;
    }
    if (book.upBestBid !== undefined) {
      priceState[asset].upBestBid = book.upBestBid;
      didUpdate = true;
    }
    if (book.downBestAsk !== undefined) {
      priceState[asset].downBestAsk = book.downBestAsk;
      didUpdate = true;
    }
    if (book.downBestBid !== undefined) {
      priceState[asset].downBestBid = book.downBestBid;
      didUpdate = true;
    }

    if (didUpdate) {
      priceState[asset].lastOrderbookUpdate = Date.now();
    }
  } catch {
    // If fetchMarketOrderbook throws (unexpected), keep previous book values.
  }
}

async function pollAllOrderbooks(): Promise<void> {
  const promises: Promise<void>[] = [];
  
  for (const [asset, market] of markets) {
    promises.push(fetchOrderbook(asset, market));
  }
  
  await Promise.allSettled(promises);
}

// ============================================
// BINANCE PRICE HANDLER (HOT PATH)
// ============================================

function handleBinancePrice(asset: Asset, price: number, timestamp: number): void {
  if (!isRunning || !isRunnerActive()) return;
  
  const now = Date.now();
  const market = markets.get(asset);
  const state = priceState[asset];
  
  // Update state
  state.binance = price;
  state.binanceTs = timestamp;
  
  // Process tick and get delta from previous tick (tick-to-tick like V29)
  const { hasPrevious, delta, direction } = processTick(asset, price);
  
  // Log tick (async)
  queueTick({
    run_id: RUN_ID,
    asset,
    ts: now,
    binance_price: price,
    up_best_bid: state.upBestBid ?? undefined,
    up_best_ask: state.upBestAsk ?? undefined,
    down_best_bid: state.downBestBid ?? undefined,
    down_best_ask: state.downBestAsk ?? undefined,
    market_slug: market?.slug,
    strike_price: market?.strikePrice,
    signal_triggered: false,
  });
  
  // Check for active position OR entry in progress (exit monitoring is done separately)
  if (activePositions.has(asset) || entryInFlight.has(asset)) {
    // Position exists or entry is pending - update price and check exit
    if (activePositions.has(asset)) {
      checkPositionExit(asset);
    }
    return;
  }
  
  // Check for signal on every tick (tick-to-tick comparison)
  if (hasPrevious) {
    checkForSignal(asset, delta, direction);
  }
}

// ============================================
// SIGNAL CHECKING
// ============================================

function checkForSignal(asset: Asset, delta: number, direction: 'UP' | 'DOWN' | null): void {
  const market = markets.get(asset);
  const state = priceState[asset];
  const now = Date.now();
  
  // Check cooldown
  const inCooldown = (now - lastExitTime[asset]) < config.cooldown_after_exit_ms;
  
  // Check exposure
  let currentExposure = 0;
  for (const pos of activePositions.values()) {
    currentExposure += pos.totalCost;
  }
  
  const result = checkSignal(
    asset,
    config,
    state,
    market,
    activePositions.has(asset),
    inCooldown,
    currentExposure,
    delta,
    direction,
    (msg, data) => logAsset(asset, msg, data)
  );
  
  if (!result.triggered) {
    // Log skip reasons for analysis (skip delta_too_small to avoid spam)
    if (result.skipReason && result.skipReason !== 'delta_too_small' && result.skipReason !== 'disabled' && result.skipReason !== 'no_previous_tick') {
      logAsset(asset, `SKIP: ${result.skipReason} ${result.skipDetails ?? ''}`, {
        skipReason: result.skipReason,
        skipDetails: result.skipDetails,
      });
    }
    return;
  }
  
  // Signal triggered!
  signalCount++;
  
  const signal = result.signal!;
  
  // Execute entry (async, non-blocking)
  void executeEntry(asset, signal, market!);
}

// ============================================
// ENTRY EXECUTION
// ============================================

async function executeEntry(asset: Asset, signal: Signal, market: MarketInfo): Promise<void> {
  // CRITICAL: Lock immediately to prevent concurrent entries during async operations
  if (entryInFlight.has(asset)) {
    signal.status = 'skipped';
    signal.skip_reason = 'entry_already_in_flight';
    return;
  }
  entryInFlight.add(asset);
  
  const state = priceState[asset];
  const direction = signal.direction;
  
  // Wrap everything in try-finally to ALWAYS release the lock
  try {
    // CRITICAL: Check market is currently active (started and not expired)
    const now = Date.now();
    const msFromStart = now - market.startTime.getTime();
    const msToExpiry = market.endTime.getTime() - now;
    
    // Market hasn't started yet
    if (msFromStart < 0) {
      logAsset(asset, `⚠️ SKIP: market starts in ${Math.abs(msFromStart / 1000).toFixed(0)}s`);
      signal.status = 'skipped';
      signal.skip_reason = 'market_not_started';
      void saveSignalLog(signal, state);
      return;
    }
    
    if (msToExpiry <= 0) {
      logAsset(asset, `⚠️ SKIP: market expired ${Math.abs(msToExpiry / 1000).toFixed(0)}s ago`);
      signal.status = 'skipped';
      signal.skip_reason = 'market_expired';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Don't trade in last 30 seconds (orderbook often empty)
    if (msToExpiry < 30_000) {
      logAsset(asset, `⚠️ SKIP: too close to expiry (${(msToExpiry / 1000).toFixed(0)}s remaining)`);
      signal.status = 'skipped';
      signal.skip_reason = 'too_close_to_expiry';
      void saveSignalLog(signal, state);
      return;
    }
    
    const bestBid = direction === 'UP' ? state.upBestBid : state.downBestBid;
    const bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
    
    if (!bestBid || !bestAsk) {
      signal.status = 'failed';
      signal.skip_reason = 'no_orderbook_at_entry';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Calculate entry price (maker-biased)
    const buffer = config.entry_price_buffer_cents / 100;
    const entryPrice = Math.round((bestBid + buffer) * 100) / 100;
    
    // Validate slippage
    if (entryPrice > bestAsk + (config.max_entry_slippage_cents / 100)) {
      signal.status = 'skipped';
      signal.skip_reason = 'slippage_too_high';
      void saveSignalLog(signal, state);
      return;
    }
    
    const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
    const shares = config.shares_per_trade;
    
    logAsset(asset, `📤 ENTRY: ${direction} ${shares} @ ${(entryPrice * 100).toFixed(1)}¢`, {
      signalId: signal.id,
      entryPrice,
      shares,
    });
    
    signal.order_submit_ts = Date.now();
    
    const result = await placeBuyOrder(tokenId, entryPrice, shares, asset, direction);
    
    if (!result.success) {
      signal.status = 'failed';
      signal.skip_reason = result.error ?? 'order_failed';
      void saveSignalLog(signal, state);
      logAsset(asset, `❌ ENTRY FAILED: ${result.error}`);
      return;
    }
    
    const filledSize = result.filledSize ?? shares;
    const avgPrice = result.avgPrice ?? entryPrice;
    
    if (filledSize <= 0) {
      signal.status = 'failed';
      signal.skip_reason = 'no_fill';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Create active position
    const position = createPositionTracker(
      signal,
      asset,
      direction,
      market.slug,
      tokenId,
      filledSize,
      avgPrice,
      result.orderId
    );
    
    activePositions.set(asset, position);
    tradeCount++;
    
    signal.status = 'filled';
    signal.entry_price = avgPrice;
    signal.shares = filledSize;
    signal.fill_ts = Date.now();
    signal.order_id = result.orderId;
    
    logAsset(asset, `✅ FILLED: ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ | latency=${Date.now() - signal.signal_ts}ms`, {
      signalId: signal.id,
      filledSize,
      avgPrice,
      latency: Date.now() - signal.signal_ts,
    });
    
    void saveSignalLog(signal, state);
    
    // Start exit monitoring
    startExitMonitor(asset, position);
    
  } catch (err) {
    signal.status = 'failed';
    signal.skip_reason = String(err);
    void saveSignalLog(signal, state);
    logError(`Entry error for ${asset}`, err);
  } finally {
    // ALWAYS release the lock when done (success or failure)
    entryInFlight.delete(asset);
  }
}

// ============================================
// EXIT MONITORING (CRITICAL)
// ============================================

function startExitMonitor(asset: Asset, position: ActivePosition): void {
  // Clear any existing monitor
  if (position.monitorInterval) {
    clearInterval(position.monitorInterval);
  }
  
  // Schedule price tracking for analytics
  schedulePriceTracking(asset, position);
  
  // Start exit check loop
  position.monitorInterval = setInterval(() => {
    checkPositionExit(asset);
  }, config.exit_monitor_interval_ms);
}

function checkPositionExit(asset: Asset): void {
  // Prevent spamming exit logs / duplicate exit calls while an exit is in progress
  if (exitInFlight.has(asset)) return;

  const now = Date.now();
  if (now < (nextExitAttemptAt[asset] || 0)) return;

  const position = activePositions.get(asset);
  if (!position) return;

  const state = priceState[asset];

  const decision = checkExit(
    position,
    config,
    state,
    (msg, data) => logAsset(asset, msg, data)
  );

  if (decision.shouldExit) {
    void executeExit(asset, position, decision.type!, decision.reason ?? '', decision.unrealizedPnl ?? 0);
  }
}

// ============================================
// EXIT EXECUTION
// ============================================

async function executeExit(
  asset: Asset,
  position: ActivePosition,
  exitType: ExitType,
  exitReason: string,
  unrealizedPnl: number
): Promise<void> {
  // Guard against concurrent exit attempts (interval + price-tick path)
  if (exitInFlight.has(asset)) return;
  exitInFlight.add(asset);

  try {
    // Stop monitoring
    if (position.monitorInterval) {
      clearInterval(position.monitorInterval);
      position.monitorInterval = undefined;
    }

    const state = priceState[asset];
    const market = markets.get(asset);
    const signal = position.signal;

    // CRITICAL: Check if market has expired - if so, we cannot sell, must wait for claim
    const now = Date.now();
    const positionMarketSlug = position.marketSlug;
    
    // Extract epoch from slug (e.g., "btc-updown-15m-1768596300" -> 1768596300)
    const slugParts = positionMarketSlug.split('-');
    const marketEndEpoch = parseInt(slugParts[slugParts.length - 1], 10) * 1000;
    
    if (Number.isFinite(marketEndEpoch) && now >= marketEndEpoch) {
      logAsset(asset, `⏰ MARKET EXPIRED: position will be settled via claim, removing from active tracking`, {
        positionId: position.id,
        marketSlug: positionMarketSlug,
        marketEndEpoch,
        expiredAgo: `${((now - marketEndEpoch) / 1000).toFixed(0)}s`,
      });
      
      signal.exit_type = 'expired';
      signal.exit_reason = 'market_expired_before_exit';
      signal.exit_ts = now;
      void saveSignalLog(signal, state);
      
      // Remove position so new trades can happen
      activePositions.delete(asset);
      lastExitTime[asset] = now;
      
      return;
    }

    const bestBid = position.direction === 'UP' ? state.upBestBid : state.downBestBid;

    if (!bestBid || !market) {
      // CRITICAL: Do NOT delete position - we still hold shares!
      // Restart monitoring and retry later when orderbook is available
      logAsset(asset, `⚠️ EXIT: No bid available, retrying in 500ms`, {
        positionId: position.id,
        hasMarket: !!market,
        hasBid: !!bestBid,
        lastOrderbookUpdate: state.lastOrderbookUpdate,
      });
      
      // Backoff and retry
      nextExitAttemptAt[asset] = Date.now() + 500;
      position.monitorInterval = setInterval(() => {
        checkPositionExit(asset);
      }, config.exit_monitor_interval_ms);
      
      return;
    }

    // Sell at market (use bid)
    const sellPrice = Math.floor(bestBid * 100) / 100;

    logAsset(asset, `📤 EXIT: ${position.direction} ${position.shares} @ ${(sellPrice * 100).toFixed(1)}¢ | type=${exitType}`, {
      positionId: position.id,
      exitType,
      exitReason,
      sellPrice,
      unrealizedPnl,
    });

    const result = await placeSellOrder(
      position.tokenId,
      sellPrice,
      position.shares,
      asset,
      position.direction
    );

    // If we couldn't even post the sell order, check if market expired
    if (!result.success) {
      const errMsg = result.error || 'Unknown error (no error message returned)';
      
      // Check if this is a balance/allowance error which often means market expired
      const isExpiredError = errMsg.includes('balance') || errMsg.includes('allowance');
      
      // Re-check market expiry (might have just expired)
      const nowCheck = Date.now();
      if (Number.isFinite(marketEndEpoch) && nowCheck >= marketEndEpoch) {
        logAsset(asset, `⏰ MARKET EXPIRED during exit attempt: position will be settled via claim`, {
          positionId: position.id,
          error: errMsg,
        });
        
        signal.exit_type = 'expired';
        signal.exit_reason = `market_expired: ${errMsg}`;
        signal.exit_ts = nowCheck;
        void saveSignalLog(signal, state);
        
        activePositions.delete(asset);
        lastExitTime[asset] = nowCheck;
        
        return;
      }
      
      logAsset(asset, `❌ EXIT FAILED: ${errMsg}`, {
        positionId: position.id,
        exitType,
        sellPrice,
        shares: position.shares,
        tokenId: position.tokenId,
        latencyMs: result.latencyMs,
        isExpiredError,
      });

      signal.exit_type = 'error';
      signal.exit_reason = `sell_failed: ${errMsg}`;
      void saveSignalLog(signal, state);

      // If it looks like an expired market error, verify with position sync before removing
      if (isExpiredError) {
        logAsset(asset, `🔍 Balance/allowance error - syncing live positions to verify...`);
        
        try {
          // Fetch actual positions from Polymarket API
          const livePositions = await fetchPositions(pmConfig.polymarket.address);
          
          // Find if we still have this position
          const matchingPosition = livePositions.find(p => 
            p.asset === position.tokenId || 
            (p.eventSlug && position.marketSlug.includes(p.eventSlug))
          );
          
          if (matchingPosition && matchingPosition.size > 0.1) {
            // We still have shares! Update our position and retry
            logAsset(asset, `📊 POSITION STILL EXISTS: ${matchingPosition.size.toFixed(2)} shares @ ${matchingPosition.outcome}`, {
              apiShares: matchingPosition.size,
              localShares: position.shares,
              curPrice: matchingPosition.curPrice,
            });
            
            // Update local position with actual shares from API
            position.shares = matchingPosition.size;
            
            // Backoff and retry with corrected shares
            nextExitAttemptAt[asset] = Date.now() + 2000;
            position.monitorInterval = setInterval(() => {
              checkPositionExit(asset);
            }, config.exit_monitor_interval_ms);
            
            return;
          } else {
            // Position really is gone (redeemed/expired/sold elsewhere)
            logAsset(asset, `🛑 Position confirmed GONE from Polymarket API - removing from tracking`, {
              searchedToken: position.tokenId,
              searchedSlug: position.marketSlug,
              foundPositions: livePositions.length,
            });
            activePositions.delete(asset);
            lastExitTime[asset] = Date.now();
            return;
          }
        } catch (syncErr) {
          logAsset(asset, `⚠️ Position sync failed, keeping position for retry: ${syncErr}`);
          // Backoff and retry
          nextExitAttemptAt[asset] = Date.now() + 3000;
          position.monitorInterval = setInterval(() => {
            checkPositionExit(asset);
          }, config.exit_monitor_interval_ms);
          return;
        }
      }

      // Backoff + retry for other errors
      nextExitAttemptAt[asset] = Date.now() + 1000;
      position.monitorInterval = setInterval(() => {
        checkPositionExit(asset);
      }, config.exit_monitor_interval_ms);

      return;
    }

    const exitTs = Date.now();
    const holdTimeMs = exitTs - position.entryTime;

    const actualExitPrice = result.avgPrice ?? sellPrice;
    const soldShares = result.filledSize ?? position.shares;

    // Calculate P&L
    const grossPnl = (actualExitPrice - position.entryPrice) * soldShares;
    const fees = soldShares * actualExitPrice * 0.001; // ~0.1% fee estimate
    const netPnl = grossPnl - fees;

    // Update stats
    exitCount++;
    totalPnl += netPnl;

    // Update signal
    signal.status = 'exited';
    signal.exit_price = actualExitPrice;
    signal.exit_ts = exitTs;
    signal.exit_type = exitType;
    signal.exit_reason = exitReason;
    signal.gross_pnl = grossPnl;
    signal.fees = fees;
    signal.net_pnl = netPnl;

    void saveSignalLog(signal, state);

    logAsset(asset, `✅ EXITED: ${position.direction} | type=${exitType} | hold=${holdTimeMs}ms | PnL=${(netPnl * 100).toFixed(2)}¢`, {
      positionId: position.id,
      exitType,
      holdTimeMs,
      grossPnl,
      netPnl,
    });

    // Remove position
    activePositions.delete(asset);
    lastExitTime[asset] = exitTs;
  } catch (err) {
    logError(`Exit error for ${asset}`, err);

    // Backoff + keep position so we can retry exiting
    nextExitAttemptAt[asset] = Date.now() + 1500;

    if (activePositions.has(asset)) {
      position.monitorInterval = setInterval(() => {
        checkPositionExit(asset);
      }, config.exit_monitor_interval_ms);
    } else {
      lastExitTime[asset] = Date.now();
    }
  } finally {
    exitInFlight.delete(asset);
  }
}

// ============================================
// PRICE TRACKING FOR ANALYTICS
// ============================================

function schedulePriceTracking(asset: Asset, position: ActivePosition): void {
  const signal = position.signal;
  const state = priceState[asset];
  
  // Track price at +1s, +2s, +3s, +5s
  const trackAt = [1000, 2000, 3000, 5000];
  
  for (const delay of trackAt) {
    setTimeout(() => {
      const currentBid = position.direction === 'UP' ? state.upBestBid : state.downBestBid;
      
      if (currentBid) {
        if (delay === 1000) signal.price_at_1s = currentBid;
        if (delay === 2000) signal.price_at_2s = currentBid;
        if (delay === 3000) signal.price_at_3s = currentBid;
        if (delay === 5000) signal.price_at_5s = currentBid;
      }
    }, delay);
  }
}

// ============================================
// SAVE SIGNAL LOG
// ============================================

async function saveSignalLog(signal: Signal, state: PriceState): Promise<void> {
  const logRecord: SignalLog = {
    id: signal.id,
    run_id: RUN_ID,
    asset: signal.asset,
    direction: signal.direction,
    
    binance_price: signal.binance_price,
    binance_delta: signal.binance_delta,
    binance_ts: signal.binance_ts,
    
    share_price_t0: signal.share_price_t0,
    spread_t0: signal.spread_t0,
    best_bid_t0: (signal.direction === 'UP' ? state.upBestBid : state.downBestBid) ?? 0,
    best_ask_t0: (signal.direction === 'UP' ? state.upBestAsk : state.downBestAsk) ?? 0,
    
    market_slug: signal.market_slug,
    strike_price: signal.strike_price,
    
    status: signal.status,
    skip_reason: signal.skip_reason,
    entry_price: signal.entry_price,
    exit_price: signal.exit_price,
    shares: signal.shares,
    
    signal_ts: signal.signal_ts,
    decision_ts: signal.decision_ts,
    fill_ts: signal.fill_ts,
    exit_ts: signal.exit_ts,
    
    exit_type: signal.exit_type,
    exit_reason: signal.exit_reason,
    
    gross_pnl: signal.gross_pnl,
    fees: signal.fees,
    net_pnl: signal.net_pnl,
    
    price_at_1s: signal.price_at_1s,
    price_at_2s: signal.price_at_2s,
    price_at_3s: signal.price_at_3s,
    price_at_5s: signal.price_at_5s,
    
    decision_latency_ms: signal.decision_ts - signal.signal_ts,
    order_latency_ms: signal.order_submit_ts ? signal.order_submit_ts - signal.decision_ts : undefined,
    fill_latency_ms: signal.fill_ts && signal.order_submit_ts ? signal.fill_ts - signal.order_submit_ts : undefined,
    exit_latency_ms: signal.exit_ts && signal.fill_ts ? signal.exit_ts - signal.fill_ts : undefined,
  };
  
  await saveSignal(logRecord);
}

// ============================================
// CHAINLINK HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  priceState[asset].chainlink = price;
}

// ============================================
// HEARTBEAT
// ============================================

async function sendStatusHeartbeat(): Promise<void> {
  const positionsData: Record<string, unknown> = {};
  
  for (const [asset, pos] of activePositions) {
    positionsData[asset] = {
      direction: pos.direction,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      holdTime: Date.now() - pos.entryTime,
    };
  }
  
  await sendHeartbeat(RUN_ID, isRunning ? 'running' : 'stopped', {
    signals: signalCount,
    trades: tradeCount,
    exits: exitCount,
    totalPnl,
    activePositions: activePositions.size,
    positions: positionsData,
    markets: markets.size,
    config: {
      signal_delta_usd: config.signal_delta_usd,
      up_target: config.up.target_profit_cents_min,
      down_target: config.down.target_profit_cents_min,
    },
  });
}

// ============================================
// CONFIG REFRESH
// ============================================

async function refreshConfig(): Promise<void> {
  try {
    const dbConfig = await loadConfig();
    if (dbConfig) {
      const oldSpread = config.max_spread_cents;
      const oldDelta = config.signal_delta_usd;
      
      // Merge DB values into config
      config = { ...DEFAULT_CONFIG, ...dbConfig } as V29Config;
      
      // Log if important settings changed
      if (dbConfig.max_spread_cents !== oldSpread || dbConfig.signal_delta_usd !== oldDelta) {
        log(`🔄 Config updated: spread=${config.max_spread_cents}¢, delta=$${config.signal_delta_usd}`);
      }
    }
  } catch (err) {
    logError('Config refresh failed', err);
  }
}

// ============================================
// USER CHANNEL HANDLERS (REALTIME FILL TRACKING)
// ============================================

/**
 * Handle realtime trade fills from User Channel WebSocket
 * This is the PRIMARY source of truth for filled shares!
 */
function handleUserChannelTrade(event: TradeEvent): void {
  const tokenId = event.asset_id;
  const side = event.side;
  const price = parseFloat(event.price);
  const size = parseFloat(event.size);
  const status = event.status;
  
  // Only process confirmed fills
  if (status !== 'MATCHED' && status !== 'MINED' && status !== 'CONFIRMED') {
    return;
  }
  
  // Find which market/asset this fill belongs to
  let matchedAsset: Asset | null = null;
  let matchedDirection: 'UP' | 'DOWN' | null = null;
  let matchedMarket: MarketInfo | null = null;
  
  for (const [asset, market] of markets) {
    if (market.upTokenId === tokenId) {
      matchedAsset = asset;
      matchedDirection = 'UP';
      matchedMarket = market;
      break;
    }
    if (market.downTokenId === tokenId) {
      matchedAsset = asset;
      matchedDirection = 'DOWN';
      matchedMarket = market;
      break;
    }
  }
  
  if (!matchedAsset || !matchedDirection || !matchedMarket) {
    log(`🔔 UserWS: Fill for unknown token ${tokenId.slice(0, 12)}... ${side} ${size} @ ${(price * 100).toFixed(1)}¢`);
    return;
  }
  
  const position = activePositions.get(matchedAsset);
  
  if (side === 'BUY') {
    // BUY fill - update or create position
    if (position) {
      // Update existing position with additional shares
      const oldShares = position.shares;
      const oldAvg = position.entryPrice;
      const newTotalShares = oldShares + size;
      const newAvgPrice = (oldShares * oldAvg + size * price) / newTotalShares;
      
      position.shares = newTotalShares;
      position.entryPrice = newAvgPrice;
      
      logAsset(matchedAsset, `🔔 REALTIME BUY: +${size} shares @ ${(price * 100).toFixed(1)}¢ → total ${newTotalShares} shares @ avg ${(newAvgPrice * 100).toFixed(1)}¢`, {
        oldShares,
        addedShares: size,
        newTotalShares,
        oldAvg,
        fillPrice: price,
        newAvgPrice,
      });
    } else {
      // New position from User Channel (might be from another entry path)
      const fakeSignal: Signal = {
        id: `ws-${Date.now()}-${matchedAsset}`,
        asset: matchedAsset,
        direction: matchedDirection,
        binance_price: priceState[matchedAsset].binance ?? 0,
        binance_delta: 0,
        binance_ts: Date.now(),
        share_price_t0: price,
        spread_t0: 0,
        market_slug: matchedMarket.slug,
        strike_price: matchedMarket.strikePrice,
        status: 'filled',
        signal_ts: Date.now(),
        decision_ts: Date.now(),
        entry_price: price,
        shares: size,
      };
      
      const newPosition = createPositionTracker(
        fakeSignal,
        matchedAsset,
        matchedDirection,
        matchedMarket.slug,
        tokenId,
        size,
        price,
        event.taker_order_id
      );
      
      activePositions.set(matchedAsset, newPosition);
      
      logAsset(matchedAsset, `🔔 REALTIME NEW POSITION: ${matchedDirection} ${size} shares @ ${(price * 100).toFixed(1)}¢`, {
        shares: size,
        price,
        tokenId: tokenId.slice(0, 12),
      });
      
      // Start exit monitoring
      startExitMonitor(matchedAsset, newPosition);
    }
  } else if (side === 'SELL') {
    // SELL fill - update position
    if (position) {
      const oldShares = position.shares;
      const newShares = Math.max(0, oldShares - size);
      
      position.shares = newShares;
      
      const pnl = size * (price - position.entryPrice);
      
      logAsset(matchedAsset, `🔔 REALTIME SELL: -${size} shares @ ${(price * 100).toFixed(1)}¢ → ${newShares} remaining | PnL: $${pnl.toFixed(3)}`, {
        oldShares,
        soldShares: size,
        newShares,
        sellPrice: price,
        entryPrice: position.entryPrice,
        pnl,
      });
      
      // If position is fully closed, remove it
      if (newShares <= 0.01) {
        activePositions.delete(matchedAsset);
        if (position.monitorInterval) {
          clearInterval(position.monitorInterval);
        }
        logAsset(matchedAsset, `✅ Position fully closed via realtime sell`);
      }
    } else {
      log(`🔔 UserWS: SELL for ${matchedAsset} but no active position tracked`);
    }
  }
}

/**
 * Handle order events (placement, cancellation, updates)
 */
function handleUserChannelOrder(event: OrderEvent): void {
  const tokenId = event.asset_id;
  const eventType = event.type;
  const sizeMatched = parseFloat(event.size_matched);
  const originalSize = parseFloat(event.original_size);
  
  // Find asset for logging
  let matchedAsset: Asset | null = null;
  for (const [asset, market] of markets) {
    if (market.upTokenId === tokenId || market.downTokenId === tokenId) {
      matchedAsset = asset;
      break;
    }
  }
  
  if (matchedAsset && eventType === 'UPDATE' && sizeMatched > 0) {
    logAsset(matchedAsset, `📝 Order update: ${sizeMatched}/${originalSize} filled`, {
      eventType,
      sizeMatched,
      originalSize,
      orderId: event.id,
    });
  }
}

// ============================================
// POSITION SYNC (CRITICAL: Fetch real positions from Polymarket)
// ============================================

async function syncLivePositions(): Promise<void> {
  const walletAddress = pmConfig.polymarket.address;
  if (!walletAddress) {
    log('⚠️ No wallet address configured for position sync');
    return;
  }
  
  try {
    const positions = await fetchPositions(walletAddress);
    
    // Build lookup: tokenId -> MarketInfo
    const tokenToMarket = new Map<string, { asset: Asset; direction: 'UP' | 'DOWN'; market: MarketInfo }>();
    for (const [asset, market] of markets) {
      tokenToMarket.set(market.upTokenId, { asset, direction: 'UP', market });
      tokenToMarket.set(market.downTokenId, { asset, direction: 'DOWN', market });
    }
    
    let syncedCount = 0;
    
    for (const pos of positions) {
      // Match position to active market by slug
      if (!pos.eventSlug) continue;
      
      // Find market by slug
      let matchedAsset: Asset | null = null;
      let matchedMarket: MarketInfo | null = null;
      let matchedDirection: 'UP' | 'DOWN' | null = null;
      
      for (const [asset, market] of markets) {
        if (market.slug === pos.eventSlug) {
          matchedAsset = asset;
          matchedMarket = market;
          // Determine direction from outcome
          matchedDirection = pos.outcome?.toLowerCase().includes('up') || pos.outcomeIndex === 0 ? 'UP' : 'DOWN';
          break;
        }
      }
      
      if (!matchedAsset || !matchedMarket || !matchedDirection) continue;
      
      // Skip if already tracking this asset
      if (activePositions.has(matchedAsset)) {
        // Update shares if different
        const existing = activePositions.get(matchedAsset)!;
        if (Math.abs(existing.shares - pos.size) > 0.01) {
          log(`📊 ${matchedAsset} position updated: ${existing.shares} → ${pos.size} shares`);
          existing.shares = pos.size;
        }
        continue;
      }
      
      // New position found - create tracker
      const tokenId = matchedDirection === 'UP' ? matchedMarket.upTokenId : matchedMarket.downTokenId;
      
      const fakeSignal: Signal = {
        id: `sync-${Date.now()}-${matchedAsset}`,
        asset: matchedAsset,
        direction: matchedDirection,
        binance_price: priceState[matchedAsset].binance ?? 0,
        binance_delta: 0,
        binance_ts: Date.now(),
        share_price_t0: pos.avgPrice,
        spread_t0: 0,
        market_slug: matchedMarket.slug,
        strike_price: matchedMarket.strikePrice,
        status: 'filled',
        signal_ts: Date.now(),
        decision_ts: Date.now(),
        entry_price: pos.avgPrice,
        shares: pos.size,
      };
      
      const position = createPositionTracker(
        fakeSignal,
        matchedAsset,
        matchedDirection,
        matchedMarket.slug,
        tokenId,
        pos.size,
        pos.avgPrice,
        undefined
      );
      
      activePositions.set(matchedAsset, position);
      syncedCount++;
      
      log(`🔄 SYNCED: ${matchedAsset} ${matchedDirection} ${pos.size} shares @ ${(pos.avgPrice * 100).toFixed(1)}¢`, {
        asset: matchedAsset,
        direction: matchedDirection,
        shares: pos.size,
        avgPrice: pos.avgPrice,
        slug: matchedMarket.slug,
      });
      
      // Start exit monitoring for synced position
      startExitMonitor(matchedAsset, position);
    }
    
    if (syncedCount > 0) {
      log(`✅ Position sync: ${syncedCount} positions loaded from Polymarket`);
    }
    
  } catch (err) {
    logError('Position sync failed', err);
  }
}

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  log('🚀 V29 Response-Based Strategy Starting...');
  
  // SET RUNNER IDENTITY - V29R is authorized to place real orders
  setRunnerIdentity('v29-response');
  
  // Initialize DB
  initDb();
  
  // Load config from DB
  const dbConfig = await loadConfig();
  if (dbConfig) {
    config = { ...DEFAULT_CONFIG, ...dbConfig } as V29Config;
    log(`Config loaded from DB`);
  }
  
  // VPN check
  const vpnOk = await verifyVpnConnection();
  if (!vpnOk) {
    log('⚠️ VPN check failed - continuing anyway');
  }
  
  // Test Polymarket connection
  const pmOk = await testConnection();
  if (!pmOk) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');
  
  // Acquire lease
  const forceTakeover =
    process.argv.includes('--force') ||
    process.env.FORCE_TAKEOVER === '1' ||
    process.env.FORCE_TAKEOVER === 'true';

  const leaseOk = await acquireLease(RUN_ID, { force: forceTakeover });
  if (!leaseOk) {
    logError('Failed to acquire lease');
    process.exit(1);
  }
  log('✅ Lease acquired');
  
  // Get balance
  const balance = await getBalance();
  log(`💰 Balance: $${balance.toFixed(2)}`);
  
  // Fetch markets
  await fetchMarkets();
  
  // Initialize pre-signed cache
  const marketsForCache = Array.from(markets.values()).map(m => ({
    asset: m.asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsForCache);
  
  // CRITICAL: Sync live positions from Polymarket BEFORE starting
  log('📥 Syncing live positions from Polymarket...');
  await syncLivePositions();
  
  isRunning = true;
  
  // Start Binance feed (zero latency mode)
  startBinanceFeed(
    config.assets,
    handleBinancePrice,
    config.binance_buffer_ms
  );
  log('✅ Binance feed started');
  
  // Start Chainlink feed
  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink feed started');
  
  // Start orderbook polling
  orderbookPollInterval = setInterval(pollAllOrderbooks, config.orderbook_poll_ms);
  
  // Start market refresh
  marketRefreshInterval = setInterval(fetchMarkets, 60_000);
  
  // Start config refresh (every 30 seconds)
  configRefreshInterval = setInterval(refreshConfig, 30_000);
  
  // Start position sync (every 30 seconds) - ensures we track real Polymarket state
  positionSyncInterval = setInterval(syncLivePositions, 30_000);
  
// Start heartbeat
  heartbeatInterval = setInterval(sendStatusHeartbeat, 10_000);
  
  // Start User Channel WebSocket for realtime fill tracking
  const userChannelStarted = startUserChannel(handleUserChannelTrade, handleUserChannelOrder);
  if (userChannelStarted) {
    log('✅ User Channel WebSocket started (realtime fills)');
  } else {
    log('⚠️ User Channel not started - no API credentials');
  }
  
  log('🟢 V29 Response-Based Strategy RUNNING');
  log(`   Signal: Δ≥$${config.signal_delta_usd} in ${config.signal_window_ms}ms`);
  log(`   UP: target ${config.up.target_profit_cents_min}-${config.up.target_profit_cents_max}¢, max ${config.up.max_hold_seconds}s`);
  log(`   DOWN: target ${config.down.target_profit_cents_min}-${config.down.target_profit_cents_max}¢, max ${config.down.max_hold_seconds}s`);
  
  // Send initial heartbeat
  await sendStatusHeartbeat();
  
  // Graceful shutdown
  const shutdown = async () => {
    log('Shutting down...');
    isRunning = false;
    
    // Clear intervals
    if (orderbookPollInterval) clearInterval(orderbookPollInterval);
    if (marketRefreshInterval) clearInterval(marketRefreshInterval);
    if (configRefreshInterval) clearInterval(configRefreshInterval);
    if (positionSyncInterval) clearInterval(positionSyncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    // Clear position monitors
    for (const pos of activePositions.values()) {
      if (pos.monitorInterval) clearInterval(pos.monitorInterval);
    }
    
    // Stop feeds
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    stopUserChannel();
    
    // Release lease
    await releaseLease();
    
    // Flush logs
    await flushAll();
    
    log('Shutdown complete');
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
