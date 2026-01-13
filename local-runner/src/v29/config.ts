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
  
  // Take Profit settings
  tp_enabled: boolean;
  tp_cents: number; // e.g., 4 = sell when price rises 4¢
  
  // Stop Loss settings
  sl_enabled: boolean;
  sl_cents: number; // e.g., 5 = sell when price drops 5¢
  
  // Timeout: auto-close position after X ms
  timeout_ms: number;
  
  // Polling intervals
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  
  // Minimum time between orders (prevent spam)
  order_cooldown_ms: number;
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
  tp_enabled: true,
  tp_cents: 4,
  sl_enabled: true,
  sl_cents: 3,
  timeout_ms: 30_000,
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
