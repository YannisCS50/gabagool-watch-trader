/**
 * strategy.ts - Active Strategy Wrapper
 * =====================================
 * This file exports the GPT-strat (Polymarket15mArbBot) adapted for the local-runner.
 * The loveable-strat.ts is preserved as backup.
 * 
 * Strategy: gpt-strat (Polymarket 15m Hedge/Arbitrage Bot - Gabagool-Grade)
 */

import { config } from './config.js';

// Re-export types from gpt-strat
export type { 
  Side as Outcome, 
  BotState as State,
  Inventory,
  OrderIntent as TradeSignal,
  MarketSnapshot,
  BookTop,
  OrderBook,
  PriceLevel,
  OpenOrder,
  FillEvent,
  BotMetrics,
  StrategyConfig,
} from './gpt-strat.js';

export { 
  DEFAULT_CONFIG,
  Polymarket15mArbBot,
  startBotLoop,
} from './gpt-strat.js';

// ============================================================
// STRATEGY VERSION
// ============================================================
export const STRATEGY_VERSION = '4.2.3-gabagool-skew-guard-hotfix';
export const STRATEGY_NAME = 'Polymarket 15m Hedge/Arb (Gabagool v4.2.3 - Skew Stop Allows Hedge)';

// ============================================================
// BACKWARD COMPATIBILITY LAYER
// Maps the old API to the new GPT-strat API
// ============================================================

import { 
  DEFAULT_CONFIG, 
  type Side,
  type BookTop as GptBookTop,
  type Inventory as GptInventory,
  type OrderIntent,
} from './gpt-strat.js';

// Legacy TopOfBook format used by index.ts
export interface TopOfBook {
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
  updatedAtMs: number;
}

// Legacy MarketPosition format
export interface MarketPosition {
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
  upCost?: number;
  downCost?: number;
  firstFillTs?: number;
  lastFillTs?: number;
}

// Legacy PendingHedge format
export interface PendingHedge {
  up: number;
  down: number;
}

// ============================================================
// STRATEGY CONFIGURATION (EXPOSED FOR LOGGING)
// ============================================================

