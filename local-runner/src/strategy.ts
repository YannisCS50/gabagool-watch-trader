/**
 * strategy.ts - Active Strategy Wrapper
 * =====================================
 * This file exports the GPT-strat (Polymarket1hArbBot) adapted for the local-runner.
 * The loveable-strat.ts is preserved as backup.
 * 
 * Strategy: gpt-strat (Polymarket 1h Hedge/Arbitrage Bot - Gabagool-Grade)
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
export const STRATEGY_VERSION = '5.1.0-relaxed';
export const STRATEGY_NAME = 'Polymarket 1h Hedge/Arb (v5.1.0 - Relaxed Hedge)';

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
  
  // Opening parameters - v4.6.0: ATOMIC PAIRS - always do both sides
  opening: {
    shares: 50,          // Fixed 50 shares per opening
    notional: 25,        // ~$25 at 50¢ = 50 shares
    maxPrice: 0.52,      // v4.6.0: Up to 52¢ for entry side
    maxCombined: 0.98,   // v4.6.0: Combined must be < 98¢ for edge
    skipEdgeCheck: true,
    maxDelayMs: 5000,
  },
  
  // Hedge parameters - v5.1.0: RELAXED HEDGE - allow exposed positions
  hedge: {
    shares: 50,           // Fixed 50 shares per hedge
    maxPrice: 0.75,       // Allow expensive hedges up to 75¢
    cushionTicks: 3,      // 3 ticks above ask for faster fills
    forceTimeoutSec: 180, // v5.1.0: 180s for 1h markets - more time exposed
    cooldownMs: 0,        // NO COOLDOWN for hedge!
    relaxedEdge: 0.045,   // v5.1.0: Only hedge at 4.5% edge (combined < 95.5¢)
    panicHedgeSec: 300,   // v5.1.0: Force hedge at any price below 5 min remaining
    panicMaxPrice: 0.95,  // v5.1.0: Accept up to 5% loss in panic mode
  },
  
  // Accumulate parameters - v5.1.0: only when hedged, but no hurry
  accumulate: {
    maxShares: 50,       // Max 50 shares per accumulate
    requireHedged: false,// v5.1.0: Can accumulate even if one-sided (risky but more trades)
    minEdge: 0.01,       // v5.1.0: Lowered to 1% edge to accumulate
  },
  
  // v5.0.0: Delta regime configuration
  delta: {
    lowThreshold: 0.0030,    // LOW: delta < 0.30%
    midThreshold: 0.0070,    // MID: 0.30% - 0.70%
    deepMaxDelta: 0.0040,    // DEEP only if delta < 0.40%
  },
  
  // v5.0.0: Time-scaled parameters (adjusted for 1h = 3600s markets)
  timeScaled: {
    hedgeTimeoutBaseSec: 120,  // Base: 120s for 1h markets, scaled by timeFactor
    maxSkewBase: 0.70,         // Base: 70/30, shrinks toward 50/50
    bufferAddBase: 0.008,      // Base: +0.8%, increases as time decreases
  },
  
  // v5.0.0: DEEP mode conditions (adjusted for 1h markets)
  deep: {
    minTimeSec: 600,           // Only if > 600s (10 min) remaining for 1h markets
    maxCombinedAsk: 0.95,      // Only if combined < 95¢
    maxDeltaPct: 0.0040,       // Only if delta < 0.40%
  },
  
  // Entry conditions - v4.5.1: Relaxed for better entry
  entry: {
    minSecondsRemaining: DEFAULT_CONFIG.timing.unwindStartSec,
    minPrice: 0.05,      // v4.5.1: Min 5¢ (avoid dust)
    maxPrice: 0.95,      // v4.5.1: Max 95¢ (allow more range)
    staleBookMs: 5000,
  },
  
  // Cooldown - v4.6.0: ZERO cooldown between UP/DOWN of same pair
  cooldownMs: 0, // v4.6.0: No cooldown - we do atomic pairs
  
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
 * v5.0.0: Compute timeFactor for parameter scaling (1h markets = 3600s)
 */
function getTimeFactor(secondsRemaining: number): number {
  return Math.max(secondsRemaining, 120) / 3600;  // 1.0 at 3600s (1h), 0.03 at 120s
}

/**
 * v5.0.0: Time-scaled hedge timeout (longer for 1h markets)
 */
function getScaledHedgeTimeout(timeFactor: number): number {
  return Math.max(15, Math.floor(STRATEGY.timeScaled.hedgeTimeoutBaseSec * timeFactor));
}

/**
 * v5.0.0: Time-scaled max skew (shrinks toward 50/50)
 */
