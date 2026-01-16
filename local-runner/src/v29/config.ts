/**
 * V29 Pair-Instead-of-Sell Strategy - Configuration
 * 
 * STRATEGY:
 * - Binance tick delta → buy shares (UP or DOWN)
 * - Track unpaired positions waiting for hedge opportunity
 * - When opposite side becomes cheap (combined < target), BUY opposite to lock profit
 * - Paired shares = guaranteed profit at settlement (no need to sell!)
 * 
 * ADVANTAGES OVER SELL:
 * - No slippage on exit (buying is easier than selling)
 * - No need to find buyers for your shares
 * - Profit is LOCKED once paired (both sides owned)
 * - Natural settlement - no active management needed
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface V29Config {
  // Enable/disable trading
  enabled: boolean;
  
  // Tick-to-tick delta (USD) - triggers trade when Binance price moves this much between ticks
  tick_delta_usd: number;
  
  // === SMART DIRECTION FILTER (V30-style fair value) ===
  // Uses P(UP wins) to decide if opposite-direction ticks should be blocked
  smart_direction_enabled: boolean;
  
  // Probability threshold to block opposite direction
  // If P(UP) >= 0.65, block DOWN ticks (and vice versa)
  smart_direction_threshold: number;
  
  // Minimum samples required before using smart direction
  // Falls back to delta_threshold if insufficient data
  smart_direction_min_samples: number;
  
  // LEGACY: Delta threshold for direction logic (fallback when smart not available)
  // delta = binance_price - strike_price
  // -75 to +75: trade both directions
  // < -75: only trade DOWN
  // > +75: only trade UP
  delta_threshold: number;
  
  // Share price range (only trade if share price is between these)
  min_share_price: number; // e.g., 0.30 = 30¢
  max_share_price: number; // e.g., 0.75 = 75¢
  
  // Shares per trade (per burst order)
  shares_per_trade: number;
  
  // === DELTA TRAP STRATEGY ===
  // When enabled, buy MORE shares in the direction of the delta
  // e.g., if price is $200 above strike → buy 2x UP shares, 0.5x DOWN shares
  delta_trap_enabled: boolean;
  
  // Minimum delta to start scaling (below this, buy 1x both directions)
  delta_trap_min_delta: number;  // e.g., 50 = start scaling at $50 delta
  
  // Maximum multiplier for favored direction
  delta_trap_max_multiplier: number;  // e.g., 2.5 = buy up to 2.5x shares in favored direction
  
  // Minimum multiplier for unfavored direction (can be 0 to skip entirely)
  delta_trap_min_multiplier: number;  // e.g., 0.3 = buy 0.3x shares in unfavored direction
  
  // Delta at which max scaling is reached
  delta_trap_full_scale_delta: number;  // e.g., 200 = at $200 delta, use max multipliers
  
  // === PAIRING CONFIG (replaces sell logic) ===
  
  // Maximum combined price to lock in profit
  // If UP @ 60¢ and DOWN @ 38¢ = 98¢ combined → 2¢ profit locked!
  max_combined_price: number;  // e.g., 0.98 = only pair if combined < 98¢
  
  // Minimum profit per share to consider pairing (in cents)
  // profit = 100 - combined_price
  min_pair_profit_cents: number;  // e.g., 2 = only pair if profit >= 2¢
  
  // Maximum age before force-pairing at any profit (seconds)
  // After this time, pair even at 0.5¢ profit to reduce exposure
  force_pair_after_sec: number;  // e.g., 120 = after 2 min, accept any profit
  
  // Minimum profit to accept during force-pair (in cents)
  // Won't pair at a loss even during force-pair
  min_force_pair_profit_cents: number;  // e.g., 0.5 = accept 0.5¢ profit during force-pair
  
  // Maximum exposure per asset (unpaired shares)
  max_exposure_per_asset: number;  // shares
  max_cost_per_asset: number;      // USD
  
  // Price buffer above best ask (to guarantee fill)
  price_buffer_cents: number;
  
  // Assets to trade
  assets: Asset[];
  
  // Polling intervals
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  
  // Minimum time between orders (prevent spam)
  order_cooldown_ms: number;
  
  // Pair check interval (how often to check for pairing opportunities)
  pair_check_ms: number;
}

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  tick_delta_usd: 6,              // Trigger on $6 moves
  
  // SMART DIRECTION: Use V30's fair value to filter ticks
  smart_direction_enabled: true,  // Use P(UP) to block unfavored ticks
  smart_direction_threshold: 0.65, // Block opposite if P(side) >= 65%
  smart_direction_min_samples: 10, // Minimum samples before trusting
  
  delta_threshold: 75,            // FALLBACK: < -75 = DOWN only, > +75 = UP only
  min_share_price: 0.08,          // WIDENED: Trade 8¢-92¢ range (was 15-85)
  max_share_price: 0.92,          // WIDENED: allows trading when price is far from strike
  shares_per_trade: 5,            // FIXED: Polymarket minimum is 5 shares!
  
  // DELTA TRAP: Buy more in direction of delta
  delta_trap_enabled: true,       // Enable proportional buying
  delta_trap_min_delta: 50,       // Start scaling at $50 delta
  delta_trap_max_multiplier: 2.0, // Favored direction: up to 2x shares
  delta_trap_min_multiplier: 0.5, // Unfavored direction: 0.5x shares (still buy some)
  delta_trap_full_scale_delta: 200, // Full scaling at $200 delta
  
  // PAIRING CONFIG - Lock in profits by buying opposite side
  max_combined_price: 0.98,       // Pair when combined < 98¢ (= 2¢ profit)
  min_pair_profit_cents: 2,       // Normal pairing: min 2¢ profit
  force_pair_after_sec: 120,      // After 2 min, accept lower profit
  min_force_pair_profit_cents: 0.5, // Force-pair: accept 0.5¢ profit
  
  max_exposure_per_asset: 200,
  max_cost_per_asset: 100,
  
  price_buffer_cents: 2,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_poll_ms: 100,
  orderbook_poll_ms: 1500,
  order_cooldown_ms: 1500,        // 1.5 second cooldown
  pair_check_ms: 150,             // Check pairing opportunities every 150ms
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
