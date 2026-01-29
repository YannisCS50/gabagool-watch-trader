// ============================================================
// V35 CONFIGURATION - GABAGOOL STRATEGY
// ============================================================
// Version: V35.4.4 - "Smart Cheap-Side Skip"
//
// V35.4.4: Only buy the CHEAP side if the EXPENSIVE side already
// leads in inventory. This prevents accumulating shares on the
// likely-losing side without a hedge lead.
//
// V35.4.0: Circuit breaker is MARKET-SPECIFIC - bot SKIPS to
// next market instead of halting. NO manual intervention required.
//
// STRATEGY: Place limit BUY orders on a grid for both UP and DOWN sides.
// When retail traders hit our orders, we accumulate both sides.
// At settlement: one side pays $1.00, other pays $0.00.
// If combined cost < $1.00 -> GUARANTEED profit.
// ============================================================

export const V35_VERSION = 'V35.5.0';
export const V35_CODENAME = 'Emergency Recovery';

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
  // 🎯 HEDGE PARAMETERS (V35.1.0+)
  // =========================================================================
  enableActiveHedge: boolean;       // TRUE = gabagool style active hedging
  maxHedgeSlippage: number;         // Max extra we'll pay for hedge (e.g., 0.03)
  hedgeTimeoutMs: number;           // Timeout for hedge order
  minEdgeAfterHedge: number;        // Minimum edge after hedge (e.g., 0.005 = 0.5%)
  maxExpensiveBias: number;         // Max ratio expensive:cheap (e.g., 1.2 = 20% more)
  minHedgeNotional: number;         // V35.3.0: Min $ notional for hedge orders
  
  // =========================================================================
  // 🛡️ RISK LIMITS - V35.3.0 CIRCUIT BREAKER INTEGRATED
  // =========================================================================
  warnUnpairedShares: number;       // Warning threshold - block leading side
  criticalUnpairedShares: number;   // Critical - cancel all leading, prepare halt
  maxUnpairedShares: number;        // ABSOLUTE HARD STOP - trip circuit breaker
  maxUnpairedImbalance: number;     // Alias for maxUnpairedShares (compatibility)
  maxImbalanceRatio: number;        // Max ratio UP:DOWN or DOWN:UP
  maxLossPerMarket: number;         // Max $ loss per market before stopping
  maxConcurrentMarkets: number;     // Max markets to trade simultaneously
  maxMarkets: number;               // Alias for maxConcurrentMarkets
  maxNotionalPerMarket: number;     // Max $ notional per market
  maxTotalExposure: number;         // Max $ total exposure across all markets
  skewThreshold: number;            // Skew threshold for warning logs
  capitalPerMarket: number;         // $ allocated per market
  
  // =========================================================================
  // ⏱️ TIMING PARAMETERS
  // =========================================================================
  startDelayMs: number;             // Delay after market open before placing orders
  stopBeforeExpirySec: number;      // Stop quoting X seconds before expiry
  refreshIntervalMs: number;        // Milliseconds between order updates
  
  // =========================================================================
  // 🚫 FEATURES
  // =========================================================================
  enableMomentumFilter: boolean;    // MUST BE FALSE - reduces fills
  
  // =========================================================================
  // 🎯 ASSETS
  // =========================================================================
  enabledAssets: string[];          // Which assets to trade ['BTC', 'ETH']
  
  // =========================================================================
  // 🔌 API CONFIGURATION
  // =========================================================================
  clobUrl: string;
  chainId: number;
  
  // =========================================================================
  // 🧪 TESTING
  // =========================================================================
  dryRun: boolean;                  // True = no real orders (simulation)
  
  // =========================================================================
  // 📁 LOGGING
  // =========================================================================
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// =========================================================================
// PRESET CONFIGURATIONS - BASED ON GABAGOOL STRATEGY DOCUMENT
// =========================================================================

/**
 * TEST MODE - V35.3.0 Robust Hedging
 * Conservative limits with circuit breaker protection
 */
