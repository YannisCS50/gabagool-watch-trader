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
  maxUnpairedImbalance: number;   // Max directional exposure per market (STRICT!)
  maxImbalanceRatio: number;      // Max ratio UP:DOWN or DOWN:UP (e.g., 1.5)
  maxTotalExposure: number;       // Max $ across ALL markets
  maxMarkets: number;             // Max concurrent markets
  
  // =========================================================================
  // 🆕 MOMENTUM FILTER (Binance integration)
  // =========================================================================
  enableMomentumFilter: boolean;  // Enable/disable momentum-based quote filtering
  momentumThreshold: number;      // % move to consider market "trending" (e.g., 0.15)
  momentumLookbackSec: number;    // Lookback period in seconds
  
  // =========================================================================
  // 🆕 STOP LOSS
  // =========================================================================
  enableStopLoss: boolean;        // Enable stop loss protection
  maxLossPerMarket: number;       // Max unrealized loss per market before stopping
  maxLossTotal: number;           // Max total unrealized loss
  
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

// =========================================================================
// PRESET CONFIGURATIONS - UPDATED WITH STRICTER LIMITS
// =========================================================================

export const SAFE_CONFIG: V35Config = {
  mode: 'safe',
  // Grid - conservative range
  gridMin: 0.30,              // Was 0.25 - stay away from extremes
  gridMax: 0.70,              // Was 0.75
  gridStep: 0.02,
  baseSize: 5,                // Was 10 - smaller positions
  skewThreshold: 15,          // Was 30 - much more sensitive
  skewReduceFactor: 0.3,      // Was 0.5 - reduce more aggressively
  skewBoostFactor: 1.5,
  
  // Risk limits - MUCH STRICTER
  maxNotionalPerMarket: 150,  // Was 300
  maxUnpairedImbalance: 20,   // Was 75 - CRITICAL FIX
  maxImbalanceRatio: 1.3,     // NEW - max 1.3:1 ratio
  maxTotalExposure: 400,      // Was 1000
  maxMarkets: 1,              // Was 2 - start with 1
  
  // Momentum filter - ENABLED
  enableMomentumFilter: true,
  momentumThreshold: 0.10,    // 0.10% = trending (sensitive)
  momentumLookbackSec: 30,
  
  // Stop loss - ENABLED
  enableStopLoss: true,
  maxLossPerMarket: 30,       // Max $30 loss per market
  maxLossTotal: 100,          // Max $100 total loss
  
  // Timing
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 180,
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

export const MODERATE_CONFIG: V35Config = {
  mode: 'moderate',
  gridMin: 0.20,
  gridMax: 0.80,
  gridStep: 0.02,
  baseSize: 10,
  skewThreshold: 25,
  skewReduceFactor: 0.4,
  skewBoostFactor: 1.5,
  
  maxNotionalPerMarket: 500,
  maxUnpairedImbalance: 40,   // Was 150 - much stricter
  maxImbalanceRatio: 1.5,     // NEW
  maxTotalExposure: 1500,
  maxMarkets: 2,
  
  enableMomentumFilter: true,
  momentumThreshold: 0.15,
  momentumLookbackSec: 30,
  
  enableStopLoss: true,
  maxLossPerMarket: 50,
  maxLossTotal: 150,
  
  refreshIntervalMs: 5000,
  stopBeforeExpirySec: 120,
  clobUrl: 'https://clob.polymarket.com',
  chainId: 137,
  dryRun: false,
  logLevel: 'info',
};

export const PRODUCTION_CONFIG: V35Config = {
  mode: 'production',
  gridMin: 0.15,
  gridMax: 0.85,
  gridStep: 0.02,
  baseSize: 15,
  skewThreshold: 40,
  skewReduceFactor: 0.5,
  skewBoostFactor: 1.5,
  
  maxNotionalPerMarket: 2000,
  maxUnpairedImbalance: 75,   // Was 300 - much stricter
  maxImbalanceRatio: 1.5,     // NEW
  maxTotalExposure: 6000,
  maxMarkets: 3,
  
  enableMomentumFilter: true,
  momentumThreshold: 0.20,
  momentumLookbackSec: 30,
  
  enableStopLoss: true,
  maxLossPerMarket: 100,
  maxLossTotal: 300,
  
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
     
  🛡️ RISK LIMITS (STRICT)
     Max per market:       $${cfg.maxNotionalPerMarket.toLocaleString()}
     Max imbalance:        ${cfg.maxUnpairedImbalance} shares
     Max imbalance ratio:  ${cfg.maxImbalanceRatio}:1
     Max total exposure:   $${cfg.maxTotalExposure.toLocaleString()}
     Max markets:          ${cfg.maxMarkets}
     
  🆕 MOMENTUM FILTER
     Enabled:             ${cfg.enableMomentumFilter}
     Threshold:           ${cfg.momentumThreshold}%
     Lookback:            ${cfg.momentumLookbackSec}s
     
  🆕 STOP LOSS
     Enabled:             ${cfg.enableStopLoss}
     Max loss/market:     $${cfg.maxLossPerMarket}
     Max loss total:      $${cfg.maxLossTotal}
     
  ⏱️ TIMING
     Refresh:             ${cfg.refreshIntervalMs}ms
     Stop before exp:     ${cfg.stopBeforeExpirySec}s
     
  🧪 MODE
     Dry run:             ${cfg.dryRun}
`);
  console.log('='.repeat(70));
}