export const STRATEGY = {
  // Edge & Entry
  edge: {
    buffer: DEFAULT_CONFIG.edge.baseBuffer,
    minExecutableEdge: DEFAULT_CONFIG.edge.baseBuffer - DEFAULT_CONFIG.edge.feesBuffer,
  },
  
  // Tick & Rounding
  tick: {
    fallback: DEFAULT_CONFIG.execution.tickFallback,
    validTicks: DEFAULT_CONFIG.execution.tickNiceSet,
    hedgeCushion: DEFAULT_CONFIG.execution.hedgeCushionTicks,
  },
  
  // Sizing - v3.2.1: 50 shares opening, max 50 accumulate
  sizing: {
    baseClipUsd: 25,       // ~50 shares at 50¢
    minClipUsd: 20,        // ~40 shares minimum
    maxClipUsd: 50,        // ~100 shares max (for strong edge)
    maxAccumulateShares: 50, // Max 50 shares per accumulate
  },
  
  // Skew Management
  skew: {
    target: DEFAULT_CONFIG.skew.target,
    rebalanceThreshold: DEFAULT_CONFIG.skew.rebalanceThreshold,
    hardCap: DEFAULT_CONFIG.skew.hardCap,
  },
  
  // Risk Limits - v4.2.1: 300 shares max per side
  limits: {
    maxTotalNotional: 500,   // Increased for 300 shares
    maxPerSide: 300,         // 300 shares max per side
    maxPerSideShares: 300,   // Explicit share limit
    stopTradesSec: DEFAULT_CONFIG.timing.stopNewTradesSec,
    unwindStartSec: DEFAULT_CONFIG.timing.unwindStartSec,
  },
  
  // Opening parameters - v4.2.1: 50 SHARES
  opening: {
    shares: 50,          // Fixed 50 shares per opening
    notional: 25,        // ~$25 at 50¢ = 50 shares
    maxPrice: 0.52,
    skipEdgeCheck: true,
    maxDelayMs: 5000,
  },
  
  // Hedge parameters - v4.2.1: time-scaled timeout
  hedge: {
    shares: 50,          // Fixed 50 shares per hedge
    maxPrice: 0.55,      // Max 55¢ for hedge
    cushionTicks: 2,     // 2 ticks above ask
    forceTimeoutSec: 35, // Base timeout, scaled by timeFactor
    cooldownMs: 0,       // NO COOLDOWN for hedge!
  },
  
  // Accumulate parameters - v4.2.1: max 50 shares, only when hedged
  accumulate: {
    maxShares: 50,       // Max 50 shares per accumulate
    requireHedged: true, // Only accumulate when position is hedged
    minEdge: 0.02,       // Min 2% edge to accumulate
  },
  
  // v4.2.1: Delta regime configuration
  delta: {
    lowThreshold: 0.0030,    // LOW: delta < 0.30%
    midThreshold: 0.0070,    // MID: 0.30% - 0.70%
    deepMaxDelta: 0.0040,    // DEEP only if delta < 0.40%
  },
  
  // v4.2.1: Time-scaled parameters
  timeScaled: {
    hedgeTimeoutBaseSec: 35,  // Base: 35s, scaled by timeFactor
    maxSkewBase: 0.70,        // Base: 70/30, shrinks toward 50/50
    bufferAddBase: 0.008,     // Base: +0.8%, increases as time decreases
  },
  
  // v4.2.1: DEEP mode conditions
  deep: {
    minTimeSec: 180,          // Only if > 180s remaining
    maxCombinedAsk: 0.95,     // Only if combined < 95¢
    maxDeltaPct: 0.0040,      // Only if delta < 0.40%
  },
  
  // Entry conditions
  entry: {
    minSecondsRemaining: DEFAULT_CONFIG.timing.unwindStartSec,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  
  // Cooldown
  cooldownMs: 5000, // 5s cooldown for opening trades (hedge has 0)
  
  // Probability Bias (GPT-strat doesn't have this, disable)
  probabilityBias: {
    enabled: false,
    skipHedgeThresholdUsd: 85,
    highConfidenceUsd: 200,
    minSecondsToSkip: 120,
  },
};

// ============================================================
// LEGACY HELPER FUNCTIONS
// ============================================================

function roundDown(price: number, tick: number): number {
  return Math.max(0, Math.floor(price / tick) * tick);
}

function roundUp(price: number, tick: number): number {
  return Math.min(0.999, Math.ceil(price / tick) * tick);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

// ============================================================
// BALANCE CHECK
// ============================================================

export function checkBalanceForOpening(
  availableBalance: number,
  requiredNotional: number
): { canProceed: boolean; reason?: string } {
  const minRequired = requiredNotional * 2;
  
  if (availableBalance < minRequired) {
    return {
      canProceed: false,
      reason: `Insufficient balance: $${availableBalance.toFixed(2)} < $${minRequired.toFixed(2)}`,
    };
  }
  
  return { canProceed: true };
}

// ============================================================
// LIQUIDITY CHECK
// ============================================================

export interface OrderbookDepth {
  hasLiquidity: boolean;
  askVolume: number;
  bidVolume: number;
  topAsk: number | null;
  topBid: number | null;
}

export function checkLiquidityForAccumulate(
  upDepth: OrderbookDepth,
  downDepth: OrderbookDepth,
  requiredShares: number
): { canProceed: boolean; reason?: string } {
  const minLiquidity = Math.max(requiredShares, DEFAULT_CONFIG.limits.minTopDepthShares);
  
  if (!upDepth.hasLiquidity) {
    return { 
      canProceed: false, 
      reason: `UP side has no liquidity (${upDepth.askVolume.toFixed(0)} shares)` 
    };
  }
  
  if (!downDepth.hasLiquidity) {
    return { 
      canProceed: false, 
      reason: `DOWN side has no liquidity (${downDepth.askVolume.toFixed(0)} shares)` 
    };
  }
  
  if (upDepth.askVolume < minLiquidity) {
    return { 
      canProceed: false, 
      reason: `UP side insufficient (${upDepth.askVolume.toFixed(0)} < ${minLiquidity} needed)` 
    };
  }
  
  if (downDepth.askVolume < minLiquidity) {
    return { 
      canProceed: false, 
      reason: `DOWN side insufficient (${downDepth.askVolume.toFixed(0)} < ${minLiquidity} needed)` 
    };
  }
  
  return { canProceed: true };
}

// ============================================================
// PRE-HEDGE CALCULATION
// ============================================================

const MAX_HEDGE_PRICE = 0.75;
const MAX_COMBINED_COST = 1.05;

export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: 'UP' | 'DOWN',
  hedgeAsk?: number,
  tick: number = 0.01
): { hedgeSide: 'UP' | 'DOWN'; hedgePrice: number; reasoning: string } | null {
  const hedgeSide: 'UP' | 'DOWN' = openingSide === 'UP' ? 'DOWN' : 'UP';
  
  let hedgePrice: number;
  let reasoning: string;
  
  if (hedgeAsk !== undefined && hedgeAsk > 0) {
    const cushion = DEFAULT_CONFIG.execution.hedgeCushionTicks;
    const rawHedgePrice = roundUp(hedgeAsk + cushion * tick, tick);
    hedgePrice = Math.min(rawHedgePrice, MAX_HEDGE_PRICE);
    
    const projectedCombined = openingPrice + hedgePrice;
    
    if (projectedCombined > MAX_COMBINED_COST) {
      console.log(`[PreHedge] RISK LIMIT: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${(MAX_COMBINED_COST * 100).toFixed(0)}¢ max`);
      return null;
    }
    
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (ask=${(hedgeAsk * 100).toFixed(0)}¢ +${cushion}t)`;
  } else {
    const targetCombined = 1 - DEFAULT_CONFIG.edge.baseBuffer;
    const targetHedgePrice = targetCombined - openingPrice;
    hedgePrice = Math.min(Math.round(targetHedgePrice * 100) / 100, MAX_HEDGE_PRICE);
    reasoning = `Pre-hedge ${hedgeSide} @ ${(hedgePrice * 100).toFixed(0)}¢ (theoretical)`;
  }
  
  if (hedgePrice < 0.03) return null;
  
  return { hedgeSide, hedgePrice, reasoning };
}

// ============================================================
// v4.2.1 HELPER FUNCTIONS
// ============================================================

/**
 * v4.2.1: Compute timeFactor for parameter scaling
 */
function getTimeFactor(secondsRemaining: number): number {
  return Math.max(secondsRemaining, 60) / 900;  // 1.0 at 900s, 0.07 at 60s
}

/**
 * v4.2.1: Time-scaled hedge timeout
 */
function getScaledHedgeTimeout(timeFactor: number): number {
  return Math.max(8, Math.floor(STRATEGY.timeScaled.hedgeTimeoutBaseSec * timeFactor));
}

/**
 * v4.2.1: Time-scaled max skew (shrinks toward 50/50)
 */
function getScaledMaxSkew(timeFactor: number): number {
  return 0.50 + (STRATEGY.timeScaled.maxSkewBase - 0.50) * timeFactor;
}

/**
 * v4.2.1: Time-scaled buffer addition (increases as time decreases)
 */
function getScaledBufferAdd(timeFactor: number): number {
  return STRATEGY.timeScaled.bufferAddBase * (1 - timeFactor);
}

/**
 * v4.2.1: Check if DEEP mode is allowed
 */
function isDeepModeAllowed(secondsRemaining: number, combined: number): boolean {
  // Note: We don't have delta/spotPrice in legacy API, so skip delta check
  if (secondsRemaining <= STRATEGY.deep.minTimeSec) return false;
  if (combined >= STRATEGY.deep.maxCombinedAsk) return false;
  return true;
}

// ============================================================
// LEGACY EVALUATION FUNCTION (v4.2.1 UPDATED)
// ============================================================

export type Outcome = 'UP' | 'DOWN';

export interface LegacyTradeSignal {
  outcome: Outcome;
  price: number;
  shares: number;
  reasoning: string;
  type: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind';
  isMarketable?: boolean;
  cushionTicks?: number;
}

function cheapestSideByAsk(upAsk: number, downAsk: number): Outcome {
  return upAsk <= downAsk ? 'UP' : 'DOWN';
}

function pairedLockOk(upAsk: number, downAsk: number, buffer: number): boolean {
  return (upAsk + downAsk) <= (1 - buffer);
}

function sharesFromUsd(usd: number, price: number): number {
  if (price <= 0) return 0;
  return Math.max(1, Math.floor(usd / price));
}

// ============================================================
// v4.2.2 HARD SKEW STOP
// ============================================================
const HARD_SKEW_MIN = 0.35;  // Stop if UP/(UP+DOWN) < 35%
const HARD_SKEW_MAX = 0.65;  // Stop if UP/(UP+DOWN) > 65%

export function checkHardSkewStop(position: MarketPosition): { blocked: boolean; skew: number; reason?: string } {
  const total = position.upShares + position.downShares;
  if (total === 0) return { blocked: false, skew: 0.5 };
  
  const skew = position.upShares / total;
  
  if (skew < HARD_SKEW_MIN) {
    return { 
      blocked: true, 
      skew,
      reason: `HARD_SKEW_STOP: UP=${position.upShares} DOWN=${position.downShares} (${(skew*100).toFixed(0)}% < ${(HARD_SKEW_MIN*100).toFixed(0)}% min)`
    };
  }
  
  if (skew > HARD_SKEW_MAX) {
    return {
      blocked: true,
      skew,
      reason: `HARD_SKEW_STOP: UP=${position.upShares} DOWN=${position.downShares} (${(skew*100).toFixed(0)}% > ${(HARD_SKEW_MAX*100).toFixed(0)}% max)`
    };
  }
  
  return { blocked: false, skew };
}

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number,
  availableBalance?: number
): LegacyTradeSignal | null {
  // ========== v4.2.2 HARD SKEW STOP ==========
  // Only apply skew stop when we already have BOTH sides.
  // When one-sided, we must allow HEDGE signals to restore balance.
  const hasUpNow = position.upShares > 0;
  const hasDownNow = position.downShares > 0;
  if (hasUpNow && hasDownNow) {
    const skewCheck = checkHardSkewStop(position);
    if (skewCheck.blocked) {
      // Only log occasionally to avoid spam
      if (Math.random() < 0.05) {
        console.log(`🛑 ${skewCheck.reason}`);
      }
      return null;
    }
  }
  // ========== v4.2.1 TIME-SCALED PARAMETERS ==========
  const timeFactor = getTimeFactor(remainingSeconds);
  const scaledBuffer = STRATEGY.edge.buffer + getScaledBufferAdd(timeFactor);
  const scaledMaxSkew = getScaledMaxSkew(timeFactor);
  const scaledHedgeTimeout = getScaledHedgeTimeout(timeFactor);
  
  // ========== PRE-CHECKS ==========
  
  // Cooldown check
  if (lastTradeAtMs && nowMs - lastTradeAtMs < STRATEGY.cooldownMs) {
    return null;
  }

  // Book freshness
  if (nowMs - book.updatedAtMs > STRATEGY.entry.staleBookMs) {
    return null;
  }

  const upAsk = book.up.ask;
  const downAsk = book.down.ask;

  if (!isNum(upAsk) || !isNum(downAsk)) {
    return null;
  }

  const combined = upAsk + downAsk;

  // Sanity checks
  if (combined < 0.90 || combined > 1.10) return null;
  if (upAsk < STRATEGY.entry.minPrice || upAsk > STRATEGY.entry.maxPrice) return null;
  if (downAsk < STRATEGY.entry.minPrice || downAsk > STRATEGY.entry.maxPrice) return null;

  // Time check - stop new trades near expiry
  if (remainingSeconds < STRATEGY.limits.stopTradesSec) {
    return null;
  }

  // Position limits
  const totalInvested = (position.upInvested || position.upCost || 0) + (position.downInvested || position.downCost || 0);
  if (totalInvested >= STRATEGY.limits.maxTotalNotional) return null;

  const hasUp = position.upShares > 0;
  const hasDown = position.downShares > 0;
  const tick = DEFAULT_CONFIG.execution.tickFallback;
  
  // v4.2.1: Check if DEEP mode is allowed
  const deepAllowed = isDeepModeAllowed(remainingSeconds, combined);
  
  // Log v4.2.1 parameters periodically
  if (Math.random() < 0.02) { // 2% of evaluations
    console.log(`[v4.2.1] timeFactor=${timeFactor.toFixed(2)} buffer=${(scaledBuffer*100).toFixed(2)}¢ maxSkew=${(scaledMaxSkew*100).toFixed(0)}% hedgeTimeout=${scaledHedgeTimeout}s DEEP=${deepAllowed}`);
  }

  // ========== STATE LOGIC (v4.2.1) ==========

  // FLAT: No position - look for opening trade
  if (!hasUp && !hasDown) {
    const cheaperSide = cheapestSideByAsk(upAsk, downAsk);
    const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
    
    const isOpeningPrice = cheaperPrice <= STRATEGY.opening.maxPrice;
    // v4.2.1: Use time-scaled buffer for edge check
    const hasEdge = pairedLockOk(upAsk, downAsk, scaledBuffer);
    
    if (!isOpeningPrice && !hasEdge) {
      return null;
    }
    
    // Balance check
    if (availableBalance !== undefined) {
      const check = checkBalanceForOpening(availableBalance, STRATEGY.opening.notional);
      if (!check.canProceed) return null;
    }
    
    if (cheaperPrice > STRATEGY.opening.maxPrice) return null;
    
    const clipUsd = STRATEGY.sizing.baseClipUsd;
    const shares = sharesFromUsd(clipUsd, cheaperPrice);
    
    if (shares < 1) return null;
    
    return {
      outcome: cheaperSide,
      price: cheaperPrice,
      shares,
      reasoning: `ENTRY ${cheaperSide} @ ${(cheaperPrice * 100).toFixed(1)}¢ (v4.2.1 tf=${timeFactor.toFixed(2)})`,
      type: 'opening',
    };
  }

  // ONE_SIDED: Must hedge
  if ((hasUp && !hasDown) || (!hasUp && hasDown)) {
    const missingSide: Outcome = !hasUp ? 'UP' : 'DOWN';
    const missingAsk = missingSide === 'UP' ? upAsk : downAsk;
    const existingShares = missingSide === 'UP' ? position.downShares : position.upShares;
    
    const hedgeShares = Math.max(existingShares, 5); // Min 5 shares for order validity
    
    // Check if hedge would lock profit or is acceptable
    const existingCost = missingSide === 'UP' 
      ? (position.downInvested || position.downCost || 0) 
      : (position.upInvested || position.upCost || 0);
    const existingAvg = existingShares > 0 ? existingCost / existingShares : 0;
    const projectedCombined = existingAvg + missingAsk;
    
    // v4.2.1: Allow overpay for hedging
    const allowOverpay = DEFAULT_CONFIG.edge.allowOverpay;
    if (projectedCombined > 1 + allowOverpay) {
      console.log(`[v4.2.1] HEDGE_SKIPPED: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${((1 + allowOverpay) * 100).toFixed(0)}¢ max`);
      return null;
    }
    
    // v4.2.1: Use time-scaled cushion ticks
    const cushion = DEFAULT_CONFIG.execution.hedgeCushionTicks;
    const limitPrice = roundUp(missingAsk + cushion * tick, tick);
    
    return {
      outcome: missingSide,
      price: limitPrice,
      shares: hedgeShares,
      reasoning: `HEDGE ${missingSide} @ ${(limitPrice * 100).toFixed(0)}¢ (v4.2.1 timeout=${scaledHedgeTimeout}s)`,
      type: 'hedge',
      isMarketable: true,
      cushionTicks: cushion,
    };
  }

  // HEDGED: Both sides have positions - look for accumulate
  const uf = position.upShares / (position.upShares + position.downShares);
  
  // v4.2.1: Use time-scaled max skew
  const isSkewed = uf > scaledMaxSkew || uf < (1 - scaledMaxSkew);
  
  // SKEWED: Need to rebalance first
  if (isSkewed) {
    const delta = uf - DEFAULT_CONFIG.skew.target;
    const sideToBuy: Outcome = delta > 0 ? 'DOWN' : 'UP';
    const sideAsk = sideToBuy === 'UP' ? upAsk : downAsk;
    
    // v4.2.1: Use time-scaled buffer for rebalance
    if (!pairedLockOk(upAsk, downAsk, scaledBuffer)) {
      return null;
    }
    
    const currentShares = sideToBuy === 'UP' ? position.upShares : position.downShares;
    const otherShares = sideToBuy === 'UP' ? position.downShares : position.upShares;
    const sharesToBalance = Math.floor((otherShares - currentShares) / 2);
    
    if (sharesToBalance < 5) return null;
    
    return {
      outcome: sideToBuy,
      price: roundDown(sideAsk, tick),
      shares: sharesToBalance,
      reasoning: `REBALANCE ${sideToBuy} @ ${(sideAsk * 100).toFixed(1)}¢ (v4.2.1 maxSkew=${(scaledMaxSkew*100).toFixed(0)}%)`,
      type: 'rebalance',
    };
  }

  // HEDGED & BALANCED: Can accumulate if good edge
  // v4.2.1: Use time-scaled buffer for accumulate
  if (!pairedLockOk(upAsk, downAsk, scaledBuffer)) {
    return null;
  }
  
  // Check per-side share limits (300 max)
  if (position.upShares >= STRATEGY.limits.maxPerSideShares || 
      position.downShares >= STRATEGY.limits.maxPerSideShares) {
    return null;
  }
  
  // Must be balanced to accumulate (exposure check)
  const currentSkew = Math.abs(uf - 0.5);
  if (currentSkew > 0.1) {
    // Position is exposed, don't accumulate
    return null;
  }
  
  const edgePct = (1 - combined) * 100;
  
  // v4.2.1: Max 50 shares per accumulate, calculate based on edge
  let sharesToAdd: number;
  if (edgePct > 5) {
    // Strong edge: use max
    sharesToAdd = STRATEGY.accumulate.maxShares; // 50
  } else if (edgePct > 2) {
    // Medium edge: base clip
    sharesToAdd = Math.min(
      Math.floor(STRATEGY.sizing.baseClipUsd / combined),
      STRATEGY.accumulate.maxShares
    );
  } else {
    // Weak edge: smaller accumulate
    sharesToAdd = Math.min(
      Math.floor(STRATEGY.sizing.minClipUsd / combined),
      25 // Smaller for weak edge
    );
  }
  
  // Respect max position limit
  const maxAddUp = STRATEGY.limits.maxPerSideShares - position.upShares;
  const maxAddDown = STRATEGY.limits.maxPerSideShares - position.downShares;
  sharesToAdd = Math.min(sharesToAdd, maxAddUp, maxAddDown);
  
  if (sharesToAdd < 5) return null;
  
  // Return UP first (caller should also do DOWN)
  return {
    outcome: 'UP',
    price: roundDown(upAsk, tick),
    shares: sharesToAdd,
    reasoning: `ACCUMULATE ${sharesToAdd} @ ${(combined * 100).toFixed(1)}¢ (v4.2.1 edge=${edgePct.toFixed(1)}% buffer=${(scaledBuffer*100).toFixed(2)}¢)`,
    type: 'accumulate',
  };
}
