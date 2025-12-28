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
export const STRATEGY_VERSION = '3.0.0-gpt-strat';
export const STRATEGY_NAME = 'Polymarket 15m Hedge/Arb (GPT-Grade)';

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
  
  // Sizing
  sizing: {
    baseClipUsd: DEFAULT_CONFIG.tradeSizeUsd.base,
    minClipUsd: DEFAULT_CONFIG.tradeSizeUsd.min,
    maxClipUsd: DEFAULT_CONFIG.tradeSizeUsd.max,
  },
  
  // Skew Management
  skew: {
    target: DEFAULT_CONFIG.skew.target,
    rebalanceThreshold: DEFAULT_CONFIG.skew.rebalanceThreshold,
    hardCap: DEFAULT_CONFIG.skew.hardCap,
  },
  
  // Risk Limits
  limits: {
    maxTotalNotional: DEFAULT_CONFIG.limits.maxTotalUsd,
    maxPerSide: DEFAULT_CONFIG.limits.maxPerSideUsd,
    hedgeTimeoutSec: DEFAULT_CONFIG.timing.hedgeTimeoutSec,
    stopTradesSec: DEFAULT_CONFIG.timing.stopNewTradesSec,
    unwindStartSec: DEFAULT_CONFIG.timing.unwindStartSec,
  },
  
  // Opening parameters
  opening: {
    notional: config.trading.maxNotionalPerTrade,
    maxPrice: 0.52,
    skipEdgeCheck: true,
    maxDelayMs: 5000,
  },
  
  // Entry conditions
  entry: {
    minSecondsRemaining: DEFAULT_CONFIG.timing.unwindStartSec,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  
  // Cooldown
  cooldownMs: DEFAULT_CONFIG.limits.sideCooldownMs * 5, // 10s effective
  
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
// LEGACY EVALUATION FUNCTION (ADAPTER)
// Converts old API calls to GPT-strat logic
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

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number,
  availableBalance?: number
): LegacyTradeSignal | null {
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

  // ========== STATE LOGIC (GPT-STRAT STYLE) ==========

  // FLAT: No position - look for opening trade
  if (!hasUp && !hasDown) {
    const cheaperSide = cheapestSideByAsk(upAsk, downAsk);
    const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
    
    const isOpeningPrice = cheaperPrice <= STRATEGY.opening.maxPrice;
    const hasEdge = pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer);
    
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
      reasoning: `ENTRY ${cheaperSide} @ ${(cheaperPrice * 100).toFixed(1)}¢ (GPT-strat cheapest-first)`,
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
    
    // GPT-strat: Allow overpay up to 2% for hedging
    const allowOverpay = DEFAULT_CONFIG.edge.allowOverpay;
    if (projectedCombined > 1 + allowOverpay) {
      console.log(`[Strategy] HEDGE_SKIPPED: combined ${(projectedCombined * 100).toFixed(0)}¢ > ${((1 + allowOverpay) * 100).toFixed(0)}¢ max`);
      return null;
    }
    
    // Calculate limit price with cushion ticks
    const cushion = DEFAULT_CONFIG.execution.hedgeCushionTicks;
    const limitPrice = roundUp(missingAsk + cushion * tick, tick);
    
    return {
      outcome: missingSide,
      price: limitPrice,
      shares: hedgeShares,
      reasoning: `HEDGE ${missingSide} @ ${(limitPrice * 100).toFixed(0)}¢ (GPT-strat +${cushion} ticks cushion)`,
      type: 'hedge',
      isMarketable: true,
      cushionTicks: cushion,
    };
  }

  // HEDGED: Both sides have positions - look for accumulate
  const uf = position.upShares / (position.upShares + position.downShares);
  const isSkewed = uf > DEFAULT_CONFIG.skew.hardCap || uf < (1 - DEFAULT_CONFIG.skew.hardCap);
  
  // SKEWED: Need to rebalance first
  if (isSkewed) {
    const delta = uf - DEFAULT_CONFIG.skew.target;
    const sideToBuy: Outcome = delta > 0 ? 'DOWN' : 'UP';
    const sideAsk = sideToBuy === 'UP' ? upAsk : downAsk;
    
    // Only rebalance if still locks profit
    if (!pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer)) {
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
      reasoning: `REBALANCE ${sideToBuy} @ ${(sideAsk * 100).toFixed(1)}¢ (GPT-strat skew correction)`,
      type: 'rebalance',
    };
  }

  // HEDGED & BALANCED: Can accumulate if good edge
  if (!pairedLockOk(upAsk, downAsk, STRATEGY.edge.buffer)) {
    return null;
  }
  
  // Check per-side limits
  if (position.upShares >= STRATEGY.limits.maxPerSide || 
      position.downShares >= STRATEGY.limits.maxPerSide) {
    return null;
  }
  
  // Must be balanced to accumulate
  const currentSkew = Math.abs(uf - 0.5);
  if (currentSkew > 0.1) return null;
  
  const edgePct = (1 - combined) * 100;
  const clipUsd = edgePct > 5 
    ? STRATEGY.sizing.maxClipUsd 
    : STRATEGY.sizing.baseClipUsd;
  const sharesToAdd = Math.floor(clipUsd / combined);
  
  if (sharesToAdd < 1) return null;
  
  // Return UP first (caller should also do DOWN)
  return {
    outcome: 'UP',
    price: roundDown(upAsk, tick),
    shares: sharesToAdd,
    reasoning: `ACCUMULATE @ ${(combined * 100).toFixed(1)}¢ (${edgePct.toFixed(1)}% edge, GPT-strat)`,
    type: 'accumulate',
  };
}
