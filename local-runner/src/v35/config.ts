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
  // 🛡️ RISK LIMITS
  // =========================================================================
  maxUnpairedShares: number;    // Max directional exposure (30 per doc)
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
  // 🚫 FEATURES - CRITICAL: KEEP DISABLED PER STRATEGY DOC
  // =========================================================================
  enableMomentumFilter: boolean;  // MUST BE FALSE - reduces fills, creates imbalance
  enableFillSync: boolean;        // MUST BE FALSE - prevents natural balancing
  
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
  
  // Grid - INCREASED DENSITY: 41 levels per side (was 17)
  // Analysis shows Gabagool uses 99 levels; we increase from 17 to 41 within same range
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,           // 2¢ step = 41 levels per side (was 0.05 = 17 levels)
  sharesPerLevel: 5,        // Polymarket minimum is 5 shares per order
  
  // Risk limits - INCREASED to allow ~75 shares per side
  maxUnpairedShares: 50,        // Increased from 30
  maxUnpairedImbalance: 50,     // Alias (used by runner)
  maxImbalanceRatio: 2.5,       // Slightly relaxed ratio
  maxLossPerMarket: 25,         // Increased loss tolerance
  maxConcurrentMarkets: 2,      // Per document
  maxMarkets: 2,                // Alias (used by runner)
  maxNotionalPerMarket: 150,    // Increased: 75 shares @ $0.50 avg = ~$75 total
  maxTotalExposure: 300,        // $300 total
  skewThreshold: 20,            // 20 shares before warning
  capitalPerMarket: 100,        // $100 per market
  
  // Timing - EXTENDED EXPOSURE: stay 90 seconds longer per market
  startDelayMs: 5000,       // Wait 5s after market open
  stopBeforeExpirySec: 30,  // Stop 30s before expiry (was 120s) = +90s exposure
  refreshIntervalMs: 2000,  // Reduced from 5000ms to 2000ms for faster order replacement
  
  // CRITICAL: DISABLED per strategy document
  // "RULE 1: Never enable momentum filtering"
  // "RULE 2: Always quote both sides simultaneously"
  enableMomentumFilter: false,
  enableFillSync: false,
  
  // Assets - start with BTC only for testing
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
  
  // Grid - INCREASED DENSITY: 41 levels per side
  gridMin: 0.10,
  gridMax: 0.90,
  gridStep: 0.02,           // 2¢ step = 41 levels per side
  sharesPerLevel: 5,        // More shares per level
  
  // Risk limits - relaxed after validation
  maxUnpairedShares: 50,
  maxUnpairedImbalance: 50,     // Alias (used by runner)
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 25,
  maxConcurrentMarkets: 5,
  maxMarkets: 5,                // Alias (used by runner)
  maxNotionalPerMarket: 200,    // $200 max per market
  maxTotalExposure: 1000,       // $1000 total
  skewThreshold: 15,            // 15 shares before warning
  capitalPerMarket: 100,
  
  // Timing - EXTENDED EXPOSURE
  startDelayMs: 3000,       // Faster entry
  stopBeforeExpirySec: 30,  // Stop 30s before expiry (was 90s)
  refreshIntervalMs: 3000,
  
  // CRITICAL: STILL DISABLED
  enableMomentumFilter: false,
  enableFillSync: false,
  
  // Add ETH after validation
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
  
  // Grid - MAXIMUM DENSITY: 2¢ step within 5-95¢ range = 46 levels
  gridMin: 0.05,
  gridMax: 0.95,
  gridStep: 0.02,           // 2¢ step = 46 levels per side
  sharesPerLevel: 10,       // Larger positions
  
  // Risk limits - production scale
  maxUnpairedShares: 100,
  maxUnpairedImbalance: 100,    // Alias (used by runner)
  maxImbalanceRatio: 2.0,
  maxLossPerMarket: 50,
  maxConcurrentMarkets: 10,
  maxMarkets: 10,               // Alias (used by runner)
  maxNotionalPerMarket: 1000,   // $1000 max per market
  maxTotalExposure: 10000,      // $10000 total
  skewThreshold: 25,            // 25 shares before warning
  capitalPerMarket: 500,
  
  // Timing - MAXIMUM EXPOSURE: stay until 15s before expiry
  startDelayMs: 2000,
  stopBeforeExpirySec: 15,  // Stop 15s before expiry (was 60s)
  refreshIntervalMs: 2000,
  
  // CRITICAL: STILL DISABLED - this is the secret sauce
  enableMomentumFilter: false,
  enableFillSync: false,
  
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
  console.log(`  V35 GABAGOOL STRATEGY — ${cfg.mode.toUpperCase()} MODE`);
  console.log('='.repeat(70));
  console.log(`
  📊 GRID (passive limit orders)
     Range:           $${cfg.gridMin.toFixed(2)} - $${cfg.gridMax.toFixed(2)}
     Step:            $${cfg.gridStep.toFixed(2)}
     Levels per side: ${Math.floor((cfg.gridMax - cfg.gridMin) / cfg.gridStep) + 1}
     Shares/level:    ${cfg.sharesPerLevel}

  🛡️ RISK LIMITS
     Max unpaired:    ${cfg.maxUnpairedShares} shares
     Max ratio:       ${cfg.maxImbalanceRatio}:1
     Max loss/market: $${cfg.maxLossPerMarket}
     Max markets:     ${cfg.maxConcurrentMarkets}
     Capital/market:  $${cfg.capitalPerMarket}
     
  ⏱️ TIMING
     Start delay:     ${cfg.startDelayMs}ms after open
     Stop before exp: ${cfg.stopBeforeExpirySec}s
     Refresh:         ${cfg.refreshIntervalMs}ms
     
  🚫 FEATURES (DISABLED per gabagool strategy)
     Momentum filter: ${cfg.enableMomentumFilter ? '⚠️ ON' : '✓ OFF'}
     Fill sync:       ${cfg.enableFillSync ? '⚠️ ON' : '✓ OFF'}
     
  🎯 ASSETS
     Trading:         ${cfg.enabledAssets.join(', ')}
     
  🧪 MODE
     Dry run:         ${cfg.dryRun}
`);
  console.log('='.repeat(70));
  console.log(`
  📈 EXPECTED PERFORMANCE (based on gabagool22 data):
     Combined cost:   ~$0.98 (target < $1.00)
     Win rate:        ~93% of markets profitable
     ROI per market:  ~1.9%
     
  ⚠️ CRITICAL RULES:
     1. NEVER enable momentum filter - reduces fills
     2. ALWAYS quote both sides - imbalance is temporary
     3. Trust the math - $1 settlement is guaranteed
`);
  console.log('='.repeat(70));
}
