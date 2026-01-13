/**
 * V29 Simple Live Runner
 * 
 * Clean implementation:
 * 1. Tick-to-tick delta detection (same as UI)
 * 2. Realtime orderbook pricing (no pre-signed cache)
 * 3. Direct GTC orders at bestAsk + buffer
 * 4. Simple TP/SL monitoring
 */

import 'dotenv/config';
import { v4 as uuid } from 'crypto';
import { Asset, V29Config, DEFAULT_CONFIG } from './config.js';
import type { MarketInfo, PriceState, Signal, Position, AggregatePosition } from './types.js';
import { startBinanceFeed, stopBinanceFeed } from './binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from './chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from './orderbook.js';
import { initDb, saveSignal, loadV29Config, sendHeartbeat, getDb, queueLog, getAggregatePosition, upsertAggregatePosition, addHedgeToPosition, getAllPositionsForMarket, clearPositionsForMarket } from './db.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, cancelOrder, getOrderStatus } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, cancelOrder, getOrderStatus } from './trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v29-${Date.now().toString(36)}`;
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

// (prevPrices moved to handleBinancePrice as lastBinancePrice)

// Current position (only one at a time for trailing stop logic)
let activePosition: Position | null = null;
let activeSignal: Signal | null = null;
let lastOrderTime = 0;
let tradesCount = 0;
let lastMarketRefresh = 0;
let lastConfigReload = 0;

// Track aggregate positions per asset/side (for accumulation strategy)
const aggregatePositions = new Map<string, AggregatePosition>(); // key: `${asset}-${side}-${marketSlug}`

// Track active BUY orders per side (UP/DOWN) per asset - MAX 1 PER SIDE
interface ActiveOrder {
  orderId: string;
  asset: Asset;
  side: 'UP' | 'DOWN';
  shares: number;
  price: number;
  placedAt: number;
}
const activeBuyOrders = new Map<string, ActiveOrder>(); // key: `${asset}-${side}`

// Track previous market slugs to detect market changes
const previousMarketSlugs: Record<Asset, string | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// Market expiration timers - exact scheduling instead of polling
const marketTimers: Record<Asset, NodeJS.Timeout | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

// ============================================
// LOGGING
// ============================================

function log(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V29] ${msg}`);
  // Queue log to database
  queueLog(RUN_ID, 'info', category, msg, asset, data);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V29] ❌ ${msg}`, err ?? '');
  // Queue error to database
  queueLog(RUN_ID, 'error', 'error', msg, undefined, err ? { error: String(err) } : undefined);
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
      // v26 flag allows fetching upcoming markets (90s before start for 15m markets)
      body: JSON.stringify({ assets: config.assets, v26: true }),
    });
    
    if (!res.ok) {
      log(`⚠️ Market fetch failed: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    
    if (Array.isArray(data.markets)) {
      const now = Date.now();
      const EARLY_15M_MS = 90_000; // 90s early entry for 15m markets
      
      for (const m of data.markets) {
        if (!m.asset || !m.upTokenId || !m.downTokenId) continue;
        
        const asset = m.asset as Asset;
        const startMs = new Date(m.eventStartTime || m.event_start_time || '').getTime();
        const endMs = new Date(m.eventEndTime || m.event_end_time || m.endTime || '').getTime();
        
        // Skip expired markets
        if (endMs <= now - 60_000) continue;
        
        // Allow 90s early entry for 15m markets
        const slug = String(m.slug || '');
        const is15m = slug.toLowerCase().includes('-15m-');
        const earlyMs = is15m ? EARLY_15M_MS : 60_000;
        
        // Skip if not started yet (with early buffer)
        if (now < startMs - earlyMs) continue;
        
        const previousSlug = previousMarketSlugs[asset];
        const isNewMarket = previousSlug !== slug;
        
        // Update market info
        markets.set(asset, {
          slug,
          asset,
          strikePrice: m.strikePrice ?? m.strike_price ?? 0,
          upTokenId: m.upTokenId,
          downTokenId: m.downTokenId,
          endTime: new Date(endMs),
        });
        
        // If market changed, update pre-signed cache immediately!
        if (isNewMarket && previousSlug !== null) {
          log(`🔁 ${asset} NEW MARKET: ${slug} (was: ${previousSlug}) → updating pre-sign cache`);
          void updateMarketCache(asset, m.upTokenId, m.downTokenId);
        } else if (isNewMarket) {
          log(`📍 ${asset}: ${slug} @ strike $${m.strikePrice ?? m.strike_price ?? 0}`);
        }
        
        previousMarketSlugs[asset] = slug;
        
        // Schedule exact timer for market expiration
        scheduleMarketRefresh(asset, endMs);
      }
      
      log(`Active: ${markets.size} markets`);
    }
    
    lastMarketRefresh = Date.now();
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// SMART MARKET TIMER
// ============================================

