/**
 * V30 Configuration
 */

import type { Asset, V30Config } from './types.js';

export const DEFAULT_V30_CONFIG: V30Config = {
  enabled: false,
  assets: ['BTC'],  // Only BTC for now
  fair_value_model: 'empirical',
  base_theta: 0.03,              // 3% edge threshold
  theta_time_decay_factor: 0.5,  // Threshold decreases 50% toward expiry
  theta_inventory_factor: 0.3,   // Threshold increases 30% at max inventory
  i_max_base: 500,               // Max 500 shares net exposure
  bet_size_base: 50,             // 50 shares per trade
  bet_size_vol_factor: 0.5,      // Reduce size in high vol
  force_counter_at_pct: 0.8,     // Force counter-bet at 80% of i_max
  aggressive_exit_sec: 60,       // Aggressive exit in last 60 seconds
  min_share_price: 0.05,         // Don't trade below 5¢
  max_share_price: 0.95,         // Don't trade above 95¢
};

export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

// Time bucket boundaries (in seconds remaining)
export const TIME_BUCKETS = [900, 600, 300, 180, 120, 60, 30, 0] as const;

// Delta bucket size (in USD)
export const DELTA_BUCKET_SIZE = 10;

// Minimum samples for trusted fair value
export const MIN_FAIR_VALUE_SAMPLES = 10;

// EWMA alpha for fair value updates
export const FAIR_VALUE_ALPHA = 0.1;
