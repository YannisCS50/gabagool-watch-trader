/**
 * V29 Response-Based Strategy - Types
 */

import type { Asset, Direction } from './config.js';

// ============================================
// MARKET INFO
// ============================================

export interface MarketInfo {
  slug: string;
  asset: Asset;
  strikePrice: number;
  upTokenId: string;
  downTokenId: string;
  startTime: Date;
  endTime: Date;
}

// ============================================
// PRICE STATE
// ============================================

export interface PriceState {
  // Latest Binance price
  binance: number | null;
  binanceTs: number;
  
  // Chainlink (optional, for delta-to-strike)
  chainlink: number | null;
  
  // Polymarket orderbook
  upBestAsk: number | null;
  upBestBid: number | null;
  downBestAsk: number | null;
  downBestBid: number | null;
  lastOrderbookUpdate: number;
}

// ============================================
// ROLLING WINDOW FOR SIGNAL DETECTION
// ============================================

export interface PriceTick {
  price: number;
  ts: number;
}

// ============================================
// SIGNAL (Entry Trigger)
// ============================================

export interface Signal {
  id: string;
  asset: Asset;
  direction: Direction;
  
  // Binance data at signal time
  binance_price: number;
  binance_delta: number;  // Price move that triggered
  binance_ts: number;
  
  // Polymarket state at signal time (t=0)
  share_price_t0: number;
  spread_t0: number;
  
  // Market info
  market_slug: string;
  strike_price: number;
  
  // Status
  status: 'pending' | 'skipped' | 'filled' | 'exited' | 'timeout' | 'failed';
  skip_reason?: string;
  
  // Timestamps
  signal_ts: number;      // When signal was detected
  decision_ts: number;    // When we decided to trade
  order_submit_ts?: number;
  fill_ts?: number;
  exit_ts?: number;
  
  // Execution
  entry_price?: number;
  exit_price?: number;
  shares?: number;
  order_id?: string;
  
  // Exit info
  exit_type?: 'target' | 'exhaustion' | 'adverse' | 'timeout' | 'error';
  exit_reason?: string;
  
  // P&L
  gross_pnl?: number;
  fees?: number;
  net_pnl?: number;
  
  // Price tracking (for analytics)
  price_at_1s?: number;
  price_at_2s?: number;
  price_at_3s?: number;
  price_at_5s?: number;
}

// ============================================
// ACTIVE POSITION (being monitored for exit)
// ============================================

export interface ActivePosition {
  id: string;
  signal: Signal;
  
  asset: Asset;
  direction: Direction;
  marketSlug: string;
  tokenId: string;
  
  shares: number;
  entryPrice: number;
  totalCost: number;
  entryTime: number;
  orderId?: string;
  
  // Tracking for exit logic
  priceAtEntry: number;  // Share price when filled
  lastPrice: number;     // Current share price
  lastPriceTs: number;
  
  // Repricing tracking
  maxPriceSeen: number;
  totalRepricing: number;  // Current price - entry price (can be negative)
  
  // Stall detection (1-second rolling window)
  priceHistory: Array<{ price: number; ts: number }>;
  
  // Monitor interval
  monitorInterval?: NodeJS.Timeout;
}

// ============================================
// LOGGING
// ============================================

export interface SignalLog {
  id: string;
  run_id: string;
  asset: Asset;
  direction: Direction;
  
  // Binance
  binance_price: number;
  binance_delta: number;
  binance_ts: number;
  
  // Polymarket at t=0
  share_price_t0: number;
  spread_t0: number;
  best_bid_t0: number;
  best_ask_t0: number;
  
  // Market
  market_slug: string;
  strike_price: number;
  
  // Execution
  status: string;
  skip_reason?: string;
  entry_price?: number;
  exit_price?: number;
  shares?: number;
  
  // Timestamps
  signal_ts: number;
  decision_ts: number;
  fill_ts?: number;
  exit_ts?: number;
  
  // Exit
  exit_type?: string;
  exit_reason?: string;
  
  // P&L
  gross_pnl?: number;
  fees?: number;
  net_pnl?: number;
  
  // Price tracking
  price_at_1s?: number;
  price_at_2s?: number;
  price_at_3s?: number;
  price_at_5s?: number;
  
  // Latency breakdown
  decision_latency_ms?: number;
  order_latency_ms?: number;
  fill_latency_ms?: number;
  exit_latency_ms?: number;
}

// ============================================
// TICK LOG (for every price update)
// ============================================

export interface TickLog {
  run_id: string;
  asset: Asset;
  ts: number;
  
  binance_price: number;
  binance_delta?: number;  // Delta in rolling window
  
  up_best_bid?: number;
  up_best_ask?: number;
  down_best_bid?: number;
  down_best_ask?: number;
  
  market_slug?: string;
  strike_price?: number;
  
  // Signal info (if triggered)
  signal_triggered: boolean;
  signal_direction?: Direction;
  signal_id?: string;
}
