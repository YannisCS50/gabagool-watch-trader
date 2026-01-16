-- ============================================
-- SIGNAL ANALYSIS TABLE
-- ============================================
-- This table provides ONE ROW PER SIGNAL CYCLE for professional-grade
-- edge analysis, adverse selection detection, and causality validation.
-- 
-- Purpose: Determine WHEN a signal was actually worth trading, and WHEN
-- it should have been ignored - exposing self-deception from small samples.

CREATE TABLE IF NOT EXISTS public.signal_quality_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- ===== BASIC CONTEXT =====
  signal_id UUID NOT NULL,           -- Reference to source signal
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,           -- UP or DOWN
  timestamp_signal_detected BIGINT NOT NULL,
  time_remaining_seconds INTEGER NOT NULL,
  strike_price NUMERIC NOT NULL,
  spot_price_at_signal NUMERIC NOT NULL,
  delta_usd NUMERIC NOT NULL,
  delta_bucket TEXT NOT NULL,        -- Dynamically computed bucket like 'd50-100'
  
  -- ===== POLYMARKET PRICES AT SIGNAL =====
  up_bid NUMERIC,
  up_ask NUMERIC,
  down_bid NUMERIC,
  down_ask NUMERIC,
  
  -- ===== SPREAD & COST REALITY =====
  spread_up NUMERIC,                 -- up_ask - up_bid
  spread_down NUMERIC,               -- down_ask - down_bid
  effective_spread_sell NUMERIC,     -- Cost to exit via sell (taker)
  effective_spread_hedge NUMERIC,    -- Cost to hedge via buying opposite (up_ask + down_ask - 1)
  
  -- ===== EXPECTED MOVE (HISTORICAL ROLLING) =====
  expected_move_5s NUMERIC,          -- Rolling avg price move 5s after signal
  expected_move_7s NUMERIC,          -- Rolling avg price move 7s after signal
  expected_move_10s NUMERIC,         -- Rolling avg price move 10s after signal
  expected_move_15s NUMERIC,         -- Rolling avg price move 15s after signal
  
  -- ===== EDGE QUALITY =====
  edge_after_spread_7s NUMERIC,      -- expected_move_7s - effective_spread_sell
  edge_after_spread_10s NUMERIC,
  
  -- ===== LEAD / LAG (CAUSALITY) =====
  binance_tick_ts BIGINT,            -- Timestamp of Binance price
  polymarket_tick_ts BIGINT,         -- When Polymarket prices moved in response
  spot_lead_ms INTEGER,              -- polymarket_tick_ts - binance_tick_ts
  spot_lead_bucket TEXT,             -- '<300ms', '300-800ms', '>800ms'
  
  -- ===== ADVERSE SELECTION / FLOW =====
  taker_volume_last_5s NUMERIC,      -- Volume from aggressive takers
  taker_volume_zscore NUMERIC,       -- Normalized vs recent history
  
  -- ===== MARKET STRUCTURE =====
  bid_depth_up NUMERIC,
  ask_depth_up NUMERIC,
  bid_depth_down NUMERIC,
  ask_depth_down NUMERIC,
  depth_imbalance NUMERIC,           -- (bid_depth - ask_depth) / (bid_depth + ask_depth)
  spread_percentile_1h NUMERIC,      -- Where current spread sits vs last hour (0-100)
  
  -- ===== EXIT REALITY (ACTUAL OUTCOMES) =====
  actual_price_at_5s NUMERIC,
  actual_price_at_7s NUMERIC,
  actual_price_at_10s NUMERIC,
  actual_price_at_15s NUMERIC,
  best_exit_sell_profit_10s NUMERIC,
  best_exit_sell_profit_15s NUMERIC,
  best_exit_hedge_profit NUMERIC,
  chosen_exit_type TEXT,             -- 'sell', 'hedge', 'timeout', 'none'
  actual_pnl NUMERIC,
  missed_profit NUMERIC,             -- Difference between best possible and actual
  
  -- ===== STATISTICAL SAFETY =====
  bucket_n INTEGER,                  -- Number of historical samples in this delta/time bucket
  bucket_confidence NUMERIC,         -- min(1, bucket_n / 50)
  
  -- ===== FINAL TRUTH FLAGS =====
  -- should_trade = edge_after_spread_7s > 0 AND spot_lead_ms >= 500 
  --                AND taker_volume_zscore < 1.5 AND bucket_confidence >= 0.6
  should_trade BOOLEAN DEFAULT false,
  would_have_lost_money BOOLEAN DEFAULT false,
  is_false_edge BOOLEAN DEFAULT false, -- Positive delta but negative edge_after_spread
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indices for common queries
CREATE INDEX IF NOT EXISTS idx_sqa_asset ON public.signal_quality_analysis(asset);
CREATE INDEX IF NOT EXISTS idx_sqa_direction ON public.signal_quality_analysis(direction);
CREATE INDEX IF NOT EXISTS idx_sqa_delta_bucket ON public.signal_quality_analysis(delta_bucket);
CREATE INDEX IF NOT EXISTS idx_sqa_should_trade ON public.signal_quality_analysis(should_trade);
CREATE INDEX IF NOT EXISTS idx_sqa_created ON public.signal_quality_analysis(created_at);
CREATE INDEX IF NOT EXISTS idx_sqa_signal_id ON public.signal_quality_analysis(signal_id);

