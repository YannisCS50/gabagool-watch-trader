/**
 * V30 Configuration
 */

import type { Asset, V30Config } from './types.js';

export const DEFAULT_V30_CONFIG: V30Config = {
  enabled: false,
  assets: ['BTC'],  // Only BTC for now
  fair_value_model: 'empirical',
  base_theta: 0.05,              // 5% edge threshold (verhoogd van 3%)
  theta_time_decay_factor: 0.5,  // Threshold decreases 50% toward expiry
  theta_inventory_factor: 0.3,   // Threshold increases 30% at max inventory
  i_max_base: 500,               // Max 500 shares net exposure
  bet_size_base: 50,             // 50 shares per trade
  bet_size_vol_factor: 0.5,      // Reduce size in high vol
  force_counter_at_pct: 0.8,     // Force counter-bet at 80% of i_max
  aggressive_exit_sec: 60,       // Aggressive exit in last 60 seconds
  min_share_price: 0.05,         // Don't trade below 5¢
  max_share_price: 0.95,         // Don't trade above 95¢
  min_time_remaining_sec: 600,   // Don't start trading if <10 min left
};

export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

// Time bucket boundaries (in seconds remaining) - more granular near expiry
export const TIME_BUCKETS = [
  900, 750, 600, 480, 360, 300, 240, 180, 150, 120, 90, 60, 45, 30, 15, 0
] as const;

// Delta bucket size per asset (in USD) - smaller = more granular
export const DELTA_BUCKET_SIZE: Record<string, number> = {
  BTC: 25,    // Was 10, now 25 for ~40 buckets in typical ±$500 range
  ETH: 3,     // ~40 buckets in ±$60 range
  SOL: 0.25,  // ~40 buckets in ±$5 range
  XRP: 0.005, // ~40 buckets in ±$0.10 range
};

// Default delta bucket size for unknown assets
export const DEFAULT_DELTA_BUCKET_SIZE = 10;

// Minimum samples for trusted fair value (reduced for more granular buckets)
export const MIN_FAIR_VALUE_SAMPLES = 5;

// EWMA alpha for fair value updates (slightly higher for faster learning)
export const FAIR_VALUE_ALPHA = 0.15;
