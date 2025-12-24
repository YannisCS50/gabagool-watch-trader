import { config } from './config.js';

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

// Strategy configuration
export const STRATEGY = {
  opening: {
    notional: config.trading.maxNotionalPerTrade,
    maxPrice: config.trading.openingMaxPrice,
  },
  hedge: {
    triggerCombined: 0.98,
    notional: config.trading.maxNotionalPerTrade,
  },
  accumulate: {
    triggerCombined: 0.97,
    notional: config.trading.maxNotionalPerTrade,
  },
  limits: {
    maxSharesPerSide: 100,
    maxTotalInvested: 50,
  },
  entry: {
    minSecondsRemaining: 60,
    minPrice: 0.03,
    maxPrice: 0.92,
    staleBookMs: 3000,
  },
  cooldownMs: 5000,
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
