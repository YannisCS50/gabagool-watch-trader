// ============================================================
// V27 CONFIGURATION
// ============================================================

export interface V27AssetConfig {
  // Dynamic delta threshold range (learned from data)
  deltaThresholdMin: number;
  deltaThresholdMax: number;
  // Current active threshold (updated by learning)
  deltaThreshold: number;
  
  // Entry sizing
  probeShares: number;
  maxProbeNotional: number;
  
  // Emergency hedge
  maxSpreadEmergency: number;
  
  // Spread thresholds
  normalSpreadThreshold: number;
  
  // Taker flow percentiles (calibrated)
  takerFillP90: number;
  takerVolumeP85: number;
}

export interface V27Config {
  // Global settings
  enabled: boolean;
  shadowMode: boolean; // Log only, no actual trades
  assets: string[];
  
  // Per-asset configuration
  assetConfigs: Record<string, V27AssetConfig>;
  
  // Timing
  causalityMinMs: number;  // Spot must lead by at least this (default 200ms)
  causalityMaxMs: number;  // But not more than this (default 3000ms)
  aggressiveFlowWindowSec: number; // 8 seconds
  takerVolumeWindowSec: number;    // 5 seconds
  spreadHistoryWindowSec: number;  // 60 seconds
  
  // Correction detection
  correctionThresholdPct: number; // % move toward expected value
  
  // Emergency window
  emergencyWindowSec: number; // 90 seconds before expiry
  
  // Order settings
  tickSize: number; // Usually 0.01
  
  // Logging
  logEveryEvaluation: boolean;
}

// Default configuration
export const V27_DEFAULT_CONFIG: V27Config = {
  enabled: true,
  shadowMode: true, // Start in shadow mode!
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  
  assetConfigs: {
    BTC: {
      deltaThresholdMin: 45,
      deltaThresholdMax: 70,
      deltaThreshold: 55, // Starting point
      probeShares: 5,
      maxProbeNotional: 5,
      maxSpreadEmergency: 0.08,
      normalSpreadThreshold: 0.04,
      takerFillP90: 50,    // Shares - will be calibrated
      takerVolumeP85: 100, // Shares - will be calibrated
    },
    ETH: {
      deltaThresholdMin: 0.18,
      deltaThresholdMax: 0.30,
      deltaThreshold: 0.22,
      probeShares: 5,
      maxProbeNotional: 5,
      maxSpreadEmergency: 0.08,
      normalSpreadThreshold: 0.04,
      takerFillP90: 50,
      takerVolumeP85: 100,
    },
    SOL: {
      deltaThresholdMin: 0.08,
      deltaThresholdMax: 0.15,
      deltaThreshold: 0.10,
      probeShares: 5,
      maxProbeNotional: 5,
      maxSpreadEmergency: 0.08,
      normalSpreadThreshold: 0.04,
      takerFillP90: 50,
      takerVolumeP85: 100,
    },
    XRP: {
      deltaThresholdMin: 0.003,
      deltaThresholdMax: 0.008,
      deltaThreshold: 0.005,
      probeShares: 5,
      maxProbeNotional: 5,
      maxSpreadEmergency: 0.08,
      normalSpreadThreshold: 0.04,
      takerFillP90: 50,
      takerVolumeP85: 100,
    },
  },
  
  causalityMinMs: 200,
  causalityMaxMs: 3000,
  aggressiveFlowWindowSec: 8,
  takerVolumeWindowSec: 5,
  spreadHistoryWindowSec: 60,
  
  correctionThresholdPct: 0.03, // 3% move toward expected
  
  emergencyWindowSec: 90,
  
  tickSize: 0.01,
  
  logEveryEvaluation: true,
};

// Runtime config (can be overridden from database)
let runtimeConfig: V27Config = { ...V27_DEFAULT_CONFIG };

export function getV27Config(): V27Config {
  return runtimeConfig;
}

export function loadV27Config(overrides?: Partial<V27Config>): V27Config {
  if (overrides) {
    runtimeConfig = {
      ...V27_DEFAULT_CONFIG,
      ...overrides,
      assetConfigs: {
        ...V27_DEFAULT_CONFIG.assetConfigs,
        ...overrides.assetConfigs,
      },
    };
  }
  return runtimeConfig;
}

export function getAssetConfig(asset: string): V27AssetConfig | undefined {
  return runtimeConfig.assetConfigs[asset];
}

export function updateAssetThreshold(asset: string, newThreshold: number): void {
  const config = runtimeConfig.assetConfigs[asset];
  if (config) {
    config.deltaThreshold = Math.max(
      config.deltaThresholdMin,
      Math.min(config.deltaThresholdMax, newThreshold)
    );
  }
}
