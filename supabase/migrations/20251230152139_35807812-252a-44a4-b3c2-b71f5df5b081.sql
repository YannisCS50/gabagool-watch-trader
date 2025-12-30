-- Create price_ticks table for live price logging
CREATE TABLE public.price_ticks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asset TEXT NOT NULL,
  price NUMERIC NOT NULL,
  delta NUMERIC,
  delta_percent NUMERIC,
  source TEXT DEFAULT 'chainlink',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create fill_logs table for trade fills
CREATE TABLE public.fill_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  iso TEXT NOT NULL,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  order_id TEXT,
  client_order_id TEXT,
  fill_qty NUMERIC NOT NULL,
  fill_price NUMERIC NOT NULL,
  fill_notional NUMERIC NOT NULL,
  intent TEXT NOT NULL,
  seconds_remaining INTEGER NOT NULL,
  spot_price NUMERIC,
  strike_price NUMERIC,
  delta NUMERIC,
  hedge_lag_ms INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create snapshot_logs table for telemetry
CREATE TABLE public.snapshot_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  iso TEXT NOT NULL,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  seconds_remaining INTEGER NOT NULL,
  spot_price NUMERIC,
  strike_price NUMERIC,
  delta NUMERIC,
  up_bid NUMERIC,
  up_ask NUMERIC,
  up_mid NUMERIC,
  down_bid NUMERIC,
  down_ask NUMERIC,
  down_mid NUMERIC,
  spread_up NUMERIC,
  spread_down NUMERIC,
  combined_ask NUMERIC,
  combined_mid NUMERIC,
  cheapest_ask_plus_other_mid NUMERIC,
  bot_state TEXT NOT NULL,
  up_shares NUMERIC NOT NULL DEFAULT 0,
  down_shares NUMERIC NOT NULL DEFAULT 0,
  avg_up_cost NUMERIC,
  avg_down_cost NUMERIC,
  pair_cost NUMERIC,
  skew NUMERIC,
  no_liquidity_streak INTEGER NOT NULL DEFAULT 0,
  adverse_streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create settlement_logs table
CREATE TABLE public.settlement_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  iso TEXT NOT NULL,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  open_ts BIGINT,
  close_ts BIGINT NOT NULL,
  final_up_shares NUMERIC NOT NULL DEFAULT 0,
  final_down_shares NUMERIC NOT NULL DEFAULT 0,
  avg_up_cost NUMERIC,
  avg_down_cost NUMERIC,
  pair_cost NUMERIC,
  realized_pnl NUMERIC,
  winning_side TEXT,
  max_delta NUMERIC,
  min_delta NUMERIC,
  time_in_low INTEGER NOT NULL DEFAULT 0,
  time_in_mid INTEGER NOT NULL DEFAULT 0,
  time_in_high INTEGER NOT NULL DEFAULT 0,
  count_dislocation_95 INTEGER NOT NULL DEFAULT 0,
  count_dislocation_97 INTEGER NOT NULL DEFAULT 0,
  last_180s_dislocation_95 INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add indexes for efficient querying
CREATE INDEX idx_price_ticks_asset_created ON public.price_ticks(asset, created_at DESC);
CREATE INDEX idx_fill_logs_market_created ON public.fill_logs(market_id, created_at DESC);
CREATE INDEX idx_fill_logs_asset_created ON public.fill_logs(asset, created_at DESC);
CREATE INDEX idx_snapshot_logs_market_created ON public.snapshot_logs(market_id, created_at DESC);
CREATE INDEX idx_snapshot_logs_asset_created ON public.snapshot_logs(asset, created_at DESC);
CREATE INDEX idx_settlement_logs_market ON public.settlement_logs(market_id);
CREATE INDEX idx_settlement_logs_asset_created ON public.settlement_logs(asset, created_at DESC);

-- Enable RLS
ALTER TABLE public.price_ticks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fill_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_logs ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Allow public read for price_ticks" ON public.price_ticks FOR SELECT USING (true);
CREATE POLICY "Allow public read for fill_logs" ON public.fill_logs FOR SELECT USING (true);
CREATE POLICY "Allow public read for snapshot_logs" ON public.snapshot_logs FOR SELECT USING (true);
CREATE POLICY "Allow public read for settlement_logs" ON public.settlement_logs FOR SELECT USING (true);

-- Service insert policies
CREATE POLICY "Allow service insert for price_ticks" ON public.price_ticks FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert for fill_logs" ON public.fill_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert for snapshot_logs" ON public.snapshot_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert for settlement_logs" ON public.settlement_logs FOR INSERT WITH CHECK (true);