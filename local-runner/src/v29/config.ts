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
  
  // Minimum delta (USD) to trigger a trade
  min_delta_usd: number;
  
  // Maximum share price to buy (e.g., 0.55 = 55¢)
  max_share_price: number;
  
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
  tp_cents: number; // e.g., 3 = sell when price rises 3¢
  
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
  min_delta_usd: 6,
  max_share_price: 0.55,
  trade_size_usd: 3,
  max_shares: 5,
  price_buffer_cents: 2,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  tp_enabled: true,
  tp_cents: 3,
  sl_enabled: true,
  sl_cents: 5,
  timeout_ms: 60_000, // 1 minute
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 5000,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
