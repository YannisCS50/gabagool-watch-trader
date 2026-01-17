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
  
  // Hard time stop (seconds) - LAST RESORT only
  max_hold_seconds: number;  // UP: 6s, DOWN: 7s
  
  // Repricing exhaustion: what % of expected repricing before exit
  repricing_exhaustion_pct: number;  // e.g., 0.65 = 65%
  
  // Price stall threshold (cents per second) - below this = exhaustion
  stall_threshold_cents_per_sec: number;  // e.g., 0.1
  
  // Expected repricing after signal (cents) - used for exhaustion calc
  expected_repricing_cents: number;  // e.g., 3.0
}

export interface V29Config {
  // Enable/disable trading
  enabled: boolean;
  
  // ============================================
  // SIGNAL DEFINITION
  // ============================================
  
  // Minimum Binance price move (USD) within rolling window to trigger
  signal_delta_usd: number;  // e.g., 6.0
  
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
  signal_window_ms: 300,
  max_share_move_cents: 0.5,
  max_spread_cents: 1.0,
  min_share_price: 0.15,
  max_share_price: 0.85,
  shares_per_trade: 5,
  
  // ENTRY
  entry_price_buffer_cents: 0.5,
  max_entry_slippage_cents: 1.0,
  
  // EXIT MONITORING
  exit_monitor_interval_ms: 100,
  
  // UP-SPECIFIC: Faster repricing, shorter hold
  up: {
    target_profit_cents_min: 1.8,
    target_profit_cents_max: 2.0,
    max_hold_seconds: 6,
    repricing_exhaustion_pct: 0.65,
    stall_threshold_cents_per_sec: 0.1,
    expected_repricing_cents: 3.0,
  },
  
  // DOWN-SPECIFIC: Slower repricing, longer hold, higher target
  down: {
    target_profit_cents_min: 2.0,
    target_profit_cents_max: 2.4,
    max_hold_seconds: 7,
    repricing_exhaustion_pct: 0.70,
    stall_threshold_cents_per_sec: 0.1,
    expected_repricing_cents: 3.5,
  },
  
  // ADVERSE SELECTION
  adverse_spread_threshold_cents: 1.5,
  taker_flow_window_ms: 300,
  
  // RISK CONTROLS
  max_positions_per_asset: 5,  // Allow 5 concurrent positions per asset
  // No cooldown needed with multiple concurrent positions // Reduced cooldown since each position exits independently
  max_exposure_usd: 50,
  
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  
  // INTERVALS
  binance_buffer_ms: 0,  // 0 = instant emit (no buffering)
  orderbook_poll_ms: 250,  // Fast orderbook polling for exit monitoring
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
