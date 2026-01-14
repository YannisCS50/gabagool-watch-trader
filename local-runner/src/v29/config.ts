/**
 * V29 Accumulator Strategy - Configuration
 * 
 * HEDGE STRATEGY:
 * - Binance spike → buy shares (accumulate)
 * - Instead of selling → buy opposite side (hedge)
 * - Lock in profit: UP + DOWN = 100¢
 * - Keep optionality for further accumulation
 * 
 * Benefits:
 * - No sell fees (only maker fees on buys)
 * - Progressive hedging at lower prices
 * - Keep exposure to winning side
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
  
  // === HEDGE CONFIG (replaces take_profit/timeout) ===
  
  // Minimum profit margin before hedging (in cents)
  min_hedge_profit_cents: number;
  
  // Maximum hedge price (don't hedge if opposite side > this)
  max_hedge_price: number;
  
  // Progressive hedge tiers: buy more hedge at lower prices
  hedge_tier_1_price: number;  // e.g., 0.35 = 35¢
  hedge_tier_1_pct: number;    // e.g., 0.33 = hedge 33%
  hedge_tier_2_price: number;  // e.g., 0.25 = 25¢
  hedge_tier_2_pct: number;    // e.g., 0.50 = hedge 50%
  hedge_tier_3_price: number;  // e.g., 0.15 = 15¢
  hedge_tier_3_pct: number;    // e.g., 1.00 = hedge 100%
  
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
  
  // Hedge check interval (how often to check for hedge opportunities)
  hedge_check_ms: number;
}

export const DEFAULT_CONFIG: V29Config = {
  enabled: true,
  tick_delta_usd: 12,
  delta_threshold: 75,
  min_share_price: 0.30,
  max_share_price: 0.75,
  shares_per_trade: 5,
  
  // Hedge config
  min_hedge_profit_cents: 4,
  max_hedge_price: 0.40,
  hedge_tier_1_price: 0.35,
  hedge_tier_1_pct: 0.33,
  hedge_tier_2_price: 0.25,
  hedge_tier_2_pct: 0.50,
  hedge_tier_3_price: 0.15,
  hedge_tier_3_pct: 1.00,
  max_exposure_per_asset: 100,
  max_cost_per_asset: 50,
  
  price_buffer_cents: 1,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_poll_ms: 100,
  orderbook_poll_ms: 2000,
  order_cooldown_ms: 3000,
  hedge_check_ms: 500,
};

// Binance WebSocket symbols
export const BINANCE_SYMBOLS: Record<Asset, string> = {
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
};
