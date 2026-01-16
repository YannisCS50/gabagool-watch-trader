/**
 * V30 Market-Maker Strategy Types
 * Bidirectional trading with fair value calculation
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface V30Config {
  enabled: boolean;
  assets: Asset[];
  fair_value_model: 'empirical' | 'kalman' | 'logistic';
  base_theta: number;              // Base edge threshold (e.g., 0.03 = 3%)
  theta_time_decay_factor: number; // Factor for τ-dependent threshold
  theta_inventory_factor: number;  // Factor for I-dependent threshold
  i_max_base: number;              // Max inventory (shares) per direction
  bet_size_base: number;           // Base bet size
  bet_size_vol_factor: number;     // Volatility multiplier
  force_counter_at_pct: number;    // % of i_max to force counter-bet
  aggressive_exit_sec: number;     // Seconds before expiry → aggressive close
  min_share_price: number;
  max_share_price: number;
  min_time_remaining_sec: number;  // Don't start trading if less than this
  // NEW: Minimum fair value to trade (prevents trading losing positions)
  min_fair_value_to_trade?: number;              // Default 0.10 (10%)
  min_fair_value_to_trade_low_confidence?: number; // Default 0.15 (15%)
}

export interface MarketInfo {
  slug: string;
  asset: Asset;
  strikePrice: number;
  upTokenId: string;
  downTokenId: string;
  endTime: Date;
}

export interface PriceState {
  binance: number | null;         // C_t - reference spot price
  chainlink: number | null;       // Z_t - oracle price (for delta calc)
  upBestAsk: number | null;
  upBestBid: number | null;
  downBestAsk: number | null;
  downBestBid: number | null;
  lastUpdate: number;
}

export interface FairValueResult {
  p_up: number;       // Fair probability UP wins
  p_down: number;     // Fair probability DOWN wins (1 - p_up)
  confidence: number; // 0-1 confidence in estimate
  samples: number;    // Number of historical samples used
}

export interface EdgeResult {
  edge_up: number;    // Δ_up = q_up - p_up (negative = underpriced)
  edge_down: number;  // Δ_down = q_down - p_down
  theta: number;      // Current dynamic threshold
  signal_up: boolean; // true if edge_up < -theta AND fair value high enough
  signal_down: boolean;
  // Extra debugging info
  fair_p_up?: number;
  fair_p_down?: number;
  min_fair_value_used?: number;
  confidence?: number;
}

export interface Inventory {
  up: number;         // Total UP shares held
  down: number;       // Total DOWN shares held
  net: number;        // up - down (positive = long UP bias)
  i_max: number;      // Current max allowed net exposure
}

export interface V30Tick {
  ts: number;
  run_id: string;
  asset: Asset;
  market_slug: string | null;
  c_price: number | null;
  z_price: number | null;
  strike_price: number | null;
  seconds_remaining: number | null;
  delta_to_strike: number | null;
  up_best_ask: number | null;
  up_best_bid: number | null;
  down_best_ask: number | null;
  down_best_bid: number | null;
  fair_p_up: number | null;
  edge_up: number | null;
  edge_down: number | null;
  theta_current: number | null;
  inventory_up: number;
  inventory_down: number;
  inventory_net: number;
  action_taken: string | null;
}

export interface V30Position {
  id?: string;
  run_id: string;
  asset: Asset;
  market_slug: string;
  direction: 'UP' | 'DOWN';
  shares: number;
  avg_entry_price: number;
  total_cost: number;
}

export type TradeAction = 
  | 'buy_up' 
  | 'buy_down' 
  | 'sell_up' 
  | 'sell_down'
  | 'force_counter_up'
  | 'force_counter_down'
  | 'aggressive_exit'
  | 'none';

export interface TradeDecision {
  action: TradeAction;
  shares: number;
  price: number;
  reason: string;
}
