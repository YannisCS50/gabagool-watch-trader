/**
 * V29 Types
 */

import type { Asset } from './config.js';

export interface MarketInfo {
  slug: string;
  asset: Asset;
  strikePrice: number;
  upTokenId: string;
  downTokenId: string;
  endTime: Date;
}

export interface PriceState {
  binance: number | null;
  chainlink: number | null; // Actual price from Chainlink oracle (for delta calculation)
  upBestAsk: number | null;
  upBestBid: number | null;
  downBestAsk: number | null;
  downBestBid: number | null;
  lastUpdate: number;
}

export interface Signal {
  id?: string;
  run_id: string;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  binance_price: number;
  binance_delta: number;
  share_price: number;
  market_slug: string | null;
  strike_price: number | null;
  status: 'pending' | 'filled' | 'closed' | 'failed' | 'timeout' | 'cancelled';
  signal_ts: number;
  entry_price: number | null;
  exit_price: number | null;
  shares: number | null;
  order_id: string | null;
  fill_ts: number | null;
  close_ts: number | null;
  exit_type: 'TP' | 'SL' | 'TRAILING' | 'TIMEOUT' | 'EMERGENCY' | 'MANUAL' | null;
  gross_pnl: number | null;
  net_pnl: number | null;
  fees: number | null;
  notes: string | null;
}

export interface Position {
  signalId: string;
  asset: Asset;
  direction: 'UP' | 'DOWN';
  tokenId: string;
  entryPrice: number;
  shares: number;
  startTime: number;
  // Trailing stop state
  peakProfit: number;       // Highest profit seen (in cents)
  trailingActive: boolean;  // True when trailing has been triggered
  sellOrderId: string | null; // Active sell order (max 1)
}
