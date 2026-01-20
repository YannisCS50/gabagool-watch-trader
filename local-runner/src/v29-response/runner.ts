/**
 * V29 Response-Based Strategy - Main Runner
 * 
 * GABAGOOL HOLD-TO-EXPIRY STRATEGY (hedge_mode_enabled=true):
 * ============================================================
 * 1. Signal: Binance price move ≥$6 triggers evaluation
 * 2. First Leg: Buy the EXPENSIVE side (follows the Binance move direction)
 *    - Binance UP → UP side becomes expensive → buy UP first
 *    - Binance DOWN → DOWN side becomes expensive → buy DOWN first
 *    - Key insight: The expensive side will likely stay expensive, but the 
 *      OTHER side will become cheaper due to mean reversion
 * 3. Second Leg: Wait 2-45s, buy other side when CPP ≤ 97¢
 * 4. NO SELLING: Hold both sides until market settles at expiry
 * 5. Profit: $1 per paired share at settlement - CPP
 * 
 * EXCEPTION: At market start (first 30s), buy the cheap side first
 * (markets are more balanced at open, so grab the cheap side opportunistically)
 * 
 * SCALP MODE (hedge_mode_enabled=false):
 * ============================================================
 * 1. Binance tick ≥$6 in 300ms window → SIGNAL
 * 2. Entry: Maker-biased limit order at best_bid + buffer
 * 3. Exit: Response-based (target, exhaustion, adverse, timeout)
 * 4. Asymmetric: UP and DOWN have different parameters
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
import { 
  registerToken, 
  onBuyFill, 
  onSellFill, 
  syncFromApi, 
  getAvailableShares, 
  canSellShares,
  logCacheState,
  clearCache as clearSharesCache 
} from './shares-cache.js';

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

// Active positions - keyed by unique position ID (supports multiple per asset)
// Key format: `${asset}-${positionId}` e.g., "BTC-abc123"
const activePositions = new Map<string, ActivePosition>();

// Prevent duplicate/concurrent ENTRY attempts per asset (critical to avoid order spam)
const entryInFlight = new Set<Asset>();

// Prevent duplicate/concurrent exit attempts per POSITION (not per asset)
const exitInFlight = new Set<string>();

// Next exit attempt time per POSITION
const nextExitAttemptAt = new Map<string, number>();

// Exit retry count per POSITION (to limit retries)
const exitRetryCount = new Map<string, number>();
const MAX_EXIT_RETRIES = 10;  // Max 10 retry attempts (10 * 250ms = 2.5s max)

// Cooldowns - we track last exit time globally (not per asset since we allow concurrent positions)
let lastGlobalExitTime = 0;

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
          
          // Clear ALL active positions for this asset if market changed
          const positionsCleared: string[] = [];
          for (const [posKey, pos] of activePositions) {
            if (pos.asset === asset) {
              // Stop monitoring
              if (pos.monitorInterval) {
                clearInterval(pos.monitorInterval);
              }
              positionsCleared.push(posKey);
            }
          }
          for (const posKey of positionsCleared) {
            activePositions.delete(posKey);
            nextExitAttemptAt.delete(posKey);
          }
          if (positionsCleared.length > 0) {
            log(`⚠️ ${asset} ${positionsCleared.length} position(s) cleared due to market change`, {
              clearedPositions: positionsCleared,
            });
          }
          
          // Update pre-signed cache
          void updateMarketCache(asset, m.upTokenId, m.downTokenId);
          
          // Register tokens in shares cache for realtime tracking
          registerToken(asset, 'UP', m.upTokenId);
          registerToken(asset, 'DOWN', m.downTokenId);
          
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
  
  // ============================================
  // HEDGE MODE: No exit monitoring - hold to settlement
  // ============================================
  if (config.hedge_mode_enabled) {
    // In hedge mode, we don't track activePositions for exit
    // We only track hedgePositions for completion
    // Check if we have pending second legs to evaluate
    // This is done in checkPendingSecondLegs() interval
    
    // Skip if entry in progress
    if (entryInFlight.has(asset)) {
      return;
    }
    
    // Skip if we already have a pending second leg for this market
    const market = markets.get(asset);
    if (market && pendingSecondLegs.has(market.slug)) {
      return;
    }
    
    // Check for new signal to start first leg
    if (hasPrevious) {
      checkForSignal(asset, delta, direction);
    }
    return; // CRITICAL: No exit monitoring in hedge mode!
  }
  
  // ============================================
  // SCALP MODE (hedge_mode_enabled=false): Original exit logic
  // ============================================
  
  // Count positions for this asset
  const assetPositionCount = countPositionsForAsset(asset);
  
  // Check all positions for this asset for exit (each has independent monitoring)
  for (const [posKey, pos] of activePositions) {
    if (pos.asset === asset) {
      checkPositionExit(posKey);
    }
  }
  
  // If max positions reached OR entry in progress, skip signal check
  if (assetPositionCount >= config.max_positions_per_asset || entryInFlight.has(asset)) {
    return;
  }
  
  // Check for signal on every tick (tick-to-tick comparison)
  if (hasPrevious) {
    checkForSignal(asset, delta, direction);
  }
}

// Helper: count active positions for an asset
function countPositionsForAsset(asset: Asset): number {
  let count = 0;
  for (const pos of activePositions.values()) {
    if (pos.asset === asset) count++;
  }
  return count;
}

// Helper: get total exposure for an asset
function getAssetExposure(asset: Asset): number {
  let total = 0;
  for (const pos of activePositions.values()) {
    if (pos.asset === asset) total += pos.totalCost;
  }
  return total;
}

// ============================================
// SIGNAL CHECKING
// ============================================

function checkForSignal(asset: Asset, delta: number, direction: 'UP' | 'DOWN' | null): void {
  const market = markets.get(asset);
  const state = priceState[asset];
  
  // Check exposure for this asset
  const currentExposure = getAssetExposure(asset);
  
  // Check position count for this asset
  const positionCount = countPositionsForAsset(asset);
  const atMaxPositions = positionCount >= config.max_positions_per_asset;
  
  const result = checkSignal(
    asset,
    config,
    state,
    market,
    atMaxPositions, // Pass "at max" instead of "has any"
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
  
  // GABAGOOL HOLD-TO-EXPIRY MODE: Sequential hedge, no selling
  // Key insight: Gabagool does NOT sell! Holds to settlement for $1 payout per paired share.
  if (config.hedge_mode_enabled) {
    // Sequential hedge entry - buy cheap side first, wait for second leg
    void executeHedgeEntry(asset, signal, market!);
    return; // CRITICAL: No exit monitoring in hedge mode!
  } else {
    // Original single-direction entry
    void executeEntry(asset, signal, market!);
  }
}

// ============================================
// HEDGE ENTRY (GABAGOOL-STYLE - SEQUENTIAL)
// Key insight from analysis: Gabagool does NOT buy simultaneously!
// - 87% of trades have 1-30 second gap between UP and DOWN
// - Buys the CHEAP side first, waits for other side to become cheap
// - 50/50 split between UP_FIRST vs DOWN_FIRST
// ============================================

// Track hedge positions by market (for completion tracking)
interface HedgePosition {
  firstSide: 'UP' | 'DOWN';
  firstShares: number;
  firstPrice: number;
  firstTs: number;
  secondSide?: 'UP' | 'DOWN';
  secondShares?: number;
  secondPrice?: number;
  secondTs?: number;
  totalCost: number;
  completed: boolean;
}
const hedgePositions = new Map<string, HedgePosition>();

// Track pending second legs (waiting for cheap price on other side)
interface PendingSecondLeg {
  marketKey: string;
  asset: Asset;
  market: MarketInfo;
  wantSide: 'UP' | 'DOWN';
  wantTokenId: string;
  firstTs: number;
  maxWaitUntil: number;
  signalId: string;
}
const pendingSecondLegs = new Map<string, PendingSecondLeg>(); // keyed by marketKey

// Interval for checking pending second legs
let secondLegCheckInterval: NodeJS.Timeout | null = null;

async function executeHedgeEntry(asset: Asset, signal: Signal, market: MarketInfo): Promise<void> {
  // CRITICAL: Lock immediately to prevent concurrent entries during async operations
  if (entryInFlight.has(asset)) {
    signal.status = 'skipped';
    signal.skip_reason = 'entry_already_in_flight';
    return;
  }
  entryInFlight.add(asset);
  
  const state = priceState[asset];
  const marketKey = market.slug;
  
  try {
    // CRITICAL: Check market is currently active
    const now = Date.now();
    const msFromStart = now - market.startTime.getTime();
    const msToExpiry = market.endTime.getTime() - now;
    
    if (msFromStart < 0 || msToExpiry <= 30_000) {
      signal.status = 'skipped';
      signal.skip_reason = msFromStart < 0 ? 'market_not_started' : 'too_close_to_expiry';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Check if we already have a position in this market
    const existing = hedgePositions.get(marketKey);
    if (existing?.completed) {
      // Already have both legs - check if we can ACCUMULATE more
      if (existing.totalCost >= config.hedge_max_cost_per_market) {
        signal.status = 'skipped';
        signal.skip_reason = `hedge_max_cost_reached: $${existing.totalCost.toFixed(2)} >= $${config.hedge_max_cost_per_market}`;
        void saveSignalLog(signal, state);
        return;
      }
      
      // We CAN accumulate! Try to add more shares if CPP is still good
      logAsset(asset, `📈 ACCUMULATE: existing hedge has $${existing.totalCost.toFixed(2)}, room for $${(config.hedge_max_cost_per_market - existing.totalCost).toFixed(2)} more`, {
        existingCost: existing.totalCost,
        maxCost: config.hedge_max_cost_per_market,
      });
      
      // Continue to try buying both sides again
    }
    
    // Check if we have a pending second leg for this market
    if (pendingSecondLegs.has(marketKey)) {
      // Already waiting for second leg - don't start new entry
      signal.status = 'skipped';
      signal.skip_reason = 'waiting_for_second_leg';
      void saveSignalLog(signal, state);
      return;
    }
    
    // Get orderbook for both sides
    const upAsk = state.upBestAsk;
    const downAsk = state.downBestAsk;
    
    if (!upAsk || !downAsk) {
      signal.status = 'skipped';
      signal.skip_reason = 'no_orderbook_for_hedge';
      void saveSignalLog(signal, state);
      return;
    }
    
    // ============================================
    // GABAGOOL KEY INSIGHT: Buy the EXPENSIVE side first!
    // ============================================
    // 
    // When Binance moves UP → UP side becomes expensive (e.g., 60¢)
    // The DOWN side becomes cheap (e.g., 40¢)
    // 
    // Strategy: Buy the expensive side FIRST because:
    // 1. It follows the momentum (likely to stay expensive)
    // 2. The cheap side will likely mean-revert and become even cheaper
    // 3. Wait 2-45s for mean reversion, then buy cheap side for good CPP
    //
    // EXCEPTION: At market start (first 30s), buy the cheap side first
    // because markets are more balanced at open
    
    const maxEntryPrice = config.hedge_max_entry_price;  // Max price for second leg
    const maxFirstLegPrice = 0.60;  // Max 60¢ for first leg (so second leg can be up to 40¢ for CPP=100¢)
    
    // Determine which side to buy based on signal direction (Binance move)
    // signal.direction tells us which way Binance moved
    let buySide: 'UP' | 'DOWN';
    let buyPrice: number;
    let buyTokenId: string;
    let waitForSide: 'UP' | 'DOWN';
    let waitForTokenId: string;
    
    // Check if we're in the early market phase (first 30s)
    // msFromStart is already calculated at line 508
    const isEarlyMarket = msFromStart < 30_000;  // First 30 seconds
    
    if (isEarlyMarket) {
      // EARLY MARKET: Buy the CHEAP side first (traditional approach)
      // Markets are balanced at open, grab the cheap opportunity
      const upIsCheap = upAsk <= maxEntryPrice;
      const downIsCheap = downAsk <= maxEntryPrice;
      
      if (!upIsCheap && !downIsCheap) {
        signal.status = 'skipped';
        signal.skip_reason = `early_market_no_cheap_side: UP=${(upAsk * 100).toFixed(0)}¢, DOWN=${(downAsk * 100).toFixed(0)}¢ > ${(maxEntryPrice * 100).toFixed(0)}¢`;
        void saveSignalLog(signal, state);
        return;
      }
      
      // Buy the cheaper side
      if (upAsk <= downAsk && upIsCheap) {
        buySide = 'UP';
        buyPrice = upAsk;
        buyTokenId = market.upTokenId;
        waitForSide = 'DOWN';
        waitForTokenId = market.downTokenId;
      } else if (downIsCheap) {
        buySide = 'DOWN';
        buyPrice = downAsk;
        buyTokenId = market.downTokenId;
        waitForSide = 'UP';
        waitForTokenId = market.upTokenId;
      } else {
        buySide = 'UP';
        buyPrice = upAsk;
        buyTokenId = market.upTokenId;
        waitForSide = 'DOWN';
        waitForTokenId = market.downTokenId;
      }
      
      logAsset(asset, `🏁 EARLY MARKET: buying CHEAP side ${buySide} at ${(buyPrice * 100).toFixed(1)}¢`, {
        msFromStart,
        upAsk: (upAsk * 100).toFixed(1),
        downAsk: (downAsk * 100).toFixed(1),
      });
    } else {
      // NORMAL MARKET: Buy the EXPENSIVE side first (follows momentum)
      // signal.direction indicates which way Binance moved
      // UP signal → Binance went UP → UP side is expensive → buy UP first
      // DOWN signal → Binance went DOWN → DOWN side is expensive → buy DOWN first
      
      if (signal.direction === 'UP') {
        buySide = 'UP';
        buyPrice = upAsk;
        buyTokenId = market.upTokenId;
        waitForSide = 'DOWN';
        waitForTokenId = market.downTokenId;
      } else {
        buySide = 'DOWN';
        buyPrice = downAsk;
        buyTokenId = market.downTokenId;
        waitForSide = 'UP';
        waitForTokenId = market.upTokenId;
      }
      
      // Safety check: Don't overpay for the expensive side
      if (buyPrice > maxFirstLegPrice) {
        signal.status = 'skipped';
        signal.skip_reason = `first_leg_too_expensive: ${buySide}=${(buyPrice * 100).toFixed(0)}¢ > ${(maxFirstLegPrice * 100).toFixed(0)}¢`;
        void saveSignalLog(signal, state);
        return;
      }
      
      // Check if the other side is at least reasonably priced for CPP potential
      const otherAsk = buySide === 'UP' ? downAsk : upAsk;
      const projectedCpp = buyPrice + otherAsk;
      
      // Don't enter if projected CPP is terrible (> 1.10 means we need 10¢+ drop on other side)
      if (projectedCpp > 1.10) {
        signal.status = 'skipped';
        signal.skip_reason = `projected_cpp_too_high: ${(projectedCpp * 100).toFixed(0)}¢ > 110¢`;
        void saveSignalLog(signal, state);
        return;
      }
      
      logAsset(asset, `📈 MOMENTUM ENTRY: buying EXPENSIVE side ${buySide} at ${(buyPrice * 100).toFixed(1)}¢ (Binance moved ${signal.direction})`, {
        signalDirection: signal.direction,
        upAsk: (upAsk * 100).toFixed(1),
        downAsk: (downAsk * 100).toFixed(1),
        waitForSide,
      });
    }
    
    // Log the entry decision
    const otherAsk = buySide === 'UP' ? downAsk : upAsk;
    const projectedCpp = buyPrice + otherAsk;
    
    logAsset(asset, `🎯 HEDGE ${buySide} FIRST: ${(buyPrice * 100).toFixed(1)}¢ | waiting for ${waitForSide} @${(otherAsk * 100).toFixed(1)}¢ | projected CPP: ${(projectedCpp * 100).toFixed(1)}¢`, {
      signalId: signal.id,
      isEarlyMarket,
      buySide,
      buyPrice,
      waitForSide,
      otherAsk,
      projectedCpp,
      maxCpp: config.hedge_max_cpp,
    });
    
    // Execute first leg
    const sharesToBuy = config.hedge_shares_per_side;
    const buffer = config.entry_price_buffer_cents / 100;
    const entryPrice = Math.round((buyPrice + buffer) * 100) / 100;
    
    signal.order_submit_ts = Date.now();
    
    const result = await placeBuyOrder(buyTokenId, entryPrice, sharesToBuy, asset, buySide);
    
    if (!result.success || !result.filledSize || result.filledSize <= 0) {
      signal.status = 'failed';
      signal.skip_reason = result.error ?? 'first_leg_no_fill';
      void saveSignalLog(signal, state);
      return;
    }
    
    const filled = result.filledSize;
    const avgPrice = result.avgPrice ?? entryPrice;
    const cost = filled * avgPrice;
    
    onBuyFill(buyTokenId, filled, avgPrice, `hedge_${buySide.toLowerCase()}_first`);
    
    // Record first leg
    const hedgePos: HedgePosition = {
      firstSide: buySide,
      firstShares: filled,
      firstPrice: avgPrice,
      firstTs: Date.now(),
      totalCost: cost,
      completed: false,
    };
    hedgePositions.set(marketKey, hedgePos);
    
    signal.status = 'filled';
    signal.entry_price = avgPrice;
    signal.shares = filled;
    signal.fill_ts = Date.now();
    tradeCount++;
    
    logAsset(asset, `✅ HEDGE ${buySide} FILLED: ${filled}@${(avgPrice * 100).toFixed(1)}¢ | now waiting for ${waitForSide}`, {
      signalId: signal.id,
      filled,
      avgPrice,
      cost,
      waitForSide,
    });
    
    void saveSignalLog(signal, state);
    
    // Set up pending second leg
    const pending: PendingSecondLeg = {
      marketKey,
      asset,
      market,
      wantSide: waitForSide,
      wantTokenId: waitForTokenId,
      firstTs: Date.now(),
      maxWaitUntil: Date.now() + config.hedge_max_wait_second_leg_ms,
      signalId: signal.id,
    };
    pendingSecondLegs.set(marketKey, pending);
    
    // Start the second leg checker if not running
    startSecondLegChecker();
    
  } catch (err) {
    signal.status = 'failed';
    signal.skip_reason = String(err);
    void saveSignalLog(signal, state);
    logError(`Hedge entry error for ${asset}`, err);
  } finally {
    entryInFlight.delete(asset);
  }
}

// Periodically check if second legs can be filled
function startSecondLegChecker(): void {
  if (secondLegCheckInterval) return; // Already running
  
  secondLegCheckInterval = setInterval(() => {
    void checkPendingSecondLegs();
  }, 500); // Check every 500ms
}

function stopSecondLegChecker(): void {
  if (secondLegCheckInterval) {
    clearInterval(secondLegCheckInterval);
    secondLegCheckInterval = null;
  }
}

async function checkPendingSecondLegs(): Promise<void> {
  const now = Date.now();
  
  for (const [marketKey, pending] of pendingSecondLegs) {
    const hedgePos = hedgePositions.get(marketKey);
    if (!hedgePos || hedgePos.completed) {
      pendingSecondLegs.delete(marketKey);
      continue;
    }
    
    // Check if market expired or timeout
    const msToExpiry = pending.market.endTime.getTime() - now;
    if (msToExpiry <= 30_000 || now > pending.maxWaitUntil) {
      logAsset(pending.asset, `⏰ HEDGE TIMEOUT: ${pending.wantSide} not filled in time`, {
        marketKey,
        firstSide: hedgePos.firstSide,
        firstShares: hedgePos.firstShares,
        waitedMs: now - pending.firstTs,
      });
      pendingSecondLegs.delete(marketKey);
      continue;
    }
    
    // Check min delay (Gabagool waits 1-30s typically)
    const waitedMs = now - pending.firstTs;
    if (waitedMs < config.hedge_min_delay_second_leg_ms) {
      continue; // Keep waiting
    }
    
    // Get current price for the wanted side
    const state = priceState[pending.asset];
    const wantAsk = pending.wantSide === 'UP' ? state.upBestAsk : state.downBestAsk;
    
    if (!wantAsk) continue;
    
    // Calculate CPP
    const cpp = hedgePos.firstPrice + wantAsk;
    
    // ============================================
    // EMERGENCY HEDGE LOGIC
    // ============================================
    // If we've waited >80% of max time, accept higher CPP to avoid unhedged exposure
    const waitRatio = waitedMs / config.hedge_max_wait_second_leg_ms;
    const isEmergency = waitRatio >= 0.80;
    
    // Emergency: accept CPP up to 105¢ (small loss is better than unhedged)
    // Normal: require CPP <= hedge_max_cpp (100¢)
    const effectiveMaxCpp = isEmergency ? 1.05 : config.hedge_max_cpp;
    
    // Check if price is reasonable (relaxed in emergency)
    const effectiveMaxEntry = isEmergency ? 0.70 : config.hedge_max_entry_price;
    
    if (wantAsk > effectiveMaxEntry) {
      if (isEmergency) {
        logAsset(pending.asset, `⚠️ HEDGE EMERGENCY: ${pending.wantSide} still too expensive ${(wantAsk * 100).toFixed(1)}¢ > ${(effectiveMaxEntry * 100).toFixed(0)}¢`, {
          marketKey,
          wantAsk,
          waitedMs,
          waitRatio: (waitRatio * 100).toFixed(0) + '%',
        });
      }
      continue;
    }
    
    if (cpp > effectiveMaxCpp) {
      if (isEmergency) {
        logAsset(pending.asset, `⚠️ HEDGE EMERGENCY: CPP ${(cpp * 100).toFixed(1)}¢ still > ${(effectiveMaxCpp * 100).toFixed(0)}¢`, {
          marketKey,
          cpp,
          waitedMs,
          waitRatio: (waitRatio * 100).toFixed(0) + '%',
        });
      }
      continue;
    }
    
    // Log emergency hedge if applicable
    if (isEmergency) {
      logAsset(pending.asset, `🚨 EMERGENCY HEDGE: accepting CPP ${(cpp * 100).toFixed(1)}¢ after ${(waitedMs / 1000).toFixed(1)}s wait`, {
        marketKey,
        cpp,
        normalMaxCpp: config.hedge_max_cpp,
        waitRatio: (waitRatio * 100).toFixed(0) + '%',
      });
    }
    
    // Good to buy second leg!
    logAsset(pending.asset, `🎯 HEDGE ${pending.wantSide} SECOND LEG: ${(wantAsk * 100).toFixed(1)}¢ | CPP: ${(cpp * 100).toFixed(1)}¢ | waited ${(waitedMs / 1000).toFixed(1)}s`, {
      marketKey,
      wantSide: pending.wantSide,
      wantAsk,
      cpp,
      waitedMs,
    });
    
    // Remove from pending first (to avoid re-entry)
    pendingSecondLegs.delete(marketKey);
    
    // Execute second leg
    const sharesToBuy = hedgePos.firstShares; // Match first leg shares
    const buffer = config.entry_price_buffer_cents / 100;
    const entryPrice = Math.round((wantAsk + buffer) * 100) / 100;
    
    try {
      const result = await placeBuyOrder(pending.wantTokenId, entryPrice, sharesToBuy, pending.asset, pending.wantSide);
      
      if (result.success && result.filledSize && result.filledSize > 0) {
        const filled = result.filledSize;
        const avgPrice = result.avgPrice ?? entryPrice;
        const cost = filled * avgPrice;
        
        onBuyFill(pending.wantTokenId, filled, avgPrice, `hedge_${pending.wantSide.toLowerCase()}_second`);
        
        // Update hedge position
        hedgePos.secondSide = pending.wantSide;
        hedgePos.secondShares = filled;
        hedgePos.secondPrice = avgPrice;
        hedgePos.secondTs = Date.now();
        hedgePos.totalCost += cost;
        hedgePos.completed = true;
        hedgePositions.set(marketKey, hedgePos);
        
        const actualCpp = hedgePos.firstPrice + avgPrice;
        const pairedShares = Math.min(hedgePos.firstShares, filled);
        const profitPerShare = 1 - actualCpp;
        const estimatedProfit = profitPerShare * pairedShares;
        
        tradeCount++;
        
        logAsset(pending.asset, `✅ HEDGE COMPLETE: ${hedgePos.firstSide} ${hedgePos.firstShares}@${(hedgePos.firstPrice * 100).toFixed(1)}¢ + ${pending.wantSide} ${filled}@${(avgPrice * 100).toFixed(1)}¢ = CPP ${(actualCpp * 100).toFixed(1)}¢ | profit $${estimatedProfit.toFixed(2)}`, {
          marketKey,
          firstSide: hedgePos.firstSide,
          firstShares: hedgePos.firstShares,
          firstPrice: hedgePos.firstPrice,
          secondSide: pending.wantSide,
          secondShares: filled,
          secondPrice: avgPrice,
          actualCpp,
          pairedShares,
          profitPerShare,
          estimatedProfit,
          totalWaitMs: now - hedgePos.firstTs,
        });
      } else {
        logAsset(pending.asset, `❌ HEDGE SECOND LEG FAILED: ${result.error ?? 'no_fill'}`, {
          marketKey,
          wantSide: pending.wantSide,
        });
        // Put back in pending to retry
        pendingSecondLegs.set(marketKey, pending);
      }
    } catch (err) {
      logError(`Hedge second leg error for ${pending.asset}`, err);
      // Put back in pending to retry
      pendingSecondLegs.set(marketKey, pending);
    }
  }
  
  // Stop checker if no more pending
  if (pendingSecondLegs.size === 0) {
    stopSecondLegChecker();
  }
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
    
    // Use unique position key: ${asset}-${positionId}
    const positionKey = `${asset}-${position.id}`;
    activePositions.set(positionKey, position);
    tradeCount++;
    
    // CRITICAL: Update shares cache with entry fill
    onBuyFill(tokenId, filledSize, avgPrice, 'entry_fill');
    
    signal.status = 'filled';
    signal.entry_price = avgPrice;
    signal.shares = filledSize;
    signal.fill_ts = Date.now();
    signal.order_id = result.orderId;
    
    const posCount = countPositionsForAsset(asset);
    logAsset(asset, `✅ FILLED: ${direction} ${filledSize} @ ${(avgPrice * 100).toFixed(1)}¢ | pos=${posCount}/${config.max_positions_per_asset} | latency=${Date.now() - signal.signal_ts}ms`, {
      signalId: signal.id,
      positionKey,
      positionCount: posCount,
      filledSize,
      avgPrice,
      latency: Date.now() - signal.signal_ts,
    });
    
    void saveSignalLog(signal, state);
    
    // Start exit monitoring for this specific position
    startExitMonitor(positionKey, position);
    
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

function startExitMonitor(positionKey: string, position: ActivePosition): void {
  // Clear any existing monitor
  if (position.monitorInterval) {
    clearInterval(position.monitorInterval);
  }
  
  const asset = position.asset as Asset;
  
  // Schedule price tracking for analytics
  schedulePriceTracking(asset, position);
  
  // Start exit check loop for THIS position
  position.monitorInterval = setInterval(() => {
    checkPositionExit(positionKey);
  }, config.exit_monitor_interval_ms);
}

function checkPositionExit(positionKey: string): void {
  // Prevent spamming exit logs / duplicate exit calls while an exit is in progress
  if (exitInFlight.has(positionKey)) return;

  const now = Date.now();
  const nextAttempt = nextExitAttemptAt.get(positionKey) || 0;
  if (now < nextAttempt) return;

  const position = activePositions.get(positionKey);
  if (!position) return;

  const asset = position.asset as Asset;
  const state = priceState[asset];

  const decision = checkExit(
    position,
    config,
    state,
    (msg, data) => logAsset(asset, msg, data)
  );

  if (decision.shouldExit) {
    void executeExit(positionKey, position, decision.type!, decision.reason ?? '', decision.unrealizedPnl ?? 0);
  }
}

// ============================================
// EXIT EXECUTION
// ============================================

async function executeExit(
  positionKey: string,
  position: ActivePosition,
  exitType: ExitType,
  exitReason: string,
  unrealizedPnl: number
): Promise<void> {
  // Guard against concurrent exit attempts (interval + price-tick path)
  if (exitInFlight.has(positionKey)) return;
  exitInFlight.add(positionKey);

  const asset = position.asset as Asset;

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
        positionKey,
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
      activePositions.delete(positionKey);
      lastGlobalExitTime = now;
      
      return;
    }

    const bestBid = position.direction === 'UP' ? state.upBestBid : state.downBestBid;

    if (!bestBid || !market) {
      // CRITICAL: Do NOT delete position - we still hold shares!
      const retries = (exitRetryCount.get(positionKey) ?? 0) + 1;
      exitRetryCount.set(positionKey, retries);
      
      if (retries >= MAX_EXIT_RETRIES) {
        logAsset(asset, `🛑 EXIT: Max retries (${MAX_EXIT_RETRIES}) reached without bid - forcing position cleanup`, {
          positionKey,
          positionId: position.id,
          retries,
        });
        
        signal.exit_type = 'error';
        signal.exit_reason = 'max_retries_no_bid';
        signal.exit_ts = Date.now();
        void saveSignalLog(signal, state);
        
        activePositions.delete(positionKey);
        exitRetryCount.delete(positionKey);
        lastGlobalExitTime = Date.now();
        return;
      }
      
      // Restart monitoring and retry with FASTER backoff (250ms instead of 500ms)
      logAsset(asset, `⚠️ EXIT: No bid available, retry ${retries}/${MAX_EXIT_RETRIES} in 250ms`, {
        positionKey,
        positionId: position.id,
        hasMarket: !!market,
        hasBid: !!bestBid,
        lastOrderbookUpdate: state.lastOrderbookUpdate,
        retries,
      });
      
      nextExitAttemptAt.set(positionKey, Date.now() + 250);
      position.monitorInterval = setInterval(() => {
        checkPositionExit(positionKey);
      }, config.exit_monitor_interval_ms);
      
      return;
    }

    // Sell at market (use bid)
    const sellPrice = Math.floor(bestBid * 100) / 100;

    // CRITICAL: Check shares cache for actual available shares (non-blocking)
    // This prevents "not enough balance" errors by using the realtime WebSocket-tracked amount
    const { canSell, available, shortfall } = canSellShares(position.tokenId, position.shares);
    
    // Use the MINIMUM of position.shares and available (from WebSocket cache)
    // This ensures we never try to sell more than we actually have
    const sharesToSell = Math.min(position.shares, available);
    
    if (available < 0.5) {
      // No shares available according to realtime cache - position may already be sold
      logAsset(asset, `⚠️ EXIT SKIPPED: No shares in cache (available=${available.toFixed(2)}, position=${position.shares.toFixed(2)})`, {
        positionKey,
        positionId: position.id,
        cachedShares: available,
        positionShares: position.shares,
      });
      
      signal.exit_type = 'error';
      signal.exit_reason = `no_shares_in_cache: available=${available.toFixed(2)}`;
      signal.exit_ts = Date.now();
      void saveSignalLog(signal, state);
      
      // Clean up position - shares are already gone
      activePositions.delete(positionKey);
      exitRetryCount.delete(positionKey);
      lastGlobalExitTime = Date.now();
      return;
    }
    
    // Validate minimum order value with adjusted shares
    const MIN_ORDER_VALUE_USD = 1.0;
    const orderValue = sharesToSell * sellPrice;
    if (orderValue < MIN_ORDER_VALUE_USD) {
      logAsset(asset, `⚠️ EXIT SKIPPED: Order value $${orderValue.toFixed(2)} < min $${MIN_ORDER_VALUE_USD}`, {
        positionKey,
        sharesToSell,
        sellPrice,
        orderValue,
      });
      
      signal.exit_type = 'error';
      signal.exit_reason = `order_value_too_low: $${orderValue.toFixed(2)}`;
      signal.exit_ts = Date.now();
      void saveSignalLog(signal, state);
      
      // Clean up - dust position not worth selling
      activePositions.delete(positionKey);
      exitRetryCount.delete(positionKey);
      lastGlobalExitTime = Date.now();
      return;
    }

    logAsset(asset, `📤 EXIT: ${position.direction} ${sharesToSell.toFixed(2)} @ ${(sellPrice * 100).toFixed(1)}¢ | type=${exitType}`, {
      positionKey,
      positionId: position.id,
      exitType,
      exitReason,
      sellPrice,
      sharesToSell,
      positionShares: position.shares,
      cachedShares: available,
      unrealizedPnl,
    });

    const result = await placeSellOrder(
      position.tokenId,
      sellPrice,
      sharesToSell,  // Use adjusted shares from cache
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
          positionKey,
          positionId: position.id,
          error: errMsg,
        });
        
        signal.exit_type = 'expired';
        signal.exit_reason = `market_expired: ${errMsg}`;
        signal.exit_ts = nowCheck;
        void saveSignalLog(signal, state);
        
        activePositions.delete(positionKey);
        lastGlobalExitTime = nowCheck;
        
        return;
      }
      
      logAsset(asset, `❌ EXIT FAILED: ${errMsg}`, {
        positionKey,
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
            nextExitAttemptAt.set(positionKey, Date.now() + 2000);
            position.monitorInterval = setInterval(() => {
              checkPositionExit(positionKey);
            }, config.exit_monitor_interval_ms);
            
            return;
          } else {
            // Position really is gone (redeemed/expired/sold elsewhere)
            logAsset(asset, `🛑 Position confirmed GONE from Polymarket API - removing from tracking`, {
              positionKey,
              searchedToken: position.tokenId,
              searchedSlug: position.marketSlug,
              foundPositions: livePositions.length,
            });
            activePositions.delete(positionKey);
            lastGlobalExitTime = Date.now();
            return;
          }
        } catch (syncErr) {
          logAsset(asset, `⚠️ Position sync failed, keeping position for retry: ${syncErr}`);
          // Backoff and retry
          nextExitAttemptAt.set(positionKey, Date.now() + 3000);
          position.monitorInterval = setInterval(() => {
            checkPositionExit(positionKey);
          }, config.exit_monitor_interval_ms);
          return;
        }
      }

      // Backoff + retry for other errors with FASTER retry (500ms)
      const retries = (exitRetryCount.get(positionKey) ?? 0) + 1;
      exitRetryCount.set(positionKey, retries);
      
      if (retries >= MAX_EXIT_RETRIES) {
        logAsset(asset, `🛑 EXIT: Max retries (${MAX_EXIT_RETRIES}) reached with errors - removing position`, {
          positionKey,
          positionId: position.id,
          retries,
          lastError: errMsg,
        });
        activePositions.delete(positionKey);
        exitRetryCount.delete(positionKey);
        lastGlobalExitTime = Date.now();
        return;
      }
      
      logAsset(asset, `🔄 EXIT: retry ${retries}/${MAX_EXIT_RETRIES} in 500ms`, { positionKey });
      nextExitAttemptAt.set(positionKey, Date.now() + 500);
      position.monitorInterval = setInterval(() => {
        checkPositionExit(positionKey);
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

    const remainingPos = countPositionsForAsset(asset) - 1;
    logAsset(asset, `✅ EXITED: ${position.direction} | type=${exitType} | hold=${holdTimeMs}ms | PnL=${(netPnl * 100).toFixed(2)}¢ | remaining=${remainingPos}`, {
      positionKey,
      positionId: position.id,
      exitType,
      holdTimeMs,
      grossPnl,
      netPnl,
      remainingPositions: remainingPos,
    });

    // Remove position
    activePositions.delete(positionKey);
    nextExitAttemptAt.delete(positionKey);
    lastGlobalExitTime = exitTs;
  } catch (err) {
    logError(`Exit error for ${positionKey}`, err);

    // Backoff + keep position so we can retry exiting
    nextExitAttemptAt.set(positionKey, Date.now() + 1500);

    if (activePositions.has(positionKey)) {
      position.monitorInterval = setInterval(() => {
        checkPositionExit(positionKey);
      }, config.exit_monitor_interval_ms);
    }
    // No cooldown tracking needed
  } finally {
    exitInFlight.delete(positionKey);
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
  
  // Find existing position for this asset+direction (take first match)
  let position: ActivePosition | undefined;
  let positionKey: string | undefined;
  for (const [key, pos] of activePositions) {
    if (pos.asset === matchedAsset && pos.direction === matchedDirection) {
      position = pos;
      positionKey = key;
      break;
    }
  }
  
  if (side === 'BUY') {
    // CRITICAL: Update shares cache FIRST (realtime source of truth)
    onBuyFill(tokenId, size, price, 'ws_buy');
    
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
        id: randomUUID(),  // Use real UUID for database compatibility
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
      
      const newPosKey = `${matchedAsset}-${newPosition.id}`;
      activePositions.set(newPosKey, newPosition);
      
      logAsset(matchedAsset, `🔔 REALTIME NEW POSITION: ${matchedDirection} ${size} shares @ ${(price * 100).toFixed(1)}¢`, {
        positionKey: newPosKey,
        shares: size,
        price,
        tokenId: tokenId.slice(0, 12),
      });
      
      // Start exit monitoring
      startExitMonitor(newPosKey, newPosition);
    }
  } else if (side === 'SELL') {
    // CRITICAL: Update shares cache FIRST (realtime source of truth)
    onSellFill(tokenId, size, 'ws_sell');
    
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
      if (newShares <= 0.01 && positionKey) {
        activePositions.delete(positionKey);
        nextExitAttemptAt.delete(positionKey);
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
      
      // Get the tokenId for this position
      const tokenId = matchedDirection === 'UP' ? matchedMarket.upTokenId : matchedMarket.downTokenId;
      
      // CRITICAL: Sync shares cache from API data
      syncFromApi(tokenId, pos.size, pos.avgPrice);
      
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
      const fakeSignal: Signal = {
        id: randomUUID(),  // Use real UUID for database compatibility
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
      
      // Start exit monitoring for synced position - ONLY in scalp mode
      if (!config.hedge_mode_enabled) {
        startExitMonitor(matchedAsset, position);
      } else {
        log(`   → Holding to expiry (no exit monitor)`);
      }
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
  
  // Log critical strategy mode
  if (config.hedge_mode_enabled) {
    log(`🔒 HEDGE MODE ACTIVE: hold-to-expiry, no selling`);
    log(`   → First leg max: 60¢, Second leg max: ${(config.hedge_max_entry_price * 100).toFixed(0)}¢`);
    log(`   → Target CPP: ${(config.hedge_max_cpp * 100).toFixed(0)}¢, Emergency CPP: 105¢`);
    log(`   → Wait for second leg: ${config.hedge_min_delay_second_leg_ms}ms - ${config.hedge_max_wait_second_leg_ms}ms`);
  } else {
    log(`⚡ SCALP MODE ACTIVE: entry + exit monitor`);
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
  
  // Log shares cache state after sync
  logCacheState();
  
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
  if (config.hedge_mode_enabled) {
    log(`   ╔═══════════════════════════════════════════════════════╗`);
    log(`   ║  GABAGOOL HOLD-TO-EXPIRY MODE (NO SELLING!)           ║`);
    log(`   ╠═══════════════════════════════════════════════════════╣`);
    log(`   ║  • Buy cheap side first (≤${(config.hedge_max_entry_price * 100).toFixed(0)}¢)                      ║`);
    log(`   ║  • Wait ${config.hedge_min_delay_second_leg_ms / 1000}s-${config.hedge_max_wait_second_leg_ms / 1000}s for second leg at CPP ≤${(config.hedge_max_cpp * 100).toFixed(0)}¢       ║`);
    log(`   ║  • Hold both sides until market settles               ║`);
    log(`   ║  • Profit = $1 per paired share - CPP                 ║`);
    log(`   ╚═══════════════════════════════════════════════════════╝`);
    log(`   Assets: ${config.assets.join(', ')}`);
    log(`   Shares per side: ${config.hedge_shares_per_side} | Max cost per market: $${config.hedge_max_cost_per_market}`);
  } else {
    log(`   SCALP MODE (exit-based)`);
    log(`   Signal: Δ≥$${config.signal_delta_usd} in ${config.signal_window_ms}ms`);
    log(`   UP: target ${config.up.target_profit_cents_min}-${config.up.target_profit_cents_max}¢, max ${config.up.max_hold_seconds}s`);
    log(`   DOWN: target ${config.down.target_profit_cents_min}-${config.down.target_profit_cents_max}¢, max ${config.down.max_hold_seconds}s`);
  }
  
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
    stopSecondLegChecker(); // Stop hedge second leg checker
    
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