/**
 * Schedule exact refresh for when market expires.
 * Instead of polling every 5 seconds, we set a timer for:
 * - 5 seconds before market end (to fetch next market)
 * - Market durations are fixed: 15m or 1h
 */
function scheduleMarketRefresh(asset: Asset, endTimeMs: number): void {
  // Clear existing timer for this asset
  if (marketTimers[asset]) {
    clearTimeout(marketTimers[asset]!);
    marketTimers[asset] = null;
  }
  
  const now = Date.now();
  const timeUntilEnd = endTimeMs - now;
  
  // Schedule refresh 5 seconds before market end
  const refreshIn = Math.max(timeUntilEnd - 5_000, 1_000);
  
  // Don't schedule if market already expired or too far in future (> 2 hours)
  if (timeUntilEnd <= 0 || timeUntilEnd > 2 * 60 * 60 * 1000) {
    return;
  }
  
  log(`⏰ ${asset} timer: refresh in ${Math.floor(refreshIn / 1000)}s (market ends in ${Math.floor(timeUntilEnd / 1000)}s)`, 'market', asset);
  
  marketTimers[asset] = setTimeout(() => {
    log(`🔄 ${asset} market expiring NOW → fetching next market`, 'market', asset);
    void fetchMarkets();
  }, refreshIn);
}

// ============================================
// CHAINLINK PRICE HANDLER
// ============================================

function handleChainlinkPrice(asset: Asset, price: number): void {
  const prev = priceState[asset].chainlink;
  priceState[asset].chainlink = price;
  
  // Only log chainlink when there's a significant move ($10+)
  if (prev && Math.abs(price - prev) >= 10) {
    queueLog(RUN_ID, 'info', 'price', `${asset} chainlink $${price.toFixed(2)} Δ${price > prev ? '+' : ''}${(price - prev).toFixed(2)}`, asset, { source: 'chainlink', price, delta: price - prev });
  }
}

// ============================================
// PRICE HANDLING
// ============================================

// Track previous price per asset for tick-to-tick delta (matches UI behavior)
const lastBinancePrice: Record<Asset, number | null> = { BTC: null, ETH: null, SOL: null, XRP: null };

function handleBinancePrice(asset: Asset, price: number, _timestamp: number): void {
  const now = Date.now();
  
  // Update current state
  priceState[asset].binance = price;
  
  // Get previous price for tick-to-tick delta
  const prevPrice = lastBinancePrice[asset];
  lastBinancePrice[asset] = price;
  
  // Calculate tick-to-tick delta (now based on 100ms buffered prices)
  const tickDelta = prevPrice !== null ? price - prevPrice : 0;
  
  // Only log significant movements (>= threshold)
  if (Math.abs(tickDelta) >= config.tick_delta_usd) {
    queueLog(RUN_ID, 'info', 'price', `${asset} binance $${price.toFixed(2)} Δ${tickDelta >= 0 ? '+' : ''}${tickDelta.toFixed(2)} 🎯`, asset, { 
      source: 'binance', 
      price,
      tickDelta, 
      threshold: config.tick_delta_usd
    });
  }
  
  // Skip if disabled
  if (!config.enabled) return;
  
  // Skip if already in a position
  if (activePosition !== null) return;
  
  // Skip if in cooldown
  if (now - lastOrderTime < config.order_cooldown_ms) return;
  
  // Need previous price to calculate delta
  if (prevPrice === null) return;
  
  // Check if tick delta exceeds threshold (e.g., $6 price move)
  if (Math.abs(tickDelta) < config.tick_delta_usd) return;
  
  // Get market to check strike price
  const market = markets.get(asset);
  if (!market || !market.strikePrice) {
    log(`⚠️ No market/strike for ${asset}`);
    return;
  }
  
  // Get Chainlink price for delta calculation (fallback to Binance if not available)
  const chainlinkPrice = priceState[asset].chainlink;
  const actualPrice = chainlinkPrice ?? price; // Use Chainlink, fallback to Binance
  const priceSource = chainlinkPrice ? 'chainlink' : 'binance';
  
  // Calculate actual-to-strike delta for direction logic
  const priceVsStrikeDelta = actualPrice - market.strikePrice;
  
  log(`📊 ${asset} TRIGGER CHECK: tickΔ=$${tickDelta.toFixed(2)} (threshold=$${config.tick_delta_usd}) | ${priceSource}=$${actualPrice.toFixed(2)} vs strike=$${market.strikePrice.toFixed(0)} → Δ$${priceVsStrikeDelta.toFixed(0)}`);
  
  // Determine direction based on tick movement (exactly like UI)
  const tickDirection: 'UP' | 'DOWN' = tickDelta > 0 ? 'UP' : 'DOWN';
  
  // Apply direction filter based on delta_threshold
  let allowedDirection: 'UP' | 'DOWN' | 'BOTH';
  if (priceVsStrikeDelta > config.delta_threshold) {
    allowedDirection = 'UP';
  } else if (priceVsStrikeDelta < -config.delta_threshold) {
    allowedDirection = 'DOWN';
  } else {
    allowedDirection = 'BOTH';
  }
  
  // Check if direction is allowed
  if (allowedDirection !== 'BOTH' && allowedDirection !== tickDirection) {
    log(`⚠️ ${asset} direction ${tickDirection} blocked | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | only ${allowedDirection} allowed`);
    return;
  }
  
  log(`🎯 TRIGGER: ${asset} ${tickDirection} | tickΔ$${tickDelta.toFixed(2)} | price vs strike: $${priceVsStrikeDelta.toFixed(0)} | allowed: ${allowedDirection}`, 'signal', asset, { tickDelta, priceVsStrikeDelta, direction: tickDirection });
  
  // Execute trade
  // Execute trade (accumulation mode)
  void executeTrade(asset, tickDirection, price, tickDelta, priceVsStrikeDelta);
  
  // Also check if we can hedge the OPPOSITE side
  if (config.auto_hedge_enabled) {
    void checkAndExecuteHedge(asset, tickDirection === 'UP' ? 'DOWN' : 'UP');
  }
}

