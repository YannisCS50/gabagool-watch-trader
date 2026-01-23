// ============================================================
// V35 CONFIGURATION
// ============================================================
// Passive Dual-Outcome Market Maker for Polymarket 15-min options
// 
// STRATEGY: Place limit BUY orders on a grid for both UP and DOWN sides.
// When retail traders hit our orders, we accumulate both sides.
// At settlement: one side pays $1.00, other pays $0.00.
// If combined cost < $1.00 -> GUARANTEED profit.
// ============================================================

export type V35Mode = 'safe' | 'moderate' | 'production';

export interface V35Config {
  // =========================================================================
  // 🎚️ MODE SELECTOR
  // =========================================================================
  mode: V35Mode;
  
  // =========================================================================
  // 🎯 GRID PARAMETERS
  // =========================================================================
  gridMin: number;          // Lowest bid price (e.g., 0.25)
  gridMax: number;          // Highest bid price (e.g., 0.75)
  gridStep: number;         // Step between price levels (e.g., 0.02)
  
  // =========================================================================
  // 📊 SIZING PARAMETERS
  // =========================================================================
  baseSize: number;         // Shares per price level
  skewThreshold: number;    // When skew adjustment starts
  skewReduceFactor: number; // Reduce size when overweight (e.g., 0.5 = halve)
  skewBoostFactor: number;  // Boost size when underweight (e.g., 1.5 = 50% more)
  
  // =========================================================================
  // 🛡️ RISK LIMITS (CRITICAL!)
  // =========================================================================
  maxNotionalPerMarket: number;   // Max $ per market (both sides combined)
  maxUnpairedImbalance: number;   // Max directional exposure per market
  maxTotalExposure: number;       // Max $ across ALL markets
  maxMarkets: number;             // Max concurrent markets
  
  // =========================================================================
  // ⏱️ TIMING PARAMETERS
  // =========================================================================
  refreshIntervalMs: number;      // Milliseconds between order updates
  stopBeforeExpirySec: number;    // Stop quoting X seconds before expiry
  
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
// PRESET CONFIGURATIONS
// =========================================================================

export const SAFE_CONFIG: V35Config = {
  mode: 'safe',
  gridMin: 0.25,
  gridMax: 0.75,
  gridStep: 0.02,
  baseSize: 10,
  skewThreshold: 30,
  skewReduceFactor: 0.5,
  skewBoostFactor: 1.5,
  maxNotionalPerMarket: 300,
  maxUnpairedImbalance: 75,
  maxTotalExposure: 1000,
  maxMarkets: 2,
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 180,
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

export const MODERATE_CONFIG: V35Config = {
  mode: 'moderate',
  gridMin: 0.15,
  gridMax: 0.85,
  gridStep: 0.02,
  baseSize: 15,
  skewThreshold: 50,
  skewReduceFactor: 0.5,
  skewBoostFactor: 1.5,
  maxNotionalPerMarket: 1000,
  maxUnpairedImbalance: 150,
  maxTotalExposure: 3000,
  maxMarkets: 3,
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 120,
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

export const PRODUCTION_CONFIG: V35Config = {
  mode: 'production',
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,
  baseSize: 20,
  skewThreshold: 75,
  skewReduceFactor: 0.5,
  skewBoostFactor: 1.5,
  maxNotionalPerMarket: 5000,
  maxUnpairedImbalance: 300,
  maxTotalExposure: 15000,
  maxMarkets: 4,
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 120,
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

// Runtime config (can be overridden from database or environment)
let runtimeConfig: V35Config = { ...SAFE_CONFIG };

export function getV35Config(): V35Config {
  return runtimeConfig;
}

export function loadV35Config(mode: V35Mode): V35Config {
  switch (mode) {
    case 'safe':
      runtimeConfig = { ...SAFE_CONFIG };
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
  console.log(`  V35 CONFIGURATION — ${cfg.mode.toUpperCase()} MODE`);
  console.log('='.repeat(70));
  console.log(`
  📊 GRID
     Range:     $${cfg.gridMin.toFixed(2)} - $${cfg.gridMax.toFixed(2)}
     Step:      $${cfg.gridStep.toFixed(2)}
     Levels:    ${Math.floor((cfg.gridMax - cfg.gridMin) / cfg.gridStep) + 1} per side

  📈 SIZING  
     Base size: ${cfg.baseSize} shares/level
     Skew threshold: ${cfg.skewThreshold} shares
     
  🛡️ RISK LIMITS
     Max per market:    $${cfg.maxNotionalPerMarket.toLocaleString()}
     Max imbalance:     $${cfg.maxUnpairedImbalance.toLocaleString()}
     Max total:         $${cfg.maxTotalExposure.toLocaleString()}
     Max markets:       ${cfg.maxMarkets}
     
  ⏱️ TIMING
     Refresh:           ${cfg.refreshIntervalMs}ms
     Stop before exp:   ${cfg.stopBeforeExpirySec}s
     
  🧪 MODE
     Dry run:           ${cfg.dryRun}
`);
  console.log('='.repeat(70));
}