function getScaledMaxSkew(timeFactor: number): number {
  return 0.50 + (STRATEGY.timeScaled.maxSkewBase - 0.50) * timeFactor;
}

/**
 * v5.0.0: Time-scaled buffer addition (increases as time decreases)
 */
function getScaledBufferAdd(timeFactor: number): number {
  return STRATEGY.timeScaled.bufferAddBase * (1 - timeFactor);
}

/**
 * v5.0.0: Check if DEEP mode is allowed (adjusted for 1h markets)
 */
function isDeepModeAllowed(secondsRemaining: number, combined: number): boolean {
  // Note: We don't have delta/spotPrice in legacy API, so skip delta check
  // For 1h markets: require at least 600s (10 min) remaining for DEEP
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
  type: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind' | 'paired';
  isMarketable?: boolean;
  cushionTicks?: number;
  // v4.6.0: For paired trades - second leg info
  pairedWith?: {
    outcome: Outcome;
    price: number;
    shares: number;
  };
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

  // FLAT: No position - v4.6.0 ATOMIC PAIRED ENTRY
  if (!hasUp && !hasDown) {
    const combined = upAsk + downAsk;
    
    // v4.6.0: Check combined price for edge (must be < 98¢ for profit)
    const maxCombined = STRATEGY.opening.maxCombined || 0.98;
    if (combined >= maxCombined) {
      if (Math.random() < 0.01) {
        console.log(`[v4.6.0] SKIP: combined ${(combined * 100).toFixed(1)}¢ >= ${(maxCombined * 100).toFixed(0)}¢ max`);
      }
      return null;
    }
    
    // v4.6.0: Both prices must be reasonable (not too extreme)
    if (upAsk > STRATEGY.opening.maxPrice && downAsk > STRATEGY.opening.maxPrice) {
      return null;
    }
    
    // Balance check - need enough for BOTH sides
    if (availableBalance !== undefined) {
      const totalNeeded = (upAsk + downAsk) * STRATEGY.opening.shares;
      if (availableBalance < totalNeeded * 1.1) {
        console.log(`[v4.6.0] SKIP: balance $${availableBalance.toFixed(2)} < $${(totalNeeded * 1.1).toFixed(2)} needed`);
        return null;
      }
    }
    
    const shares = STRATEGY.opening.shares; // Fixed 50 shares
    const edge = ((1 - combined) * 100).toFixed(1);
    
    // v4.6.0: Return PAIRED trade signal with both legs
    console.log(`[v4.6.0] 🎯 ATOMIC PAIR: UP@${(upAsk*100).toFixed(0)}¢ + DOWN@${(downAsk*100).toFixed(0)}¢ = ${(combined*100).toFixed(0)}¢ (edge=${edge}%)`);
    
    return {
      outcome: 'UP',
      price: upAsk,
      shares,
      reasoning: `ATOMIC_PAIR ${shares}sh: UP@${(upAsk*100).toFixed(0)}¢ + DOWN@${(downAsk*100).toFixed(0)}¢ = ${(combined*100).toFixed(0)}¢ (edge=${edge}%)`,
      type: 'paired',
      pairedWith: {
        outcome: 'DOWN',
        price: downAsk,
        shares,
      },
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
    
    // v5.0.0: RELAXED HEDGE - allow more overpay, prioritize getting hedged
    // Being one-sided near expiry is worse than losing some edge
    const allowOverpay = 0.05; // Allow up to 5% overpay
    if (projectedCombined > 1 + allowOverpay) {
      // v5.0.0: Only skip if we have plenty of time left (10+ minutes for 1h markets)
      if (remainingSeconds > 600) {
        console.log(`[v5.0.0] HEDGE_SKIPPED: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${((1 + allowOverpay) * 100).toFixed(0)}¢ max (time=${remainingSeconds}s)`);
        return null;
      }
      // Under 600s (10 min): ALWAYS hedge regardless of cost
      console.log(`[v5.0.0] FORCE_HEDGE: time=${remainingSeconds}s, combined=${(projectedCombined * 100).toFixed(0)}¢`);
    }
    
    // v4.5.1: Use more aggressive cushion ticks for faster fills
    const cushion = STRATEGY.hedge.cushionTicks;
    const limitPrice = roundUp(missingAsk + cushion * tick, tick);
    
    return {
      outcome: missingSide,
      price: limitPrice,
      shares: hedgeShares,
      reasoning: `HEDGE ${missingSide} @ ${(limitPrice * 100).toFixed(0)}¢ (v4.5.1 timeout=${scaledHedgeTimeout}s)`,
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