// ============================================
// TRADE EXECUTION (Accumulation Mode)
// ============================================

async function executeTrade(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  binancePrice: number,
  tickDelta: number,
  strikeActualDelta: number
): Promise<void> {
  const signalTs = Date.now();
  const orderKey = `${asset}-${direction}`;
  
  // Get market
  const market = markets.get(asset);
  if (!market) {
    log(`⚠️ No market for ${asset}`);
    return;
  }
  
  // Check accumulation limits BEFORE placing order
  if (config.accumulation_enabled) {
    const posKey = `${asset}-${direction}-${market.slug}`;
    const existingPos = aggregatePositions.get(posKey);
    
    if (existingPos) {
      // Check if we've hit the max cost limit
      if (existingPos.totalCost >= config.max_total_cost_usd) {
        log(`⚠️ ${asset} ${direction} at max cost $${existingPos.totalCost.toFixed(2)} >= $${config.max_total_cost_usd}`, 'order', asset);
        return;
      }
      
      // Check if we've hit the max shares limit
      if (existingPos.totalShares >= config.max_total_shares) {
        log(`⚠️ ${asset} ${direction} at max shares ${existingPos.totalShares} >= ${config.max_total_shares}`, 'order', asset);
        return;
      }
      
      // Check if fully hedged (no need to accumulate more)
      if (existingPos.isFullyHedged) {
        log(`⚠️ ${asset} ${direction} already fully hedged, skipping accumulation`, 'order', asset);
        return;
      }
    }
  }
  
  // Get current orderbook for this direction
  const state = priceState[asset];
  const bestAsk = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!bestAsk || bestAsk <= 0) {
    log(`⚠️ No orderbook for ${asset} ${direction}`);
    return;
  }
  
  // ========================================
  // PRICE RANGE CHECK - BLOCK if ask is outside min/max
  // ========================================
  if (bestAsk < config.min_share_price) {
    log(`🚫 BLOCKED: ${asset} ${direction} ask ${(bestAsk * 100).toFixed(1)}¢ < min ${(config.min_share_price * 100).toFixed(1)}¢`, 'order', asset, { bestAsk, min: config.min_share_price, reason: 'ask_too_low' });
    return;
  }
  
  if (bestAsk > config.max_share_price) {
    log(`🚫 BLOCKED: ${asset} ${direction} ask ${(bestAsk * 100).toFixed(1)}¢ > max ${(config.max_share_price * 100).toFixed(1)}¢`, 'order', asset, { bestAsk, max: config.max_share_price, reason: 'ask_too_high' });
    return;
  }
  
  // Calculate price with buffer (now safe since ask is within range)
  const priceBuffer = config.price_buffer_cents / 100;
  const buyPrice = Math.ceil((bestAsk + priceBuffer) * 100) / 100;
  
  // Calculate shares
  const rawShares = config.trade_size_usd / buyPrice;
  const shares = Math.min(Math.floor(rawShares), config.max_shares);
  
  if (shares < 1) {
    log(`⚠️ Shares < 1`);
    return;
  }
  
  // ========================================
  // 1 ORDER PER SIDE RULE
  // Check if there's already an active order for this side
  // If so: place NEW order FIRST, then cancel OLD order
  // ========================================
  const existingOrder = activeBuyOrders.get(orderKey);
  
  // Create signal
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
    notes: `${direction} | tickΔ$${Math.abs(tickDelta).toFixed(0)} | strikeΔ$${strikeActualDelta.toFixed(0)} | @${(buyPrice * 100).toFixed(1)}¢`,
  };
  
  // Save signal first (get ID)
  const signalId = await saveSignal(signal);
  if (signalId) signal.id = signalId;
  
  // Mark order time
  lastOrderTime = Date.now();
  
  // Place NEW order FIRST
  log(`📤 PLACING ORDER: ${asset} ${direction} ${shares} shares @ ${(buyPrice * 100).toFixed(1)}¢${existingOrder ? ` (replacing ${existingOrder.orderId})` : ''}`, 'order', asset, { direction, shares, price: buyPrice });
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
  
  const latency = Date.now() - signalTs;
  
  if (!result.success) {
    signal.status = 'failed';
    signal.notes = `${result.error ?? 'Unknown error'} | Latency: ${latency}ms`;
    log(`❌ FAILED: ${result.error ?? 'Unknown'} (${latency}ms)`);
    void saveSignal(signal);
    return;
  }
  
  const orderId = result.orderId;
  if (!orderId) {
    signal.status = 'failed';
    signal.notes = `No order ID returned | Latency: ${latency}ms`;
    log(`❌ FAILED: No order ID returned (${latency}ms)`);
    void saveSignal(signal);
    return;
  }
  
  // NOW cancel the old order (after new one is placed)
  if (existingOrder) {
    log(`🗑️ Cancelling old order: ${existingOrder.orderId}`, 'order', asset);
    void cancelOrder(existingOrder.orderId);
  }
  
  // Track the new order
  activeBuyOrders.set(orderKey, {
    orderId,
    asset,
    side: direction,
    shares,
    price: buyPrice,
    placedAt: Date.now(),
  });
  
  signal.order_id = orderId;
  log(`📋 Order placed: ${orderId} - waiting for fill...`, 'order', asset);
  
  // Wait up to 5 seconds for fill, checking every 500ms
  const FILL_TIMEOUT_MS = 5000;
  const POLL_INTERVAL_MS = 500;
  const startWait = Date.now();
  let filled = false;
  let filledSize = 0;
  let actualPrice = buyPrice;
  
  while (Date.now() - startWait < FILL_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    
    const status = await getOrderStatus(orderId);
    if (status.filled || status.filledSize > 0) {
      filled = true;
      filledSize = status.filledSize || shares;
      break;
    }
    
    // If status is cancelled or dead, stop waiting
    if (status.status === 'CANCELLED' || status.status === 'DEAD') {
      log(`⚠️ Order ${orderId} was ${status.status}`);
      break;
    }
  }
  
  const totalLatency = Date.now() - signalTs;
  
  if (filled && filledSize > 0) {
    // SUCCESS! Remove from active orders
    activeBuyOrders.delete(orderKey);
    
    signal.status = 'filled';
    signal.entry_price = result.avgPrice ?? buyPrice;
    signal.shares = filledSize;
    signal.fill_ts = Date.now();
    signal.notes = `Filled ${filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ | Latency: ${totalLatency}ms`;
    
    tradesCount++;
    
    log(`✅ FILLED: ${asset} ${direction} ${filledSize} @ ${(signal.entry_price * 100).toFixed(1)}¢ (${totalLatency}ms)`, 'fill', asset, { direction, shares: filledSize, price: signal.entry_price, latencyMs: totalLatency });
    
    // ACCUMULATION MODE: Update aggregate position in DB
    if (config.accumulation_enabled) {
      const tradeCost = filledSize * signal.entry_price;
      const updated = await upsertAggregatePosition(
        RUN_ID,
        asset,
        direction,
        market.slug,
        tokenId,
        filledSize,
        tradeCost
      );
      
      if (updated) {
        const posKey = `${asset}-${direction}-${market.slug}`;
        aggregatePositions.set(posKey, updated);
        log(`📊 ACCUMULATED: ${asset} ${direction} now ${updated.totalShares} shares @ avg ${(updated.avgEntryPrice * 100).toFixed(1)}¢ ($${updated.totalCost.toFixed(2)} total)`, 'accumulate', asset, {
          totalShares: updated.totalShares,
          totalCost: updated.totalCost,
          avgEntry: updated.avgEntryPrice,
        });
      }
    } else {
      // Non-accumulation mode: Create single position with trailing stop state
      activePosition = {
        signalId: signal.id!,
        asset,
        direction,
        tokenId,
        entryPrice: signal.entry_price,
        shares: filledSize,
        startTime: Date.now(),
        peakProfit: 0,
        trailingActive: false,
        sellOrderId: null,
      };
      activeSignal = signal;
      
      const minSellPrice = (signal.entry_price + config.min_profit_cents / 100);
      log(`📊 Position open: Entry=${(signal.entry_price * 100).toFixed(1)}¢ | Min sell=${(minSellPrice * 100).toFixed(1)}¢ (+${config.min_profit_cents}¢) | Trailing trigger=+${config.trailing_trigger_cents}¢`, 'order', asset);
      
      // Start monitoring
      startPositionMonitor();
    }
  } else {
    // Not filled in time - keep order active (don't cancel)
    log(`⏰ Order not filled in 5s - keeping active: ${orderId}`, 'order', asset);
    
    signal.status = 'pending';
    signal.notes = `Waiting for fill (${totalLatency}ms elapsed)`;
  }
  
  // Update signal in DB
  void saveSignal(signal);
}

