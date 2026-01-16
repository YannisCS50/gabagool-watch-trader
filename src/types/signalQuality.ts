// ============================================
// SIGNAL QUALITY & EDGE TRUTH TYPES
// ============================================
// Types for professional-grade edge analysis, adverse selection detection,
// and causality validation.

export interface SignalQualityAnalysis {
  id: string;
  signal_id: string;
  market_id: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  timestamp_signal_detected: number;
  time_remaining_seconds: number;
  strike_price: number;
  spot_price_at_signal: number;
  delta_usd: number;
  delta_bucket: string;
  
  // Polymarket prices
  up_bid: number | null;
  up_ask: number | null;
  down_bid: number | null;
  down_ask: number | null;
  
  // Spread & cost reality
  spread_up: number | null;
  spread_down: number | null;
  effective_spread_sell: number | null;
  effective_spread_hedge: number | null;
  
  // Expected moves (rolling historical)
  expected_move_5s: number | null;
  expected_move_7s: number | null;
  expected_move_10s: number | null;
  expected_move_15s: number | null;
  
  // Edge quality
  edge_after_spread_7s: number | null;
  edge_after_spread_10s: number | null;
  
  // Lead/lag causality
  binance_tick_ts: number | null;
  polymarket_tick_ts: number | null;
  spot_lead_ms: number | null;
  spot_lead_bucket: string | null;
  
  // Adverse selection
  taker_volume_last_5s: number | null;
  taker_volume_zscore: number | null;
  
  // Market structure
  bid_depth_up: number | null;
  ask_depth_up: number | null;
  bid_depth_down: number | null;
  ask_depth_down: number | null;
  depth_imbalance: number | null;
  spread_percentile_1h: number | null;
  
  // Exit reality
  actual_price_at_5s: number | null;
  actual_price_at_7s: number | null;
  actual_price_at_10s: number | null;
  actual_price_at_15s: number | null;
  best_exit_sell_profit_10s: number | null;
  best_exit_sell_profit_15s: number | null;
  best_exit_hedge_profit: number | null;
  chosen_exit_type: 'sell' | 'hedge' | 'timeout' | 'none' | null;
  actual_pnl: number | null;
  missed_profit: number | null;
  
  // Statistical safety
  bucket_n: number | null;
  bucket_confidence: number | null;
  
  // Truth flags
  should_trade: boolean;
  would_have_lost_money: boolean;
  is_false_edge: boolean;
  
  created_at: string;
  updated_at: string;
}

export interface DeltaBucketConfig {
  id: string;
  asset: string;
  bucket_index: number;
  bucket_label: string;
  min_delta: number;
  max_delta: number;
  sample_count: number;
  last_calibrated_at: string;
}

export interface BucketStatistics {
  id: string;
  asset: string;
  delta_bucket: string;
  time_bucket: string | null;
  sample_count: number;
  avg_edge_after_spread: number | null;
  win_rate: number | null;
  avg_spot_lead_ms: number | null;
  avg_taker_zscore: number | null;
  avg_move_5s: number | null;
  avg_move_7s: number | null;
  avg_move_10s: number | null;
  avg_move_15s: number | null;
  std_move_7s: number | null;
  last_updated_at: string;
}

// Aggregated stats for dashboard display
export interface SignalQualityStats {
  totalSignals: number;
  signalsWithPositiveEdge: number;
  pctPositiveEdge: number;
  avgEdgeAfterSpread: number;
  
  // By should_trade flag
  shouldTradeCount: number;
  shouldNotTradeCount: number;
  winRateWhenShouldTrade: number;
  winRateWhenShouldNotTrade: number;
  
  // False edge detection
  falseEdgeCount: number;
  falseEdgePct: number;
  
  // Low confidence warnings
  lowConfidenceCount: number;
  lowConfidencePct: number;
}

export interface BucketAggregation {
  bucket: string;
  count: number;
  avgEdge: number;
  winRate: number;
  avgSpotLead: number;
  confidence: number;
  isLowSample: boolean; // bucket_n < 30
}

// Spot lead bucket classification
export type SpotLeadBucket = '<300ms' | '300-800ms' | '>800ms';

export function classifySpotLead(leadMs: number | null): SpotLeadBucket {
  if (leadMs === null) return '<300ms';
  if (leadMs < 300) return '<300ms';
  if (leadMs <= 800) return '300-800ms';
  return '>800ms';
}

// Delta bucket helper (dynamically computed per asset)
export function computeDeltaBucket(asset: string, deltaUsd: number): string {
  const absD = Math.abs(deltaUsd);
  
  // Asset-specific bucket sizes (from empirical data)
  const bucketSizes: Record<string, number[]> = {
    BTC: [0, 20, 50, 100, 200, 500],
    ETH: [0, 2, 5, 10, 20, 50],
    SOL: [0, 0.1, 0.25, 0.5, 1, 2],
    XRP: [0, 0.005, 0.01, 0.02, 0.05, 0.1],
  };
  
  const sizes = bucketSizes[asset] || bucketSizes.BTC;
  
  for (let i = sizes.length - 1; i >= 0; i--) {
    if (absD >= sizes[i]) {
      const nextSize = sizes[i + 1];
      if (nextSize) {
        return `d${sizes[i]}-${nextSize}`;
      }
      return `d${sizes[i]}+`;
    }
  }
  return `d0-${sizes[1] || 10}`;
}
