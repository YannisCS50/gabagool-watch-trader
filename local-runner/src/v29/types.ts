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
  status: 'pending' | 'filled' | 'closed' | 'failed' | 'timeout';
  signal_ts: number;
  entry_price: number | null;
  exit_price: number | null;
  shares: number | null;
  order_id: string | null;
  fill_ts: number | null;
  close_ts: number | null;
  exit_type: 'TP' | 'SL' | 'TIMEOUT' | 'MANUAL' | null;
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
  tpPrice: number | null;
  slPrice: number | null;
  startTime: number;
}
