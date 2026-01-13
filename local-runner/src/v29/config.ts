/**
 * V29 Simple Live Runner - Configuration
 * 
 * SIMPLE STRATEGY:
 * - Binance spike → buy 5 shares
 * - 4¢ profit → sell
 * - 10 sec timeout → market sell
 * - MAX 1 position at a time (no stacking)
 * - Delta rules: -75/+75
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
  
  // Shares per trade (fixed at 5)
  shares_per_trade: number;
  
  // Take profit in cents (e.g., 4¢)
  take_profit_cents: number;
  
  // Timeout in seconds before market sell
  timeout_seconds: number;
  
  // Max sell retry attempts before force market sell
  max_sell_retries: number;
  
  // Price buffer above best ask (to guarantee fill)
  price_buffer_cents: number;
  
  // Assets to trade
  assets: Asset[];
  
  // Polling intervals
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  
  // Minimum time between orders (prevent spam)
  order_cooldown_ms: number;
}

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  tick_delta_usd: 6,
  delta_threshold: 75,
  min_share_price: 0.30,
  max_share_price: 0.75,
  shares_per_trade: 5,
  take_profit_cents: 4,
  timeout_seconds: 10,
  max_sell_retries: 5,
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
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
