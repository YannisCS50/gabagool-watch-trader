/**
 * V29 Response-Based Strategy - Configuration
 * 
 * KEY PRINCIPLE:
 * Exit based on POLYMARKET PRICE RESPONSE, not fixed time.
 * This is a latency-reaction strategy exploiting Binance → Polymarket repricing delay.
 * 
 * ASYMMETRY:
 * UP and DOWN tokens reprice differently. UP is faster, DOWN is slower.
 * All parameters are configurable per direction.
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type Direction = 'UP' | 'DOWN';

// ============================================
// DIRECTION-SPECIFIC PARAMETERS
// ============================================

export interface DirectionConfig {
  // Target profit to take (in cents)
  // Exit when unrealized profit reaches this level
  target_profit_cents_min: number;  // e.g., 1.8
  target_profit_cents_max: number;  // e.g., 2.0
  
  // TRAILING PROFIT: Lock in profits as price rises
  // Start with low target, raise target as profit grows
  trailing_enabled: boolean;         // Enable trailing profit
  trailing_start_cents: number;      // Start trailing after this profit (e.g., 1.5¢)
  trailing_step_cents: number;       // Raise target by this per step (e.g., 1.0¢)
  trailing_pullback_cents: number;   // Exit if price pulls back this much from max (e.g., 0.8¢)
  
  // Hard time stop (seconds) - REDUCED from 60s+ to 15-20s based on analysis
  // Analysis: losers hold ~37s avg vs winners ~9s avg
  max_hold_seconds: number;  // UP: 15s, DOWN: 20s
  
  // Repricing exhaustion: what % of expected repricing before exit
  repricing_exhaustion_pct: number;  // e.g., 0.65 = 65%
  
  // Price stall threshold (cents per second) - below this = exhaustion
  stall_threshold_cents_per_sec: number;  // e.g., 0.1
  
  // Expected repricing after signal (cents) - used for exhaustion calc
  expected_repricing_cents: number;  // e.g., 3.0
  
  // STAGNATION EXIT: if price doesn't improve between checks, exit early
  // Analysis showed: losers have +2.6% move at 1s then +2.8% at 5s (stagnation)
  // Winners show: +4.7% at 1s then +5.6% at 5s (momentum continues)
  stagnation_threshold_cents: number;  // exit if price improvement < this after initial move
  stagnation_check_after_ms: number;   // start checking for stagnation after this time
}

export interface V29Config {
  // Enable/disable trading
  enabled: boolean;
  
  // ============================================
  // SIGNAL DEFINITION
  // ============================================
  
  // Minimum Binance price move (USD) within rolling window to trigger
  signal_delta_usd: number;  // e.g., 6.0
  
  // Maximum delta - skip if delta > this (analysis showed >$15 has negative avg P&L)
  signal_delta_max_usd: number;  // e.g., 15.0
  
  // DYNAMIC DELTA: Adjust min delta based on recent volatility
  // If volatility is high, require proportionally higher delta
  dynamic_delta_enabled: boolean;         // Enable dynamic delta adjustment
  dynamic_delta_volatility_window_ms: number;  // Window to measure volatility (e.g., 5000ms)
  dynamic_delta_base_volatility: number;  // "Normal" volatility level (e.g., 20 USD range per window)
  dynamic_delta_multiplier_cap: number;   // Max multiplier (e.g., 2.0 = max $12 delta in high vol)
  
  // Require higher delta for extreme share prices (near 0.35 or 0.65)
  // Analysis: volatile price zones need stronger signals
  extreme_price_threshold: number;       // e.g., 0.35/0.65 boundary
  extreme_price_delta_multiplier: number; // e.g., 1.5 → need $9 instead of $6
  
  // Rolling window for delta calculation (ms)
  signal_window_ms: number;  // e.g., 300
  
  // Max share price movement allowed before signal is invalid (cents)
  // If Polymarket already repriced more than this, skip
  max_share_move_cents: number;  // e.g., 0.5
  
  // Max spread allowed (cents) - if spread > this, skip
  max_spread_cents: number;  // e.g., 1.0
  
  // Share price range
  min_share_price: number;  // e.g., 0.15
  max_share_price: number;  // e.g., 0.85
  
  // Shares per trade
  shares_per_trade: number;  // e.g., 5
  
  // ============================================
  // ENTRY EXECUTION
  // ============================================
  
  // Price buffer above best bid for maker-biased order (cents)
  entry_price_buffer_cents: number;  // e.g., 0.5
  
  // Max slippage allowed on entry (cents)
  max_entry_slippage_cents: number;  // e.g., 1.0
  
  // ============================================
  // EXIT LOGIC (RESPONSE-BASED)
  // ============================================
  
  // Monitor interval for exit conditions (ms)
  exit_monitor_interval_ms: number;  // e.g., 100
  
  // Direction-specific config
  up: DirectionConfig;
  down: DirectionConfig;
  
  // ============================================
  // ADVERSE SELECTION DETECTION
  // ============================================
  
  // Spread widening threshold (cents) - exit if spread widens beyond this
  adverse_spread_threshold_cents: number;  // e.g., 1.5
  
  // Taker flow detection window (ms)
  taker_flow_window_ms: number;  // e.g., 300
  
  // ============================================
  // RISK CONTROLS
  // ============================================
  
  // Max concurrent positions per asset (each with independent exit)
  max_positions_per_asset: number;  // e.g., 5
  
  // Cooldown after exit (ms) - per position, not per asset
  cooldown_after_exit_ms: number;  // e.g., 2000
  
  // Max exposure per asset (USD)
  max_exposure_usd: number;
  
  // Assets to trade
  assets: Asset[];
  
  // ============================================
  // POLLING INTERVALS
  // ============================================
  
  binance_buffer_ms: number;  // How often to emit buffered Binance price
  orderbook_poll_ms: number;  // Fallback orderbook polling
}

// ============================================
// DEFAULT CONFIGURATION
// ============================================

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  
  // SIGNAL DEFINITION
  signal_delta_usd: 6.0,
  signal_delta_max_usd: 15.0,  // Skip delta >$15 (analysis: negative avg P&L)
  dynamic_delta_enabled: true,  // NEW: Enable dynamic delta adjustment
  dynamic_delta_volatility_window_ms: 5000,  // Measure volatility over 5s
  dynamic_delta_base_volatility: 20,  // "Normal" is $20 range per 5s
  dynamic_delta_multiplier_cap: 1.8,  // Max 1.8x = $10.80 delta in high vol
  extreme_price_threshold: 0.35,  // Price <0.35 or >0.65 = extreme zone
  extreme_price_delta_multiplier: 1.5,  // Need $9 delta in extreme zones
  signal_window_ms: 300,
  max_share_move_cents: 0.5,
  max_spread_cents: 1.0,
  min_share_price: 0.15,
  max_share_price: 0.85,
  shares_per_trade: 10,  // INCREASED from 5 for higher profit per bet
  
  // ENTRY
  entry_price_buffer_cents: 0.5,
  max_entry_slippage_cents: 1.0,
  
  // EXIT MONITORING
  exit_monitor_interval_ms: 100,
  
  // UP-SPECIFIC: Faster repricing, SHORTER hold (analysis: 15s max)
  up: {
    target_profit_cents_min: 1.8,
    target_profit_cents_max: 2.0,
    // TRAILING PROFIT: Let winners run longer
    trailing_enabled: true,
    trailing_start_cents: 1.5,      // Start trailing after 1.5¢ profit
    trailing_step_cents: 1.0,       // Raise target by 1¢ per step
    trailing_pullback_cents: 0.8,   // Exit if pulls back 0.8¢ from max
    max_hold_seconds: 15,
    repricing_exhaustion_pct: 0.65,
    stall_threshold_cents_per_sec: 0.1,
    expected_repricing_cents: 3.0,
    stagnation_threshold_cents: 0.5,
    stagnation_check_after_ms: 3000,
  },
  
  // DOWN-SPECIFIC: Slower repricing, SHORTER hold (analysis: 20s max)
  down: {
    target_profit_cents_min: 2.0,
    target_profit_cents_max: 2.4,
    // TRAILING PROFIT: Let winners run longer
    trailing_enabled: true,
    trailing_start_cents: 1.8,      // Start trailing after 1.8¢ profit
    trailing_step_cents: 1.2,       // Raise target by 1.2¢ per step (DOWN moves slower)
    trailing_pullback_cents: 0.7,   // Exit if pulls back 0.7¢ from max
    max_hold_seconds: 20,
    repricing_exhaustion_pct: 0.70,
    stall_threshold_cents_per_sec: 0.1,
    expected_repricing_cents: 3.5,
    stagnation_threshold_cents: 0.5,
    stagnation_check_after_ms: 4000,
  },
  
  // ADVERSE SELECTION
  adverse_spread_threshold_cents: 1.5,
  taker_flow_window_ms: 300,
  
  // RISK CONTROLS
  max_positions_per_asset: 5,
  cooldown_after_exit_ms: 0,
  max_exposure_usd: 50,
  
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  
  // INTERVALS
  binance_buffer_ms: 0,
  orderbook_poll_ms: 250,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
