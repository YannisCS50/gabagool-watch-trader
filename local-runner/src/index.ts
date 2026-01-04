import WebSocket from 'ws';
import os from 'os';
import dns from 'node:dns';
import { config } from './config.js';
import { placeOrder, testConnection, getBalance, getOrderbookDepth, invalidateBalanceCache, ensureValidCredentials } from './polymarket.js';
import { evaluateOpportunity, TopOfBook, MarketPosition, Outcome, checkLiquidityForAccumulate, checkBalanceForOpening, calculatePreHedgePrice, checkHardSkewStop, STRATEGY, STRATEGY_VERSION, STRATEGY_NAME, LegacyTradeSignal, getStrategy, buildMicroHedge, logMicroHedgeIntent, logMicroHedgeResult, checkV611Guardrails, MicroHedgeState, MicroHedgeIntent, MicroHedgeResult, unpairedShares as stratUnpairedShares } from './strategy.js';
import { enforceVpnOrExit } from './vpn-check.js';
import { fetchMarkets as backendFetchMarkets, fetchTrades, saveTrade, sendHeartbeat, sendOffline, fetchPendingOrders, updateOrder, syncPositionsToBackend, savePriceTicks, PriceTick, saveBotEvent, saveOrderLifecycle, saveInventorySnapshot, saveFundingSnapshot, BotEvent, OrderLifecycle, InventorySnapshot, FundingSnapshot } from './backend.js';
import { fetchChainlinkPrice } from './chain.js';
import { checkAndClaimWinnings, getClaimableValue, startAutoClaimLoop, stopAutoClaimLoop, isAutoClaimActive, getClaimStats } from './redeemer.js';
import { syncPositions, syncPositionsToDatabase, printPositionsReport, filter15mPositions } from './positions-sync.js';
import { recordSnapshot, recordFill, recordSettlement, TradeIntent } from './telemetry.js';
import { SNAPSHOT_INTERVAL_MS } from './logger.js';
import { startBenchmarkPolling, stopBenchmarkPolling, updateBenchmarkSnapshot, getBenchmarkTradeCount } from './benchmark-gabagool.js';

// v6.0.0: New reliability modules
import { canPlaceOrder, ReserveManager, getAvailableBalance, invalidateBalanceCacheNow, getBlockedOrderStats, FUNDING_CONFIG } from './funding.js';
import { OrderRateLimiter, canPlaceOrderRateLimited, recordOrderPlaced, recordOrderFailure, RATE_LIMIT_CONFIG } from './order-rate-limiter.js';
import { executeHedgeWithEscalation, getHedgeEscalatorStats, HEDGE_ESCALATOR_CONFIG } from './hedge-escalator.js';

// v6.3.0: Config Unification
import { getResolvedConfig, getCurrentConfig, CONFIG_VERSION } from './resolved-config.js';

// Ensure Node prefers IPv4 to avoid hangs on IPv6-only DNS results under some VPN setups.
try {
  dns.setDefaultResultOrder('ipv4first');
  console.log('🌐 DNS: default result order set to ipv4first');
} catch {
  // ignore
}

const RUNNER_ID = `local-${os.hostname()}`;
const RUNNER_VERSION = '6.3.4';  // v6.3.4: v6.1.2 Micro-Hedge Full Integration
const RUN_ID = crypto.randomUUID();

// v6.3.1: Track when runner started - only trade on markets that start AFTER this
const RUNNER_START_TIME_MS = Date.now();
const STARTUP_GRACE_CONFIG = {
  // Only trade markets that started AFTER runner boot, with a small grace window
  requireFreshMarkets: true,
  // Allow markets that started within this window before boot (for quick restarts)
  graceWindowBeforeBootMs: 60_000, // 1 minute
  // Log blocked trades for debugging
  logBlockedTrades: true,
};

// Startup banner will be printed AFTER config is built
async function printStartupBanner(): Promise<void> {
  const cfg = getCurrentConfig();
  const strategy = getStrategy();
  
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        🚀 POLYMARKET LIVE TRADER - LOCAL RUNNER                ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  📋 Strategy:  ${STRATEGY_NAME.padEnd(47)}║`);
  console.log(`║  📋 Version:   ${STRATEGY_VERSION.padEnd(47)}║`);
  console.log(`║  🔧 Config:    ${CONFIG_VERSION.padEnd(47)}║`);
  console.log('╠════════════════════════════════════════════════════════════════╣');
  
  if (cfg) {
    console.log(`║  📦 Source:    ${cfg.source.padEnd(47)}║`);
    console.log('╠════════════════════════════════════════════════════════════════╣');
    console.log('║  ⚙️  EFFECTIVE CONFIG (from ResolvedConfig):                   ║');
    console.log(`║     Trade Size: $${cfg.tradeSizing.base} (range $${cfg.tradeSizing.min}-$${cfg.tradeSizing.max})`.padEnd(66) + '║');
    console.log(`║     Max Notional/Trade: $${cfg.limits.maxNotionalPerTrade}`.padEnd(66) + '║');
    console.log(`║     Edge Buffer: ${(cfg.edge.baseBuffer * 100).toFixed(1)}% (min exec: ${(cfg.edge.minExecutableEdge * 100).toFixed(1)}%)`.padEnd(66) + '║');
    console.log(`║     Opening: max ${(cfg.opening.maxPrice * 100).toFixed(0)}¢, ~${cfg.opening.shares} shares`.padEnd(66) + '║');
    console.log(`║     Hedge: max ${(cfg.hedge.maxPrice * 100).toFixed(0)}¢, force ${cfg.hedge.forceTimeoutSec}s, ${cfg.hedge.cooldownMs}ms cd`.padEnd(66) + '║');
    console.log(`║     Timing: stop ${cfg.timing.stopNewTradesSec}s, unwind ${cfg.timing.unwindStartSec}s`.padEnd(66) + '║');
    console.log(`║     Assets: ${cfg.tradeAssets.join(', ')}`.padEnd(66) + '║');
    if (cfg.conflicts.length > 0) {
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║  ⚠️  ${cfg.conflicts.length} CONFIG CONFLICT(S) DETECTED - check logs above`.padEnd(65) + '║');
    }
  } else {
    console.log('║  ⚙️  STRATEGY CONFIG (hardcoded fallback):                     ║');
    console.log(`║     Opening: max ${(strategy.opening.maxPrice * 100).toFixed(0)}¢, ${strategy.opening.shares} shares`.padEnd(66) + '║');
    console.log(`║     Edge buffer: ${(strategy.edge.buffer * 100).toFixed(1)}¢`.padEnd(66) + '║');
    console.log(`║     Assets: ${config.trading.assets.join(', ')}`.padEnd(66) + '║');
  }
  
  // v6.3.1: Startup grace period info
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  🛡️  STARTUP GRACE PERIOD:                                      ║');
  console.log(`║     Enabled: ${STARTUP_GRACE_CONFIG.requireFreshMarkets ? 'YES' : 'NO'}`.padEnd(66) + '║');
  console.log(`║     Grace window: ${STARTUP_GRACE_CONFIG.graceWindowBeforeBootMs / 1000}s before boot`.padEnd(66) + '║');
  console.log(`║     Boot time: ${new Date(RUNNER_START_TIME_MS).toISOString().slice(11, 19)} UTC`.padEnd(66) + '║');
  console.log('║     → Only trades on markets starting after boot time          ║');
  
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
}

let currentBalance = 0;
let lastClaimCheck = 0;
let claimInFlight = false;

// Latest Chainlink spot cache (used for filling snapshot/fill context)
let lastBtcPrice: number | null = null;
let lastEthPrice: number | null = null;

interface MarketToken {
  slug: string;
  asset: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: string;
}

interface MarketContext {
  slug: string;
  market: MarketToken;
  book: TopOfBook;
  position: MarketPosition;
  lastTradeAtMs: number;
  inFlight: boolean;
  lastSnapshotTs: number;  // For snapshot logging throttle
  spotPrice: number | null;  // Cached spot price from external source
  strikePrice: number | null;  // Cached strike price from market
  // v6.1.2: Micro-hedge state tracking
  microHedgeState: MicroHedgeState;
  previousUnpaired: number;  // Track unpaired shares before last fill
}

const markets = new Map<string, MarketContext>();
const tokenToMarket = new Map<string, { slug: string; side: 'up' | 'down' }>();
let clobSocket: WebSocket | null = null;
let tradeCount = 0;
let isRunning = true;

