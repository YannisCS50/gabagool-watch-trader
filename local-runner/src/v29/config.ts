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
  
  // === COUNTER-SCALPING PREVENTION ===
  // If true: don't buy opposite direction when you already have a position in this market
  // e.g., if you have UP shares, don't buy DOWN shares (prevents self-hedging)
  prevent_counter_scalping: boolean;
  
  // === SELL CONFIG ===
  
  // Minimum profit before selling (in cents) - based on SETTLED entry price!
  min_profit_cents: number;  // e.g., 2 = only sell if bestBid >= entryPrice - 2¢
  
  // Aggregation threshold (seconds) - positions older than this get grouped
  aggregate_after_sec: number;  // e.g., 15 = after 15s, mark for aggregation
  
  // Force close threshold (seconds) - aggregated positions get market dumped
  force_close_after_sec: number;  // e.g., 20 = after 20s, force close at market
  
  // Stop loss threshold after timeout (cents) - max loss we'll accept after timeout
  stop_loss_cents: number;  // e.g., 10 = after force close, max 10¢ loss accepted
  
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
  tick_delta_usd: 6,              // Trigger on $6 moves
  delta_threshold: 75,            // Direction filter: < -75 = DOWN only, > +75 = UP only
  min_share_price: 0.15,          // Trade 15¢-85¢ range
  max_share_price: 0.85,
  shares_per_trade: 2,            // 2 shares, but ensure min $1 order in code
  prevent_counter_scalping: false,
  
  // Sell config - MONITOR AND FIRE
  min_profit_cents: 2,            // TP target: entry + 2¢
  aggregate_after_sec: 60,        // After 60s, passive monitoring
  force_close_after_sec: 120,     // After 2min, force close
  stop_loss_cents: 8,             // Exit if 8¢ below entry
  
  max_exposure_per_asset: 200,
  max_cost_per_asset: 100,
  
  price_buffer_cents: 2,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_poll_ms: 100,
  orderbook_poll_ms: 1500,
  order_cooldown_ms: 1500,        // 1.5 second cooldown
  sell_check_ms: 150,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
