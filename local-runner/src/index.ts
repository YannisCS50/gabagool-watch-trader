import WebSocket from 'ws';
import os from 'os';
import dns from 'node:dns';
import { config } from './config.js';
import { testConnection, getBalance, getOrderbookDepth, invalidateBalanceCache, ensureValidCredentials } from './polymarket.js';
import { evaluateOpportunity, TopOfBook, MarketPosition, Outcome, checkLiquidityForAccumulate, checkBalanceForOpening, calculatePreHedgePrice, checkHardSkewStop, STRATEGY, STRATEGY_VERSION, STRATEGY_NAME, buildMicroHedge, logMicroHedgeIntent, logMicroHedgeResult, checkV611Guardrails, MicroHedgeState, MicroHedgeIntent, MicroHedgeResult, unpairedShares as stratUnpairedShares, checkEntryGuards } from './strategy.js';
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

// v6.5.0: Inventory Risk & Robustness
import { 
  checkRiskGate, 
  calculateInventoryRisk, 
  evaluateDegradedMode, 
  updateQueueSize, 
  logActionSkipped, 
  getRiskMetricsForSnapshot, 
  getMarketAggregation,
  isDegradedMode,
  isQueueStressed,
  INVENTORY_RISK_CONFIG,
  type IntendedAction,
  type SkipReason,
  // v6.6.0: Emergency Unwind & Safety Block
  setSafetyBlock,
  clearSafetyBlock,
  isSafetyBlocked,
  checkEmergencyUnwindTrigger,
  isEmergencyUnwindActive,
  isInEmergencyCooldown,
  logGuardrailThrottled,
  type EmergencyUnwindContext,
} from './inventory-risk.js';

// v7.0.1: Patch Layer (minimal additions)
import {
  V7_PATCH_VERSION,
  v7CheckReadinessGate,
  v7ClearReadinessState,
  v7IsMarketReady,
  getReadinessState,
  accumulateHedgeNeeded,
  shouldPlaceMicroHedge,
  clearMicroHedgeAccumulator,
  resetMicroHedgeAccumulator,
  calculateRiskScore,
  isActionAllowedInDegradedMode,
  updateGlobalPendingCount,
  v7IsQueueStressed,
  isActionAllowedInQueueStress,
  checkV7Gates,
  getV7PatchStats,
  logV7PatchStatus,
  type V7MarketBook,
  type V7IntentType,
  type RiskScoreResult,
} from './strategy.js';

// v7 REV C: MarketStateManager for pairing guardrails
import { 
  getMarketStateManager, 
  MarketStateManager,
  type PairingState,
  type StatePermissions,
  MARKET_STATE_CONFIG,
  LATE_EXPIRY_SECONDS,
} from './market-state-manager.js';

// v7.2.4 REV C.4: Hard Invariants (position caps, one-sided freeze, CPP paired-only)
// v7.2.5 REV C.5: placeOrderWithCaps is now the ONLY allowed order entry point
// v7.2.6: ExposureLedger for effective exposure tracking
// v7.2.7 REV C.4.1: Concurrency safety (mutex, burst limiter, halt on breach)
import {
  checkAllInvariants,
  onFillUpdateInvariants,
  activateFreezeAdds,
  clearFreezeAdds,
  isFreezeAddsActive,
  calculateCppPairedOnly,
  HARD_INVARIANT_CONFIG,
  HALT_ON_BREACH_CONFIG,
  placeOrderWithCaps,
  checkForEffectiveBreachHalt,
  getConcurrencyStats,
  clearConcurrencyState,
  type OrderSide,
  type OrderContext,
} from './hard-invariants.js';
import {
  syncPosition as ledgerSyncPosition,
  clearMarket as ledgerClearMarket,
  getEffectiveExposure,
  getLedgerEntry,
  assertInvariants as ledgerAssertInvariants,
} from './exposure-ledger.js';
// v7.2.7: Market mutex for concurrency protection
import { tryAcquire as mutexTryAcquire, forceRelease as mutexForceRelease, getMutexStats } from './market-mutex.js';
import { BURST_LIMITER_CONFIG, getBurstStats, clearBurstState } from './burst-limiter.js';

// v7.3.2: Runner lease for single-runner enforcement
import {
  acquireLeaseOrHalt,
  releaseLease,
  renewLease,
  isLeaseHeld,
  getLeaseStatus,
  LEASE_CONFIG,
} from './runner-lease.js';

// v7.2.8 REV C.4.2: PnL Accounting + Sell Policy
import {
  processFill as accountingProcessFill,
  processSettlement as accountingProcessSettlement,
  updateMarkPrices as accountingUpdateMarkPrices,
  getMarketPnL,
  getGlobalPnL,
  getEntry as getAccountingEntry,
  initializePosition as accountingInitializePosition,
  clearMarket as accountingClearMarket,
  logPnLSnapshot,
  type FillEvent as AccountingFillEvent,
} from './accounting-ledger.js';
import {
  checkSellPolicy,
  getSellPolicy,
  logSellPolicyStatus,
  type SellReason,
} from './sell-policy.js';

// Ensure Node prefers IPv4 to avoid hangs on IPv6-only DNS results under some VPN setups.
try {
  dns.setDefaultResultOrder('ipv4first');
  console.log('🌐 DNS: default result order set to ipv4first');
} catch {
  // ignore
}

const RUNNER_ID = `local-${os.hostname()}`;
const RUNNER_VERSION = '7.3.1';  // v7.3.1: Gabagool-Aligned Emergency Fix - CPP sanity guard, dominantSide invariant, skew worsening check
const RUN_ID = crypto.randomUUID();

// v7 REV C: Initialize MarketStateManager singleton
let marketStateManager: MarketStateManager | null = null;

// v6.3.1: Track when runner started - only trade on markets that start AFTER this
const RUNNER_START_TIME_MS = Date.now();
const STARTUP_GRACE_CONFIG = {
  // Only trade markets that started AFTER runner boot, with a small grace window
  requireFreshMarkets: true,
  // Allow markets that started within this window before boot (for quick restarts)
  graceWindowBeforeBootMs: 60_000, // 1 minute
  // Log blocked trades for debugging
  logBlockedTrades: true,
  // v6.3.2: Block entry if delta is already too large (market already moved significantly)
  // This prevents opening cheap bets that are unlikely to recover
  maxDeltaForEntry: 0.025, // 2.5% delta = block entry
  // Also block if combined mid is too extreme (price already dislocated)
  minCombinedMidForEntry: 0.92, // Below 92¢ combined = dislocation, block entry
};

