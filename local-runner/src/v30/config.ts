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
  // CRITICAL: Minimum fair value thresholds
  // Prevents buying sides with very low win probability
  min_fair_value_to_trade: 0.10,              // 10% minimum for high-confidence estimates
  min_fair_value_to_trade_low_confidence: 0.15, // 15% minimum for heuristic estimates
};

export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};

// Time bucket boundaries (in seconds remaining) - 8 buckets
export const TIME_BUCKETS = [900, 600, 420, 300, 180, 90, 45, 0] as const;

// Delta bucket size per asset (in USD) - ~15 buckets per direction
// Larger buckets = more samples per bucket = better empirical data
export const DELTA_BUCKET_SIZE: Record<string, number> = {
  BTC: 75,    // ~15 buckets in ±$500 range (was 25)
  ETH: 8,     // ~15 buckets in ±$60 range (was 3)
  SOL: 0.6,   // ~15 buckets in ±$5 range (was 0.25)
  XRP: 0.015, // ~15 buckets in ±$0.10 range (was 0.005)
};

// Default delta bucket size for unknown assets
export const DEFAULT_DELTA_BUCKET_SIZE = 50;

// Minimum samples for trusted fair value
export const MIN_FAIR_VALUE_SAMPLES = 5;

// EWMA alpha for fair value updates
export const FAIR_VALUE_ALPHA = 0.15;