// ============================================
// AUTO-HEDGE LOGIC
// ============================================

async function checkAndExecuteHedge(asset: Asset, hedgeSide: 'UP' | 'DOWN'): Promise<void> {
  const market = markets.get(asset);
  if (!market) return;
  
  // Get the OPPOSITE side's position (the one we want to hedge)
  const mainSide = hedgeSide === 'UP' ? 'DOWN' : 'UP';
  const mainPosKey = `${asset}-${mainSide}-${market.slug}`;
  const mainPos = aggregatePositions.get(mainPosKey);
  
  // No main position to hedge
  if (!mainPos || mainPos.totalShares <= 0) return;
  
  // Already fully hedged
  if (mainPos.isFullyHedged) return;
  
  // Get current orderbook for hedge side
  const state = priceState[asset];
  const hedgeAsk = hedgeSide === 'UP' ? state.upBestAsk : state.downBestAsk;
  const mainBid = mainSide === 'UP' ? state.upBestBid : state.downBestBid;
  
  if (!hedgeAsk || !mainBid) return;
  
  // Check if hedge is cheap enough (below trigger)
  const hedgeTrigger = config.hedge_trigger_cents / 100;
  if (hedgeAsk > hedgeTrigger) {
    return; // Hedge too expensive
  }
  
  // Calculate unrealized profit on main position
  const currentValue = mainPos.totalShares * mainBid;
  const unrealizedProfit = currentValue - mainPos.totalCost;
  const unrealizedProfitPerShare = unrealizedProfit / mainPos.totalShares;
  const unrealizedProfitCents = unrealizedProfitPerShare * 100;
  
  // Check if we have enough profit to hedge
  if (unrealizedProfitCents < config.hedge_min_profit_cents) {
    return; // Not enough profit to justify hedging
  }
  
  // Calculate how many shares we need to hedge
  const sharesToHedge = mainPos.totalShares - mainPos.hedgeShares;
  if (sharesToHedge <= 0) return;
  
  // Calculate expected locked profit after hedge
  const hedgeCost = sharesToHedge * hedgeAsk;
  const totalInvestment = mainPos.totalCost + hedgeCost;
  const guaranteedReturn = mainPos.totalShares; // One side wins = $1 per share
  const lockedProfit = guaranteedReturn - totalInvestment;
  
  // Only hedge if it locks in actual profit
  if (lockedProfit <= 0) {
    log(`⚠️ ${asset} hedge would not lock profit: return=$${guaranteedReturn.toFixed(2)} - investment=$${totalInvestment.toFixed(2)} = $${lockedProfit.toFixed(2)}`, 'hedge', asset);
    return;
  }
  
  log(`🔒 HEDGE OPPORTUNITY: ${asset} ${hedgeSide} ${sharesToHedge} @ ${(hedgeAsk * 100).toFixed(1)}¢ | Locks $${lockedProfit.toFixed(2)} profit!`, 'hedge', asset, {
    mainSide,
    mainShares: mainPos.totalShares,
    mainCost: mainPos.totalCost,
    hedgeSide,
    hedgeAsk,
    sharesToHedge,
    hedgeCost,
    lockedProfit,
  });
  
  // Place hedge order
  const tokenId = hedgeSide === 'UP' ? market.upTokenId : market.downTokenId;
  const priceBuffer = config.price_buffer_cents / 100;
  const hedgePrice = Math.ceil((hedgeAsk + priceBuffer) * 100) / 100;
  
  const result = await placeBuyOrder(tokenId, hedgePrice, sharesToHedge, asset, hedgeSide);
  
  if (result.success && result.orderId) {
    log(`📤 HEDGE ORDER PLACED: ${asset} ${hedgeSide} ${sharesToHedge} @ ${(hedgePrice * 100).toFixed(1)}¢`, 'hedge', asset);
    
    // Wait briefly for fill
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await getOrderStatus(result.orderId);
    
    if (status.filled || status.filledSize > 0) {
      const filledSize = status.filledSize || sharesToHedge;
      const actualPrice = result.avgPrice ?? hedgePrice;
      const actualHedgeCost = filledSize * actualPrice;
      
      // Update position with hedge info
      const newHedgeShares = mainPos.hedgeShares + filledSize;
      const newHedgeCost = mainPos.hedgeCost + actualHedgeCost;
      const isFullyHedged = newHedgeShares >= mainPos.totalShares;
      
      await addHedgeToPosition(mainPos.id, newHedgeShares, newHedgeCost, isFullyHedged);
      
      // Update local cache
      mainPos.hedgeShares = newHedgeShares;
      mainPos.hedgeCost = newHedgeCost;
      mainPos.isFullyHedged = isFullyHedged;
      
      const actualLockedProfit = mainPos.totalShares - (mainPos.totalCost + newHedgeCost);
      
      log(`🔒 HEDGED: ${asset} ${filledSize} ${hedgeSide} @ ${(actualPrice * 100).toFixed(1)}¢ | ${isFullyHedged ? 'FULLY HEDGED' : `${newHedgeShares}/${mainPos.totalShares} hedged`} | Locked profit: $${actualLockedProfit.toFixed(2)}`, 'hedge', asset, {
        hedgeShares: newHedgeShares,
        hedgeCost: newHedgeCost,
        isFullyHedged,
        lockedProfit: actualLockedProfit,
      });
    }
  } else {
    log(`❌ Hedge order failed: ${result.error}`, 'hedge', asset);
  }
}

