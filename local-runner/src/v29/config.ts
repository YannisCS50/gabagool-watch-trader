/**
 * V29 Simple Live Runner - Configuration
 * 
 * Clean, simple trading logic:
 * - Tick-to-tick delta detection (like UI)
 * - Realtime orderbook pricing
 * - Direct GTC orders
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface V29Config {
  // Enable/disable trading
  enabled: boolean;
  
  // Tick-to-tick delta (USD) - triggers trade when Binance price moves this much between ticks
  tick_delta_usd: number;
  
  // Delta threshold for direction logic
  // delta = strike_price - binance_price
  // -70 to +70: trade both directions
  // < -70: only trade DOWN
  // > +70: only trade UP
  delta_threshold: number;
  
  // Share price range (only trade if share price is between these)
  min_share_price: number; // e.g., 0.30 = 30¢
  max_share_price: number; // e.g., 0.75 = 75¢
  
  // How much USD per trade
  trade_size_usd: number;
  
  // Maximum shares per order
  max_shares: number;
  
  // Price buffer above best ask (to guarantee fill)
  price_buffer_cents: number;
  
  // Assets to trade
  assets: Asset[];
  
  // === TRAILING STOP WITH MINIMUM PROFIT ===
  // Minimum profit per share (ALWAYS guaranteed, e.g., 4¢)
  min_profit_cents: number;
  
  // Trailing stop trigger: when unrealized profit reaches this, start trailing
  trailing_trigger_cents: number; // e.g., 7¢ - start trailing when profit >= 7¢
  
  // Trailing stop distance: once triggered, if price drops this much from peak, sell
  trailing_distance_cents: number; // e.g., 3¢ - if profit drops 3¢ from peak, sell
  
  // Emergency stop loss (only in extreme cases - this IS a loss)
  emergency_sl_cents: number; // e.g., 10¢ - absolute max loss before force-sell
  
  // Timeout: auto-close position after X ms (at min_profit if possible, else emergency)
  timeout_ms: number;
  
  // Polling intervals
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  
  // Minimum time between orders (prevent spam)
  order_cooldown_ms: number;
  
  // === ACCUMULATION & AUTO-HEDGE ===
  // Enable accumulation mode (buy shares over time instead of single trades)
  accumulation_enabled: boolean;
  
  // Maximum total cost per asset/side before stopping accumulation
  max_total_cost_usd: number;
  
  // Maximum total shares per asset/side
  max_total_shares: number;
  
  // Enable auto-hedging when profitable
  auto_hedge_enabled: boolean;
  
  // Trigger hedge when opposing share price is below this (cents)
  hedge_trigger_cents: number;
  
  // Only hedge when unrealized profit is at least this much (cents per share)
  hedge_min_profit_cents: number;
}

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  tick_delta_usd: 6,
  delta_threshold: 70,
  min_share_price: 0.30,
  max_share_price: 0.75,
  trade_size_usd: 5,
  max_shares: 10,
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  // Trailing stop with minimum profit
  min_profit_cents: 4,           // MINIMUM 4¢ profit guaranteed
  trailing_trigger_cents: 7,     // Start trailing when profit >= 7¢
  trailing_distance_cents: 3,    // Sell if profit drops 3¢ from peak
  emergency_sl_cents: 10,        // Emergency loss limit (should rarely trigger)
  timeout_ms: 30_000,
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
  // Accumulation & auto-hedge (relaxed, not aggressive)
  accumulation_enabled: true,
  max_total_cost_usd: 75,        // Max $75 per asset/side
  max_total_shares: 300,         // Max 300 shares per asset/side
  auto_hedge_enabled: true,
  hedge_trigger_cents: 15,       // Hedge when opposing ask < 15¢
  hedge_min_profit_cents: 10,    // Only hedge with >= 10¢ unrealized profit
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