export const TEST_CONFIG: V35Config = {
  mode: 'test',
  
  // Grid: 46 levels per side (2¢ step, 5-95¢)
  gridMin: 0.05,
  gridMax: 0.95,
  gridStep: 0.02,
  sharesPerLevel: 5,
  
  // HEDGE PARAMETERS - V35.3.0 IMPROVED
  enableActiveHedge: true,
  maxHedgeSlippage: 0.03,           // Accept up to 3¢ slippage for hedge
  hedgeTimeoutMs: 2000,             // 2 second timeout
  minEdgeAfterHedge: 0.005,         // Minimum 0.5% edge after hedge
  maxExpensiveBias: 1.20,           // Expensive side can have 20% more shares
  minHedgeNotional: 1.50,           // V35.3.0 FIX: Min $1.50 notional for hedges
  
  // Risk limits - V35.4.5 TIGHTER CIRCUIT BREAKER
  // Three-tier safety system:
  // 1. WARNING (10) - block leading side
  // 2. CRITICAL (15) - cancel leading side, prepare halt
  // 3. ABSOLUTE (20) - trip circuit breaker, halt ALL trading
  warnUnpairedShares: 10,
  criticalUnpairedShares: 15,
  maxUnpairedShares: 20,            // ABSOLUTE HARD STOP - TIGHTER!
  maxUnpairedImbalance: 20,         // Alias
  maxImbalanceRatio: 2.0,           // Stricter ratio
  maxLossPerMarket: 25,
  maxConcurrentMarkets: 1,          // V35.3.0: Start with 1 market only
  maxMarkets: 1,
  maxNotionalPerMarket: 100,        // Lower for safety
  maxTotalExposure: 150,
  skewThreshold: 8,
  capitalPerMarket: 75,
  
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
 * MODERATE MODE - V35.3.0
 * Use after 50+ profitable markets in test mode
 */
export const MODERATE_CONFIG: V35Config = {
  mode: 'moderate',
  
  // Grid: 46 levels per side (5-95¢)
  gridMin: 0.05,
  gridMax: 0.95,
  gridStep: 0.02,
  sharesPerLevel: 5,
  
  // HEDGE PARAMETERS
  enableActiveHedge: true,
  maxHedgeSlippage: 0.03,
  hedgeTimeoutMs: 2000,
  minEdgeAfterHedge: 0.005,
  maxExpensiveBias: 1.20,
  minHedgeNotional: 1.50,
  
  // Risk limits - V35.3.0
  warnUnpairedShares: 15,
  criticalUnpairedShares: 30,
  maxUnpairedShares: 40,
  maxUnpairedImbalance: 40,
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 25,
  maxConcurrentMarkets: 3,
  maxMarkets: 3,
  maxNotionalPerMarket: 200,
  maxTotalExposure: 600,
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
 * PRODUCTION MODE - V35.3.0
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
  minHedgeNotional: 1.50,
  
  // Risk limits - V35.3.0 (scaled up for production)
  warnUnpairedShares: 20,
  criticalUnpairedShares: 40,
  maxUnpairedShares: 50,
  maxUnpairedImbalance: 50,
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 50,
  maxConcurrentMarkets: 5,
  maxMarkets: 5,
  maxNotionalPerMarket: 500,
  maxTotalExposure: 2500,
  skewThreshold: 10,
  capitalPerMarket: 250,
  
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
  console.log(`  V35 GABAGOOL — ${cfg.mode.toUpperCase()} MODE (${V35_VERSION} "${V35_CODENAME}")`);
  console.log('='.repeat(70));
  console.log(`
  📊 GRID (passive limit orders)
     Range:           $${cfg.gridMin.toFixed(2)} - $${cfg.gridMax.toFixed(2)}
     Step:            $${cfg.gridStep.toFixed(2)}
     Levels per side: ${Math.floor((cfg.gridMax - cfg.gridMin) / cfg.gridStep) + 1}
     Shares/level:    ${cfg.sharesPerLevel}

  🎯 ACTIVE HEDGING
     Enabled:         ${cfg.enableActiveHedge ? '✅ YES' : '❌ NO'}
     Max slippage:    ${(cfg.maxHedgeSlippage * 100).toFixed(1)}¢
     Min edge:        ${(cfg.minEdgeAfterHedge * 100).toFixed(1)}%
     Expensive bias:  ${cfg.maxExpensiveBias}x
     Min notional:    $${cfg.minHedgeNotional?.toFixed(2) || '1.00'}

  🛡️ CIRCUIT BREAKER (V35.3.0)
     ⚠️ WARNING:      ${cfg.warnUnpairedShares} shares (block leading side)
     🔴 CRITICAL:     ${cfg.criticalUnpairedShares || cfg.maxUnpairedShares - 10} shares (cancel + prepare halt)
     🚨 ABSOLUTE:     ${cfg.maxUnpairedShares} shares (TRIP CIRCUIT BREAKER)
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