// ============================================
// POSITION MONITORING (TP/SL)
// ============================================

let monitorInterval: NodeJS.Timeout | null = null;

function startPositionMonitor(): void {
  if (monitorInterval) return;
  
  monitorInterval = setInterval(() => {
    checkPositionExit();
  }, 500);
}

function stopPositionMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

function checkPositionExit(): void {
  if (!activePosition || !activeSignal) return;
  
  const pos = activePosition;
  const sig = activeSignal;
  const state = priceState[pos.asset];
  
  // Get current bid (what we can sell at)
  const currentBid = pos.direction === 'UP' ? state.upBestBid : state.downBestBid;
  
  if (!currentBid) return;
  
  // Calculate current profit in cents
  const profitCents = (currentBid - pos.entryPrice) * 100;
  
  // Update peak profit
  if (profitCents > pos.peakProfit) {
    pos.peakProfit = profitCents;
    if (profitCents >= config.trailing_trigger_cents && !pos.trailingActive) {
      pos.trailingActive = true;
      log(`📈 TRAILING ACTIVATED: ${pos.asset} ${pos.direction} | Peak profit: ${profitCents.toFixed(1)}¢ (>= trigger ${config.trailing_trigger_cents}¢)`);
    }
  }
  
  // Calculate minimum sell price (entry + min_profit)
  const minSellPrice = pos.entryPrice + (config.min_profit_cents / 100);
  
  // TRAILING STOP LOGIC
  if (pos.trailingActive) {
    // Check if profit dropped from peak by trailing_distance
    const dropFromPeak = pos.peakProfit - profitCents;
    
    if (dropFromPeak >= config.trailing_distance_cents) {
      // Trailing stop triggered! Sell at minimum guaranteed price
      log(`📉 TRAILING STOP: ${pos.asset} ${pos.direction} | Drop ${dropFromPeak.toFixed(1)}¢ from peak ${pos.peakProfit.toFixed(1)}¢ | Selling @ min ${(minSellPrice * 100).toFixed(1)}¢`);
      void closePosition('TRAILING', minSellPrice);
      return;
    }
  }
  
  // Check if we hit minimum profit (TP at min_profit if not trailing yet)
  if (profitCents >= config.min_profit_cents && !pos.trailingActive) {
    // If we're at min profit and price is stable, just take it
    log(`🎯 MIN PROFIT HIT: ${pos.asset} ${pos.direction} | Profit ${profitCents.toFixed(1)}¢ >= min ${config.min_profit_cents}¢`);
    void closePosition('TP', currentBid);
    return;
  }
  
  // EMERGENCY STOP LOSS (actual loss - should rarely happen)
  const lossCents = -profitCents;
  if (lossCents >= config.emergency_sl_cents) {
    log(`🚨 EMERGENCY SL: ${pos.asset} ${pos.direction} | Loss ${lossCents.toFixed(1)}¢ >= emergency ${config.emergency_sl_cents}¢`);
    void closePosition('EMERGENCY', currentBid);
    return;
  }
  
  // Check timeout - try to sell at min profit, or emergency
  const elapsed = Date.now() - pos.startTime;
  if (elapsed >= config.timeout_ms) {
    if (profitCents >= config.min_profit_cents) {
      log(`⏰ TIMEOUT (profit): ${pos.asset} ${pos.direction} | Selling with ${profitCents.toFixed(1)}¢ profit`);
      void closePosition('TIMEOUT', currentBid);
    } else {
      log(`⏰ TIMEOUT (no profit): ${pos.asset} ${pos.direction} | Current ${profitCents.toFixed(1)}¢ - selling at min price`);
      void closePosition('TIMEOUT', minSellPrice);
    }
    return;
  }
}