// Startup banner will be printed AFTER config is built
async function printStartupBanner(): Promise<void> {
  const cfg = getCurrentConfig();
  
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║        🚀 POLYMARKET LIVE TRADER - LOCAL RUNNER                ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  📋 Runner:    ${RUNNER_VERSION.padEnd(47)}║`);
  console.log(`║  📋 Strategy:  ${STRATEGY_NAME.padEnd(47)}║`);
  console.log(`║  📋 Strat Ver: ${STRATEGY_VERSION.padEnd(47)}║`);
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
    console.log(`║     Opening: max ${(STRATEGY.opening.maxPrice * 100).toFixed(0)}¢, ${STRATEGY.opening.shares} shares`.padEnd(66) + '║');
    console.log(`║     Edge buffer: ${(STRATEGY.edge.baseBuffer * 100).toFixed(1)}¢`.padEnd(66) + '║');
    console.log(`║     Assets: ${config.trading.assets.join(', ')}`.padEnd(66) + '║');
  }
  
  // v6.3.1: Startup grace period info
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  🛡️  STARTUP GRACE PERIOD:                                      ║');
  console.log(`║     Enabled: ${STARTUP_GRACE_CONFIG.requireFreshMarkets ? 'YES' : 'NO'}`.padEnd(66) + '║');
  console.log(`║     Grace window: ${STARTUP_GRACE_CONFIG.graceWindowBeforeBootMs / 1000}s before boot`.padEnd(66) + '║');
  console.log(`║     Boot time: ${new Date(RUNNER_START_TIME_MS).toISOString().slice(11, 19)} UTC`.padEnd(66) + '║');
  console.log('║     → Only trades on markets starting after boot time          ║');
  
  // v7.0.1: Patch layer info
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  🔧 v7.0.1 PATCH LAYER (on v6 infra):                           ║`);
  console.log('║     ✓ Readiness gate + 12s timeout                             ║');
  console.log('║     ✓ Bounded intent slots (max 2 per market)                  ║');
  console.log('║     ✓ Micro-hedge accumulator (min 5 shares)                   ║');
  console.log('║     ✓ Degraded mode via riskScore >= 400                       ║');
  console.log('║     ✓ Queue-stress gating                                      ║');
  
  // v7.2.0 REV C: Pairing guardrails
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  🛡️ v7.2.0 REV C PAIRING GUARDRAILS:                            ║`);
  console.log(`║     ✓ PAIRING timeout: ${MARKET_STATE_CONFIG.pairingTimeoutSeconds}s max dwell                         ║`);
  console.log(`║     ✓ Dynamic hedge slippage caps (vol-based)                  ║`);
  console.log(`║     ✓ Bounded hedge chunks: ${MARKET_STATE_CONFIG.minHedgeChunkAbs}-${MARKET_STATE_CONFIG.maxHedgeChunkAbs} shares                   ║`);
  console.log(`║     ✓ State machine: FLAT→ONE_SIDED→PAIRING→PAIRED             ║`);
  console.log(`║     ✓ Heavy skew warning at 75%+ ratio                         ║`);
  
  // v7.2.4 REV C.4: Hard Invariants
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  🔒 v7.2.4 REV C.4 HARD INVARIANTS:                              ║`);
  console.log(`║     ✓ maxSharesPerSide: ${HARD_INVARIANT_CONFIG.maxSharesPerSide} shares                            ║`);
  console.log(`║     ✓ maxTotalSharesPerMarket: ${HARD_INVARIANT_CONFIG.maxTotalSharesPerMarket} shares                   ║`);
  console.log(`║     ✓ ONE_SIDED freeze adds (no adds on dominant side)         ║`);
  console.log(`║     ✓ CPP paired-only (avgUp + avgDown cents)                  ║`);
  
  // v7.2.7 REV C.4.1: Concurrency safety
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  🔐 v7.2.7 REV C.4.1 CONCURRENCY SAFETY:                         ║`);
  console.log(`║     ✓ Per-market mutex (no concurrent orders)                  ║`);
  console.log(`║     ✓ Burst limiter: max ${BURST_LIMITER_CONFIG.maxOrdersPerMinutePerMarket}/min, ${BURST_LIMITER_CONFIG.minMsBetweenOrdersPerMarket}ms min interval      ║`);
  console.log(`║     ✓ Halt on breach: suspend market + cancel orders           ║`);
  
  // v7.2.8 REV C.4.2: PnL Accounting + Sell Policy
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  📊 v7.2.8 REV C.4.2 PNL ACCOUNTING:                              ║`);
  console.log(`║     ✓ Realized PnL: tracked per SELL/settlement                ║`);
  console.log(`║     ✓ Unrealized PnL: mark-to-market (bestBid)                 ║`);
  console.log(`║     ✓ Cost basis: average-cost method                          ║`);
  const policy = getSellPolicy();
  const modeLabel = (!policy.allowProactiveSells && !policy.allowProfitTakingSells) 
    ? '💎 GABAGOOL' 
    : (policy.allowProactiveSells && policy.allowProfitTakingSells) 
      ? '⚡ AGGRESSIVE' 
      : '🔀 CUSTOM';
  console.log(`║     ✓ Sell Policy: ${modeLabel} (proactive=${policy.allowProactiveSells ? 'ON' : 'OFF'})             ║`);
  
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  // Log full sell policy details
  logSellPolicyStatus();
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
  firstFillTs: number | null;  // v6.4.0: Track first fill time for paired_delay_sec
  // v7.0.1: Risk tracking
  unpairedFirstTs: number | null;  // When unpaired position started
  lastRiskScore: RiskScoreResult | null;
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
          firstFillTs: null,  // v6.4.0: Track first fill time
          // v7.0.1: Risk tracking
          unpairedFirstTs: null,
          lastRiskScore: null,
        });
      }
    }

    // Prune expired markets and clear v7 state + ledger
    for (const slug of markets.keys()) {
      if (!activeSlugs.has(slug)) {
        const ctx = markets.get(slug);
        // v7.0.1: Clear readiness state and accumulators
        v7ClearReadinessState(slug);
        resetMicroHedgeAccumulator(slug);
        // v7.2.6: Clear ledger for expired market
        // v7.2.7: Clear concurrency state (mutex, burst limiter)
        // v7.2.8: Clear accounting ledger for expired market
        if (ctx) {
          ledgerClearMarket(slug, ctx.market.asset);
          clearConcurrencyState(slug, ctx.market.asset);
          accountingClearMarket(slug, ctx.market.asset);
        }
        markets.delete(slug);
      }
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

  // Reset positions (both local context and ledger)
  for (const ctx of markets.values()) {
    ctx.position = { upShares: 0, downShares: 0, upInvested: 0, downInvested: 0 };
  }

  // Aggregate positions per market
  const positionsBySlug = new Map<string, { upShares: number; downShares: number }>();
  
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
      
      // Track for ledger sync
      if (!positionsBySlug.has(trade.market_slug)) {
        positionsBySlug.set(trade.market_slug, { upShares: 0, downShares: 0 });
      }
      const pos = positionsBySlug.get(trade.market_slug)!;
      if (trade.outcome === 'UP') pos.upShares += trade.shares;
      else pos.downShares += trade.shares;
    }
  }

  // v7.2.6: Sync positions to ExposureLedger
  for (const [slug, pos] of positionsBySlug) {
    const ctx = markets.get(slug);
    if (!ctx) continue;

    ledgerSyncPosition(slug, ctx.market.asset, pos.upShares, pos.downShares);

    // DEBUG: If we start already over the cap, we should see it immediately in logs.
    // This does NOT change behavior; it just helps confirm whether >100 is pre-existing.
    const cap = HARD_INVARIANT_CONFIG.maxSharesPerSide;
    if (pos.upShares > cap || pos.downShares > cap) {
      console.warn(
        `🚨 [STARTUP] POSITION_OVER_CAP: ${ctx.market.asset} ${slug} ` +
          `UP=${pos.upShares} DOWN=${pos.downShares} (cap=${cap}/side)`
      );
    }
  }

  console.log(`📋 Loaded ${trades.length} existing trades, synced ${positionsBySlug.size} markets to ledger`);
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
  // ============================================================
  // v7.2.4 REV C.4: HARD INVARIANTS CHECK (MUST BE FIRST)
  // This is the SINGLE entry point for all position/freeze guards
  // ============================================================
  const invariantCheck = checkAllInvariants({
    marketId: ctx.slug,
    asset: ctx.market.asset,
    side: 'BUY' as OrderSide,
    outcome,
    requestedSize: shares,
    intentType: intent,
    currentUpShares: ctx.position.upShares,
    currentDownShares: ctx.position.downShares,
    upCost: ctx.position.upInvested,
    downCost: ctx.position.downInvested,
    combinedAsk: ctx.book.up.ask !== null && ctx.book.down.ask !== null 
      ? ctx.book.up.ask + ctx.book.down.ask : null,
    runId: RUN_ID,
  });
  
  if (!invariantCheck.allowed) {
    // Already logged by checkAllInvariants
    return false;
  }
  
  // Use clamped size if applicable
  const finalShares = invariantCheck.finalSize;
  if (finalShares !== shares) {
    console.log(`📏 [v7.2.4] Using clamped size: ${shares}→${finalShares} shares`);
  }
  
  // v4.2.3: HARD SKEW STOP - block ONLY non-corrective trades.
  // Important: we must allow HEDGE orders to restore balance, otherwise we can get stuck one-sided.
  if (intent !== 'HEDGE') {
    const skewCheck = checkHardSkewStop(ctx.position);
    if (skewCheck.blocked) {
      // v7.2.1 HOTFIX E: Throttle to max 1 log per 30s per market per reason
      const logKey = `skew_block_${ctx.slug}`;
      const nowMs = Date.now();
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
        (global as any)[logKey] = nowMs;
        console.log(`🛑 TRADE BLOCKED: ${skewCheck.reason} (${ctx.market.asset})`);
      }
      return false;
    }
  }
  const tokenId = outcome === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
  const total = finalShares * price;

  // v6.0.0: Rate limit check
  const rateLimitCheck = canPlaceOrderRateLimited(ctx.slug);
  if (!rateLimitCheck.allowed) {
    console.log(`⚡ [v6.0.0] Rate limited: ${rateLimitCheck.reason} (wait ${rateLimitCheck.waitMs}ms)`);
    // Avoid log/attempt spam while breaker is open
    ctx.lastTradeAtMs = Date.now();
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

  console.log(`\n📊 EXECUTING: ${outcome} ${finalShares} @ ${(price * 100).toFixed(0)}¢ on ${ctx.slug}`);

  // v6.0.0: Reserve notional before placing order
  const tempOrderId = `temp_${ctx.slug}_${outcome}_${Date.now()}`;
  ReserveManager.reserve(tempOrderId, ctx.slug, total, outcome);

  // v7.2.5: Use placeOrderWithCaps for hard cap enforcement
  const orderCtx: OrderContext = {
    marketId: ctx.slug,
    asset: ctx.market.asset,
    outcome,
    currentUpShares: ctx.position.upShares,
    currentDownShares: ctx.position.downShares,
    upCost: ctx.position.upInvested,
    downCost: ctx.position.downInvested,
    intentType: intent,
    runId: RUN_ID,
  };

  const result = await placeOrderWithCaps({
    tokenId,
    side: 'BUY',
    price,
    size: finalShares,
    orderType: 'GTC',
  }, orderCtx);

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
          // v7.2.5: Required fields for hard cap enforcement
          asset: ctx.market.asset,
          currentUpShares: ctx.position.upShares,
          currentDownShares: ctx.position.downShares,
          upCost: ctx.position.upInvested,
          downCost: ctx.position.downInvested,
          runId: RUN_ID,
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
          
          // v7.2.8: Update accounting ledger with fill
          accountingProcessFill({
            marketId: ctx.slug,
            asset: ctx.market.asset,
            side: outcome as 'UP' | 'DOWN',
            action: 'BUY',  // Hedge is always a BUY (we don't SELL during normal operation)
            qty: filledShares,
            price: avgPrice,
            orderId: escalationResult.orderId,
            runId: RUN_ID,
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
    // v6.4.0: Track first fill time for paired_delay_sec calculation
    if (ctx.firstFillTs === null) {
      ctx.firstFillTs = Date.now();
    }
    
    if (outcome === 'UP') {
      ctx.position.upShares += filledShares;
      ctx.position.upInvested += filledShares * price;
    } else {
      ctx.position.downShares += filledShares;
      ctx.position.downInvested += filledShares * price;
    }
    
    // ============================================================
    // v7.2.5 REV C.5: UPDATE HARD INVARIANTS AFTER FILL
    // This triggers freeze activation/clearing and invariant assertions
    // If position exceeds caps, market is SUSPENDED immediately
    // ============================================================
    const invariantUpdate = onFillUpdateInvariants({
      marketId: ctx.slug,
      asset: ctx.market.asset,
      fillSide: outcome,
      fillQty: filledShares,
      newUpShares: ctx.position.upShares,
      newDownShares: ctx.position.downShares,
      upCost: ctx.position.upInvested,
      downCost: ctx.position.downInvested,
      runId: RUN_ID,
    });
    
    // CRITICAL: If invariant violated (position > 100), market MUST be suspended
    if (invariantUpdate.invariantViolated) {
      console.error(`🚨 [v7.2.5] INVARIANT_BREACH: Position exceeds hard cap!`);
      console.error(`   UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
      console.error(`   Max per side: ${HARD_INVARIANT_CONFIG.maxSharesPerSide}`);
      
      // Suspend market to prevent further trading
      marketStateManager?.suspendMarket(ctx.slug, ctx.market.asset, 300000, 'INVARIANT_BREACH_HARD_CAP');
      
      // Log critical event
      saveBotEvent({
        event_type: 'INVARIANT_BREACH_HARD_CAP',
        asset: ctx.market.asset,
        market_id: ctx.slug,
        ts: Date.now(),
        run_id: RUN_ID,
        data: {
          upShares: ctx.position.upShares,
          downShares: ctx.position.downShares,
          maxSharesPerSide: HARD_INVARIANT_CONFIG.maxSharesPerSide,
          lastFillSide: outcome,
          lastFillQty: filledShares,
        },
      }).catch(() => {});
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
    
    // v7.2.8: Update accounting ledger with fill
    accountingProcessFill({
      marketId: ctx.slug,
      asset: ctx.market.asset,
      side: outcome as 'UP' | 'DOWN',
      action: 'BUY',  // All fills are BUYs (gabagool style - no proactive sells)
      qty: filledShares,
      price: result.avgPrice || price,
      orderId: result.orderId,
      runId: RUN_ID,
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
    const paired = Math.min(ctx.position.upShares, ctx.position.downShares);
    const state = ctx.position.upShares === 0 && ctx.position.downShares === 0 ? 'FLAT'
      : ctx.position.upShares === 0 || ctx.position.downShares === 0 ? 'ONE_SIDED'
      : unpaired / (ctx.position.upShares + ctx.position.downShares) > 0.2 ? 'SKEWED'
      : 'HEDGED';
    
    // v6.4.0: Calculate unpaired_notional_usd (unpaired shares * avg cost of unpaired side)
    const unpairedSide = ctx.position.upShares > ctx.position.downShares ? 'UP' : 'DOWN';
    const unpairedAvgCost = unpairedSide === 'UP' ? upAvg : downAvg;
    const unpairedNotionalUsd = unpaired * unpairedAvgCost;
    
    // v6.4.0: Calculate paired_delay_sec (time from first fill to becoming paired)
    let pairedDelaySec: number | undefined = undefined;
    if (paired > 0 && ctx.microHedgeState?.pairedMinReachedTs && ctx.firstFillTs) {
      pairedDelaySec = (ctx.microHedgeState.pairedMinReachedTs - ctx.firstFillTs) / 1000;
    }
    
    saveInventorySnapshot({
      market_id: ctx.slug,
      asset: ctx.market.asset,
      up_shares: ctx.position.upShares,
      down_shares: ctx.position.downShares,
      avg_up_cost: upAvg > 0 ? upAvg : undefined,
      avg_down_cost: downAvg > 0 ? downAvg : undefined,
      pair_cost: pairCost > 0 ? pairCost : undefined,
      unpaired_shares: unpaired,
      paired_shares: paired,                           // v6.4.0
      unpaired_notional_usd: unpairedNotionalUsd > 0 ? unpairedNotionalUsd : undefined, // v6.4.0
      paired_delay_sec: pairedDelaySec,                // v6.4.0
      state,
      trigger_type: `FILL_${intent}`,
      ts: nowMs,
    }).catch(() => { /* non-critical */ });
    
    // ============================================================
    // v7.0.1 PATCH 3: MICRO-HEDGE ACCUMULATOR (min order size safe)
    // v7.2.2 REV C.2: Micro-hedge only allowed in PAIRED state
    // ============================================================
    if (intent !== 'HEDGE' && ctx.position.upShares > 0 && ctx.position.downShares > 0) {
      const endTime = new Date(ctx.market.eventEndTime).getTime();
      const remainingSeconds = Math.floor((endTime - nowMs) / 1000);
      
      // v7.2.2 REV C.2: Check state permissions for micro-hedge
      if (!marketStateManager) {
        marketStateManager = getMarketStateManager(RUN_ID);
      }
      const microHedgePermissions = marketStateManager.getStatePermissions(ctx.slug, ctx.market.asset, remainingSeconds);
      
      if (!microHedgePermissions.canMicroHedge) {
        // Log once per 30s to avoid spam
        const logKey = `micro_hedge_blocked_${ctx.slug}`;
        if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
          (global as any)[logKey] = nowMs;
          const currentState = marketStateManager.getState(ctx.slug, ctx.market.asset);
          console.log(`🚫 [v7.2.2] MICRO_HEDGE BLOCKED: state=${currentState} (${microHedgePermissions.reason})`);
        }
        // Don't accumulate or place micro-hedge
      } else {
        // Calculate fill delta (how much more unpaired we got from this fill)
        const newUnpaired = Math.abs(ctx.position.upShares - ctx.position.downShares);
        const deltaUnpaired = newUnpaired - ctx.previousUnpaired;
        
        // Accumulate hedge needed
        if (deltaUnpaired > 0) {
          const accumulatedShares = accumulateHedgeNeeded(ctx.slug, deltaUnpaired);
          console.log(`[v7.0.1] HEDGE_ACCUMULATE: +${deltaUnpaired.toFixed(1)} shares → total ${accumulatedShares.toFixed(1)} pending`);
        }
        
        // Check if we should place hedge now
        const hedgeCheck = shouldPlaceMicroHedge(ctx.slug, remainingSeconds);
      
        if (!hedgeCheck.should) {
          // Not placing hedge yet - log reason
          if (hedgeCheck.reason !== 'NO_HEDGE_NEEDED') {
            console.log(`[v7.0.1] MICRO_HEDGE DEFERRED: ${hedgeCheck.reason}`);
          }
          ctx.previousUnpaired = newUnpaired;
        } else {
        // Place accumulated hedge
        console.log(`[v7.0.1] MICRO_HEDGE TRIGGER: ${hedgeCheck.shares} shares (${hedgeCheck.reason})`);
        
        // Convert MarketPosition to Inventory for strategy functions
        const inv = {
          upShares: ctx.position.upShares,
          downShares: ctx.position.downShares,
          upCost: ctx.position.upInvested,
          downCost: ctx.position.downInvested,
          firstFillTs: ctx.microHedgeState.pairedMinReachedTs ? undefined : nowMs - 30000,
          lastFillTs: nowMs,
        };
        
        // Build micro-hedge with accumulated shares
        const microResult = buildMicroHedge(
          inv,
          ctx.book,
          hedgeCheck.shares,  // Use accumulated shares, not delta
          remainingSeconds
        );
        
        // Update previousUnpaired for next iteration
        ctx.previousUnpaired = newUnpaired;
        
        // Track paired_min reached
        const paired = Math.min(ctx.position.upShares, ctx.position.downShares);
        if (paired >= (STRATEGY.pairedControl?.minShares ?? 10) && !ctx.microHedgeState.pairedMinReachedTs) {
          ctx.microHedgeState.pairedMinReachedTs = nowMs;
          console.log(`[v7.0.1] ✅ PAIRED_MIN reached: ${paired} shares`);
        }
      
        if (microResult) {
          // Execute accumulated micro-hedge
          const microTokenId = microResult.side === 'UP' 
            ? ctx.market.upTokenId 
            : ctx.market.downTokenId;
          
          const microStartMs = Date.now();
          console.log(`[v7.0.1] PLACING ACCUMULATED MICRO-HEDGE: ${microResult.side} ${microResult.qty}@${(microResult.price * 100).toFixed(1)}¢`);
          
          // v7.2.5: Use placeOrderWithCaps for hard cap enforcement
          const microOrderCtx: OrderContext = {
            marketId: ctx.slug,
            asset: ctx.market.asset,
            outcome: microResult.side,
            currentUpShares: ctx.position.upShares,
            currentDownShares: ctx.position.downShares,
            upCost: ctx.position.upInvested,
            downCost: ctx.position.downInvested,
            intentType: 'HEDGE',
            runId: RUN_ID,
          };
          
          placeOrderWithCaps({
            tokenId: microTokenId,
            side: 'BUY',
            price: microResult.price,
            size: microResult.qty,
            orderType: 'GTC',
          }, microOrderCtx).then(microOrderResult => {
            const microEndMs = Date.now();
            const fillLatencyMs = microEndMs - microStartMs;
            
            if (microOrderResult.success) {
              const microFilledShares = microOrderResult.status === 'filled' 
                ? microResult.qty 
                : (microOrderResult.filledSize ?? 0);
              
              // Update position
              if (microResult.side === 'UP') {
                ctx.position.upShares += microFilledShares;
                ctx.position.upInvested += microFilledShares * microResult.price;
              } else {
                ctx.position.downShares += microFilledShares;
                ctx.position.downInvested += microFilledShares * microResult.price;
              }
              
              // v7.0.1: Clear accumulated shares
              clearMicroHedgeAccumulator(ctx.slug, microFilledShares);
              
              // Update micro-hedge state
              ctx.microHedgeState.lastMicroHedgeTs = microEndMs;
              ctx.microHedgeState.retryCount = 0;
              
              // Save trade
              saveTrade({
                market_slug: ctx.slug,
                asset: ctx.market.asset,
                outcome: microResult.side,
                shares: microFilledShares,
                price: microResult.price,
                total: microFilledShares * microResult.price,
                order_id: microOrderResult.orderId,
                status: microFilledShares > 0 ? 'filled' : 'pending',
                reasoning: `[v7.0.1] ACCUMULATED_MICRO_HEDGE ${hedgeCheck.reason}`,
                event_start_time: ctx.market.eventStartTime,
                event_end_time: ctx.market.eventEndTime,
                avg_fill_price: microOrderResult.avgPrice || microResult.price,
              }).catch(() => { /* non-critical */ });
              
              // Log bot event
              saveBotEvent({
                event_type: 'MICRO_HEDGE_RESULT',
                asset: ctx.market.asset,
                market_id: ctx.slug,
                run_id: RUN_ID,
                data: {
                  status: 'FILLED',
                  side: microResult.side,
                  shares: microFilledShares,
                  price: microResult.price,
                  fill_latency_ms: fillLatencyMs,
                  accumulated: true,
                  trigger: hedgeCheck.reason,
                },
                ts: microEndMs,
              }).catch(() => { /* non-critical */ });
              
              console.log(`[v7.0.1] ✅ ACCUMULATED MICRO-HEDGE FILLED: ${microResult.side} ${microFilledShares}@${(microResult.price * 100).toFixed(1)}¢`);
            } else {
              // Micro-hedge failed
              ctx.microHedgeState.retryCount++;
              console.log(`[v7.0.1] ❌ MICRO-HEDGE FAILED: ${microOrderResult.error}`);
            }
          }).catch(err => {
            console.error(`[v7.0.1] ❌ MICRO-HEDGE ERROR:`, err);
          });
          
          // Log intent event
          saveBotEvent({
            event_type: 'MICRO_HEDGE_INTENT',
            asset: ctx.market.asset,
            market_id: ctx.slug,
            run_id: RUN_ID,
            data: {
              side: microResult.side,
              qty: microResult.qty,
              price: microResult.price,
              isUrgent: microResult.isUrgent,
              trigger: hedgeCheck.reason,
              accumulated_shares: hedgeCheck.shares,
            },
            ts: nowMs,
          }).catch(() => { /* non-critical */ });
          }
        } // end else (hedgeCheck.should)
      } // end else (canMicroHedge)
    } // end if (micro-hedge conditions)
  } // end if (position check)

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
    
    // v7.2.5: Use placeOrderWithCaps for hard cap enforcement
    const hedgeRetryCtx: OrderContext = {
      marketId: ctx.slug,
      asset: ctx.market.asset,
      outcome,
      currentUpShares: ctx.position.upShares,
      currentDownShares: ctx.position.downShares,
      upCost: ctx.position.upInvested,
      downCost: ctx.position.downInvested,
      intentType: 'HEDGE',
      runId: RUN_ID,
    };
    
    const result = await placeOrderWithCaps({
      tokenId,
      side: 'BUY',
      price: currentPrice,
      size: currentShares,
      orderType: 'GTC',
    }, hedgeRetryCtx);
    
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
    
    // v7.2.1 HOTFIX C: Check if market is suspended due to balance error
    const suspendKey = `market_suspended_${slug}`;
    const suspendedUntil = (global as any)[suspendKey];
    if (suspendedUntil && nowMs < suspendedUntil) {
      const remainingSec = Math.ceil((suspendedUntil - nowMs) / 1000);
      const logKey = `suspended_log_${slug}`;
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
        (global as any)[logKey] = nowMs;
        console.log(`⏸️ [v7.2.1] MARKET_SUSPENDED: ${ctx.market.asset} (${remainingSec}s remaining)`);
      }
      ctx.inFlight = false;
      return;
    }
    
    const startTime = new Date(ctx.market.eventStartTime).getTime();
    const endTime = new Date(ctx.market.eventEndTime).getTime();
    const remainingSeconds = Math.floor((endTime - nowMs) / 1000);

    // ============================================================
    // v7.0.1 PATCH 1: READINESS GATE + 12s TIMEOUT
    // v7.1.1: Active orderbook fetch if WebSocket data is stale
    // ============================================================
    
    // Check if book data is stale (> 2s or never received)
    const bookAgeMs = ctx.book.updatedAtMs > 0 ? (nowMs - ctx.book.updatedAtMs) : Infinity;
    const isBookStale = bookAgeMs > 2000;
    
    // v7.1.1: If book is stale, try to fetch via HTTP as fallback
    if (isBookStale && !getReadinessState(slug)?.disabled) {
      try {
        // Fetch orderbook for both tokens in parallel
        const [upDepth, downDepth] = await Promise.all([
          getOrderbookDepth(ctx.market.upTokenId),
          getOrderbookDepth(ctx.market.downTokenId),
        ]);
        
        // Update book if we got data
        if (upDepth.topAsk !== null || upDepth.topBid !== null) {
          ctx.book.up.ask = upDepth.topAsk;
          ctx.book.up.bid = upDepth.topBid;
        }
        if (downDepth.topAsk !== null || downDepth.topBid !== null) {
          ctx.book.down.ask = downDepth.topAsk;
          ctx.book.down.bid = downDepth.topBid;
        }
        
        // Update timestamp if we got any data
        if ((upDepth.topAsk !== null || upDepth.topBid !== null) ||
            (downDepth.topAsk !== null || downDepth.topBid !== null)) {
          ctx.book.updatedAtMs = nowMs;
          console.log(`📡 [v7.1.1] Orderbook fetched via HTTP for ${slug}: UP=${upDepth.topAsk?.toFixed(2) || 'n/a'} DOWN=${downDepth.topAsk?.toFixed(2) || 'n/a'}`);
        }
      } catch (err) {
        // Non-critical - WebSocket may still update
      }
    }
    
    const v7Book: V7MarketBook = {
      up: ctx.book.up,
      down: ctx.book.down,
      updatedAtMs: ctx.book.updatedAtMs,
    };
    
    const readinessCheck = v7CheckReadinessGate(
      slug,
      v7Book,
      startTime,
      ctx.market.asset,
      RUN_ID,
      nowMs
    );
    
    if (!readinessCheck.allowed) {
      // Only log once to avoid spam
      const logKey = `readiness_${slug}`;
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 5000)) {
        (global as any)[logKey] = nowMs;
        if (readinessCheck.disabled) {
          console.log(`🚫 [v7.0.1] Market DISABLED: ${slug} - ${readinessCheck.reason}`);
        } else {
          console.log(`⏳ [v7.0.1] Waiting for orderbook: ${slug} - ${readinessCheck.reason}`);
        }
      }
      ctx.inFlight = false;
      return;
    }

    // ============================================================
    // v6.6.0: SAFETY BLOCK CHECK (Invalid Book)
    // ============================================================
    const safetyCheck = isSafetyBlocked(slug);
    if (safetyCheck.blocked) {
      // Only allow CANCEL_ALL in safety block mode
      // Log once per 5s to avoid spam
      const logKey = `safety_block_${slug}`;
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 5000)) {
        (global as any)[logKey] = nowMs;
        console.log(`🚨 [v6.6.0] SAFETY_BLOCK: All trading blocked for ${slug}`);
        console.log(`   Reason: ${safetyCheck.reason}`);
      }
      ctx.inFlight = false;
      return;
    }

    // ============================================================
    // v7.2.0 REV C: MARKET STATE MANAGER - PAIRING GUARDRAILS
    // ============================================================
    if (!marketStateManager) {
      marketStateManager = getMarketStateManager(RUN_ID);
    }
    
    // Calculate combined mid for volatility tracking
    const upAskForMid = ctx.book.up.ask ?? 0.5;
    const downAskForMid = ctx.book.down.ask ?? 0.5;
    const combinedMid = upAskForMid + downAskForMid;
    
    // Process tick through MarketStateManager
    const stateResult = marketStateManager.processTick(
      slug,
      ctx.market.asset,
      ctx.position.upShares,
      ctx.position.downShares,
      remainingSeconds,
      combinedMid,
      { bestAskUp: ctx.book.up.ask, bestAskDown: ctx.book.down.ask }
    );
    
    // Handle PAIRING_TIMEOUT_REVERT - block further trading and cancel unfilled hedges
    if (stateResult.pairingTimedOut) {
      console.log(`🚨 [v7.2.2 REV C.2] PAIRING_TIMEOUT: ${ctx.market.asset} after ${stateResult.timeInPairing.toFixed(1)}s`);
      console.log(`   UP=${ctx.position.upShares}, DOWN=${ctx.position.downShares}`);
      console.log(`   → Reverted to ${stateResult.state}, FREEZE_ADDS=true, blocking new entries`);
      
      // v7.2.2 REV C.2: FREEZE_ADDS is now set in MarketStateManager
      // All subsequent entry/accumulate will be blocked by state permissions
    }
    
    // ============================================================
    // v7.2.2 REV C.2: CENTRAL STATE GATING (AUTHORITATIVE)
    // This is the ONE central point that gates all trading decisions
    // ============================================================
    const statePermissions = marketStateManager.getStatePermissions(slug, ctx.market.asset, remainingSeconds);
    
    // Check suspension first
    const suspensionCheck = marketStateManager.isSuspended(slug, ctx.market.asset);
    if (suspensionCheck.suspended) {
      const logKey = `suspended_log_${slug}`;
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
        (global as any)[logKey] = nowMs;
        console.log(`⏸️ [v7.2.2] MARKET_SUSPENDED: ${ctx.market.asset} - ${suspensionCheck.reason}`);
      }
      ctx.inFlight = false;
      return;
    }
    
    // ============================================================
    // v7.2.7 REV C.4.1: PROACTIVE EFFECTIVE EXPOSURE BREACH CHECK
    // Halt market if effective exposure exceeds caps
    // ============================================================
    const breachCheck = checkForEffectiveBreachHalt(slug, ctx.market.asset, RUN_ID);
    if (breachCheck.breached) {
      console.error(`🚨 [v7.2.7] EFFECTIVE_BREACH_HALT: ${ctx.market.asset}`);
      console.error(`   Effective: UP=${breachCheck.effectiveUp} DOWN=${breachCheck.effectiveDown} TOTAL=${breachCheck.effectiveTotal}`);
      for (const v of breachCheck.violations) {
        console.error(`   ❌ ${v}`);
      }
      
      // Suspend market for 15 minutes
      marketStateManager?.suspendMarket(slug, ctx.market.asset, HALT_ON_BREACH_CONFIG.suspendDurationMs, 'EFFECTIVE_EXPOSURE_BREACH');
      ctx.inFlight = false;
      return;
    }
    
    // Log state changes for observability
    const stateLogKey = `state_log_${slug}`;
    const lastLoggedState = (global as any)[stateLogKey];
    if (lastLoggedState !== stateResult.state) {
      (global as any)[stateLogKey] = stateResult.state;
      console.log(`🔄 [v7.2.2] STATE_CHANGE: ${ctx.market.asset} → ${stateResult.state}`);
      if (statePermissions.reason) {
        console.log(`   Permissions: entry=${statePermissions.canEntry} accum=${statePermissions.canAccumulate} hedge=${statePermissions.canHedge} micro=${statePermissions.canMicroHedge}`);
      }
      
      // Log UNWIND_ONLY_ENTER when transitioning into UNWIND_ONLY
      if (stateResult.state === 'UNWIND_ONLY') {
        saveBotEvent({
          event_type: 'UNWIND_ONLY_ENTER',
          asset: ctx.market.asset,
          market_id: slug,
          run_id: RUN_ID,
          ts: nowMs,
          data: { secondsRemaining: remainingSeconds, upShares: ctx.position.upShares, downShares: ctx.position.downShares },
        }).catch(() => {});
      }
    }

    // ============================================================
    // v7.0.1 PATCH 4: RISK SCORE CALCULATION & DEGRADED MODE
    // ============================================================
    const unpaired = Math.abs(ctx.position.upShares - ctx.position.downShares);
    const unpairedSide = ctx.position.upShares > ctx.position.downShares ? 'UP' : 'DOWN';
    const unpairedAvgCost = unpairedSide === 'UP' 
      ? (ctx.position.upShares > 0 ? ctx.position.upInvested / ctx.position.upShares : 0)
      : (ctx.position.downShares > 0 ? ctx.position.downInvested / ctx.position.downShares : 0);
    const unpairedNotional = unpaired * unpairedAvgCost;
    
    // Track when unpaired started
    if (unpaired === 0) {
      ctx.unpairedFirstTs = null;
    } else if (ctx.unpairedFirstTs === null) {
      ctx.unpairedFirstTs = nowMs;
    }
    const unpairedAgeSec = ctx.unpairedFirstTs ? (nowMs - ctx.unpairedFirstTs) / 1000 : 0;
    
    // Calculate risk score
    const riskScore = calculateRiskScore(unpairedNotional, unpairedAgeSec);
    
    // v7.2.0: Additional check - if in PAIRING state for too long, increase risk score
    if (stateResult.state === 'PAIRING' && stateResult.timeInPairing > 30) {
      // Approaching timeout, be extra cautious
      console.log(`⏳ [v7.2.0] PAIRING_WARNING: ${ctx.market.asset} in PAIRING for ${stateResult.timeInPairing.toFixed(0)}s/${MARKET_STATE_CONFIG.pairingTimeoutSeconds}s`);
    }
    
    // ============================================================
    // v6.6.0: EMERGENCY UNWIND CHECK
    // v6.6.1 FIX: CPP guards only apply when paired > 0
    // ============================================================
    const paired = Math.min(ctx.position.upShares, ctx.position.downShares);
    const totalInvested = ctx.position.upInvested + ctx.position.downInvested;
    // v6.6.1: Use null for costPerPaired when paired=0 to prevent Infinity deadlock
    const costPerPaired = paired > 0 ? totalInvested / paired : null;
    const totalShares = ctx.position.upShares + ctx.position.downShares;
    const skewRatio = totalShares > 0 ? Math.max(ctx.position.upShares, ctx.position.downShares) / totalShares : 0.5;
    const isOneSided = paired === 0 && totalShares > 0;
    
    // v6.6.1 FIX: Only check emergency unwind when paired > 0
    // When one-sided (paired=0), CPP emergency doesn't apply - that would deadlock the bot
    if (paired > 0) {
      const emergencyCtx: EmergencyUnwindContext = {
        costPerPaired: costPerPaired ?? 0,
        skewRatio,
        unpairedAgeSec,
        upShares: ctx.position.upShares,
        downShares: ctx.position.downShares,
        upInvested: ctx.position.upInvested,
        downInvested: ctx.position.downInvested,
        paired,
      };
      
      const emergencyResult = checkEmergencyUnwindTrigger(slug, ctx.market.asset, emergencyCtx, RUN_ID);
      
      // v7.2.1 HOTFIX A: CPP_IMPLAUSIBLE returns implausibleCpp=true but triggerEmergency=false
      // In that case, freeze adds but do NOT place emergency orders
      if (emergencyResult.implausibleCpp && !emergencyResult.triggerEmergency) {
        // FREEZE_ADDS only - no order placement
        const logKey = `freeze_adds_${slug}`;
        if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
          (global as any)[logKey] = nowMs;
          console.log(`🛑 [v7.2.1] FREEZE_ADDS: ${ctx.market.asset} - CPP implausible, blocking new adds`);
        }
        ctx.inFlight = false;
        return;
      }
      
      if (emergencyResult.triggerEmergency) {
        // Emergency unwind mode: block entries, attempt to reduce position
        console.log(`🚨 [v6.6.0] EMERGENCY_UNWIND triggered for ${slug}`);
        console.log(`   Reason: ${emergencyResult.reason}`);
        console.log(`   Dominant side: ${emergencyResult.dominantSide}`);
        
        // v7.2.0: IMPLEMENT ACTUAL UNWIND - Sell the dominant side to reduce exposure
        const dominantSide = emergencyResult.dominantSide as 'UP' | 'DOWN';
        const dominantShares = dominantSide === 'UP' ? ctx.position.upShares : ctx.position.downShares;
        const tokenId = dominantSide === 'UP' ? ctx.market.upTokenId : ctx.market.downTokenId;
        
        // ============================================================
        // v7.3.1: DOMINANT SIDE INVARIANT CHECK
        // Verify we're selling the correct side - HARD ERROR if mismatch
        // ============================================================
        const actualDominantSide: 'UP' | 'DOWN' = ctx.position.upShares > ctx.position.downShares ? 'UP' : 'DOWN';
        
        if (emergencyResult.dominantSide !== actualDominantSide) {
          console.error(`🚨 [EMERGENCY_SIDE_MISMATCH] HARD ERROR DETECTED!`);
          console.error(`   emergencyResult.dominantSide: ${emergencyResult.dominantSide}`);
          console.error(`   actualDominantSide: ${actualDominantSide}`);
          console.error(`   upShares: ${ctx.position.upShares}, downShares: ${ctx.position.downShares}`);
          console.error(`   → Aborting emergency sell to prevent minority side sell`);
          
          saveBotEvent({
            event_type: 'EMERGENCY_SIDE_MISMATCH',
            asset: ctx.market.asset,
            market_id: slug,
            run_id: RUN_ID,
            ts: Date.now(),
            reason_code: 'INVARIANT_BREACH',
            data: {
              expected: actualDominantSide,
              got: emergencyResult.dominantSide,
              upShares: ctx.position.upShares,
              downShares: ctx.position.downShares,
              upInvested: ctx.position.upInvested,
              downInvested: ctx.position.downInvested,
            },
          }).catch(() => {});
          
          ctx.inFlight = false;
          return;
        }
        
        // v7.2.1 HOTFIX B: Check orderbook depth BEFORE attempting sell
        const currentBid = dominantSide === 'UP' ? ctx.book.up.bid : ctx.book.down.bid;
        const currentAsk = dominantSide === 'UP' ? ctx.book.up.ask : ctx.book.down.ask;
        
        if (typeof currentBid !== 'number' || typeof currentAsk !== 'number' || currentBid < 0.01) {
          // No valid book - abort emergency order, do NOT fallback to 1¢
          const logKey = `emergency_abort_no_book_${slug}`;
          if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 30000)) {
            (global as any)[logKey] = nowMs;
            console.warn(`⏭️ [v7.2.1] EMERGENCY_ABORT_NO_BOOK: ${ctx.market.asset} - no valid bid/ask`);
          }
          ctx.inFlight = false;
          return;
        }
        
        const spread = Math.max(0, currentAsk - currentBid);
        
        // Sell a chunk of the dominant position per tick to reduce risk
        const desiredChunk = Math.floor(dominantShares * 0.25);
        const minEmergencySellShares = 5;
        const maxEmergencySellShares = 50;
        const sellQtyCandidate = Math.min(maxEmergencySellShares, dominantShares, Math.max(minEmergencySellShares, desiredChunk));
        
        // v7.2.1 HOTFIX D: Fix misleading log - show actual compared values
        if (dominantShares < minEmergencySellShares || sellQtyCandidate < minEmergencySellShares) {
          console.log(`⏭️ [v7.2.1] Skip emergency sell: sellQtyCandidate=${sellQtyCandidate} < minEmergencySellShares=${minEmergencySellShares}`);
          ctx.inFlight = false;
          return;
        }
        
        // ============================================================
        // v7.3.1: SKEW WORSENING CHECK
        // Verify sell will REDUCE skew, not increase it
        // ============================================================
        const currentSkew = totalShares > 0 ? Math.max(ctx.position.upShares, ctx.position.downShares) / totalShares : 0;
        
        const afterUpShares = actualDominantSide === 'UP' 
          ? ctx.position.upShares - sellQtyCandidate 
          : ctx.position.upShares;
        const afterDownShares = actualDominantSide === 'DOWN' 
          ? ctx.position.downShares - sellQtyCandidate 
          : ctx.position.downShares;
        const afterTotal = afterUpShares + afterDownShares;
        const afterSkew = afterTotal > 0 ? Math.max(afterUpShares, afterDownShares) / afterTotal : 0;
        
        if (afterSkew > currentSkew) {
          console.error(`🚨 [SKEW_WORSENING] BLOCKED: Sell would worsen skew!`);
          console.error(`   currentSkew: ${(currentSkew * 100).toFixed(1)}% → afterSkew: ${(afterSkew * 100).toFixed(1)}%`);
          console.error(`   sellSide: ${actualDominantSide}, sellQty: ${sellQtyCandidate}`);
          console.error(`   → Aborting emergency sell`);
          
          saveBotEvent({
            event_type: 'EMERGENCY_SELL_BLOCKED_SKEW_WORSENING',
            asset: ctx.market.asset,
            market_id: slug,
            run_id: RUN_ID,
            ts: Date.now(),
            reason_code: 'SKEW_WORSENING',
            data: { 
              currentSkew, 
              afterSkew, 
              sellSide: actualDominantSide, 
              sellQty: sellQtyCandidate,
              upShares: ctx.position.upShares,
              downShares: ctx.position.downShares,
            },
          }).catch(() => {});
          
          ctx.inFlight = false;
          return;
        }
        
        // For a SELL, price at bid (placeOrder with SURVIVAL intent will improve by lowering further)
        // v7.2.1: NEVER use fallback to 1¢ - if bid is too low, abort
        const sellPrice = currentBid;
        
        console.log(`🔥 [v7.2.0] EMERGENCY_SELL: ${dominantSide} ${sellQtyCandidate} shares @ ${(sellPrice * 100).toFixed(0)}¢`);
        
        try {
          // v7.2.5: Use placeOrderWithCaps for hard cap enforcement (SELL orders)
          const sellCtx: OrderContext = {
            marketId: ctx.slug,
            asset: ctx.market.asset,
            outcome: dominantSide,
            currentUpShares: ctx.position.upShares,
            currentDownShares: ctx.position.downShares,
            upCost: ctx.position.upInvested,
            downCost: ctx.position.downInvested,
            intentType: 'UNWIND',
            runId: RUN_ID,
          };
          
          const sellResult = await placeOrderWithCaps({
            tokenId,
            side: 'SELL',
            price: sellPrice,
            size: sellQtyCandidate,
            orderType: 'GTC',
            intent: 'SURVIVAL',
            spread,
          }, sellCtx);
          
          if (sellResult.success) {
            console.log(`✅ [v7.2.0] EMERGENCY_SELL executed: orderId=${sellResult.orderId}`);
            
            // Update local position tracking (approximate)
            if (dominantSide === 'UP') {
              ctx.position.upShares -= sellQtyCandidate;
            } else {
              ctx.position.downShares -= sellQtyCandidate;
            }
            
            // Log event
            saveBotEvent({
              event_type: 'EMERGENCY_SELL',
              asset: ctx.market.asset,
              market_id: slug,
              run_id: RUN_ID,
              ts: Date.now(),
              data: {
                dominantSide,
                sharesSold: sellQtyCandidate,
                price: sellPrice,
                orderId: sellResult.orderId,
                reason: emergencyResult.reason,
                cpp: costPerPaired,
                currentSkew,
                afterSkew,
              },
            }).catch(() => { /* non-critical */ });
          } else {
            // v7.2.1 HOTFIX C: Handle balance/allowance error
            const isBalanceError = sellResult.error?.toLowerCase().includes('balance') 
              || sellResult.error?.toLowerCase().includes('allowance');
            
            if (isBalanceError) {
              console.warn(`🛑 [v7.2.1] EMERGENCY_ABORT_BALANCE: ${ctx.market.asset}`);
              console.warn(`   Error: ${sellResult.error}`);
              console.warn(`   → Market suspended for 60s, setting UNWIND_ONLY`);
              
              // Suspend market for 60s
              const suspendKey = `market_suspended_${slug}`;
              (global as any)[suspendKey] = nowMs + 60000;
              
              saveBotEvent({
                event_type: 'EMERGENCY_ABORT_BALANCE',
                asset: ctx.market.asset,
                market_id: slug,
                run_id: RUN_ID,
                ts: nowMs,
                data: { error: sellResult.error },
              }).catch(() => {});
            } else {
              console.log(`⚠️ [v7.2.0] EMERGENCY_SELL failed: ${sellResult.error}`);
            }
          }
        } catch (err) {
          console.error(`❌ [v7.2.0] EMERGENCY_SELL error:`, err);
        }
        
        ctx.inFlight = false;
        return;
      }
      
      // v6.6.0: Throttled guardrail logging (only when paired > 0)
      const guardrailTrigger = 
        emergencyResult.implausibleCpp ? 'CPP_IMPLAUSIBLE' :
        (costPerPaired !== null && costPerPaired >= INVENTORY_RISK_CONFIG.cppEmergency) ? 'COST_PER_PAIRED_EMERGENCY' :
        (costPerPaired !== null && costPerPaired >= 1.05) ? 'COST_PER_PAIRED_STOP' :
        skewRatio >= 0.70 ? 'SKEW_CAP_EXCEEDED' :
        'NONE';
      
      if (guardrailTrigger !== 'NONE') {
        logGuardrailThrottled({
          marketId: slug,
          asset: ctx.market.asset,
          trigger: guardrailTrigger,
          paired,
          unpaired,
          totalInvested,
          costPerPaired: costPerPaired ?? 0,
          skewRatio,
          secondsRemaining: remainingSeconds,
          action: isEmergencyUnwindActive(slug) ? 'EMERGENCY_UNWIND' : 'BLOCK_ALL_ADDS',
        }, RUN_ID);
      }
    } else if (isOneSided) {
      // v6.6.1: Log one-sided state (once per 10s to avoid spam)
      const logKey = `one_sided_${slug}`;
      if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 10000)) {
        (global as any)[logKey] = nowMs;
        console.log(`📊 [v6.6.1] ONE_SIDED: ${slug} - CPP guards do not apply`);
        console.log(`   UP=${ctx.position.upShares}, DOWN=${ctx.position.downShares}, paired=0`);
        console.log(`   → Hedge allowed to become paired`);
      }
    }
    
    // Check cooldown after emergency (applies regardless of paired state)
    if (isInEmergencyCooldown(slug)) {
      const isNewEntry = ctx.position.upShares === 0 && ctx.position.downShares === 0;
      if (isNewEntry) {
        const logKey = `emergency_cooldown_${slug}`;
        if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 10000)) {
          (global as any)[logKey] = nowMs;
          console.log(`⏳ [v6.6.0] EMERGENCY_COOLDOWN: No new entries for ${slug}`);
        }
        ctx.inFlight = false;
        return;
      }
    }
    ctx.lastRiskScore = riskScore;

    // ============================================================
    // v7.0.1 PATCH 5: QUEUE STRESS CHECK
    // ============================================================
    const queueStressed = v7IsQueueStressed();

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
        
        // v6.3.2: Even for fresh markets, block entry if delta/dislocation is already too large
        // This prevents opening cheap bets on markets that have already moved significantly
        const upAsk = ctx.book?.UP?.ask;
        const downAsk = ctx.book?.DOWN?.ask;
        const combinedMid = (typeof upAsk === 'number' && typeof downAsk === 'number') 
          ? upAsk + downAsk 
          : null;
        
        // Calculate current delta if we have spot and strike
        const currentDelta = (ctx.spotPrice !== null && ctx.strikePrice !== null && ctx.strikePrice > 0)
          ? Math.abs(ctx.spotPrice - ctx.strikePrice) / ctx.strikePrice
          : null;
        
        // Block if delta already too large (market already moved)
        if (currentDelta !== null && currentDelta > STARTUP_GRACE_CONFIG.maxDeltaForEntry) {
          const logKey = `startup_delta_${slug}`;
          if (!(global as any)[logKey]) {
            (global as any)[logKey] = true;
            console.log(`🛡️ [v6.3.2] STARTUP DELTA GUARD: Blocking entry on ${ctx.market.asset}`);
            console.log(`   Delta: ${(currentDelta * 100).toFixed(2)}% > max ${(STARTUP_GRACE_CONFIG.maxDeltaForEntry * 100).toFixed(1)}%`);
            console.log(`   Spot: $${ctx.spotPrice?.toFixed(2)} | Strike: $${ctx.strikePrice?.toFixed(2)}`);
            console.log(`   → Market already moved too much, waiting for next fresh market.`);
          }
          ctx.inFlight = false;
          return;
        }
        
        // Block if combined mid too low (prices already dislocated)
        if (combinedMid !== null && combinedMid < STARTUP_GRACE_CONFIG.minCombinedMidForEntry) {
          const logKey = `startup_disloc_${slug}`;
          if (!(global as any)[logKey]) {
            (global as any)[logKey] = true;
            console.log(`🛡️ [v6.3.2] STARTUP DISLOCATION GUARD: Blocking entry on ${ctx.market.asset}`);
            console.log(`   Combined Mid: ${(combinedMid * 100).toFixed(0)}¢ < min ${(STARTUP_GRACE_CONFIG.minCombinedMidForEntry * 100).toFixed(0)}¢`);
            console.log(`   UP ask: ${(upAsk! * 100).toFixed(0)}¢ | DOWN ask: ${(downAsk! * 100).toFixed(0)}¢`);
            console.log(`   → Prices already dislocated, waiting for next fresh market.`);
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
    
    // ============================================================
    // v7.0.1 PATCH 4+5: BLOCK ENTRY IN DEGRADED MODE OR QUEUE STRESS
    // ============================================================
    if (isOpeningCandidate) {
      // v7.2.0 REV C: Check MarketStateManager state - don't open if we just timed out
      if (stateResult.pairingTimedOut) {
        console.log(`🚫 [v7.2.0] ENTRY blocked: Recent PAIRING_TIMEOUT on ${ctx.market.asset}`);
        ctx.inFlight = false;
        return;
      }
      
      // Check degraded mode
      const degradedCheck = isActionAllowedInDegradedMode('ENTRY', riskScore.inDegradedMode);
      if (!degradedCheck.allowed) {
        console.log(`⏭️ [v7.0.1] ENTRY blocked: ${degradedCheck.reason} (riskScore=${riskScore.riskScore.toFixed(0)})`);
        ctx.inFlight = false;
        return;
      }
      
      // Check queue stress
      const queueCheck = isActionAllowedInQueueStress('ENTRY');
      if (!queueCheck.allowed) {
        console.log(`⏭️ [v7.0.1] ENTRY blocked: ${queueCheck.reason}`);
        ctx.inFlight = false;
        return;
      }
      
      // ============================================================
      // v7: ENTRY GUARD CHECK (Tail-Entry, Pair-Edge, Direction Sanity)
      // ============================================================
      const upAsk = ctx.book.up?.ask;
      const downAsk = ctx.book.down?.ask;
      if (typeof upAsk === 'number' && typeof downAsk === 'number') {
        const entryGuard = checkEntryGuards(upAsk, downAsk, ctx.spotPrice, ctx.strikePrice);
        if (!entryGuard.allowed) {
          console.log(`🛡️ [v7] ENTRY BLOCKED by guard: ${entryGuard.reason}`);
          console.log(`   → ${entryGuard.details?.message}`);
          console.log(`   📊 Market: ${ctx.market.asset} | UP: ${(upAsk * 100).toFixed(0)}¢ | DOWN: ${(downAsk * 100).toFixed(0)}¢`);
          if (ctx.spotPrice != null && ctx.strikePrice != null) {
            console.log(`   📈 Spot: $${ctx.spotPrice.toFixed(2)} | Strike: $${ctx.strikePrice.toFixed(2)}`);
          }
          
          // Log to backend for auditing
          logActionSkipped(
            ctx.slug,
            ctx.market.asset,
            'ENTRY',
            entryGuard.reason as any,
            {
              unpairedShares: 0,
              unpairedNotionalUsd: 0,
              inventoryRiskScore: riskScore.riskScore,
              pairCost: null,
              secondsRemaining: remainingSeconds,
              degradedMode: riskScore.inDegradedMode,
            },
            RUN_ID
          );
          
          ctx.inFlight = false;
          return;
        }
      }
      
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
    } else {
      // Not an opening trade - check if we're in a dangerous skew state
      // v7.2.0: Block accumulate trades if heavily skewed
      const skewRatioForGuard = totalShares > 0 
        ? Math.max(ctx.position.upShares, ctx.position.downShares) / totalShares 
        : 0.5;
      
      if (skewRatioForGuard > 0.75 && unpaired > 50) {
        // Heavy skew detected - similar to screenshot situation
        const logKey = `skew_warning_${slug}`;
        if (!(global as any)[logKey] || (nowMs - (global as any)[logKey] > 10000)) {
          (global as any)[logKey] = nowMs;
          console.warn(`⚠️ [v7.2.0] HEAVY_SKEW_WARNING: ${ctx.market.asset}`);
          console.warn(`   UP=${ctx.position.upShares} DOWN=${ctx.position.downShares} skew=${(skewRatioForGuard * 100).toFixed(0)}%`);
          console.warn(`   Invested: UP=$${ctx.position.upInvested.toFixed(2)} DOWN=$${ctx.position.downInvested.toFixed(2)}`);
          console.warn(`   → Only HEDGE trades allowed, no ACCUMULATE`);
        }
      }
    }

    // v7: Pass spot/strike to evaluateOpportunity for direction sanity check
    const signal = evaluateOpportunity(
      ctx.book,
      ctx.position,
      remainingSeconds,
      ctx.lastTradeAtMs,
      nowMs,
      balanceForCheck, // Pass balance for opening trade validation
      ctx.spotPrice ?? undefined,
      ctx.strikePrice ?? undefined,
      slug,
      ctx.firstFillTs ?? undefined
    );

    if (signal) {
      // ============================================================
      // v7.2.3 REV C.3: HARD POSITION LIMIT CHECK
      // Block ANY trade that would exceed maxSharesPerSide (100)
      // ============================================================
      const cfg = getCurrentConfig();
      const maxSharesPerSide = cfg?.risk.maxSharesPerSide ?? 100;
      
      // Calculate what the position would be AFTER this trade
      const tradeOutcome = signal.outcome;
      const tradeShares = signal.shares;
      const projectedUp = tradeOutcome === 'UP' ? ctx.position.upShares + tradeShares : ctx.position.upShares;
      const projectedDown = tradeOutcome === 'DOWN' ? ctx.position.downShares + tradeShares : ctx.position.downShares;
      
      // For paired trades, also check the paired side
      const pairedShares = signal.pairedWith?.shares ?? 0;
      const projectedUpWithPair = signal.pairedWith && signal.pairedWith.outcome === 'UP' 
        ? projectedUp + pairedShares : projectedUp;
      const projectedDownWithPair = signal.pairedWith && signal.pairedWith.outcome === 'DOWN'
        ? projectedDown + pairedShares : projectedDown;
      
      if (projectedUpWithPair > maxSharesPerSide || projectedDownWithPair > maxSharesPerSide) {
        console.log(`🚫 [v7.2.3] POSITION_LIMIT_BLOCK: Trade would exceed maxSharesPerSide (${maxSharesPerSide})`);
        console.log(`   Current: UP=${ctx.position.upShares} DOWN=${ctx.position.downShares}`);
        console.log(`   After trade: UP=${projectedUpWithPair} DOWN=${projectedDownWithPair}`);
        console.log(`   Blocked: ${signal.type} ${signal.outcome} ${tradeShares}sh`);
        
        saveBotEvent({
          event_type: 'POSITION_LIMIT_BLOCK',
          asset: ctx.market.asset,
          market_id: slug,
          run_id: RUN_ID,
          reason_code: 'MAX_SHARES_PER_SIDE',
          data: {
            maxSharesPerSide,
            currentUp: ctx.position.upShares,
            currentDown: ctx.position.downShares,
            projectedUp: projectedUpWithPair,
            projectedDown: projectedDownWithPair,
            tradeType: signal.type,
            tradeOutcome: signal.outcome,
            tradeShares,
          },
          ts: Date.now(),
        }).catch(() => {});
        
        ctx.inFlight = false;
        return;
      }
      
      // ============================================================
      // v7.2.2 REV C.2: STATE-BASED TRADE GATING
      // Check permissions BEFORE executing any trade
      // ============================================================
      
      // v4.6.0: Handle PAIRED atomic trades - both sides at once
      if (signal.type === 'paired' && signal.pairedWith) {
        // ENTRY permission check
        if (!statePermissions.canEntry) {
          console.log(`🚫 [v7.2.2] ENTRY BLOCKED by state ${stateResult.state}: ${statePermissions.reason}`);
          ctx.inFlight = false;
          return;
        }
        
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
          // v7.2.2 REV C.2: After UP fills, call beginPairing() BEFORE placing hedge
          const pairingResult = marketStateManager.beginPairing(
            slug,
            ctx.market.asset,
            'PAIR_EDGE',
            { bestAskUp: ctx.book.up.ask, bestAskDown: ctx.book.down.ask },
            remainingSeconds
          );
          
          if (!pairingResult.success) {
            console.warn(`⚠️ [v7.2.2] beginPairing failed: ${pairingResult.reason} - continuing with DOWN anyway`);
          }
          
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
            // v7.2.3 REV C.3: NO AGGRESSIVE EMERGENCY HEDGE
            // Instead: remain in PAIRING state, let standard hedge flow handle it
            // The beginPairing() call above already established PAIRING state
            // Standard hedge logic will respect hedgeSlippageCap, pairingTimeout, lateExpiry rules
            console.log(`⚠️ [v7.2.3] PARTIAL PAIR: UP filled, DOWN failed - staying in PAIRING state`);
            console.log(`   → Standard hedge flow will attempt pairing (no aggressive ask+0.03)`);
            console.log(`   → Bounded by: hedgeSlippageCap, minHedgeChunk, pairingTimeout`);
            
            // Log bot event for tracking
            saveBotEvent({
              event_type: 'PAIR_LEG_FAILED',
              asset: ctx.market.asset,
              market_id: slug,
              run_id: RUN_ID,
              reason_code: 'DOWN_LEG_FAILED',
              data: {
                upShares: signal.shares,
                downSharesAttempted: signal.pairedWith.shares,
                downPrice: signal.pairedWith.price,
                bookDownAsk: ctx.book.down.ask,
                action: 'REMAIN_IN_PAIRING',
              },
              ts: Date.now(),
            }).catch(() => {});
          }
        } else {
          console.log(`⚠️ [v4.6.0] PAIR FAILED: UP side failed, skipping DOWN`);
        }
      }
      // Handle accumulate trades
      else if (signal.type === 'accumulate') {
        // v7.2.2 REV C.2: ACCUMULATE permission check
        if (!statePermissions.canAccumulate) {
          console.log(`🚫 [v7.2.2] ACCUMULATE BLOCKED by state ${stateResult.state}: ${statePermissions.reason}`);
          ctx.inFlight = false;
          return;
        }
        
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
            // v7.2.3 REV C.3: NO AGGRESSIVE EMERGENCY HEDGE
            // Instead: call beginPairing() and let standard hedge flow handle it
            console.log(`⚠️ [v7.2.3] Accumulate PARTIAL: UP ok, DOWN failed - entering PAIRING state`);
            console.log(`   → Standard hedge flow will attempt pairing (no aggressive ask+0.03)`);
            
            // Ensure we enter PAIRING state for the accumulated shares
            const pairingResult = marketStateManager.beginPairing(
              slug,
              ctx.market.asset,
              'PAIR_EDGE',
              { bestAskUp: ctx.book.up.ask, bestAskDown: ctx.book.down.ask },
              remainingSeconds
            );
            
            if (!pairingResult.success) {
              console.warn(`⚠️ [v7.2.3] beginPairing after accumulate failed: ${pairingResult.reason}`);
            }
            
            // Log bot event for tracking
            saveBotEvent({
              event_type: 'ACCUMULATE_LEG_FAILED',
              asset: ctx.market.asset,
              market_id: slug,
              run_id: RUN_ID,
              reason_code: 'DOWN_LEG_FAILED',
              data: {
                upShares: signal.shares,
                bookDownAsk: ctx.book.down.ask,
                action: 'ENTER_PAIRING',
              },
              ts: Date.now(),
            }).catch(() => {});
          }
        } else if (!upSuccess) {
          console.log(`⚠️ Accumulate aborted: UP side failed, skipping DOWN`);
        }
      } else {
        // Single-side trade (opening, hedge, rebalance)
        const isHedgeTrade = signal.type === 'hedge';
        const isEntryTrade = signal.type === 'opening';
        
        // v7.2.2 REV C.2: State-based permission checks
        if (isEntryTrade && !statePermissions.canEntry) {
          console.log(`🚫 [v7.2.2] ENTRY BLOCKED by state ${stateResult.state}: ${statePermissions.reason}`);
          ctx.inFlight = false;
          return;
        }
        
        if (isHedgeTrade && !statePermissions.canHedge) {
          console.log(`🚫 [v7.2.2] HEDGE BLOCKED by state ${stateResult.state}: ${statePermissions.reason}`);
          ctx.inFlight = false;
          return;
        }
        
        // v7.2.2 REV C.2: Before placing first hedge from ONE_SIDED, call beginPairing()
        if (isHedgeTrade && (stateResult.state === 'ONE_SIDED_UP' || stateResult.state === 'ONE_SIDED_DOWN')) {
          const hedgeReason: 'PAIR_EDGE' | 'EMERGENCY_SKEW' = skewRatio >= 0.70 ? 'EMERGENCY_SKEW' : 'PAIR_EDGE';
          
          const pairingResult = marketStateManager.beginPairing(
            slug,
            ctx.market.asset,
            hedgeReason,
            { bestAskUp: ctx.book.up.ask, bestAskDown: ctx.book.down.ask },
            remainingSeconds
          );
          
          if (!pairingResult.success) {
            console.log(`🚫 [v7.2.2] HEDGE BLOCKED - beginPairing failed: ${pairingResult.reason}`);
            ctx.inFlight = false;
            return;
          }
        }
        
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

  clobSocket.on('open', async () => {
    console.log('✅ Connected to Polymarket CLOB WebSocket');
    
    // Subscribe to market updates (price changes + book updates)
    clobSocket!.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
    
    // v7.1.1: Immediately fetch orderbooks via HTTP to bootstrap data
    // This ensures we have data before WebSocket starts streaming updates
    console.log('📡 [v7.1.1] Fetching initial orderbooks via HTTP...');
    let fetchedCount = 0;
    const updatedSlugs: string[] = [];

    for (const ctx of markets.values()) {
      try {
        const [upDepth, downDepth] = await Promise.all([
          getOrderbookDepth(ctx.market.upTokenId),
          getOrderbookDepth(ctx.market.downTokenId),
        ]);

        if (upDepth.topAsk !== null || upDepth.topBid !== null) {
          ctx.book.up.ask = upDepth.topAsk;
          ctx.book.up.bid = upDepth.topBid;
        }
        if (downDepth.topAsk !== null || downDepth.topBid !== null) {
          ctx.book.down.ask = downDepth.topAsk;
          ctx.book.down.bid = downDepth.topBid;
        }

        if (upDepth.topAsk !== null || upDepth.topBid !== null || downDepth.topAsk !== null || downDepth.topBid !== null) {
          ctx.book.updatedAtMs = Date.now();
          fetchedCount++;
          updatedSlugs.push(ctx.slug);
        }
      } catch {
        // Non-critical, WebSocket will provide updates
      }
    }

    console.log(`📡 [v7.1.1] Initial orderbooks loaded: ${fetchedCount}/${markets.size} markets`);

    // Kick off evaluation immediately (don’t wait for the next WS tick)
    if (updatedSlugs.length > 0) {
      await Promise.allSettled(updatedSlugs.map((slug) => evaluateMarket(slug)));
    }
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
        const asks = (data.asks || []) as any[];
        const bids = (data.bids || []) as any[];

        const parseLevelPrice = (level: any): number | null => {
          // WS payloads vary: [price,size] tuples OR { price, size } objects
          const rawPrice = Array.isArray(level)
            ? level[0]
            : (level && typeof level === 'object' ? level.price : null);

          const n = typeof rawPrice === 'number'
            ? rawPrice
            : typeof rawPrice === 'string'
              ? parseFloat(rawPrice)
              : NaN;

          return Number.isFinite(n) ? n : null;
        };

        // CRITICAL FIX: Compute bestBid = MAX(bids), bestAsk = MIN(asks)
        // Do NOT assume array order!
        let bestBid: number | null = null;
        let bestAsk: number | null = null;

        for (const level of bids) {
          const p = parseLevelPrice(level);
          if (p !== null && (bestBid === null || p > bestBid)) {
            bestBid = p;
          }
        }
        for (const level of asks) {
          const p = parseLevelPrice(level);
          if (p !== null && (bestAsk === null || p < bestAsk)) {
            bestAsk = p;
          }
        }

        const levels = asks.length + bids.length;

        // v6.6.0: SUSPICIOUS_BOOK_SHAPE detection (same as HTTP handler)
        // If bestBid <= 0.02 AND bestAsk >= 0.98 with many levels, book is invalid
        if (
          bestBid !== null &&
          bestAsk !== null &&
          bestBid <= 0.02 &&
          bestAsk >= 0.98 &&
          levels > 20
        ) {
          console.log(
            `⚠️ [WS] SUSPICIOUS_BOOK_SHAPE marketId=${marketInfo.slug} bestBid=${bestBid.toFixed(2)} bestAsk=${bestAsk.toFixed(2)} levels=${levels}`
          );
          setSafetyBlock(marketInfo.slug, ctx.market.asset, `SUSPICIOUS_BOOK_SHAPE: bid=${bestBid.toFixed(2)} ask=${bestAsk.toFixed(2)}`, RUN_ID);
          ctx.inFlight = false;
          return;
        } else if (levels > 0 && bestBid !== null && bestAsk !== null) {
          // Clear safety block if book looks valid now
          clearSafetyBlock(marketInfo.slug, ctx.market.asset, RUN_ID);
        }

        // BOOK_WS logging for diagnostics (rate-limited)
        const logKey = `book_ws_${marketInfo.slug}_${marketInfo.side}`;
        if (!(global as any)[logKey] || (Date.now() - (global as any)[logKey] > 10000)) {
          (global as any)[logKey] = Date.now();
          console.log(
            `BOOK_WS marketId=${marketInfo.slug} side=${marketInfo.side} levels=${levels} bestBid=${bestBid === null ? 'null' : bestBid.toFixed(2)} bestAsk=${bestAsk === null ? 'null' : bestAsk.toFixed(2)}`
          );
        }

        // IMPORTANT: don't overwrite good HTTP-seeded values with invalid WS values
        let updated = false;
        if (marketInfo.side === 'up') {
          if (bestAsk !== null) {
            ctx.book.up.ask = bestAsk;
            updated = true;
          }
          if (bestBid !== null) {
            ctx.book.up.bid = bestBid;
            updated = true;
          }
        } else {
          if (bestAsk !== null) {
            ctx.book.down.ask = bestAsk;
            updated = true;
          }
          if (bestBid !== null) {
            ctx.book.down.bid = bestBid;
            updated = true;
          }
        }

        if (updated) {
          ctx.book.updatedAtMs = Date.now();
          await evaluateMarket(marketInfo.slug);
        }
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

  // v7.3.2: CRITICAL - Acquire exclusive runner lease before trading
  // Only ONE runner may be active at a time to prevent conflicting orders
  console.log('\n🔒 Acquiring exclusive runner lease...');
  const leaseAcquired = await acquireLeaseOrHalt(RUNNER_ID);
  if (!leaseAcquired) {
    console.error('\n🚫 HALTING: Another runner holds the lease. Only one runner may be active at a time.');
    console.error('   Stop the other runner or wait for its lease to expire (~60s after it stops).\n');
    process.exit(1);
  }
  console.log('✅ Exclusive runner lease acquired\n');

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
    
    // v6.5.0: Update queue size for queue stress tracking
    updateQueueSize(orders.length);
    for (const order of orders) {
      console.log(`\n📥 RECEIVED ORDER: ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ on ${order.market_slug}`);

      // v7.1.0: Auto-resize on FUNDS instead of skipping
      // If notional exceeds maxNotionalPerTrade, resize shares to fit
      const cfg = getCurrentConfig();
      const maxNotionalPerTrade = cfg?.sizing?.maxNotionalPerTrade ?? cfg?.limits.maxNotionalPerTrade ?? config.trading.maxNotionalPerTrade;
      const minLotShares = cfg?.sizing?.minLotShares ?? 5;
      let orderShares = order.shares;
      let orderNotional = orderShares * order.price;

      if (Number.isFinite(maxNotionalPerTrade) && maxNotionalPerTrade > 0 && orderNotional > maxNotionalPerTrade + 1e-9) {
        // v7.1.0: Auto-resize instead of skip
        const newQty = Math.floor(maxNotionalPerTrade / order.price);
        
        if (newQty < minLotShares) {
          // Cannot resize - would be below minimum lot size
          const secondsRemaining = order.event_end_time
            ? Math.max(0, Math.floor((new Date(order.event_end_time).getTime() - Date.now()) / 1000))
            : 0;

          console.warn(
            `⛔ FUNDS_MIN_QTY: Cannot resize ${orderShares}@${(order.price * 100).toFixed(0)}¢ → ${newQty} shares (min: ${minLotShares}) on ${order.market_slug}`
          );

          logActionSkipped(
            order.market_slug,
            order.asset,
            'ADD',
            'FUNDS',
            {
              unpairedShares: 0,
              unpairedNotionalUsd: 0,
              inventoryRiskScore: 0,
              secondsRemaining,
              pairCost: null,
              queueSize: orders.length,
              degradedMode: isDegradedMode(order.market_slug, order.asset),
            }
          );

          // Log FUNDS_MIN_QTY event
          saveBotEvent({
            event_type: 'FUNDS_MIN_QTY',
            asset: order.asset,
            market_id: order.market_slug,
            data: {
              originalQty: orderShares,
              resizedQty: newQty,
              minLotShares,
              price: order.price,
              maxNotionalPerTrade,
            },
            ts: Date.now(),
          }).catch(() => {});

          await updateOrder(order.id, 'failed', {
            error: `FUNDS_MIN_QTY: resize ${orderShares}→${newQty} < min ${minLotShares}`,
          });
          continue;
        }

        // Successfully resized
        const oldNotional = orderNotional;
        const newNotional = newQty * order.price;
        
        console.log(
          `📐 RESIZED_ORDER: ${orderShares}@${(order.price * 100).toFixed(0)}¢ → ${newQty}@${(order.price * 100).toFixed(0)}¢ ($${oldNotional.toFixed(2)} → $${newNotional.toFixed(2)}) on ${order.market_slug}`
        );

        // Log RESIZED_ORDER event
        saveBotEvent({
          event_type: 'RESIZED_ORDER',
          asset: order.asset,
          market_id: order.market_slug,
          data: {
            originalQty: orderShares,
            resizedQty: newQty,
            originalNotional: oldNotional,
            resizedNotional: newNotional,
            price: order.price,
            maxNotionalPerTrade,
          },
          ts: Date.now(),
        }).catch(() => {});

        // Use resized values
        orderShares = newQty;
        orderNotional = newNotional;
      }
      
      try {
        // v7.2.5: Use placeOrderWithCaps for hard cap enforcement
        // IMPORTANT: In DATABASE/queue mode we MUST maintain an in-memory position,
        // otherwise caps/freeze checks will see 0 and can be bypassed.
        const marketCtx = markets.get(order.market_slug);
        if (!marketCtx) {
          const msg = `NO_MARKET_CTX: ${order.market_slug} not in active markets map (refusing to execute order)`;
          console.warn(`⛔ ${msg}`);
          await updateOrder(order.id, 'failed', { error: msg });
          continue;
        }

        const queueOrderCtx: OrderContext = {
          marketId: order.market_slug,
          asset: order.asset,
          outcome: order.outcome as 'UP' | 'DOWN',
          currentUpShares: marketCtx.position.upShares,
          currentDownShares: marketCtx.position.downShares,
          upCost: marketCtx.position.upInvested,
          downCost: marketCtx.position.downInvested,
          intentType: order.intent_type || 'ENTRY',
          runId: RUN_ID,
        };

        const result = await placeOrderWithCaps(
          {
            tokenId: order.token_id,
            side: 'BUY',
            price: order.price,
            size: orderShares, // Use potentially resized shares
            orderType: order.order_type as 'GTC' | 'FOK' | 'GTD',
          },
          queueOrderCtx,
        );

        if (result.success) {
          const status = result.status ?? 'unknown';

          // Use filledSize when available, even if status reports "filled".
          const filledShares =
            status === 'filled'
              ? (result.filledSize ?? orderShares)
              : status === 'partial'
                ? (result.filledSize ?? 0)
                : 0;

          // Update in-memory position + hard invariants on actual fills
          if (filledShares > 0) {
            const fillPrice = result.avgPrice ?? order.price;

            if (order.outcome === 'UP') {
              marketCtx.position.upShares += filledShares;
              marketCtx.position.upInvested += filledShares * fillPrice;
            } else {
              marketCtx.position.downShares += filledShares;
              marketCtx.position.downInvested += filledShares * fillPrice;
            }

            const invariantUpdate = onFillUpdateInvariants({
              marketId: order.market_slug,
              asset: order.asset,
              fillSide: order.outcome as 'UP' | 'DOWN',
              fillQty: filledShares,
              newUpShares: marketCtx.position.upShares,
              newDownShares: marketCtx.position.downShares,
              upCost: marketCtx.position.upInvested,
              downCost: marketCtx.position.downInvested,
              runId: RUN_ID,
            });

            if (invariantUpdate.invariantViolated) {
              console.error(`🚨 [v7.2.5] INVARIANT_BREACH: Position exceeds hard cap (QUEUE MODE)!`);
              console.error(`   UP=${marketCtx.position.upShares} DOWN=${marketCtx.position.downShares}`);

              marketStateManager?.suspendMarket(
                order.market_slug,
                order.asset,
                300000,
                'INVARIANT_BREACH_HARD_CAP_QUEUE',
              );

              saveBotEvent({
                event_type: 'INVARIANT_BREACH_HARD_CAP',
                asset: order.asset,
                market_id: order.market_slug,
                ts: Date.now(),
                run_id: RUN_ID,
                data: {
                  upShares: marketCtx.position.upShares,
                  downShares: marketCtx.position.downShares,
                  maxSharesPerSide: HARD_INVARIANT_CONFIG.maxSharesPerSide,
                  lastFillSide: order.outcome,
                  lastFillQty: filledShares,
                  mode: 'QUEUE',
                },
              }).catch(() => {});
            }
          }

          // CRITICAL FIX: Log ALL orders, not just filled ones
          const logShares = filledShares > 0 ? filledShares : orderShares;
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
            console.log(`📝 ORDER PLACED: ${order.outcome} ${orderShares}@${(order.price * 100).toFixed(0)}¢ (pending) - ${result.orderId}`);
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

  // v7.0.1: Log patch stats every 60 seconds
  let lastV7StatsLog = 0;
  setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastV7StatsLog >= 60000) {
      lastV7StatsLog = nowMs;
      logV7PatchStatus();
    }
  }, 15000);

  // v7.1.1: Periodic orderbook refresh with jitter for markets with stale data
  // Only refresh if: market enabled AND book stale > 3s AND WS silent
  const STALE_THRESHOLD_MS = 3000;
  const REFRESH_BASE_MS = 3000;
  const REFRESH_JITTER_MS = 1500; // 3000 ± 1500 = 1.5s - 4.5s
  let refreshInFlight = false;
  
  const doStaleRefresh = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    
    try {
      const nowMs = Date.now();
      
      for (const ctx of markets.values()) {
        const bookAge = ctx.book.updatedAtMs > 0 ? (nowMs - ctx.book.updatedAtMs) : Infinity;
        
        // Skip if book is fresh (WS is providing updates)
        if (bookAge <= STALE_THRESHOLD_MS) continue;
        
        // Skip expired markets
        const endMs = new Date(ctx.market.eventEndTime).getTime();
        if (nowMs >= endMs) continue;
        
        // Skip disabled markets
        const readinessState = getReadinessState(ctx.slug);
        if (readinessState?.disabled) continue;
        
        try {
          const [upDepth, downDepth] = await Promise.all([
            getOrderbookDepth(ctx.market.upTokenId),
            getOrderbookDepth(ctx.market.downTokenId),
          ]);
          
          if (upDepth.topAsk !== null || upDepth.topBid !== null) {
            ctx.book.up.ask = upDepth.topAsk;
            ctx.book.up.bid = upDepth.topBid;
          }
          if (downDepth.topAsk !== null || downDepth.topBid !== null) {
            ctx.book.down.ask = downDepth.topAsk;
            ctx.book.down.bid = downDepth.topBid;
          }
          
          if (upDepth.topAsk !== null || upDepth.topBid !== null || downDepth.topAsk !== null || downDepth.topBid !== null) {
            ctx.book.updatedAtMs = Date.now();
            // Evaluate immediately on refreshed data
            void evaluateMarket(ctx.slug);
          }
        } catch {
          // Non-critical
        }
      }
    } finally {
      refreshInFlight = false;
      // Schedule next with jitter
      const jitter = (Math.random() - 0.5) * 2 * REFRESH_JITTER_MS;
      setTimeout(doStaleRefresh, REFRESH_BASE_MS + jitter);
    }
  };
  
  // Start the refresh loop with initial jitter
  setTimeout(doStaleRefresh, REFRESH_BASE_MS + Math.random() * REFRESH_JITTER_MS);

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
      
      // v7.2.8: Update mark prices for unrealized PnL calculation
      accountingUpdateMarkPrices(
        ctx.slug,
        ctx.market.asset,
        ctx.book.up.bid,   // Conservative: use bestBid (what we can sell at)
        ctx.book.down.bid,
      );
    }
    
    // v7.2.8: Log global PnL snapshot (throttled internally)
    logPnLSnapshot(RUN_ID);
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
  
  // v7.3.2: Release runner lease FIRST so another runner can start immediately
  console.log('🔓 Releasing runner lease...');
  await releaseLease();
  
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