-- RLS: Public read access for dashboard
ALTER TABLE public.signal_quality_analysis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to signal_quality_analysis"
  ON public.signal_quality_analysis
  FOR SELECT
  USING (true);

CREATE POLICY "Allow public insert to signal_quality_analysis"
  ON public.signal_quality_analysis
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow public update to signal_quality_analysis"
  ON public.signal_quality_analysis
  FOR UPDATE
  USING (true);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.signal_quality_analysis;

-- ============================================
-- DELTA BUCKET CONFIGURATION TABLE
-- ============================================
-- Stores dynamically learned bucket boundaries per asset
-- Recomputed periodically based on empirical distribution

CREATE TABLE IF NOT EXISTS public.delta_bucket_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset TEXT NOT NULL,
  bucket_index INTEGER NOT NULL,     -- 0, 1, 2, 3...
  bucket_label TEXT NOT NULL,        -- 'd0-20', 'd20-50', etc.
  min_delta NUMERIC NOT NULL,
  max_delta NUMERIC NOT NULL,
  sample_count INTEGER DEFAULT 0,
  last_calibrated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(asset, bucket_index)
);

CREATE INDEX IF NOT EXISTS idx_dbc_asset ON public.delta_bucket_config(asset);

ALTER TABLE public.delta_bucket_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to delta_bucket_config"
  ON public.delta_bucket_config
  FOR SELECT
  USING (true);

CREATE POLICY "Allow public write to delta_bucket_config"
  ON public.delta_bucket_config
  FOR ALL
  USING (true);

-- ============================================
-- BUCKET STATISTICS TABLE
-- ============================================
-- Aggregated stats per delta bucket for confidence calculations

CREATE TABLE IF NOT EXISTS public.bucket_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset TEXT NOT NULL,
  delta_bucket TEXT NOT NULL,
  time_bucket TEXT,                  -- Optional: further split by time remaining
  
  sample_count INTEGER DEFAULT 0,
  avg_edge_after_spread NUMERIC,
  win_rate NUMERIC,                  -- % of signals that were profitable
  avg_spot_lead_ms NUMERIC,
  avg_taker_zscore NUMERIC,
  
  -- Rolling stats for expected moves
  avg_move_5s NUMERIC,
  avg_move_7s NUMERIC,
  avg_move_10s NUMERIC,
  avg_move_15s NUMERIC,
  std_move_7s NUMERIC,
  
  last_updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(asset, delta_bucket, time_bucket)
);

ALTER TABLE public.bucket_statistics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public access to bucket_statistics"
  ON public.bucket_statistics
  FOR ALL
  USING (true);