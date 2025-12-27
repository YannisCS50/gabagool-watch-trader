import { config } from './config.js';
import type { OrderbookDepth } from './polymarket.js';

export type Outcome = 'UP' | 'DOWN';

export interface TopOfBook {
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
  updatedAtMs: number;
}

export interface MarketPosition {
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
}

export interface TradeSignal {
  outcome: Outcome;
  price: number;
  shares: number;
  reasoning: string;
  type: 'opening' | 'hedge' | 'accumulate';
}

// Strategy configuration - LIVE TRADING PARAMETERS
export const STRATEGY = {
  opening: {
    notional: config.trading.maxNotionalPerTrade,
    maxPrice: 0.50, // Strenger: alleen tot 50¢ openen
  },
  hedge: {
    triggerCombined: 0.97, // Hedge bij < 97¢ (3% edge minimum)
    notional: config.trading.maxNotionalPerTrade,
  },
  accumulate: {
    triggerCombined: 0.96, // Accumulate bij < 96¢ (4% edge)
    notional: config.trading.maxNotionalPerTrade,
    requireBalanced: true, // Alleen als UP shares == DOWN shares
  },
  limits: {
    maxSharesPerSide: 150,
    maxTotalInvested: 75,
  },
  entry: {
    minSecondsRemaining: 45,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 5000,
  },
  cooldownMs: 3000,
};

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function calcShares(notional: number, price: number): number {
  if (price <= 0) return 0;
  return Math.floor(notional / price);
}

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number
): TradeSignal | null {
  // Cooldown check
  if (lastTradeAtMs && nowMs - lastTradeAtMs < STRATEGY.cooldownMs) {
    return null;
  }

  // Time check
  if (remainingSeconds < STRATEGY.entry.minSecondsRemaining) {
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

  // Position limits
  const totalInvested = position.upInvested + position.downInvested;
  if (totalInvested >= STRATEGY.limits.maxTotalInvested) return null;

  // ========== TRADING LOGIC ==========

  // PHASE 1: OPENING - No position yet
  if (position.upShares === 0 && position.downShares === 0) {
    const cheaperSide: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
    const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;

    if (cheaperPrice <= STRATEGY.opening.maxPrice) {
      const shares = calcShares(STRATEGY.opening.notional, cheaperPrice);
      if (shares >= 1) {
        return {
          outcome: cheaperSide,
          price: cheaperPrice,
          shares,
          reasoning: `Opening ${cheaperSide} @ ${(cheaperPrice * 100).toFixed(0)}¢`,
          type: 'opening',
        };
      }
    }
    return null;
  }

  // PHASE 2: HEDGE - One side filled, buy other at good price
  if (position.upShares === 0 || position.downShares === 0) {
    const missingSide: Outcome = position.upShares === 0 ? 'UP' : 'DOWN';
    const missingPrice = missingSide === 'UP' ? upAsk : downAsk;
    const existingShares = missingSide === 'UP' ? position.downShares : position.upShares;
    const existingInvested = missingSide === 'UP' ? position.downInvested : position.upInvested;
    const existingAvg = existingShares > 0 ? existingInvested / existingShares : 0;
    const projectedCombined = existingAvg + missingPrice;

    if (projectedCombined < STRATEGY.hedge.triggerCombined && missingPrice <= STRATEGY.opening.maxPrice) {
      const edgePct = ((1 - projectedCombined) * 100).toFixed(1);
      return {
        outcome: missingSide,
        price: missingPrice,
        shares: existingShares,
        reasoning: `Hedge ${missingSide} @ ${(missingPrice * 100).toFixed(0)}¢ (${edgePct}% edge)`,
        type: 'hedge',
      };
    }
    return null;
  }

  // PHASE 3: ACCUMULATE - Both sides filled, add equal shares if good combined
  // Only accumulate if position is balanced (UP shares == DOWN shares)
  if (STRATEGY.accumulate.requireBalanced && position.upShares !== position.downShares) {
    // Position not balanced, skip accumulate
    return null;
  }

  if (combined < STRATEGY.accumulate.triggerCombined) {
    const priceSum = upAsk + downAsk;
    const sharesToAdd = Math.floor(STRATEGY.accumulate.notional / priceSum);

    if (
      sharesToAdd >= 1 &&
      position.upShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide &&
      position.downShares + sharesToAdd <= STRATEGY.limits.maxSharesPerSide
    ) {
      const edgePct = ((1 - combined) * 100).toFixed(1);
      // Return UP first, caller should also do DOWN
      return {
        outcome: 'UP',
        price: upAsk,
        shares: sharesToAdd,
        reasoning: `Accumulate @ ${(combined * 100).toFixed(0)}¢ combined (${edgePct}% edge)`,
        type: 'accumulate',
      };
    }
  }

  return null;
}

/**
 * Check if both sides have enough liquidity for an accumulate trade.
 * Returns whether we can proceed and the reason if not.
 */
export function checkLiquidityForAccumulate(
  upDepth: OrderbookDepth,
  downDepth: OrderbookDepth,
  requiredShares: number
): { canProceed: boolean; reason?: string } {
  const minLiquidity = Math.max(requiredShares, 10);
  
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
