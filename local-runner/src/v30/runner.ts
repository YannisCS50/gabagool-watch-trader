/**
 * V30 Market-Maker Runner
 * 
 * STRATEGY:
 * 1. Calculate fair value p_t = P(UP wins | C_t, Z_t, τ)
 * 2. Calculate edge: Δ = market_price - fair_value
 * 3. Buy when edge < -θ (price is undervalued)
 * 4. Trade BOTH sides (UP and DOWN) for spread capture
 * 5. Active inventory management with forced counter-bets
 * 6. Aggressive exit near expiry
 */

// CRITICAL: Import HTTP agent FIRST
import './http-agent.js';

import 'dotenv/config';
import { randomUUID } from 'crypto';
import type { Asset, V30Config, MarketInfo, PriceState, V30Tick, TradeAction } from './types.js';
import { DEFAULT_V30_CONFIG, BINANCE_SYMBOLS } from './config.js';
import { EmpiricalFairValue, getFairValueModel } from './fair-value.js';
import { getCrossingModel, EmpiricalCrossingModel } from './crossing-model.js';
import { EdgeCalculator } from './edge-calculator.js';
import { InventoryManager } from './inventory.js';
import { 
  initDb, 
  loadV30Config, 
  saveV30Config, 
  queueTick, 
  flushTicks, 
  queueLog,
  flushLogs,
  loadPositions, 
  upsertPosition, 
  clearMarketPositions, 
  sendHeartbeat,
  loadHistoricalData 
} from './db.js';
// Import shared modules from v29
import { startBinanceFeed, stopBinanceFeed } from '../v29/binance.js';
import { startChainlinkFeed, stopChainlinkFeed, getChainlinkPrice } from '../v29/chainlink.js';
import { fetchMarketOrderbook, fetchAllOrderbooks } from '../v29/orderbook.js';
import { startOrderbookWs, stopOrderbookWs, updateMarkets as updateOrderbookWsMarkets } from '../v29/orderbook-ws.js';
import { placeBuyOrder, placeSellOrder, getBalance, initPreSignedCache, stopPreSignedCache, updateMarketCache, cancelOrder, isCacheInitialized } from '../v29/trading.js';
import { verifyVpnConnection } from '../vpn-check.js';
import { testConnection } from '../polymarket.js';
import { acquireLease, releaseLease, isRunnerActive } from '../v29/lease.js';
import { config as globalConfig } from '../config.js';
import { setRunnerIdentity } from '../order-guard.js';

// ============================================
// STATE
// ============================================

const RUN_ID = `v30-${Date.now().toString(36)}`;
let isRunning = false;
let config: V30Config = { ...DEFAULT_V30_CONFIG };

// Core components
let fairValueModel: EmpiricalFairValue;
let crossingModel: EmpiricalCrossingModel;
let edgeCalculator: EdgeCalculator;
let inventoryManager: InventoryManager;

// Markets by asset
const markets = new Map<Asset, MarketInfo>();

// Price state by asset
const priceState: Record<Asset, PriceState> = {
  BTC: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  ETH: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  SOL: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
  XRP: { binance: null, chainlink: null, upBestAsk: null, upBestBid: null, downBestAsk: null, downBestBid: null, lastUpdate: 0 },
};

// Stats
let buysUpCount = 0;
let buysDownCount = 0;
let forceCounterCount = 0;
let aggressiveExitCount = 0;
let lastMarketRefresh = 0;
let lastConfigReload = 0;
let totalPnL = 0;

// Intervals
const TICK_INTERVAL_MS = 500;        // Evaluate every 500ms
const MARKET_REFRESH_MS = 60_000;    // Refresh markets every minute
const CONFIG_RELOAD_MS = 30_000;     // Reload config every 30s
const HEARTBEAT_MS = 10_000;         // Heartbeat every 10s
const CALIBRATION_INTERVAL_MS = 300_000; // Recalibrate fair value every 5 min

// ============================================
// LOGGING
// ============================================

