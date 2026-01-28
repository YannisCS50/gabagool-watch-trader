// ============================================================
// V35 CONFIGURATION - GABAGOOL STRATEGY
// ============================================================
// Passive Dual-Outcome Market Maker for Polymarket 15-min options
// 
// STRATEGY: Place limit BUY orders on a grid for both UP and DOWN sides.
// When retail traders hit our orders, we accumulate both sides.
// At settlement: one side pays $1.00, other pays $0.00.
// If combined cost < $1.00 -> GUARANTEED profit.
//
// SOURCE: Reverse-engineered from gabagool22's proven strategy
// - 34,569 trades analyzed
// - $165,450 volume
// - 1.88% ROI, 93% win rate
// ============================================================

export type V35Mode = 'test' | 'moderate' | 'production';

export interface V35Config {
  // =========================================================================
  // 🎚️ MODE SELECTOR
  // =========================================================================
  mode: V35Mode;
  
  // =========================================================================
  // 🎯 GRID PARAMETERS
  // =========================================================================
  gridMin: number;          // Lowest bid price (e.g., 0.15)
  gridMax: number;          // Highest bid price (e.g., 0.85)
  gridStep: number;         // Step between price levels (e.g., 0.05)
  
  // =========================================================================
  // 📊 SIZING PARAMETERS
  // =========================================================================
  sharesPerLevel: number;   // Shares per price level (min 3 for Polymarket)
  
  // =========================================================================
  // 🎯 HEDGE PARAMETERS (V35.1.0 - THE FIX)
  // =========================================================================
  enableActiveHedge: boolean;       // TRUE = gabagool style active hedging
  maxHedgeSlippage: number;         // Max extra we'll pay for hedge (e.g., 0.03)
  hedgeTimeoutMs: number;           // Timeout for hedge order
  minEdgeAfterHedge: number;        // Minimum edge after hedge (e.g., 0.005 = 0.5%)
  maxExpensiveBias: number;         // Max ratio expensive:cheap (e.g., 1.2 = 20% more)
  
  // =========================================================================
  // 🛡️ RISK LIMITS
  // =========================================================================
  warnUnpairedShares: number;   // Warning threshold - start blocking leading-side quoting
  maxUnpairedShares: number;    // Emergency stop - absolute max imbalance
  maxUnpairedImbalance: number; // Alias for maxUnpairedShares (used by runner)
  maxImbalanceRatio: number;    // Max ratio UP:DOWN or DOWN:UP (2.0 per doc)
  maxLossPerMarket: number;     // Max $ loss per market before stopping
  maxConcurrentMarkets: number; // Max markets to trade simultaneously
  maxMarkets: number;           // Alias for maxConcurrentMarkets (used by runner)
  maxNotionalPerMarket: number; // Max $ notional per market
  maxTotalExposure: number;     // Max $ total exposure across all markets
  skewThreshold: number;        // Skew threshold for warning logs
  capitalPerMarket: number;     // $ allocated per market
  
  // =========================================================================
  // ⏱️ TIMING PARAMETERS
  // =========================================================================
  startDelayMs: number;         // Delay after market open before placing orders
  stopBeforeExpirySec: number;  // Stop quoting X seconds before expiry
  refreshIntervalMs: number;    // Milliseconds between order updates
  
  // =========================================================================
  // 🚫 FEATURES
  // =========================================================================
  enableMomentumFilter: boolean;  // MUST BE FALSE - reduces fills
  
  // =========================================================================
  // 🎯 ASSETS
  // =========================================================================
  enabledAssets: string[];      // Which assets to trade ['BTC', 'ETH']
  
  // =========================================================================
  // 🔌 API CONFIGURATION
  // =========================================================================
  clobUrl: string;
  chainId: number;
  
  // =========================================================================
  // 🧪 TESTING
  // =========================================================================
  dryRun: boolean;               // True = no real orders (simulation)
  