async function closePosition(exitType: 'TP' | 'SL' | 'TRAILING' | 'TIMEOUT' | 'EMERGENCY' | 'MANUAL', sellPrice: number): Promise<void> {
  if (!activePosition || !activeSignal) return;
  
  const pos = activePosition;
  const sig = activeSignal;
  
  stopPositionMonitor();
  
  // Place sell order
  log(`📤 SELL ORDER: ${pos.asset} ${pos.direction} ${pos.shares} shares @ ${(sellPrice * 100).toFixed(1)}¢ (${exitType})`);
  const result = await placeSellOrder(pos.tokenId, sellPrice, pos.shares);
  
  const actualExitPrice = result.success ? (result.avgPrice ?? sellPrice) : sellPrice;
  
  // Calculate PnL
  const grossPnl = (actualExitPrice - pos.entryPrice) * pos.shares;
  const fees = pos.shares * 0.02; // Estimate 2% taker fee
  const netPnl = grossPnl - fees;
  
  // Update signal
  sig.status = 'closed';
  sig.exit_price = actualExitPrice;
  sig.close_ts = Date.now();
  sig.exit_type = exitType;
  sig.gross_pnl = grossPnl;
  sig.net_pnl = netPnl;
  sig.fees = fees;
  sig.notes = `${exitType} @ ${(actualExitPrice * 100).toFixed(1)}¢ | PnL: $${netPnl.toFixed(2)} | Peak: ${pos.peakProfit.toFixed(1)}¢`;
  
  const emoji = netPnl >= 0 ? '💰' : '📉';
  log(`${emoji} CLOSED: ${pos.asset} ${pos.direction} | ${exitType} @ ${(actualExitPrice * 100).toFixed(1)}¢ | PnL: $${netPnl.toFixed(2)}`);
  
  void saveSignal(sig);
  
  // Clear position
  activePosition = null;
  activeSignal = null;
}

