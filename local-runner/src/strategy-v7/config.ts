/**
 * Strategy v7.0 Configuration
 * ============================================================
 * Single source of truth for all strategy parameters
 * 
 * Priority: DB override > ENV override > defaults
 */

import type { Asset } from './types.js';

export const STRATEGY_VERSION = '7.0.0';
export const STRATEGY_NAME = 'GPT Strategy v7.0 – Gabagool Inventory Arbitrage + Execution Hardening';

// ============================================================
// DEFAULT CONFIGURATION
// ============================================================

export interface StrategyV7Config {
  version: string;
  
  // Assets to trade
  assetsEnabled: Asset[];
  
  // Tick size for price rounding
  tickSize: number;
  
  // Entry configuration
  entry: {
    stopNewTradesSec: number;           // No new trades after this time remaining
    minSecondsRemainingToEnter: number; // Minimum time to enter
    baseEdgeBuffer: number;             // Minimum edge required (1.5c = 0.015)
    strongEdgeThreshold: number;        // Edge that triggers larger sizing
    minExecutableEdge: number;          // Minimum edge after fees/slippage
  };
  
  // Hedge configuration
  hedge: {
    hedgeMustBySec: number;             // Must be hedged by this time
    hedgeTimeoutLowSec: number;         // Hedge timeout in LOW delta regime
    hedgeTimeoutMidSec: number;         // Hedge timeout in MID delta regime
    hedgeTimeoutHighSec: number;        // Hedge timeout in HIGH delta regime
    maxPriceMaker: number;              // Max price for maker hedge orders
    maxPriceUrgent: number;             // Max price for urgent (taker) hedges
    edgeLockBuffer: number;             // Buffer for pair-cost check on hedges
    urgentLossCap: number;              // Max loss accepted in urgent mode
    makerCushionTicks: number;          // Ticks above ask for maker orders
    urgentCushionTicks: number;         // Ticks above ask for urgent orders
  };
  
  // Position sizing
  sizing: {
    lotShares: number;                  // Standard lot size
    minLotShares: number;               // Minimum lot (for partial hedges)
    maxLotShares: number;               // Maximum lot per order
    baseNotionalUsd: number;            // Base trade size in USD
    minNotionalPerTrade: number;        // Minimum trade size
    maxNotionalPerTrade: number;        // Maximum trade size
  };
  
  // Risk management
  risk: {
    perMarketMaxNotional: number;       // Max investment per market
    globalMaxNotional: number;          // Max total investment
    degradedTriggerNotional: number;    // Unpaired notional to trigger degraded
    degradedTriggerAgeSec: number;      // Unpaired age to trigger degraded
    degradedRiskScoreTrigger: number;   // Risk score threshold
    queueStressSize: number;            // Queue size that triggers stress mode
    circuitBreakerFailuresPerMin: number; // Failures/min to trigger breaker
    maxSkewLow: number;                 // Max skew in LOW delta
    maxSkewMid: number;                 // Max skew in MID delta
    maxSkewHigh: number;                // Max skew in HIGH delta
  };
  
  // Timing
  timing: {
    survivalModeSec: number;            // Enter survival mode at this time
    panicModeSec: number;               // Enter panic mode at this time
    unwindStartSec: number;             // Start unwinding at this time
    entryWindowStartSec: number;        // Primary entry window start
    entryWindowEndSec: number;          // Primary entry window end
  };
  
  // Delta regime thresholds
  delta: {
    lowThreshold: number;               // Below this = LOW regime
    midThreshold: number;               // Above this = HIGH regime
    deepMaxDelta: number;               // Max delta for DEEP mode
  };
  
  // Micro-hedge settings
  microHedge: {
    cooldownMs: number;                 // Cooldown between micro-hedges
    maxRetries: number;                 // Max retry attempts
    retryDelayMs: number;               // Delay between retries
  };
  
  // Readiness gate
  readiness: {
    maxSnapshotAgeMs: number;           // Max age for orderbook snapshot
    minLevels: number;                  // Minimum orderbook levels required
    retryDelayMs: number;               // Delay before retry on not-ready
    maxRetries: number;                 // Max retries for readiness
  };
  
  // Queue management
  queue: {
    maxPendingPerMarket: number;        // Max pending intents per market
    maxPendingGlobal: number;           // Max pending intents globally
    entryPriority: number;              // Priority for entry intents
    hedgePriority: number;              // Priority for hedge intents
    microHedgePriority: number;         // Priority for micro-hedge
    unwindPriority: number;             // Priority for unwind
  };
}

// ============================================================
// DEFAULT VALUES
// ============================================================