function log(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V30] ${msg}`);
  // Also queue for database
  queueLog(RUN_ID, 'info', category, msg, asset, data);
}

function logDebug(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [V30] ${msg}`);
  queueLog(RUN_ID, 'debug', category, msg, asset, data);
}

function logWarn(msg: string, category = 'system', asset?: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.warn(`[${ts}] [V30] ⚠️ ${msg}`);
  queueLog(RUN_ID, 'warn', category, msg, asset, data);
}

function logError(msg: string, err?: unknown, category = 'error', asset?: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [V30] ❌ ${msg}`, err ?? '');
  queueLog(RUN_ID, 'error', category, msg, asset, { error: String(err) });
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
      
      for (const m of data.markets) {
        const asset = m.asset as Asset;
        if (!config.assets.includes(asset)) continue;
        
        const endMs = new Date(m.eventEndTime || m.event_end_time).getTime();
        const startMs = new Date(m.eventStartTime || m.event_start_time).getTime();
        
        // Skip expired markets
        if (endMs <= now) continue;
        
        // Skip future markets - only trade CURRENT markets
        if (startMs > now) {
          log(`⏳ ${asset}: Market starts in ${Math.round((startMs - now) / 60000)}min, skipping`);
          continue;
        }
        
        // Parse strikePrice - use 0 as fallback if not yet available
        // The fair value model will use live Binance price anyway
        let strikePrice = parseFloat(m.strikePrice || m.strike_price || m.openPrice || '0');
        if (isNaN(strikePrice)) strikePrice = 0;
        
        // Validate token IDs before adding market
        const upTokenId = m.upTokenId || m.up_token_id;
        const downTokenId = m.downTokenId || m.down_token_id;
        
        if (!upTokenId || !downTokenId) {
          log(`⚠️ ${asset}: Missing token IDs, skipping`);
          continue;
        }
        
        const marketInfo: MarketInfo = {
          slug: m.slug,
          asset,
          strikePrice,
          upTokenId,
          downTokenId,
          endTime: new Date(endMs),
        };
        
        markets.set(asset, marketInfo);
        log(`📊 Market: ${asset} | Strike $${strikePrice > 0 ? strikePrice.toFixed(0) : 'pending'} | Ends ${marketInfo.endTime.toISOString().slice(11, 19)}`);
      }
      
      // Update orderbook WS subscriptions - pass the full markets Map
      updateOrderbookWsMarkets(markets);
      
      // Only update pre-signed cache if already initialized (not on first call)
      // On first call, initPreSignedCache() handles the cache build
      if (isCacheInitialized()) {
        for (const [asset, market] of markets) {
          await updateMarketCache(asset, market.upTokenId, market.downTokenId);
        }
      }
    }
    
    lastMarketRefresh = Date.now();
  } catch (err) {
    logError('Market fetch error', err);
  }
}

// ============================================
// PRICE HANDLERS
// ============================================

function handleBinancePrice(asset: Asset, price: number): void {
  priceState[asset].binance = price;
  priceState[asset].lastUpdate = Date.now();
}

function handleChainlinkPrice(asset: Asset, price: number): void {
  priceState[asset].chainlink = price;
}

// ============================================
// ORDERBOOK UPDATES
// ============================================

async function refreshOrderbooks(): Promise<void> {
  for (const [asset, market] of markets) {
    try {
      const book = await fetchMarketOrderbook(market);
      if (book) {
        const state = priceState[asset];
        state.upBestAsk = book.upBestAsk ?? null;
        state.upBestBid = book.upBestBid ?? null;
        state.downBestAsk = book.downBestAsk ?? null;
        state.downBestBid = book.downBestBid ?? null;
        state.lastUpdate = Date.now();
      }
    } catch (err) {
      // Ignore individual failures
    }
  }
}

// ============================================
// MAIN TICK EVALUATION
// ============================================

async function evaluateTick(): Promise<void> {
  if (!isRunning) return;
  
  for (const asset of config.assets) {
    await evaluateAsset(asset);
  }
}

async function evaluateAsset(asset: Asset): Promise<void> {
  const market = markets.get(asset);
  if (!market) return;
  
  const state = priceState[asset];
  const now = Date.now();
  
  // Check we have required data
  const C_t = state.binance;
  if (!C_t) return;
  
  const upAsk = state.upBestAsk;
  const downAsk = state.downBestAsk;
  if (!upAsk || !downAsk) return;
  
  // Calculate time remaining
  const secRemaining = Math.max(0, (market.endTime.getTime() - now) / 1000);
  if (secRemaining <= 0) return;
  
  // Skip if not enough time remaining (wait for next market)
  const minTimeRequired = config.min_time_remaining_sec ?? 600;
  const inventory = inventoryManager.getInventory(asset, market.slug, secRemaining);
  const hasPosition = inventory.up > 0 || inventory.down > 0;
  
  // Only skip if we have NO position yet - if we have a position, we need to manage it
  if (!hasPosition && secRemaining < minTimeRequired) {
    // Log once per minute
    if (Math.floor(now / 60000) !== Math.floor((now - 500) / 60000)) {
      log(`⏳ ${asset}: Only ${Math.floor(secRemaining / 60)}min left, waiting for next market`);
    }
    return;
  }
  
  // Calculate delta to strike using blended price (Binance + Chainlink)
  const Z_t = state.chainlink;
  const deltaToStrike = fairValueModel.getBlendedDelta(C_t, Z_t, market.strikePrice, secRemaining);
  
  // Get fair value using blended delta
  const fairValue = fairValueModel.getFairP(asset, deltaToStrike, secRemaining);
  
  // Calculate edges (using inventory from above)
  const edgeResult = edgeCalculator.calculateEdge(
    upAsk,
    downAsk,
    fairValue,
    inventory,
    secRemaining
  );
  
  // Log tick
  const tick: V30Tick = {
    ts: now,
    run_id: RUN_ID,
    asset,
    market_slug: market.slug,
    c_price: C_t,
    z_price: state.chainlink,
    strike_price: market.strikePrice,
    seconds_remaining: Math.floor(secRemaining),
    delta_to_strike: deltaToStrike,
    up_best_ask: upAsk,
    up_best_bid: state.upBestBid,
    down_best_ask: downAsk,
    down_best_bid: state.downBestBid,
    fair_p_up: fairValue.p_up,
    edge_up: edgeResult.edge_up,
    edge_down: edgeResult.edge_down,
    theta_current: edgeResult.theta,
    inventory_up: inventory.up,
    inventory_down: inventory.down,
    inventory_net: inventory.net,
    action_taken: null,
  };
  
  // Check for aggressive exit
  if (edgeCalculator.shouldAggressiveExit(secRemaining)) {
    const action = await handleAggressiveExit(asset, market, inventory);
    tick.action_taken = action;
    queueTick(tick);
    return;
  }
  
  // Check for forced counter-bet (pass edge + avg prices for smart hedging)
  const { up: upPos, down: downPos } = inventoryManager.getMarketPositions(asset, market.slug);
  const forceCheck = edgeCalculator.shouldForceCounter(
    inventory,
    edgeResult,  // Pass edge result for edge-aware hedging
    upPos?.avg_entry_price,
    downPos?.avg_entry_price
  );
  if (forceCheck.force && forceCheck.direction) {
    const action = await handleForceCounter(asset, market, forceCheck.direction, forceCheck.reason);
    tick.action_taken = action;
    queueTick(tick);
    return;
  } else if (forceCheck.reason && !forceCheck.force) {
    // Log why we're NOT forcing counter (useful for debugging)
    logDebug(`⚖️ ${asset}: ${forceCheck.reason}`, 'hedge', asset);
  }
  
  // Normal edge-based trading
  let action: TradeAction = 'none';
  
  // Log when edge looks attractive but CI lower bound blocks it
  if (upAsk - fairValue.p_up < -edgeResult.theta && !edgeResult.signal_up) {
    // Point estimate edge is good, but CI lower bound says no
    logDebug(`⚠️ ${asset}: UP price ${(upAsk * 100).toFixed(1)}¢ < P(UP)=${(fairValue.p_up * 100).toFixed(1)}¢, but CI_lower=${(fairValue.ci_lower_up * 100).toFixed(1)}¢ blocks trade`, 'fair-value', asset);
  }
  if (downAsk - fairValue.p_down < -edgeResult.theta && !edgeResult.signal_down) {
    logDebug(`⚠️ ${asset}: DOWN price ${(downAsk * 100).toFixed(1)}¢ < P(DOWN)=${(fairValue.p_down * 100).toFixed(1)}¢, but CI_lower=${(fairValue.ci_lower_down * 100).toFixed(1)}¢ blocks trade`, 'fair-value', asset);
  }
  
  // Check UP signal
  if (edgeResult.signal_up && canTrade(asset, 'UP', upAsk)) {
    const space = inventoryManager.getAvailableSpace(asset, market.slug, 'UP', secRemaining);
    if (space > 0) {
      const size = Math.min(
        edgeCalculator.calculateBetSize(),
        space
      );
      
      const success = await executeBuy(asset, 'UP', market, upAsk, size);
      if (success) {
        action = 'buy_up';
        buysUpCount++;
        log(`🟢 BUY UP: ${asset} | ${size} sh @ ${(upAsk * 100).toFixed(1)}¢ | P(UP)=${(fairValue.p_up * 100).toFixed(1)}% [${(fairValue.ci_lower_up * 100).toFixed(0)}-${(fairValue.ci_upper_up * 100).toFixed(0)}%] | edge=${(edgeResult.edge_up * 100).toFixed(1)}%`);
      }
    }
  }
  
  // Check DOWN signal (can trade both in same tick!)
  if (edgeResult.signal_down && canTrade(asset, 'DOWN', downAsk)) {
    const space = inventoryManager.getAvailableSpace(asset, market.slug, 'DOWN', secRemaining);
    if (space > 0) {
      const size = Math.min(
        edgeCalculator.calculateBetSize(),
        space
      );
      
      const success = await executeBuy(asset, 'DOWN', market, downAsk, size);
      if (success) {
        action = action === 'buy_up' ? 'buy_up' : 'buy_down';
        buysDownCount++;
        log(`🔴 BUY DOWN: ${asset} | ${size} sh @ ${(downAsk * 100).toFixed(1)}¢ | P(DOWN)=${(fairValue.p_down * 100).toFixed(1)}% [${(fairValue.ci_lower_down * 100).toFixed(0)}-${(fairValue.ci_upper_down * 100).toFixed(0)}%] | edge=${(edgeResult.edge_down * 100).toFixed(1)}%`);
      }
    }
  }
  
  tick.action_taken = action;
  queueTick(tick);
}

// ============================================
// TRADE GUARDS
// ============================================

function canTrade(asset: Asset, direction: 'UP' | 'DOWN', price: number): boolean {
  // Price range check
  if (price < config.min_share_price || price > config.max_share_price) {
    return false;
  }
  
  // TODO: Add cooldown, rate limiting
  return true;
}

// ============================================
// TRADE EXECUTION
// ============================================

async function executeBuy(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  market: MarketInfo,
  price: number,
  shares: number
): Promise<boolean> {
  if (!isRunnerActive()) {
    log(`🛑 Runner not active, skipping buy`);
    return false;
  }
  
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const buyPrice = Math.ceil((price + 0.01) * 100) / 100; // 1¢ buffer
  
  try {
    // placeBuyOrder signature: (tokenId, price, shares, asset?, direction?)
    const result = await placeBuyOrder(tokenId, buyPrice, shares, asset, direction);
    
    if (result && result.orderId) {
      // Track position
      const pos = inventoryManager.addPosition(
        RUN_ID,
        asset,
        market.slug,
        direction,
        shares,
        buyPrice
      );
      
      // Persist to DB
      await upsertPosition(pos);
      
      return true;
    }
    
    return false;
  } catch (err) {
    logError(`Buy ${asset} ${direction} failed`, err);
    return false;
  }
}

async function executeSell(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  market: MarketInfo,
  price: number,
  shares: number
): Promise<boolean> {
  const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
  const sellPrice = Math.floor((price - 0.01) * 100) / 100; // 1¢ below bid
  
  try {
    // placeSellOrder signature: (tokenId, price, shares, asset?, direction?)
    const result = await placeSellOrder(tokenId, sellPrice, shares, asset, direction);
    
    if (result && result.orderId) {
      // Update inventory
      inventoryManager.reducePosition(asset, market.slug, direction, shares);
      return true;
    }
    
    return false;
  } catch (err) {
    logError(`Sell ${asset} ${direction} failed`, err);
    return false;
  }
}

// ============================================
// SPECIAL HANDLERS
// ============================================

async function handleForceCounter(
  asset: Asset,
  market: MarketInfo,
  direction: 'UP' | 'DOWN',
  reason: string
): Promise<TradeAction> {
  const secRemaining = Math.max(0, (market.endTime.getTime() - Date.now()) / 1000);
  const inventory = inventoryManager.getInventory(asset, market.slug, secRemaining);
  
  // Calculate how much imbalance we actually need to fix
  // net > 0 means more UP than DOWN, so we buy DOWN to balance
  // net < 0 means more DOWN than UP, so we buy UP to balance
  const imbalance = Math.abs(inventory.net);
  
  // Only buy enough to reduce imbalance, not create opposite imbalance
  // Target: reduce net to 50% of current (gradual rebalancing)
  const targetReduction = Math.ceil(imbalance * 0.5);
  const maxSize = Math.min(targetReduction, config.bet_size_base);
  
  if (maxSize < 5) {
    log(`⚠️ FORCE COUNTER SKIP: ${asset} | imbalance ${imbalance} too small to hedge`);
    return 'none';
  }
  
  log(`⚠️ FORCE COUNTER: ${asset} ${direction} | ${reason} | imbalance=${imbalance} buying=${maxSize}`);
  
  const state = priceState[asset];
  const price = direction === 'UP' ? state.upBestAsk : state.downBestAsk;
  
  if (!price) return 'none';
  
  const success = await executeBuy(asset, direction, market, price, maxSize);
  
  if (success) {
    forceCounterCount++;
    return direction === 'UP' ? 'force_counter_up' : 'force_counter_down';
  }
  
  return 'none';
}

async function handleAggressiveExit(
  asset: Asset,
  market: MarketInfo,
  inventory: { up: number; down: number; net: number }
): Promise<TradeAction> {
  const state = priceState[asset];
  const { up: upPos, down: downPos } = inventoryManager.getMarketPositions(asset, market.slug);
  
  // Only sell positions that would be at a loss if held to expiry
  // If we bought cheap (< 30¢), let it ride - potential upside is worth the small risk
  let soldAny = false;
  
  // Check UP position
  if (inventory.up > 0 && state.upBestBid && upPos) {
    const avgCost = upPos.avg_entry_price;
    const currentBid = state.upBestBid;
    
    // Only exit if:
    // 1. We bought expensive (> 50¢) and price dropped, OR
    // 2. We're in profit and want to lock it in
    const inProfit = currentBid > avgCost;
    const boughtExpensive = avgCost > 0.50;
    
    if (inProfit || boughtExpensive) {
      const success = await executeSell(asset, 'UP', market, currentBid, inventory.up);
      if (success) {
        const pnl = (currentBid - avgCost) * inventory.up;
        log(`🏃 AGGRESSIVE EXIT: Sold ${inventory.up} UP @ ${(currentBid * 100).toFixed(1)}¢ (cost ${(avgCost * 100).toFixed(1)}¢) PnL: $${pnl.toFixed(2)}`);
        soldAny = true;
      }
    } else {
      log(`💎 HOLD UP: ${inventory.up} sh @ ${(avgCost * 100).toFixed(0)}¢ - cheap position, letting it ride`);
    }
  }
  
  // Check DOWN position
  if (inventory.down > 0 && state.downBestBid && downPos) {
    const avgCost = downPos.avg_entry_price;
    const currentBid = state.downBestBid;
    
    const inProfit = currentBid > avgCost;
    const boughtExpensive = avgCost > 0.50;
    
    if (inProfit || boughtExpensive) {
      const success = await executeSell(asset, 'DOWN', market, currentBid, inventory.down);
      if (success) {
        const pnl = (currentBid - avgCost) * inventory.down;
        log(`🏃 AGGRESSIVE EXIT: Sold ${inventory.down} DOWN @ ${(currentBid * 100).toFixed(1)}¢ (cost ${(avgCost * 100).toFixed(1)}¢) PnL: $${pnl.toFixed(2)}`);
        soldAny = true;
      }
    } else {
      log(`💎 HOLD DOWN: ${inventory.down} sh @ ${(avgCost * 100).toFixed(0)}¢ - cheap position, letting it ride`);
    }
  }
  
  if (soldAny) {
    aggressiveExitCount++;
    return 'aggressive_exit';
  }
  
  return 'none';
}

// ============================================
// CALIBRATION
// ============================================

async function calibrateFairValue(): Promise<void> {
  log('📚 Calibrating fair value model from historical data...');
  
  try {
    // Load legacy cell-based model
    const history = await loadHistoricalData(10000);
    
    if (history.length > 0) {
      fairValueModel.loadFromHistory(history);
      const stats = fairValueModel.getStats();
      log(`✅ Legacy fair value calibrated: ${stats.trustedCells}/${stats.totalCells} trusted cells`);
    }
    
    // Load new crossing model from v30_ticks
    log('📊 Loading empirical crossing model...');
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    
    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const result = await crossingModel.loadFromDatabase(supabase);
      const crossingStats = crossingModel.getStats();
      log(`✅ Crossing model loaded: ${result.loaded} ticks → ${crossingStats.significantCells} significant cells (${crossingStats.totalSamples} samples)`);
    } else {
      log('⚠️ No Supabase credentials for crossing model calibration');
    }
  } catch (err) {
    logError('Fair value calibration failed', err);
  }
}

// ============================================
// MAIN LOOP
// ============================================

async function main(): Promise<void> {
  log('🚀 V30 Market-Maker starting...');
  
  // Initialize DB
  initDb();
  
  // Load config
  config = await loadV30Config();
  log(`📋 Config: enabled=${config.enabled}, assets=${config.assets.join(',')}, θ=${config.base_theta}`);
  
  if (!config.enabled) {
    log('⚠️ V30 is disabled in config. Set enabled=true to start trading.');
    log('   Continuing in monitor mode...');
  }
  
  // VPN check
  try {
    const vpnOk = await verifyVpnConnection();
    if (!vpnOk) {
      log('⚠️ VPN check failed, continuing anyway...');
    }
  } catch {
    log('⚠️ VPN check skipped');
  }
  
  // Test Polymarket connection
  try {
    await testConnection();
    log('✅ Polymarket connection OK');
  } catch (err) {
    logError('Polymarket connection failed', err);
    return;
  }
  
  // Get initial balance
  try {
    const balance = await getBalance();
    log(`💰 Balance: $${balance.toFixed(2)}`);
  } catch {
    log('⚠️ Could not fetch balance');
  }
  
  // Initialize components
  fairValueModel = getFairValueModel();
  crossingModel = getCrossingModel();
  edgeCalculator = new EdgeCalculator(config);
  inventoryManager = new InventoryManager(config);
  
  // Calibrate fair value model
  await calibrateFairValue();
  
  // Load existing positions
  const existingPositions = await loadPositions(RUN_ID);
  if (existingPositions.length > 0) {
    inventoryManager.loadPositions(existingPositions);
    log(`📋 Loaded ${existingPositions.length} existing positions`);
  }
  
  // Acquire lease - use force if FORCE_TAKEOVER env var is set
  const forceTakeover = process.env.FORCE_TAKEOVER === '1' || process.env.FORCE_TAKEOVER === 'true';
  const leaseOk = await acquireLease(RUN_ID, { force: forceTakeover });
  if (!leaseOk) {
    log('⚠️ Could not acquire lease, another runner may be active');
    log('   Continuing in monitor mode...');
  }
  
  // Load markets
  await fetchMarkets();
  
  if (markets.size === 0) {
    log('⚠️ No active markets found');
  }
  
  // Initialize pre-signed order cache
  const marketArray = Array.from(markets.entries()).map(([asset, market]) => ({
    asset,
    upTokenId: market.upTokenId,
    downTokenId: market.downTokenId,
  }));
  await initPreSignedCache(marketArray);
  
  // Start price feeds with configured assets
  const assets = config.assets;
  startBinanceFeed(assets, (asset, price) => handleBinancePrice(asset, price));
  startChainlinkFeed(assets, (asset, price) => handleChainlinkPrice(asset, price));
  
  // Start orderbook WebSocket with proper callback signature
  // First update markets so WS knows which tokens to subscribe to
  updateOrderbookWsMarkets(markets);
  
  // Start with correct callback: (asset, direction, bestBid, bestAsk, timestamp)
  startOrderbookWs((asset: Asset, direction: 'UP' | 'DOWN', bestBid: number | null, bestAsk: number | null, _timestamp: number) => {
    // Update price state from WS
    if (direction === 'UP') {
      priceState[asset].upBestBid = bestBid;
      priceState[asset].upBestAsk = bestAsk;
    } else {
      priceState[asset].downBestBid = bestBid;
      priceState[asset].downBestAsk = bestAsk;
    }
  });
  
  isRunning = true;
  
  // Main tick loop
  setInterval(evaluateTick, TICK_INTERVAL_MS);
  
  // Market refresh
  setInterval(async () => {
    await fetchMarkets();
  }, MARKET_REFRESH_MS);
  
  // Config reload
  setInterval(async () => {
    const newConfig = await loadV30Config();
    if (newConfig.enabled !== config.enabled) {
      log(`📋 Config updated: enabled=${newConfig.enabled}`);
    }
    config = newConfig;
    edgeCalculator.updateConfig(config);
    inventoryManager.updateConfig(config);
  }, CONFIG_RELOAD_MS);
  
  // Heartbeat
  setInterval(async () => {
    const balance = await getBalance().catch(() => null);
    await sendHeartbeat(
      RUN_ID,
      isRunning ? 'running' : 'stopped',
      markets.size,
      inventoryManager.getAllPositions().length,
      balance
    );
  }, HEARTBEAT_MS);
  
  // Recalibrate fair value periodically
  setInterval(calibrateFairValue, CALIBRATION_INTERVAL_MS);
  
  // Periodic orderbook refresh (backup for WS)
  setInterval(refreshOrderbooks, 5000);
  
  // Flush ticks and logs periodically
  setInterval(flushTicks, 5000);
  setInterval(flushLogs, 3000);
  
  log('✅ V30 Market-Maker running');
  log(`   Tick interval: ${TICK_INTERVAL_MS}ms`);
  log(`   Fair value model: ${config.fair_value_model}`);
  log(`   Base θ: ${(config.base_theta * 100).toFixed(1)}%`);
  log(`   Max inventory: ${config.i_max_base} shares`);
  
  // Graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function shutdown(): Promise<void> {
  log('🛑 Shutting down...', 'system');
  isRunning = false;
  
  stopBinanceFeed();
  stopChainlinkFeed();
  stopOrderbookWs();
  stopPreSignedCache();
  await flushTicks();
  await flushLogs();
  await releaseLease(RUN_ID);
  
  console.log('[V30] 👋 V30 stopped');
  process.exit(0);
}

// Start
main().catch(err => {
  logError('Fatal error', err);
  process.exit(1);
});