// ============================================
// ORDERBOOK POLLING
// ============================================

async function pollOrderbooks(): Promise<void> {
  const books = await fetchAllOrderbooks(markets);
  
  for (const [asset, book] of books) {
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
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    V29 SIMPLE LIVE RUNNER                     ║
║  Clean tick-to-tick delta detection • Realtime orderbooks     ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  log(`Run ID: ${RUN_ID}`);
  
  // Check VPN
  const vpnResult = await verifyVpnConnection();
  if (!vpnResult.passed) {
    logError(`VPN check failed: ${vpnResult.error} - Cloudflare may block requests`);
  } else {
    log(`✅ VPN OK: ${vpnResult.ip} (${vpnResult.provider})`);
  }
  
  // Test Polymarket connection
  const connected = await testConnection();
  if (!connected) {
    logError('Polymarket connection failed');
    process.exit(1);
  }
  log('✅ Polymarket connected');
  
  // Get balance
  const balance = await getBalance();
  log(`💰 Balance: $${balance.toFixed(2)}`);
  
  // Init DB
  initDb();
  
  // Load config from DB (v29_config table)
  const dbConfig = await loadV29Config();
  if (dbConfig) {
    config = {
      ...config,
      enabled: dbConfig.enabled,
      tick_delta_usd: dbConfig.tick_delta_usd ?? 6,
      delta_threshold: dbConfig.delta_threshold ?? 70,
      min_share_price: dbConfig.min_share_price ?? 0.30,
      max_share_price: dbConfig.max_share_price,
      trade_size_usd: dbConfig.trade_size_usd,
      max_shares: dbConfig.max_shares,
      price_buffer_cents: dbConfig.price_buffer_cents,
      assets: dbConfig.assets as Asset[],
      tp_enabled: dbConfig.tp_enabled,
      tp_cents: dbConfig.tp_cents,
      sl_enabled: dbConfig.sl_enabled,
      sl_cents: dbConfig.sl_cents,
      timeout_ms: dbConfig.timeout_ms,
      binance_poll_ms: dbConfig.binance_poll_ms,
      orderbook_poll_ms: dbConfig.orderbook_poll_ms,
      order_cooldown_ms: dbConfig.order_cooldown_ms,
      // Accumulation & hedge
      accumulation_enabled: dbConfig.accumulation_enabled ?? true,
      max_total_cost_usd: dbConfig.max_total_cost_usd ?? 75,
      max_total_shares: dbConfig.max_total_shares ?? 300,
      auto_hedge_enabled: dbConfig.auto_hedge_enabled ?? true,
      hedge_trigger_cents: dbConfig.hedge_trigger_cents ?? 15,
      hedge_min_profit_cents: dbConfig.hedge_min_profit_cents ?? 10,
    };
    log('✅ Loaded config from v29_config table');
  } else {
    log('⚠️ Using default config (no v29_config found)');
  }
  
  if (!config.enabled) {
    log('❌ Trading is DISABLED in config. Exiting.');
    process.exit(0);
  }
  
  log(`Config: tick_delta=$${config.tick_delta_usd} | delta_threshold=±$${config.delta_threshold} | price=${(config.min_share_price * 100).toFixed(0)}-${(config.max_share_price * 100).toFixed(0)}¢ | TP=${config.tp_cents}¢`);
  
  // Fetch markets
  await fetchMarkets();
  
  // Initialize pre-signed order cache for maximum speed
  const marketsForCache = Array.from(markets.entries()).map(([asset, m]) => ({
    asset,
    upTokenId: m.upTokenId,
    downTokenId: m.downTokenId,
  }));
  await initPreSignedCache(marketsForCache);
  log('✅ Pre-signed order cache initialized');
  
  // Initial orderbook fetch
  await pollOrderbooks();
  
  // Start Chainlink WebSocket feed
  startChainlinkFeed(config.assets, handleChainlinkPrice);
  log('✅ Chainlink WebSocket feed started');
  
  // Start Binance feed (emit latest price every binance_poll_ms, not every trade)
  startBinanceFeed(config.assets, handleBinancePrice, config.binance_poll_ms, (evt) => {
    if (evt.type === 'open') {
      queueLog(RUN_ID, 'info', 'system', `Binance WS connected`, undefined, { url: evt.url });
    } else if (evt.type === 'close') {
      queueLog(RUN_ID, 'warn', 'system', `Binance WS disconnected`, undefined, { url: evt.url });
    } else {
      queueLog(RUN_ID, 'error', 'error', `Binance WS error: ${evt.message}`, undefined, { url: evt.url });
    }
  });
  log('✅ Binance price feed started');
  
  isRunning = true;
  
  // Orderbook polling
  setInterval(() => {
    void pollOrderbooks();
  }, config.orderbook_poll_ms);
  
  // Market timers are now scheduled exactly per-asset in fetchMarkets()
  // Fallback refresh every 5 minutes (safety net, normally timers handle it)
  setInterval(() => {
    void fetchMarkets();
  }, 5 * 60 * 1000);
  
  // Heartbeat (every 30 seconds)
  setInterval(async () => {
    const bal = await getBalance();
    void sendHeartbeat(RUN_ID, 'running', bal, activePosition ? 1 : 0, tradesCount);
  }, 30_000);
  
  // Initial heartbeat
  void sendHeartbeat(RUN_ID, 'starting', balance, 0, 0);
  
  // Graceful shutdown
  const shutdown = (): void => {
    log('Shutting down...');
    isRunning = false;
    stopBinanceFeed();
    stopChainlinkFeed();
    stopPreSignedCache();
    stopPositionMonitor();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  log('🚀 V29 Runner started - watching for price spikes...');
}

main().catch((err) => {
  logError('Fatal error', err);
  process.exit(1);
});