async function fetchMarkets(): Promise<void> {
  try {
    const data = await backendFetchMarkets();
    if (!data.success || !data.markets) {
      console.error('❌ Failed to fetch markets');
      return;
    }

    const nowMs = Date.now();
    const previousTokens = new Set(tokenToMarket.keys());
    tokenToMarket.clear();

    const activeSlugs = new Set<string>();

    for (const market of data.markets) {
      // Filter by configured assets and 15min/1hour markets (v5.1: prefer 15min)
      const validMarketType = market.marketType === '15min' || market.marketType === '1hour';
      if (!validMarketType) continue;
      if (!config.trading.assets.includes(market.asset)) continue;

      const startMs = new Date(market.eventStartTime).getTime();
      const endMs = new Date(market.eventEndTime).getTime();

      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      if (nowMs < startMs || nowMs >= endMs) continue;

      activeSlugs.add(market.slug);
      tokenToMarket.set(market.upTokenId, { slug: market.slug, side: 'up' });
      tokenToMarket.set(market.downTokenId, { slug: market.slug, side: 'down' });

      if (!markets.has(market.slug)) {
        markets.set(market.slug, {
          slug: market.slug,
          market,
          book: {
            up: { bid: null, ask: null },
            down: { bid: null, ask: null },
            updatedAtMs: 0,
          },
          position: { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 },
          lastTradeAtMs: 0,
          inFlight: false,
          lastSnapshotTs: 0,
          spotPrice: null,
          strikePrice: null,
          // v6.1.2: Initialize micro-hedge state
          microHedgeState: {
            lastMicroHedgeTs: 0,
            retryCount: 0,
            pairedMinReachedTs: undefined,
          },
          previousUnpaired: 0,
        });
      }
    }

    // Prune expired markets
    for (const slug of markets.keys()) {
      if (!activeSlugs.has(slug)) markets.delete(slug);
    }

    const newTokens = new Set(tokenToMarket.keys());
    const changed = newTokens.size !== previousTokens.size || 
      [...newTokens].some(id => !previousTokens.has(id));

    if (changed) {
      console.log(`📊 Markets updated: ${markets.size} active (${tokenToMarket.size} tokens)`);
      return; // Signal reconnect needed
    }
  } catch (error) {
    console.error('❌ Error fetching markets:', error);
  }
}

async function fetchExistingTrades(): Promise<void> {
  const slugs = Array.from(markets.keys());
  if (slugs.length === 0) return;

  const trades = await fetchTrades(slugs);

  // Reset positions
  for (const ctx of markets.values()) {
    ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
  }

  for (const trade of trades) {
    const ctx = markets.get(trade.market_slug);
    if (ctx) {
      if (trade.outcome === 'UP') {
        ctx.position.upShares += trade.shares;
        ctx.position.upInvested += trade.total;
      } else {
        ctx.position.downShares += trade.shares;
        ctx.position.downInvested += trade.total;
      }
    }
  }

  console.log(`📋 Loaded ${trades.length} existing trades`);
}

// ============================================================
// v5.2.0: HEDGE RETRY CONFIGURATION
// ============================================================
const HEDGE_RETRY_CONFIG = {
  maxRetries: 3,              // Max retries per hedge attempt
  retryDelayMs: 500,          // Delay between retries
  sizeReductionFactor: 0.7,   // Reduce size by 30% on each retry
  priceIncreasePerRetry: 0.02, // Add 2¢ per retry (more aggressive)
  minSharesForRetry: 5,       // Don't retry if shares drop below 5
  panicModeThresholdSec: 120, // Under 2 min, be very aggressive
  survivalModeThresholdSec: 60, // Under 1 min, accept any price
};

// Track failed hedge attempts per market to avoid spamming
const failedHedgeAttempts = new Map<string, { lastAttemptMs: number; failures: number }>();

