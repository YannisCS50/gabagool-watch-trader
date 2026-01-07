/**
 * v8 Strategy Configuration
 * 
 * State Mispricing Strategy - trades on empirically calibrated fair price surface
 * Completely independent from v7.x logic
 */

export const V8 = {
  // Feature flag to enable v8 strategy
  enabled: process.env.FEATURE_STRATEGY === 'v8',
  
  // Assets to trade
  enabledAssets: ['BTC', 'ETH'] as const,
  
  // Bucketing configuration
  buckets: {
    BTC: { deltaWidthUsd: 10 },      // $10 buckets for BTC
    ETH: { deltaWidthUsd: 0.05 },    // $0.05 buckets for ETH  
    SOL: { deltaWidthUsd: 0.01 },    // $0.01 buckets for SOL (future)
    XRP: { deltaWidthUsd: 0.001 },   // $0.001 buckets for XRP (future)
    timeBucketsSec: [0, 120, 240, 360, 480, 600, 720, 900] as const, // 2-min boundaries
    maxDeltaBucket: 5000,            // Clamp absDeltaUsd
  },
  
  // Fair price surface configuration
  surface: {
    ewmaAlpha: 0.15,                   // EWMA recency weight
    minSamplesToTrade: 10,             // Reduced from 50 for faster startup testing
    maxFairUpAgeMs: 10 * 60 * 1000,    // 10 minutes max age
  },
  
  // Entry configuration
  entry: {
    minSecRemaining: 240,              // 4 minutes minimum
    maxSecRemaining: 870,              // 14.5 minutes maximum
    edgeEntryMin: 0.08,                // 8 cents "cheapness" required
    maxSpread: 0.06,                   // Max 6 cent spread
    minDepth: 50,                      // Min 50 shares at top of book
    baseShares: 10,                    // Default entry size
    maxShares: 25,                     // Max entry size
    maxNotionalUsdPerMarket: 50,       // $50 max per market
    maxConcurrentMarketsPerAsset: 4,   // Max 4 concurrent markets per asset
  },
  
  // Correction detection configuration
  correction: {
    edgeCorrectedMax: 0.03,            // Edge shrunk to < 3 cents
    profitTriggerUsd: 0.50,            // $0.50 unrealized profit
    minSecondsAfterEntryFill: 8,       // Wait 8 seconds after entry fill
  },
  
  // Hedge configuration  
  hedge: {
    deadlineSecRemaining: 90,          // 90 seconds deadline
    maxOppAsk: 0.80,                   // Max 80 cents for hedge side
    maxCppApprox: 1.00,                // Max combined cost (entry + hedge ask)
    hedgeMinShares: 5,                 // Minimum hedge size
    hedgeMaxShares: 25,                // Maximum hedge size
    hedgeRatio: 1.0,                   // 1:1 hedge ratio
  },
  
  // Execution configuration
  execution: {
    tick: 0.01,                        // 1 cent tick size
    maxBookAgeMs: 500,                 // 500ms max book staleness
    allowEmergencyExit: false,         // Emergency exit disabled by default
    emergencyExitSecRemaining: 45,     // 45 seconds for emergency
    emergencyCrossTicks: 2,            // Allow 2 tick crossing in emergency
    emergencyRateLimitMs: 30_000,      // 30 second rate limit for emergency
  },
  
  // Logging configuration
  logging: {
    logAllEvals: false,                // Log every eval (very verbose)
    logSkipsWithReasons: true,         // Log skipped evals with reasons
    logOrders: true,                   // Log all order attempts
    logFills: true,                    // Log all fills
    logCorrections: true,              // Log correction events
    logSurfaceUpdates: false,          // Log surface EWMA updates
  },
  
  // Kill switch thresholds
  killSwitch: {
    maxStaleBookSkipPct: 15,           // Disable entries if >15% stale book skips
    minMakerFillRatio: 0.50,           // Disable entries if <50% maker fills
    makerRatioRollingWindow: 50,       // Rolling window for maker ratio
    requireFeeUsd: true,               // Disable entries if feeUsd missing on fills
  },
} as const;

export type V8Config = typeof V8;
export type V8Asset = (typeof V8.enabledAssets)[number];

/**
 * Get bucket configuration for an asset
 */
export function getAssetBucketConfig(asset: string): { deltaWidthUsd: number } {
  const buckets = V8.buckets as Record<string, { deltaWidthUsd: number }>;
  return buckets[asset] ?? buckets['BTC'];
}