  // =========================================================================
  // 📁 LOGGING
  // =========================================================================
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// =========================================================================
// PRESET CONFIGURATIONS - BASED ON GABAGOOL STRATEGY DOCUMENT
// =========================================================================

/**
 * TEST MODE - Minimum Viable Test
 * Use for initial validation with $150 capital
 * Run 50 markets before scaling up
 */
export const TEST_CONFIG: V35Config = {
  mode: 'test',
  
  // Grid: 41 levels per side (2¢ step)
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,
  sharesPerLevel: 5,
  
  // HEDGE PARAMETERS - V35.1.0 THE KEY CHANGE
  enableActiveHedge: true,          // 🔥 THIS IS THE FIX
  maxHedgeSlippage: 0.03,           // Accept up to 3¢ slippage for hedge
  hedgeTimeoutMs: 2000,             // 2 second timeout
  minEdgeAfterHedge: 0.005,         // Minimum 0.5% edge after hedge
  maxExpensiveBias: 1.20,           // Expensive side can have 20% more shares
  
  // Risk limits - V35.2.0 BURST-SAFE
  // HARD REQUIREMENT (per user): max 20 unpaired shares
  // Burst-cap in quoting engine ensures this can NEVER be exceeded
  warnUnpairedShares: 10,           // Start blocking leading side at 10
  maxUnpairedShares: 20,            // HARD LIMIT: emergency stop at 20
  maxUnpairedImbalance: 20,         // Alias for maxUnpairedShares
  maxImbalanceRatio: 2.5,
  maxLossPerMarket: 25,
  maxConcurrentMarkets: 2,
  maxMarkets: 2,
  maxNotionalPerMarket: 150,
  maxTotalExposure: 300,
  skewThreshold: 10,                // Lower threshold for logging
  capitalPerMarket: 100,
  
  // Timing
  startDelayMs: 5000,
  stopBeforeExpirySec: 30,
  refreshIntervalMs: 500,
  
  // Features
  enableMomentumFilter: false,
  
  enabledAssets: ['BTC'],
  
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

/**
 * MODERATE MODE - After successful test phase
 * Use after 50+ profitable markets in test mode
 */
export const MODERATE_CONFIG: V35Config = {
  mode: 'moderate',
  
  // Grid: 41 levels per side
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,
  sharesPerLevel: 5,
  
  // HEDGE PARAMETERS
  enableActiveHedge: true,
  maxHedgeSlippage: 0.03,
  hedgeTimeoutMs: 2000,
  minEdgeAfterHedge: 0.005,
  maxExpensiveBias: 1.20,
  
  // Risk limits - V35.2.0 BURST-SAFE
  warnUnpairedShares: 10,
  maxUnpairedShares: 20,
  maxUnpairedImbalance: 20,
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 25,
  maxConcurrentMarkets: 5,
  maxMarkets: 5,
  maxNotionalPerMarket: 200,
  maxTotalExposure: 1000,
  skewThreshold: 10,
  capitalPerMarket: 100,
  
  // Timing
  startDelayMs: 3000,
  stopBeforeExpirySec: 30,
  refreshIntervalMs: 500,
  
  // Features
  enableMomentumFilter: false,
  
  enabledAssets: ['BTC', 'ETH'],
  
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

/**
 * PRODUCTION MODE - Full Gabagool replication
 * Use after consistent profitability in moderate mode
 */
export const PRODUCTION_CONFIG: V35Config = {
  mode: 'production',
  
  // Grid: 46 levels per side (5-95¢)
  gridMin: 0.05,
  gridMax: 0.95,
  gridStep: 0.02,
  sharesPerLevel: 10,
  
  // HEDGE PARAMETERS
  enableActiveHedge: true,
  maxHedgeSlippage: 0.03,
  hedgeTimeoutMs: 2000,
  minEdgeAfterHedge: 0.005,
  maxExpensiveBias: 1.20,
  
  // Risk limits - V35.2.0 BURST-SAFE
  warnUnpairedShares: 10,
  maxUnpairedShares: 20,
  maxUnpairedImbalance: 20,
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 50,
  maxConcurrentMarkets: 10,
  maxMarkets: 10,
  maxNotionalPerMarket: 1000,
  maxTotalExposure: 10000,
  skewThreshold: 10,
  capitalPerMarket: 500,
  
  // Timing
  startDelayMs: 2000,
  stopBeforeExpirySec: 15,
  refreshIntervalMs: 500,
  
  // Features
  enableMomentumFilter: false,
  
  enabledAssets: ['BTC', 'ETH'],
  
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

// Backwards compatibility alias
export const SAFE_CONFIG = TEST_CONFIG;

// Runtime config (can be overridden from database or environment)
let runtimeConfig: V35Config = { ...TEST_CONFIG };

export function getV35Config(): V35Config {
  return runtimeConfig;
}

export function loadV35Config(mode: V35Mode): V35Config {
  switch (mode) {
    case 'test':
      runtimeConfig = { ...TEST_CONFIG };
      break;
    case 'moderate':
      runtimeConfig = { ...MODERATE_CONFIG };
      break;
    case 'production':
      runtimeConfig = { ...PRODUCTION_CONFIG };
      break;
  }
  return runtimeConfig;
}

export function setV35ConfigOverrides(overrides: Partial<V35Config>): V35Config {
  runtimeConfig = { ...runtimeConfig, ...overrides };
  return runtimeConfig;
}

export function printV35Config(cfg: V35Config): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  V35 GABAGOOL STRATEGY — ${cfg.mode.toUpperCase()} MODE (V35.2.0 Burst-Safe)`);
  console.log('='.repeat(70));
  console.log(`
  📊 GRID (passive limit orders)
     Range:           $${cfg.gridMin.toFixed(2)} - $${cfg.gridMax.toFixed(2)}
     Step:            $${cfg.gridStep.toFixed(2)}
     Levels per side: ${Math.floor((cfg.gridMax - cfg.gridMin) / cfg.gridStep) + 1}
     Shares/level:    ${cfg.sharesPerLevel}

  🎯 ACTIVE HEDGING (V35.1.0 - THE FIX)
     Enabled:         ${cfg.enableActiveHedge ? '✅ YES' : '❌ NO'}
     Max slippage:    ${(cfg.maxHedgeSlippage * 100).toFixed(1)}¢
     Min edge:        ${(cfg.minEdgeAfterHedge * 100).toFixed(1)}%
     Expensive bias:  ${cfg.maxExpensiveBias}x

  🛡️ RISK LIMITS
     Warn unpaired:   ${cfg.warnUnpairedShares} shares
     Max unpaired:    ${cfg.maxUnpairedShares} shares (hard stop)
     Max ratio:       ${cfg.maxImbalanceRatio}:1
     Max loss/market: $${cfg.maxLossPerMarket}
     Max markets:     ${cfg.maxConcurrentMarkets}
     
  ⏱️ TIMING
     Start delay:     ${cfg.startDelayMs}ms after open
     Stop before exp: ${cfg.stopBeforeExpirySec}s
     Refresh:         ${cfg.refreshIntervalMs}ms
     
  🎯 ASSETS
     Trading:         ${cfg.enabledAssets.join(', ')}
     
  🧪 MODE
     Dry run:         ${cfg.dryRun}
`);
  console.log('='.repeat(70));
}