async function executeTrade(
  ctx: MarketContext,
  outcome: Outcome,
  price: number,
  shares: number,
  reasoning: string,
  intent: TradeIntent = 'ENTRY'
): Promise<boolean> {
  // v4.2.3: HARD SKEW STOP - block ONLY non-corrective trades.
  // Important: we must allow HEDGE orders to restore balance, otherwise we can get stuck one-sided.
  if (intent !== 'HEDGE') {
    const skewCheck = checkHardSkewStop(ctx.position);
    if (skewCheck.blocked) {
      console.log(`🛑 TRADE BLOCKED: ${skewCheck.reason}`);
      return false;
    }
  }
  const tokenId = outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
  const total = shares * price;

  // v6.0.0: Rate limit check
  const rateLimitCheck = canPlaceOrderRateLimited(ctx.slug);
  if (!rateLimitCheck.allowed) {
    console.log(`⚡ [v6.0.0] Rate limited: ${rateLimitCheck.reason} (wait ${rateLimitCheck.waitMs}ms)`);
    return false;
  }

  // v6.0.0: Funding gate check (skip for HEDGE - we use hedge escalator for those)
  if (intent !== 'HEDGE') {
    const fundsCheck = await canPlaceOrder(ctx.slug, outcome, total);
    if (!fundsCheck.canProceed) {
      console.log(`💰 [v6.0.0] Order blocked: ${fundsCheck.reason}`);
      return false;
    }
  }

  console.log(`\n📊 EXECUTING: ${outcome} ${shares} @ ${(price * 100).toFixed(0)}¢ on ${ctx.slug}`);

  // v6.0.0: Reserve notional before placing order
  const tempOrderId = `temp_${ctx.slug}_${outcome}_${Date.now()}`;
  ReserveManager.reserve(tempOrderId, ctx.slug, total, outcome);

  const result = await placeOrder({
    tokenId,
    side: 'BUY',
    price,
    size: shares,
    orderType: 'GTC',
  });

  if (!result.success) {
    // v6.0.0: Release reservation on failure
    ReserveManager.release(tempOrderId);
    recordOrderFailure(ctx.slug);
    
    console.error(`❌ Order failed: ${result.error}`);
    
    // v6.1.0: Log failed order event
    saveBotEvent({
      event_type: 'ORDER_FAILED',
      asset: ctx.market.asset,
      market_id: ctx.slug,
      run_id: RUN_ID,
      reason_code: result.error?.includes('balance') ? 'INSUFFICIENT_BALANCE' 
        : result.error?.includes('liquidity') ? 'NO_LIQUIDITY'
        : result.error?.includes('429') ? 'RATE_LIMITED'
        : 'UNKNOWN',
      data: {
        side: outcome,
        intent,
        price,
        shares,
        error: result.error,
      },
      ts: Date.now(),
    }).catch(() => { /* non-critical */ });
    
    // v6.0.0: Use new hedge escalator for hedge failures
    if (intent === 'HEDGE' && result.error) {
      const isBalanceError = result.error.includes('balance') || result.error.includes('allowance');
      const isLiquidityError = result.error.includes('liquidity');
      
      if (isBalanceError || isLiquidityError) {
        console.log(`\n🔄 [v6.0.0] HEDGE ESCALATION: ${result.error}`);
        
        const nowMs = Date.now();
        const endTime = new Date(ctx.market.eventEndTime).getTime();
        const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
        
        // v6.0.1: D) Hedge sizing on unpaired shares
        const unpairedShares = Math.abs(ctx.position.upShares - ctx.position.downShares);
        const hedgeShares = Math.max(unpairedShares, shares);  // At least the intent shares
        
        // v6.0.1: Calculate avgOtherSideCost for pair-cost gate
        const otherSide = outcome === 'UP' ? 'DOWN' : 'UP';
        const otherSideShares = outcome === 'UP' ? ctx.position.downShares : ctx.position.upShares;
        const otherSideCost = outcome === 'UP' ? ctx.position.downInvested : ctx.position.upInvested;
        const avgOtherSideCost = otherSideShares > 0 ? otherSideCost / otherSideShares : undefined;
        
        // Calculate current pair cost
        const upAvg = ctx.position.upShares > 0 ? ctx.position.upInvested / ctx.position.upShares : 0;
        const downAvg = ctx.position.downShares > 0 ? ctx.position.downInvested / ctx.position.downShares : 0;
        const currentPairCost = upAvg + downAvg;
        
        console.log(`🔄 [v6.0.1] Hedge sizing: unpairedShares=${unpairedShares}, hedgeShares=${hedgeShares}`);
        
        const escalationResult = await executeHedgeWithEscalation({
          marketId: ctx.slug,
          tokenId,
          side: outcome,
          targetShares: hedgeShares,
          initialPrice: price,
          secondsRemaining: remainingSeconds,
          avgOtherSideCost,
          currentPairCost: currentPairCost > 0 ? currentPairCost : undefined,
        });
        
        if (escalationResult.ok) {
          // Update position with escalation result
          const filledShares = escalationResult.filledShares ?? shares;
          const avgPrice = escalationResult.avgPrice ?? price;
          
          if (outcome === 'UP') {
            ctx.position.upShares += filledShares;
            ctx.position.upInvested += filledShares * avgPrice;
          } else {
            ctx.position.downShares += filledShares;
            ctx.position.downInvested += filledShares * avgPrice;
          }
          
          // Record fill with v6.0.0 extended context
          recordFill({
            marketId: ctx.slug,
            asset: ctx.market.asset as 'BTC' | 'ETH',
            side: outcome,
            orderId: escalationResult.orderId || null,
            fillQty: filledShares,
            fillPrice: avgPrice,
            intent,
            secondsRemaining: remainingSeconds,
            spotPrice: ctx.spotPrice,
            strikePrice: ctx.strikePrice,
            btcPrice: lastBtcPrice,
            ethPrice: lastEthPrice,
            upBestAsk: ctx.book.up.ask,
            downBestAsk: ctx.book.down.ask,
            upBestBid: ctx.book.up.bid,
            downBestBid: ctx.book.down.bid,
          });
          
          await saveTrade({
            market_slug: ctx.slug,
            asset: ctx.market.asset,
            outcome,
            shares: filledShares,
            price: avgPrice,
            total: filledShares * avgPrice,
            order_id: escalationResult.orderId,
            status: 'filled',
            reasoning: `${reasoning} [ESCALATION x${escalationResult.attempts}]`,
            event_start_time: ctx.market.eventStartTime,
            event_end_time: ctx.market.eventEndTime,
            avg_fill_price: avgPrice,
          });
          
          tradeCount++;
          console.log(`✅ [v6.0.0] HEDGE ESCALATION SUCCESS: ${outcome} ${filledShares}@${(avgPrice * 100).toFixed(0)}¢`);
          invalidateBalanceCache();
          invalidateBalanceCacheNow();
          return true;
        } else {
          console.error(`🚨 [v6.0.0] HEDGE ESCALATION FAILED: ${escalationResult.errorCode} - ${escalationResult.error}`);
          return false;
        }
      }
    }
    
    return false;
  }

  // v6.0.0: Record rate limit event on success
  recordOrderPlaced(ctx.slug);

  // Always set a cooldown timestamp once we attempted an order (avoid spamming WAF)
  ctx.lastTradeAtMs = Date.now();

  const status = result.status ?? 'unknown';
  const filledShares =
    status === 'filled'
      ? shares
      : status === 'partial'
        ? (result.filledSize ?? 0)
        : 0;

  // v6.0.0: Update reserve based on fill
  if (result.orderId) {
    ReserveManager.release(tempOrderId);
    if (filledShares < shares) {
      // Partial fill - reserve remaining
      const remainingNotional = (shares - filledShares) * price;
      ReserveManager.reserve(result.orderId, ctx.slug, remainingNotional, outcome);
    }
    // If fully filled, reservation is released via onFill
    if (filledShares > 0) {
      ReserveManager.onFill(result.orderId, filledShares * price);
    }
  } else {
    ReserveManager.release(tempOrderId);
  }

  // CRITICAL FIX: Log ALL orders, not just filled ones
  // This ensures we track every order the bot places for accurate position tracking
  const logShares = filledShares > 0 ? filledShares : shares;
  const logStatus = filledShares > 0 
    ? (status === 'partial' ? 'partial' : 'filled')
    : 'pending';
  const logTotal = logShares * price;

  // Update local position (use filledShares for actual position, but track pending too)
  if (filledShares > 0) {
    if (outcome === 'UP') {
      ctx.position.upShares += filledShares;
      ctx.position.upInvested += filledShares * price;
    } else {
      ctx.position.downShares += filledShares;
      ctx.position.downInvested += filledShares * price;
    }
    
    // Log fill for telemetry with v6.0.0 extended context
    const nowMs = Date.now();
    const endTime = new Date(ctx.market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
    
    recordFill({
      marketId: ctx.slug,
      asset: ctx.market.asset as 'BTC' | 'ETH',
      side: outcome,
      orderId: result.orderId || null,
      fillQty: filledShares,
      fillPrice: result.avgPrice || price,
      intent,
      secondsRemaining: remainingSeconds,
      spotPrice: ctx.spotPrice,
      strikePrice: ctx.strikePrice,
      btcPrice: lastBtcPrice,
      ethPrice: lastEthPrice,
      upBestAsk: ctx.book.up.ask,
      downBestAsk: ctx.book.down.ask,
      upBestBid: ctx.book.up.bid,
      downBestBid: ctx.book.down.bid,
    });
  }

  // Always save trade to database (with appropriate status)
  await saveTrade({
    market_slug: ctx.slug,
    asset: ctx.market.asset,
    outcome,
    shares: logShares,
    price,
    total: logTotal,
    order_id: result.orderId,
    status: logStatus,
    reasoning,
    event_start_time: ctx.market.eventStartTime,
    event_end_time: ctx.market.eventEndTime,
    avg_fill_price: result.avgPrice || price,
  });

  // v6.1.0: Log order lifecycle
  const nowMs = Date.now();
  const clientOrderId = result.orderId || tempOrderId;
  saveOrderLifecycle({
    client_order_id: clientOrderId,
    market_id: ctx.slug,
    asset: ctx.market.asset,
    side: outcome,
    intent_type: intent,
    price,
    qty: shares,
    status: logStatus.toUpperCase(),
    exchange_order_id: result.orderId,
    avg_fill_price: result.avgPrice || (filledShares > 0 ? price : undefined),
    filled_qty: filledShares,
    reserved_notional: total,
    released_notional: filledShares > 0 ? filledShares * price : 0,
    correlation_id: undefined,  // TODO: add correlation tracking
    created_ts: nowMs,
    last_update_ts: nowMs,
  }).catch(() => { /* non-critical */ });

  // v6.1.0: Log inventory snapshot after position change
  if (filledShares > 0) {
    const upAvg = ctx.position.upShares > 0 ? ctx.position.upInvested / ctx.position.upShares : 0;
    const downAvg = ctx.position.downShares > 0 ? ctx.position.downInvested / ctx.position.downShares : 0;
    const pairCost = upAvg + downAvg;
    const unpaired = Math.abs(ctx.position.upShares - ctx.position.downShares);
    const state = ctx.position.upShares === 0 && ctx.position.downShares === 0 ? 'FLAT'
      : ctx.position.upShares === 0 || ctx.position.downShares === 0 ? 'ONE_SIDED'
      : unpaired / (ctx.position.upShares + ctx.position.downShares) > 0.2 ? 'SKEWED'
      : 'HEDGED';
    
    saveInventorySnapshot({
      market_id: ctx.slug,
      asset: ctx.market.asset,
      up_shares: ctx.position.upShares,
      down_shares: ctx.position.downShares,
      avg_up_cost: upAvg > 0 ? upAvg : undefined,
      avg_down_cost: downAvg > 0 ? downAvg : undefined,
      pair_cost: pairCost > 0 ? pairCost : undefined,
      unpaired_shares: unpaired,
      state,
      trigger_type: `FILL_${intent}`,
      ts: nowMs,
    }).catch(() => { /* non-critical */ });
    
    // ============================================================
    // v6.1.2: MICRO-HEDGE AFTER FILL (Gabagool-style pairing)
    // Trigger micro-hedge after ADD/ACCUMULATE fills, not after HEDGE
    // ============================================================
    if (intent !== 'HEDGE' && ctx.position.upShares > 0 && ctx.position.downShares > 0) {
      const endTime = new Date(ctx.market.eventEndTime).getTime();
      const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
      
      // Convert MarketPosition to Inventory for strategy functions
      const inv = {
        upShares: ctx.position.upShares,
        downShares: ctx.position.downShares,
        upCost: ctx.position.upInvested,
        downCost: ctx.position.downInvested,
        firstFillTs: ctx.microHedgeState.pairedMinReachedTs ? undefined : nowMs - 30000, // Estimate
        lastFillTs: nowMs,
      };
      
      // Get guardrails for micro-hedge gating
      const cheaperSide: Outcome = (ctx.book.up.ask ?? 1) <= (ctx.book.down.ask ?? 1) ? 'UP' : 'DOWN';
      const guardrails = checkV611Guardrails(inv, remainingSeconds, nowMs, undefined, cheaperSide);
      
      // Try to build micro-hedge
      const microResult = buildMicroHedge(
        inv,
        ctx.book,
        remainingSeconds,
        ctx.previousUnpaired,
        ctx.microHedgeState.lastMicroHedgeTs,
        nowMs,
        guardrails
      );
      
      // Update previousUnpaired for next iteration
      ctx.previousUnpaired = stratUnpairedShares(inv);
      
      // Track paired_min reached
      const paired = Math.min(ctx.position.upShares, ctx.position.downShares);
      if (paired >= STRATEGY.pairedControl.minShares && !ctx.microHedgeState.pairedMinReachedTs) {
        ctx.microHedgeState.pairedMinReachedTs = nowMs;
        console.log(`[v6.1.2] ✅ PAIRED_MIN reached: ${paired} >= ${STRATEGY.pairedControl.minShares} shares`);
      }
      
      if (microResult.signal && microResult.intent) {
        // Log intent
        logMicroHedgeIntent(microResult.intent, ctx.slug);
        
        // Execute micro-hedge (async, don't await - fire and forget for speed)
        const microTokenId = microResult.signal.outcome === 'UP' 
          ? ctx.market.upTokenId 
          : ctx.market.downTokenId;
        
        const microStartMs = Date.now();
        
        placeOrder({
          tokenId: microTokenId,
          side: 'BUY',
          price: microResult.signal.price,
          size: microResult.signal.shares,
          orderType: 'GTC',
        }).then(microOrderResult => {
          const microEndMs = Date.now();
          const fillLatencyMs = microEndMs - microStartMs;
          
          if (microOrderResult.success) {
            const microFilledShares = microOrderResult.status === 'filled' 
              ? microResult.signal!.shares 
              : (microOrderResult.filledSize ?? 0);
            
            // Update position
            if (microResult.signal!.outcome === 'UP') {
              ctx.position.upShares += microFilledShares;
              ctx.position.upInvested += microFilledShares * microResult.signal!.price;
            } else {
              ctx.position.downShares += microFilledShares;
              ctx.position.downInvested += microFilledShares * microResult.signal!.price;
            }
            
            // Update micro-hedge state
            ctx.microHedgeState.lastMicroHedgeTs = microEndMs;
            ctx.microHedgeState.retryCount = 0;
            
            // Log result
            logMicroHedgeResult({
              status: microFilledShares >= microResult.signal!.shares ? 'FILLED' : 
                      microFilledShares > 0 ? 'PARTIAL' : 'PLACED',
              fillLatencyMs,
              priceUsed: microResult.signal!.price,
              filledQty: microFilledShares,
            }, ctx.slug, microResult.intent!.correlationId);
            
            // Save trade
            saveTrade({
              market_slug: ctx.slug,
              asset: ctx.market.asset,
              outcome: microResult.signal!.outcome,
              shares: microFilledShares,
              price: microResult.signal!.price,
              total: microFilledShares * microResult.signal!.price,
              order_id: microOrderResult.orderId,
              status: microFilledShares > 0 ? 'filled' : 'pending',
              reasoning: microResult.signal!.reasoning,
              event_start_time: ctx.market.eventStartTime,
              event_end_time: ctx.market.eventEndTime,
              avg_fill_price: microOrderResult.avgPrice || microResult.signal!.price,
            }).catch(() => { /* non-critical */ });
            
            // Log bot event
            saveBotEvent({
              event_type: 'MICRO_HEDGE_RESULT',
              asset: ctx.market.asset,
              market_id: ctx.slug,
              run_id: RUN_ID,
              correlation_id: microResult.intent!.correlationId,
              data: {
                status: 'FILLED',
                side: microResult.signal!.outcome,
                shares: microFilledShares,
                price: microResult.signal!.price,
                fill_latency_ms: fillLatencyMs,
                mode: microResult.intent!.mode,
              },
              ts: microEndMs,
            }).catch(() => { /* non-critical */ });
            
            console.log(`[v6.1.2] ✅ MICRO-HEDGE FILLED: ${microResult.signal!.outcome} ${microFilledShares}@${(microResult.signal!.price * 100).toFixed(1)}¢`);
          } else {
            // Micro-hedge failed
            ctx.microHedgeState.retryCount++;
            
            logMicroHedgeResult({
              status: 'ABORTED',
              abortReason: 'NO_DEPTH',
              fillLatencyMs,
            }, ctx.slug, microResult.intent!.correlationId);
            
            console.log(`[v6.1.2] ❌ MICRO-HEDGE FAILED: ${microOrderResult.error}`);
          }
        }).catch(err => {
          console.error(`[v6.1.2] ❌ MICRO-HEDGE ERROR:`, err);
        });
        
        // Log intent event
        saveBotEvent({
          event_type: 'MICRO_HEDGE_INTENT',
          asset: ctx.market.asset,
          market_id: ctx.slug,
          run_id: RUN_ID,
          correlation_id: microResult.intent.correlationId,
          data: {
            side: microResult.intent.side,
            microQty: microResult.intent.microQty,
            unpaired_before: microResult.intent.unpairedBefore,
            unpaired_after_target: microResult.intent.unpairedAfterTarget,
            mode: microResult.intent.mode,
            projected_pair_cost: microResult.intent.projectedPairCost,
          },
          ts: nowMs,
        }).catch(() => { /* non-critical */ });
      } else if (microResult.abortReason) {
        // Log abort reason (only for non-trivial aborts)
        if (microResult.abortReason !== 'COOLDOWN' && microResult.abortReason !== 'SURVIVAL_MODE') {
          console.log(`[v6.1.2] ⏭️ MICRO-HEDGE SKIP: ${microResult.abortReason}`);
        }
      }
    }
  }

  tradeCount++;
  
  if (filledShares > 0) {
    console.log(`✅ TRADE #${tradeCount}: ${outcome} ${filledShares}@${(price * 100).toFixed(0)}¢ (${logStatus})`);
    console.log(`   Position: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
    
    // Invalidate balance cache after trade
    invalidateBalanceCache();
    invalidateBalanceCacheNow();
  } else {
    console.log(`📝 ORDER #${tradeCount}: ${outcome} ${shares}@${(price * 100).toFixed(0)}¢ (pending) - ${result.orderId}`);
  }
    
  return true;
}

// ============================================================
// v5.2.0: AGGRESSIVE HEDGE RETRY
// ============================================================
async function executeHedgeWithRetry(
  ctx: MarketContext,
  outcome: Outcome,
  originalPrice: number,
  originalShares: number,
  reasoning: string
): Promise<boolean> {
  const tokenId = outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
  const nowMs = Date.now();
  const endTime = new Date(ctx.market.eventEndTime).getTime();
  const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
  
  // Track failure state
  const failKey = `${ctx.slug}:${outcome}`;
  const failState = failedHedgeAttempts.get(failKey) || { lastAttemptMs: 0, failures: 0 };
  
  // Determine mode based on time remaining
  const isPanicMode = remainingSeconds < HEDGE_RETRY_CONFIG.panicModeThresholdSec;
  const isSurvivalMode = remainingSeconds < HEDGE_RETRY_CONFIG.survivalModeThresholdSec;
  
  if (isSurvivalMode) {
    console.log(`🆘 [v5.2.0] SURVIVAL MODE HEDGE - ${remainingSeconds}s remaining, accepting any price up to 95¢`);
  } else if (isPanicMode) {
    console.log(`⚠️ [v5.2.0] PANIC MODE HEDGE - ${remainingSeconds}s remaining, being very aggressive`);
  }
  
  let currentShares = originalShares;
  let currentPrice = originalPrice;
  
  for (let retry = 1; retry <= HEDGE_RETRY_CONFIG.maxRetries; retry++) {
    // Calculate retry parameters
    if (!isSurvivalMode) {
      // Normal/Panic: reduce size and increase price gradually
      currentShares = Math.floor(currentShares * HEDGE_RETRY_CONFIG.sizeReductionFactor);
      currentPrice = Math.min(
        isSurvivalMode ? 0.95 : 0.85,
        currentPrice + HEDGE_RETRY_CONFIG.priceIncreasePerRetry
      );
    } else {
      // Survival: keep size but go to max price
      currentPrice = 0.95; // Accept 5% loss to avoid 100% loss
    }
    
    // Check minimum size
    if (currentShares < HEDGE_RETRY_CONFIG.minSharesForRetry) {
      console.log(`🛑 [v5.2.0] Hedge retry aborted: shares ${currentShares} < ${HEDGE_RETRY_CONFIG.minSharesForRetry} min`);
      break;
    }
    
    console.log(`\n🔄 [v5.2.0] HEDGE RETRY #${retry}: ${outcome} ${currentShares}@${(currentPrice * 100).toFixed(0)}¢ (time: ${remainingSeconds}s)`);
    
    // Wait before retry
    await new Promise(r => setTimeout(r, HEDGE_RETRY_CONFIG.retryDelayMs));
    
    const result = await placeOrder({
      tokenId,
      side: 'BUY',
      price: currentPrice,
      size: currentShares,
      orderType: 'GTC',
    });
    
    if (result.success) {
      const filledShares = result.status === 'filled' ? currentShares : (result.filledSize ?? 0);
      
      if (filledShares > 0) {
        // Update position
        if (outcome === 'UP') {
          ctx.position.upShares += filledShares;
          ctx.position.upInvested += filledShares * currentPrice;
        } else {
          ctx.position.downShares += filledShares;
          ctx.position.downInvested += filledShares * currentPrice;
        }
        
        // Record success
        await saveTrade({
          market_slug: ctx.slug,
          asset: ctx.market.asset,
          outcome,
          shares: filledShares,
          price: currentPrice,
          total: filledShares * currentPrice,
          order_id: result.orderId,
          status: result.status === 'filled' ? 'filled' : 'partial',
          reasoning: `${reasoning} [RETRY #${retry}]`,
          event_start_time: ctx.market.eventStartTime,
          event_end_time: ctx.market.eventEndTime,
          avg_fill_price: result.avgPrice || currentPrice,
        });
        
        console.log(`✅ [v5.2.0] HEDGE RETRY SUCCESS: ${outcome} ${filledShares}@${(currentPrice * 100).toFixed(0)}¢`);
        console.log(`   Position now: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
        
        // Clear failure state
        failedHedgeAttempts.delete(failKey);
        
        // If only partial fill and we need more, continue retrying for the rest
        if (filledShares < currentShares && filledShares < originalShares) {
          currentShares = originalShares - filledShares;
          continue; // Try to fill the rest
        }
        
        return true;
      } else {
        // Order placed but not filled yet - it's in the book
        console.log(`📝 [v5.2.0] HEDGE ORDER PLACED: ${outcome} ${currentShares}@${(currentPrice * 100).toFixed(0)}¢ (pending)`);
        return true; // Consider this success - order is in the book
      }
    } else {
      console.error(`❌ [v5.2.0] HEDGE RETRY #${retry} FAILED: ${result.error}`);
      
      // Track failure
      failState.failures++;
      failState.lastAttemptMs = nowMs;
      failedHedgeAttempts.set(failKey, failState);
    }
  }
  
  console.error(`🚨 [v5.2.0] ALL HEDGE RETRIES FAILED for ${ctx.slug} ${outcome}`);
  return false;
}


async function evaluateMarket(slug: string): Promise<void> {
  const ctx = markets.get(slug);
  if (!ctx || ctx.inFlight) return;

  ctx.inFlight = true;

  try {
    const nowMs = Date.now();
    const startTime = new Date(ctx.market.eventStartTime).getTime();
    const endTime = new Date(ctx.market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - nowMs) / 1000);

    // v6.3.1: STARTUP GRACE PERIOD - Don't trade on markets that were already running before we started
    // This prevents the bot from jumping into mid-market positions on deploy
    if (STARTUP_GRACE_CONFIG.requireFreshMarkets) {
      const hasExistingPosition = ctx.position.upShares > 0 || ctx.position.downShares > 0;
      
      // Only apply grace period to NEW positions, not to managing existing ones (hedge, accumulate)
      if (!hasExistingPosition) {
        const marketStartedBeforeBoot = startTime < RUNNER_START_TIME_MS - STARTUP_GRACE_CONFIG.graceWindowBeforeBootMs;
        
        if (marketStartedBeforeBoot) {
          const marketAgeAtBoot = Math.floor((RUNNER_START_TIME_MS - startTime) / 1000);
          
          if (STARTUP_GRACE_CONFIG.logBlockedTrades) {
            // Only log once per market to avoid spam
            const logKey = `startup_grace_${slug}`;
            if (!(global as any)[logKey]) {
              (global as any)[logKey] = true;
              console.log(`⏳ [v6.3.1] STARTUP GRACE: Skipping ${ctx.market.asset} market (started ${marketAgeAtBoot}s before boot)`);
              console.log(`   Market: ${slug}`);
              console.log(`   Started: ${ctx.market.eventStartTime} | Boot: ${new Date(RUNNER_START_TIME_MS).toISOString()}`);
              console.log(`   Will trade on next fresh market for this asset.`);
            }
          }
          
          ctx.inFlight = false;
          return;
        }
      }
    }

    // Keep spot/strike cached even if a trade happens before the next 1s tick
    const latestSpot = ctx.market.asset === 'BTC' ? lastBtcPrice : ctx.market.asset === 'ETH' ? lastEthPrice : null;
    if (latestSpot !== null) {
      ctx.spotPrice = latestSpot;
      if (ctx.strikePrice === null) {
        const startMs = new Date(ctx.market.eventStartTime).getTime();
        if (Number.isFinite(startMs) && nowMs >= startMs) {
          ctx.strikePrice = latestSpot;
        }
      }
    }

    // Check if this is a potential opening trade - if so, do balance check first
    const isOpeningCandidate = ctx.position.upShares === 0 && ctx.position.downShares === 0;
    let balanceForCheck: number | undefined = undefined;
    
    if (isOpeningCandidate) {
      // Check balance before evaluating opening opportunity
      const balanceResult = await getBalance();
      balanceForCheck = balanceResult.usdc;
      
      // Pre-check: log if balance is too low for opening + hedge
      const balanceCheck = checkBalanceForOpening(balanceForCheck, STRATEGY.opening.notional);
      if (!balanceCheck.canProceed) {
        console.log(`⚠️ ${ctx.slug}: ${balanceCheck.reason}`);
        ctx.inFlight = false;
        return;
      }
    }

    const signal = evaluateOpportunity(
      ctx.book,
      ctx.position,
      remainingSeconds,
      ctx.lastTradeAtMs,
      nowMs,
      balanceForCheck // Pass balance for opening trade validation
    );

    if (signal) {
      // v4.6.0: Handle PAIRED atomic trades - both sides at once
      if (signal.type === 'paired' && signal.pairedWith) {
        console.log(`\n🎯 [v4.6.0] ATOMIC PAIRED ENTRY for ${ctx.slug}`);
        console.log(`   UP: ${signal.shares} shares @ ${(signal.price * 100).toFixed(0)}¢`);
        console.log(`   DOWN: ${signal.pairedWith.shares} shares @ ${(signal.pairedWith.price * 100).toFixed(0)}¢`);
        
        // Check liquidity for both sides
        const upDepth = await getOrderbookDepth(ctx.market.upTokenId);
        const downDepth = await getOrderbookDepth(ctx.market.downTokenId);
        
        if (!upDepth.hasLiquidity || upDepth.askVolume < signal.shares) {
          console.log(`⛔ Skip paired: UP liquidity ${upDepth.askVolume.toFixed(0)} < ${signal.shares} needed`);
          ctx.inFlight = false;
          return;
        }
        if (!downDepth.hasLiquidity || downDepth.askVolume < signal.pairedWith.shares) {
          console.log(`⛔ Skip paired: DOWN liquidity ${downDepth.askVolume.toFixed(0)} < ${signal.pairedWith.shares} needed`);
          ctx.inFlight = false;
          return;
        }
        
        // Execute both sides atomically - UP first, then DOWN immediately
        const upSuccess = await executeTrade(ctx, 'UP', signal.price, signal.shares, signal.reasoning, 'ENTRY');
        
        if (upSuccess) {
          // Immediately execute DOWN side - no waiting
          const downSuccess = await executeTrade(
            ctx,
            'DOWN',
            signal.pairedWith.price,
            signal.pairedWith.shares,
            `PAIR_DOWN ${signal.pairedWith.shares}sh @ ${(signal.pairedWith.price * 100).toFixed(0)}¢`,
            'ENTRY'
          );

          if (downSuccess) {
            console.log(`✅ [v4.6.0] ATOMIC PAIR COMPLETE: ${signal.shares} UP + ${signal.pairedWith.shares} DOWN`);
          } else {
            console.log(`⚠️ [v4.6.0] PARTIAL PAIR: UP filled, DOWN failed - EMERGENCY hedge now`);

            const fallbackAsk = ctx.book.down.ask ?? signal.pairedWith.price;
            const emergencyPrice = Math.min(0.95, fallbackAsk + 0.03);
            await executeTrade(
              ctx,
              'DOWN',
              emergencyPrice,
              signal.pairedWith.shares,
              `EMERGENCY_HEDGE DOWN ${signal.pairedWith.shares}sh @ ${(emergencyPrice * 100).toFixed(0)}¢`,
              'HEDGE'
            );
          }
        } else {
          console.log(`⚠️ [v4.6.0] PAIR FAILED: UP side failed, skipping DOWN`);
        }
      }
      // Handle accumulate trades
      else if (signal.type === 'accumulate') {
        // Extra balance check (redundant with strategy, but safety net)
        if (ctx.position.upShares !== ctx.position.downShares) {
          console.log(`⚖️ Skip accumulate: position not balanced (${ctx.position.upShares} UP vs ${ctx.position.downShares} DOWN)`);
          ctx.inFlight = false;
          return;
        }

        const upDepth = await getOrderbookDepth(ctx.market.upTokenId);
        const downDepth = await getOrderbookDepth(ctx.market.downTokenId);
        
        const liquidityOk = checkLiquidityForAccumulate(upDepth, downDepth, signal.shares);
        if (!liquidityOk.canProceed) {
          console.log(`⛔ Skip accumulate: ${liquidityOk.reason}`);
          console.log(`   📊 UP liquidity: ${upDepth.askVolume.toFixed(0)} shares, DOWN: ${downDepth.askVolume.toFixed(0)} shares`);
          ctx.inFlight = false;
          return;
        }

        // Log projected combined cost
        const projectedCombined = (ctx.book.up.ask || 0) + (ctx.book.down.ask || 0);
        console.log(`📊 Accumulate: projected combined cost = ${(projectedCombined * 100).toFixed(0)}¢ (target < 96¢)`);
        
        // Execute both sides atomically
        const upSuccess = await executeTrade(ctx, 'UP', ctx.book.up.ask!, signal.shares, signal.reasoning, 'ACCUMULATE');
        if (upSuccess && ctx.book.down.ask) {
          const downSuccess = await executeTrade(
            ctx,
            'DOWN',
            ctx.book.down.ask,
            signal.shares,
            signal.reasoning.replace('UP', 'DOWN'),
            'ACCUMULATE'
          );

          if (!downSuccess) {
            console.log(`⚠️ Accumulate PARTIAL: UP ok, DOWN failed - EMERGENCY hedge now`);
            const emergencyPrice = Math.min(0.95, ctx.book.down.ask + 0.03);
            await executeTrade(
              ctx,
              'DOWN',
              emergencyPrice,
              signal.shares,
              `EMERGENCY_HEDGE DOWN ${signal.shares}sh @ ${(emergencyPrice * 100).toFixed(0)}¢`,
              'HEDGE'
            );
          }
        } else if (!upSuccess) {
          console.log(`⚠️ Accumulate aborted: UP side failed, skipping DOWN`);
        }
      } else {
        // Single-side trade (opening, hedge, rebalance)
        const tokenId = signal.outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
        const depth = await getOrderbookDepth(tokenId);
        
        if (!depth.hasLiquidity || depth.askVolume < signal.shares) {
          console.log(`⛔ Skip ${signal.type}: insufficient liquidity for ${signal.outcome}`);
          console.log(`   📊 Need ${signal.shares} shares, only ${depth.askVolume.toFixed(0)} available`);
          ctx.inFlight = false;
          return;
        }
        
        const tradeIntent: TradeIntent = signal.type === 'opening' ? 'ENTRY' : signal.type === 'hedge' ? 'HEDGE' : 'ENTRY';
        const tradeSuccess = await executeTrade(ctx, signal.outcome, signal.price, signal.shares, signal.reasoning, tradeIntent);
        
        // For ONE_SIDED hedge trades, no need to do pre-hedge - it IS the hedge
        if (tradeSuccess && signal.type === 'opening') {
          // This should not happen in v4.6.0 since openings are now 'paired'
          // But keep as fallback
          console.log(`⚠️ [v4.6.0] Legacy opening detected - should be paired`);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Evaluation error for ${slug}:`, error);
  } finally {
    ctx.inFlight = false;
  }
}

function connectToClob(): void {
  const tokenIds = Array.from(tokenToMarket.keys());
  if (tokenIds.length === 0) {
    console.log('⚠️ No tokens to subscribe');
    return;
  }

  console.log(`🔌 Connecting to CLOB with ${tokenIds.length} tokens...`);
  clobSocket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

  clobSocket.on('open', () => {
    console.log('✅ Connected to Polymarket CLOB WebSocket');
    clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
  });

  clobSocket.on('message', async (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString());
      await processMarketEvent(event);
    } catch {}
  });

  clobSocket.on('error', (error) => {
    console.error('❌ CLOB WebSocket error:', error.message);
  });

  clobSocket.on('close', () => {
    console.log('🔌 CLOB disconnected, reconnecting in 5s...');
    setTimeout(() => {
      if (isRunning) connectToClob();
    }, 5000);
  });
}

async function processMarketEvent(data: any): Promise<void> {
  const eventType = data.event_type;

  if (eventType === 'book') {
    const assetId = data.asset_id;
    const marketInfo = tokenToMarket.get(assetId);

    if (marketInfo) {
      const ctx = markets.get(marketInfo.slug);
      if (ctx) {
        const asks = (data.asks || []) as [string, string][];
        const bids = (data.bids || []) as [string, string][];

        const topAsk = asks.length > 0 ? parseFloat(asks[0][0]) : null;
        const topBid = bids.length > 0 ? parseFloat(bids[0][0]) : null;

        if (marketInfo.side === 'up') {
          ctx.book.up.ask = topAsk;
          ctx.book.up.bid = topBid;
        } else {
          ctx.book.down.ask = topAsk;
          ctx.book.down.bid = topBid;
        }
        ctx.book.updatedAtMs = Date.now();

        await evaluateMarket(marketInfo.slug);
      }
    }
  } else if (eventType === 'price_change') {
    const changes = data.changes || data.price_changes || [];
    for (const change of changes) {
      const assetId = change.asset_id;
      const marketInfo = tokenToMarket.get(assetId);
      if (marketInfo) {
        const ctx = markets.get(marketInfo.slug);
        if (ctx) {
          const price = parseFloat(change.price);
          if (!isNaN(price)) {
            if (marketInfo.side === 'up') {
              if (ctx.book.up.ask === null) ctx.book.up.ask = price;
            } else {
              if (ctx.book.down.ask === null) ctx.book.down.ask = price;
            }
            ctx.book.updatedAtMs = Date.now();
            await evaluateMarket(marketInfo.slug);
          }
        }
      }
    }
  }
}


async function doHeartbeat(): Promise<void> {
  try {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;

    await sendHeartbeat({
      runner_id: RUNNER_ID,
      runner_type: 'local',
      last_heartbeat: new Date().toISOString(),
      status: 'active',
      markets_count: markets.size,
      positions_count: positions,
      trades_count: tradeCount,
      balance: currentBalance,
      version: RUNNER_VERSION,
    });
  } catch (error) {
    console.error('❌ Heartbeat error:', error);
  }
}

async function main(): Promise<void> {
  // ===================================================================
  // v6.3.0: BUILD RESOLVED CONFIG FIRST (DB-FIRST)
  // ===================================================================
  console.log('\n🔧 [v6.3.0] Building ResolvedConfig (DB-first)...');
  
  try {
    await getResolvedConfig(RUN_ID);
  } catch (error) {
    console.warn('⚠️  Failed to build ResolvedConfig, using fallback:', error);
  }
  
  // Print startup banner AFTER config is built
  await printStartupBanner();
  
  // Log startup event with effective config
  const cfg = getCurrentConfig();
  saveBotEvent({
    event_type: 'RUNNER_START',
    asset: 'ALL',
    run_id: RUN_ID,
    data: {
      runner_id: RUNNER_ID,
      version: RUNNER_VERSION,
      strategy: STRATEGY_NAME,
      strategy_version: STRATEGY_VERSION,
      config_version: CONFIG_VERSION,
      config_source: cfg?.source ?? 'FALLBACK',
      hostname: os.hostname(),
      effective_config: cfg ? {
        tradeSizing: cfg.tradeSizing,
        limits: cfg.limits,
        edge: cfg.edge,
        tradeAssets: cfg.tradeAssets,
      } : null,
    },
    ts: Date.now(),
  }).catch(() => { /* non-critical */ });

  // CRITICAL: Verify VPN is active before ANY trading activity
  await enforceVpnOrExit();

  // Test Polymarket connection
  const connected = await testConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Polymarket. Check your API credentials.');
    process.exit(1);
  }

  // CRITICAL: Validate/derive API credentials BEFORE any trading
  console.log('\n🔐 Ensuring valid API credentials...');
  const credsValid = await ensureValidCredentials();
  if (!credsValid) {
    console.error('❌ Failed to validate API credentials. Check your private key and address.');
    console.error('   The runner will continue but trading may fail.');
  }

  // Get initial balance (will use newly derived creds if auto-derived)
  const balanceResult = await getBalance();
  currentBalance = balanceResult.usdc;
  
  if (balanceResult.error) {
    console.error(`⚠️ Initial balance check had error: ${balanceResult.error}`);
  }

  // Initial setup
  await fetchMarkets();
  await fetchExistingTrades();
  connectToClob();

  // Send initial heartbeat
  await doHeartbeat();

  // Periodic market refresh
  setInterval(async () => {
    const previousCount = tokenToMarket.size;
    await fetchMarkets();
    
    // Reconnect if markets changed
    if (tokenToMarket.size !== previousCount && clobSocket) {
      console.log('🔄 Markets changed, reconnecting CLOB...');
      clobSocket.close();
    }
  }, 15000);

  // Poll order queue every 2 seconds (execute orders from edge function)
  setInterval(async () => {
    const orders = await fetchPendingOrders();
    
    for (const order of orders) {
      console.log(`\n📥 RECEIVED ORDER: ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ on ${order.market_slug}`);
      
      try {
        const result = await placeOrder({
          tokenId: order.token_id,
          side: 'BUY',
          price: order.price,
          size: order.shares,
          orderType: order.order_type as 'GTC' | 'FOK' | 'GTD',
        });

        if (result.success) {
          const status = result.status ?? 'unknown';
          const filledShares =
            status === 'filled'
              ? order.shares
              : status === 'partial'
                ? (result.filledSize ?? 0)
                : 0;

          // CRITICAL FIX: Log ALL orders, not just filled ones
          const logShares = filledShares > 0 ? filledShares : order.shares;
          const logStatus = filledShares > 0 
            ? (status === 'partial' ? 'partial' : 'filled')
            : 'pending';

          // Always save trade to database for tracking
          await saveTrade({
            market_slug: order.market_slug,
            asset: order.asset,
            outcome: order.outcome,
            shares: logShares,
            price: order.price,
            total: logShares * order.price,
            order_id: result.orderId,
            status: logStatus,
            reasoning: order.reasoning || 'Order from edge function',
            event_start_time: order.event_start_time || new Date().toISOString(),
            event_end_time: order.event_end_time || new Date().toISOString(),
            avg_fill_price: result.avgPrice || order.price,
          });

          // Update order queue status
          await updateOrder(order.id, logStatus === 'pending' ? 'placed' : logStatus, {
            order_id: result.orderId,
            avg_fill_price: result.avgPrice,
          });

          tradeCount++;
          
          if (filledShares > 0) {
            console.log(`✅ ORDER EXECUTED: ${order.outcome} ${filledShares}@${(order.price * 100).toFixed(0)}¢ (${logStatus})`);
          } else {
            console.log(`📝 ORDER PLACED: ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ (pending) - ${result.orderId}`);
          }
        } else {
          await updateOrder(order.id, 'failed', { error: result.error });
          console.error(`❌ ORDER FAILED: ${result.error}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await updateOrder(order.id, 'failed', { error: msg });
        console.error(`❌ ORDER ERROR: ${msg}`);
      }
    }
  }, 2000);

  // Heartbeat every 10 seconds
  setInterval(async () => {
    const balanceResult = await getBalance();
    currentBalance = balanceResult.usdc;
    await doHeartbeat();
  }, 10000);

  // Auto-claim winnings every 30 seconds
  setInterval(async () => {
    const nowMs = Date.now();

    // Only check every 30 seconds
    if (nowMs - lastClaimCheck < 30000) return;

    // Prevent overlapping claim loops (can cause duplicate tx attempts)
    if (claimInFlight) {
      console.log('⏳ Auto-claim already running, skipping this tick');
      return;
    }

    claimInFlight = true;
    lastClaimCheck = nowMs;

    try {
      const result = await checkAndClaimWinnings();
      if (result.claimed > 0) {
        console.log(`💰 Auto-claimed ${result.claimed} winning positions!`);
      }
    } catch (error) {
      console.error('❌ Auto-claim error:', error);
    } finally {
      claimInFlight = false;
    }
  }, 30000);

  // Sync positions from Polymarket API every 10 seconds
  // This reconciles pending orders with actual fills in near real-time
  let lastSyncAt = 0;
  let syncInFlight = false;
  setInterval(async () => {
    const nowMs = Date.now();
    if (nowMs - lastSyncAt < 10000) return;
    if (syncInFlight) return; // Prevent overlapping syncs
    
    syncInFlight = true;
    lastSyncAt = nowMs;

    try {
      // Sync positions from Polymarket AND write to database
      const syncResult = await syncPositionsToDatabase(config.polymarket.address);
      
      // Only print report if we have positions (reduce noise)
      if (syncResult.positions.length > 0 && syncResult.summary.totalPositions > 0) {
        console.log(`🔄 Sync: ${syncResult.summary.totalPositions} positions, $${syncResult.summary.totalValue.toFixed(2)} value, $${syncResult.summary.unrealizedPnl.toFixed(2)} P/L`);
        if (syncResult.dbResult) {
          console.log(`   💾 DB: ${syncResult.dbResult.upserted} upserted, ${syncResult.dbResult.deleted} deleted`);
        }
      }

      // Sync to backend (reconcile pending orders)
      const positions15m = filter15mPositions(syncResult.positions);
      const positionsData = positions15m.map(p => ({
        conditionId: p.conditionId,
        market: p.market,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        currentValue: p.currentValue,
        initialValue: p.initialValue,
        eventSlug: p.eventSlug,
      }));

      const backendResult = await syncPositionsToBackend(config.polymarket.address, positionsData);
      if (backendResult.success && (backendResult.updated || backendResult.cancelled)) {
        console.log(`✅ Reconciled: ${backendResult.updated || 0} fills, ${backendResult.cancelled || 0} cancelled`);
      }
    } catch (error) {
      console.error('❌ Position sync error:', error);
    } finally {
      syncInFlight = false;
    }
  }, 10000);

  // ===================================================================
  // PRICE TICK LOGGING: Save BTC/ETH Chainlink prices every 1 second
  // ===================================================================
  let tickLogInFlight = false;

  setInterval(async () => {
    if (tickLogInFlight) return;
    tickLogInFlight = true;

    try {
      const [btcResult, ethResult] = await Promise.all([
        fetchChainlinkPrice('BTC'),
        fetchChainlinkPrice('ETH'),
      ]);

      const ticks: PriceTick[] = [];

      if (btcResult) {
        const prev = lastBtcPrice ?? btcResult.price;
        const delta = btcResult.price - prev;
        const deltaPct = prev > 0 ? (delta / prev) * 100 : 0;
        ticks.push({
          asset: 'BTC',
          price: btcResult.price,
          delta,
          delta_percent: deltaPct,
          source: 'runner_chainlink',
        });
        lastBtcPrice = btcResult.price;
      }

      if (ethResult) {
        const prev = lastEthPrice ?? ethResult.price;
        const delta = ethResult.price - prev;
        const deltaPct = prev > 0 ? (delta / prev) * 100 : 0;
        ticks.push({
          asset: 'ETH',
          price: ethResult.price,
          delta,
          delta_percent: deltaPct,
          source: 'runner_chainlink',
        });
        lastEthPrice = ethResult.price;
      }

      // Keep per-market cached spot/strike up to date so SNAPSHOT/FILL logs include context
      const nowMs = Date.now();
      for (const ctx of markets.values()) {
        const spot = ctx.market.asset === 'BTC' ? lastBtcPrice : ctx.market.asset === 'ETH' ? lastEthPrice : null;
        if (spot !== null) {
          ctx.spotPrice = spot;

          // Strike price = spot at (or right after) market start, set once
          if (ctx.strikePrice === null) {
            const startMs = new Date(ctx.market.eventStartTime).getTime();
            if (Number.isFinite(startMs) && nowMs >= startMs) {
              ctx.strikePrice = spot;
            }
          }
        }
      }

      if (ticks.length > 0) {
        await savePriceTicks(ticks);
      }
    } catch (e) {
      // silent – non-critical
    } finally {
      tickLogInFlight = false;
    }
  }, 1000);

  // ===================================================================
  // SNAPSHOT LOGGING: Record market state every 1 second for telemetry
  // Also updates benchmark context for gabagool22 trade enrichment
  // ===================================================================
  setInterval(() => {
    const nowMs = Date.now();
    
    for (const ctx of markets.values()) {
      const endMs = new Date(ctx.market.eventEndTime).getTime();
      const secondsRemaining = Math.max(0, Math.floor((endMs - nowMs) / 1000));
      
      // Only snapshot active markets (not expired)
      if (secondsRemaining <= 0) continue;
      
      // Calculate delta for benchmark context
      const delta = (ctx.spotPrice !== null && ctx.strikePrice !== null && ctx.strikePrice > 0)
        ? Math.abs(ctx.spotPrice - ctx.strikePrice) / ctx.strikePrice
        : null;
      
      // Calculate cheapestAskPlusOtherMid for benchmark context
      const upMid = (ctx.book.up.bid !== null && ctx.book.up.ask !== null) 
        ? (ctx.book.up.bid + ctx.book.up.ask) / 2 
        : null;
      const downMid = (ctx.book.down.bid !== null && ctx.book.down.ask !== null) 
        ? (ctx.book.down.bid + ctx.book.down.ask) / 2 
        : null;
      
      let cheapestAskPlusOtherMid: number | null = null;
      if (ctx.book.up.ask !== null && ctx.book.down.ask !== null && upMid !== null && downMid !== null) {
        if (ctx.book.up.ask <= ctx.book.down.ask) {
          cheapestAskPlusOtherMid = ctx.book.up.ask + downMid;
        } else {
          cheapestAskPlusOtherMid = ctx.book.down.ask + upMid;
        }
      }
      
      // Update benchmark context for gabagool22 trade enrichment (READ-ONLY)
      updateBenchmarkSnapshot(ctx.slug, {
        secondsRemaining,
        spotPrice: ctx.spotPrice,
        strikePrice: ctx.strikePrice,
        delta,
        upBestAsk: ctx.book.up.ask,
        downBestAsk: ctx.book.down.ask,
        cheapestAskPlusOtherMid,
      });
      
      // v6.0.0: Extended snapshot with btcPrice/ethPrice for enrichment
      recordSnapshot({
        marketId: ctx.slug,
        asset: ctx.market.asset as 'BTC' | 'ETH',
        secondsRemaining,
        spotPrice: ctx.spotPrice,
        strikePrice: ctx.strikePrice,
        upBid: ctx.book.up.bid,
        upAsk: ctx.book.up.ask,
        downBid: ctx.book.down.bid,
        downAsk: ctx.book.down.ask,
        upShares: ctx.position.upShares,
        downShares: ctx.position.downShares,
        upCost: (ctx.position as any).upCost ?? (ctx.position as any).upInvested ?? 0,
        downCost: (ctx.position as any).downCost ?? (ctx.position as any).downInvested ?? 0,
        btcPrice: lastBtcPrice,
        ethPrice: lastEthPrice,
      });
    }
  }, SNAPSHOT_INTERVAL_MS);

  // ===================================================================
  // v5.2.0: ONE-SIDED POSITION MONITOR - AGGRESSIVE HEDGE ENFORCEMENT
  // Runs every 3 seconds to find and fix one-sided positions
  // ===================================================================
  let hedgeMonitorInFlight = false;

  setInterval(async () => {
    if (hedgeMonitorInFlight) return;
    hedgeMonitorInFlight = true;

    try {
      const nowMs = Date.now();
      
      for (const ctx of markets.values()) {
        const hasUp = ctx.position.upShares > 0;
        const hasDown = ctx.position.downShares > 0;
        
        // Only act on ONE-SIDED positions
        if ((hasUp && !hasDown) || (!hasUp && hasDown)) {
          const endTime = new Date(ctx.market.eventEndTime).getTime();
          const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
          
          // Skip if market already expired
          if (remainingSeconds <= 0) continue;
          
          // Check cooldown - don't spam same market
          const timeSinceLastTrade = nowMs - ctx.lastTradeAtMs;
          if (timeSinceLastTrade < 2000) continue; // 2s cooldown
          
          // Determine severity based on time remaining
          const missingSide: Outcome = !hasUp ? 'UP' : 'DOWN';
          const existingShares = missingSide === 'UP' ? ctx.position.downShares : ctx.position.upShares;
          const missingAsk = missingSide === 'UP' ? ctx.book.up.ask : ctx.book.down.ask;
          
          // Skip if no book data
          if (!missingAsk || missingAsk <= 0) continue;
          
          // Calculate urgency
          const isSurvival = remainingSeconds < 60;  // Under 1 min
          const isPanic = remainingSeconds < 120;     // Under 2 min
          const isUrgent = remainingSeconds < 300;    // Under 5 min
          
          if (isSurvival) {
            console.log(`\n🆘 [v5.2.0] SURVIVAL MONITOR: ${ctx.slug} is ONE-SIDED (${missingSide} missing, ${remainingSeconds}s left)`);
            console.log(`   Position: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
            console.log(`   ${missingSide} ask: ${(missingAsk * 100).toFixed(0)}¢`);
            
            // SURVIVAL: Accept high prices, just get hedged
            const survivalPrice = Math.min(0.95, missingAsk + 0.10); // Up to 95¢ or ask + 10¢
            await executeTrade(
              ctx, 
              missingSide, 
              survivalPrice, 
              existingShares, 
              `🆘 SURVIVAL_MONITOR: ${remainingSeconds}s left, MUST HEDGE`,
              'HEDGE'
            );
            
          } else if (isPanic) {
            console.log(`\n⚠️ [v5.2.0] PANIC MONITOR: ${ctx.slug} is ONE-SIDED (${missingSide} missing, ${remainingSeconds}s left)`);
            
            // PANIC: Be aggressive but still reasonable
            const panicPrice = Math.min(0.85, missingAsk + 0.05); // Up to 85¢ or ask + 5¢
            await executeTrade(
              ctx, 
              missingSide, 
              panicPrice, 
              existingShares, 
              `⚠️ PANIC_MONITOR: ${remainingSeconds}s left`,
              'HEDGE'
            );
            
          } else if (isUrgent) {
            // URGENT: Normal hedge logic but enforce it
            const urgentPrice = Math.min(0.75, missingAsk + 0.03); // Up to 75¢ or ask + 3¢
            
            // Only log every 30s to reduce noise
            if (Math.random() < 0.1) {
              console.log(`⏰ [v5.2.0] URGENT: ${ctx.slug} needs ${missingSide} hedge (${remainingSeconds}s left)`);
            }
            
            await executeTrade(
              ctx, 
              missingSide, 
              urgentPrice, 
              existingShares, 
              `⏰ URGENT_MONITOR: ${remainingSeconds}s left`,
              'HEDGE'
            );
          }
        }
      }
    } catch (error) {
      console.error('❌ Hedge monitor error:', error);
    } finally {
      hedgeMonitorInFlight = false;
    }
  }, 3000); // Every 3 seconds

  // Status logging every minute
  setInterval(async () => {
    const positions = [...markets.values()].filter(
      c => c.position.upShares > 0 || c.position.downShares > 0
    ).length;
    
    // Count one-sided positions (CRITICAL METRIC)
    const oneSided = [...markets.values()].filter(c => {
      const hasUp = c.position.upShares > 0;
      const hasDown = c.position.downShares > 0;
      return (hasUp && !hasDown) || (!hasUp && hasDown);
    }).length;
    
    // Also show claimable value
    const claimableValue = await getClaimableValue();
    const claimableStr = claimableValue > 0 ? ` | $${claimableValue.toFixed(2)} claimable` : '';
    const oneSidedStr = oneSided > 0 ? ` | ⚠️ ${oneSided} ONE-SIDED` : '';
    
    console.log(`\n📊 Status: ${markets.size} markets | ${positions} positions${oneSidedStr} | ${tradeCount} trades | $${currentBalance.toFixed(2)} balance${claimableStr}`);
    
    // Log benchmark stats (gabagool22 tracking)
    const benchmarkCount = getBenchmarkTradeCount();
    if (benchmarkCount > 0) {
      console.log(`   📊 Benchmark: ${benchmarkCount} gabagool22 trades tracked`);
    }
  }, 60000);

  // ===================================================================
  // BENCHMARK: Start gabagool22 trade tracking (READ-ONLY)
  // ===================================================================
  startBenchmarkPolling();

  // ===================================================================
  // AUTO-CLAIM: Start automatic claiming loop (every 5 minutes)
  // ===================================================================
  startAutoClaimLoop(5 * 60 * 1000); // 5 minute interval
  console.log('💰 Auto-claim loop started (5 min interval)');

  console.log('\n✅ Live trader running with auto-claim! Press Ctrl+C to stop.\n');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n👋 Shutting down...');
  isRunning = false;
  
  // Stop auto-claim loop
  stopAutoClaimLoop();
  
  // Print claim stats
  const claimStats = getClaimStats();
  console.log(`\n📊 CLAIM SESSION STATS:`);
  console.log(`   Confirmed claims: ${claimStats.confirmed}`);
  console.log(`   Total claimed: $${claimStats.totalClaimedUSDC.toFixed(2)}`);
  
  // Stop benchmark polling
  stopBenchmarkPolling();
  
  // Send offline heartbeat via backend
  await sendOffline(RUNNER_ID);
  
  if (clobSocket) clobSocket.close();
  process.exit(0);
});

main().catch(console.error);
