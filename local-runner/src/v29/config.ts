/**
 * V29 Buy-and-Sell Strategy - Configuration
 * 
 * STRATEGY:
 * - Binance tick delta → buy shares
 * - Wait for fill confirmation with SETTLED price
 * - Sell as soon as profit >= 2¢ (based on settled entry price)
 * - NEVER sell at loss unless position age > 60 seconds
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface V29Config {
  // Enable/disable trading
  enabled: boolean;
  
  // Tick-to-tick delta (USD) - triggers trade when Binance price moves this much between ticks
  tick_delta_usd: number;
  
  // Delta threshold for direction logic
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
  
  // === SELL CONFIG ===
  
  // Minimum profit before selling (in cents) - based on SETTLED entry price!
  min_profit_cents: number;  // e.g., 2 = only sell if bestBid >= entryPrice - 2¢
  
  // Maximum hold time before allowing loss sell (seconds)
  max_hold_before_loss_sell_sec: number;  // e.g., 60 = after 60s, allow selling at loss
  
  // Stop loss threshold after timeout (cents) - max loss we'll accept after timeout
  stop_loss_cents: number;  // e.g., 10 = after 60s, sell if bid >= entry - 10¢
  
  // Maximum exposure per asset
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
  
  // Sell check interval (how often to check for sell opportunities)
  sell_check_ms: number;
}

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  tick_delta_usd: 8,
  delta_threshold: 75,
  min_share_price: 0.30,
  max_share_price: 0.75,
  shares_per_trade: 5,
  
  // Sell config - QUICK: max 15s hold, sell all shares at once
  min_profit_cents: 2,           // Sell when bestBid >= entryPrice - 2¢ 
  max_hold_before_loss_sell_sec: 15,  // After 15s, force sell (was 60s)
  stop_loss_cents: 10,           // After timeout, max 10¢ loss accepted
  
  max_exposure_per_asset: 100,
  max_cost_per_asset: 50,
  
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
  sell_check_ms: 200,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