export const DEFAULT_CONFIG: StrategyV7Config = {
  version: STRATEGY_VERSION,
  
  assetsEnabled: ['BTC', 'ETH', 'SOL', 'XRP'],
  tickSize: 0.01,
  
  entry: {
    stopNewTradesSec: 60,
    minSecondsRemainingToEnter: 90,
    baseEdgeBuffer: 0.015,              // 1.5¢
    strongEdgeThreshold: 0.04,          // 4¢
    minExecutableEdge: 0.008,           // 0.8¢ after fees
  },
  
  hedge: {
    hedgeMustBySec: 60,
    hedgeTimeoutLowSec: 15,
    hedgeTimeoutMidSec: 10,
    hedgeTimeoutHighSec: 5,
    maxPriceMaker: 0.60,
    maxPriceUrgent: 0.85,
    edgeLockBuffer: 0.005,              // 0.5¢
    urgentLossCap: 0.01,                // 1¢ max loss in urgent
    makerCushionTicks: 1,
    urgentCushionTicks: 3,
  },
  
  sizing: {
    lotShares: 25,
    minLotShares: 5,
    maxLotShares: 50,
    baseNotionalUsd: 10,
    minNotionalPerTrade: 5,
    maxNotionalPerTrade: 25,
  },
  
  risk: {
    perMarketMaxNotional: 250,
    globalMaxNotional: 700,
    degradedTriggerNotional: 25,        // Raised from 15 in spec
    degradedTriggerAgeSec: 20,
    degradedRiskScoreTrigger: 500,
    queueStressSize: 6,
    circuitBreakerFailuresPerMin: 20,
    maxSkewLow: 0.70,                   // 70/30 allowed
    maxSkewMid: 0.60,                   // 60/40 allowed
    maxSkewHigh: 0.55,                  // 55/45 allowed
  },
  
  timing: {
    survivalModeSec: 120,               // 2 minutes
    panicModeSec: 30,                   // 30 seconds
    unwindStartSec: 45,
    entryWindowStartSec: 10,
    entryWindowEndSec: 40,
  },
  
  delta: {
    lowThreshold: 0.003,                // 0.30%
    midThreshold: 0.007,                // 0.70%
    deepMaxDelta: 0.004,                // 0.40%
  },
  
  microHedge: {
    cooldownMs: 1500,
    maxRetries: 3,
    retryDelayMs: 500,
  },
  
  readiness: {
    maxSnapshotAgeMs: 2000,
    minLevels: 1,
    retryDelayMs: 200,
    maxRetries: 5,
  },
  
  queue: {
    maxPendingPerMarket: 2,
    maxPendingGlobal: 12,
    entryPriority: 10,
    hedgePriority: 90,
    microHedgePriority: 95,
    unwindPriority: 100,
  },
};

// ============================================================
// CONFIG RESOLUTION (DB > ENV > defaults)
// ============================================================

let resolvedConfig: StrategyV7Config | null = null;

export function getConfig(): StrategyV7Config {
  if (resolvedConfig) return resolvedConfig;
  return DEFAULT_CONFIG;
}

export function setResolvedConfig(config: StrategyV7Config): void {
  resolvedConfig = config;
  console.log(`[v7] Config resolved: version=${config.version}, assets=${config.assetsEnabled.join(',')}`);
}

export function mergeWithEnvOverrides(base: StrategyV7Config): StrategyV7Config {
  const merged = { ...base };
  
  // ENV overrides
  if (process.env.V7_ASSETS) {
    merged.assetsEnabled = process.env.V7_ASSETS.split(',') as Asset[];
  }
  if (process.env.V7_LOT_SHARES) {
    merged.sizing.lotShares = parseInt(process.env.V7_LOT_SHARES, 10);
  }
  if (process.env.V7_MAX_NOTIONAL) {
    merged.sizing.maxNotionalPerTrade = parseFloat(process.env.V7_MAX_NOTIONAL);
  }
  if (process.env.V7_EDGE_BUFFER) {
    merged.entry.baseEdgeBuffer = parseFloat(process.env.V7_EDGE_BUFFER);
  }
  if (process.env.V7_STOP_NEW_TRADES_SEC) {
    merged.entry.stopNewTradesSec = parseInt(process.env.V7_STOP_NEW_TRADES_SEC, 10);
  }
  
  return merged;
}

// ============================================================
// CONFIG VALIDATION
// ============================================================

export function validateConfig(config: StrategyV7Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (config.entry.stopNewTradesSec < 30) {
    errors.push('stopNewTradesSec should be >= 30 for safety');
  }
  if (config.sizing.lotShares < config.sizing.minLotShares) {
    errors.push('lotShares cannot be less than minLotShares');
  }
  if (config.hedge.maxPriceMaker >= config.hedge.maxPriceUrgent) {
    errors.push('maxPriceMaker should be less than maxPriceUrgent');
  }
  if (config.timing.panicModeSec >= config.timing.survivalModeSec) {
    errors.push('panicModeSec should be less than survivalModeSec');
  }
  if (config.risk.degradedTriggerNotional < 10) {
    errors.push('degradedTriggerNotional seems too low (< $10)');
  }
  
  return { valid: errors.length === 0, errors };
}

// Log effective config at startup
export function logEffectiveConfig(config: StrategyV7Config): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  📋 STRATEGY v7.0 EFFECTIVE CONFIG                             ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  Assets: ${config.assetsEnabled.join(', ').padEnd(54)}║`);
  console.log(`║  Lot size: ${config.sizing.lotShares} shares (${config.sizing.minLotShares}-${config.sizing.maxLotShares})`.padEnd(66) + '║');
  console.log(`║  Notional: $${config.sizing.baseNotionalUsd} base ($${config.sizing.minNotionalPerTrade}-$${config.sizing.maxNotionalPerTrade})`.padEnd(66) + '║');
  console.log(`║  Edge buffer: ${(config.entry.baseEdgeBuffer * 100).toFixed(1)}¢`.padEnd(66) + '║');
  console.log(`║  Entry window: ${config.timing.entryWindowStartSec}s - ${config.timing.entryWindowEndSec}s after open`.padEnd(66) + '║');
  console.log(`║  Stop new trades: ${config.entry.stopNewTradesSec}s before expiry`.padEnd(66) + '║');
  console.log(`║  Survival mode: <${config.timing.survivalModeSec}s | Panic: <${config.timing.panicModeSec}s`.padEnd(66) + '║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
}
