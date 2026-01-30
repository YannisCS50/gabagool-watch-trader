-- V35 Expiry Snapshots Table
-- Captures exact market state 1 second before each 15-minute expiry
CREATE TABLE public.v35_expiry_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  expiry_time TIMESTAMP WITH TIME ZONE NOT NULL,
  snapshot_time TIMESTAMP WITH TIME ZONE NOT NULL,
  seconds_before_expiry NUMERIC,
  
  -- API ground truth positions
  api_up_qty NUMERIC NOT NULL DEFAULT 0,
  api_down_qty NUMERIC NOT NULL DEFAULT 0,
  api_up_cost NUMERIC NOT NULL DEFAULT 0,
  api_down_cost NUMERIC NOT NULL DEFAULT 0,
  
  -- Local state for debugging
  local_up_qty NUMERIC NOT NULL DEFAULT 0,
  local_down_qty NUMERIC NOT NULL DEFAULT 0,
  local_up_cost NUMERIC NOT NULL DEFAULT 0,
  local_down_cost NUMERIC NOT NULL DEFAULT 0,
  
  -- Calculated metrics
  paired NUMERIC NOT NULL DEFAULT 0,
  unpaired NUMERIC NOT NULL DEFAULT 0,
  combined_cost NUMERIC,
  locked_profit NUMERIC DEFAULT 0,
  avg_up_price NUMERIC,
  avg_down_price NUMERIC,
  
  -- Orderbook state
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  combined_ask NUMERIC,
  
  -- Order counts
  up_orders_count INTEGER DEFAULT 0,
  down_orders_count INTEGER DEFAULT 0,
  
  -- Flags
  was_imbalanced BOOLEAN DEFAULT false,
  imbalance_ratio NUMERIC,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for querying by market
CREATE INDEX idx_v35_expiry_snapshots_market_slug ON public.v35_expiry_snapshots(market_slug);

-- Index for time-based queries
CREATE INDEX idx_v35_expiry_snapshots_expiry_time ON public.v35_expiry_snapshots(expiry_time DESC);

-- Unique constraint to prevent duplicate snapshots
CREATE UNIQUE INDEX idx_v35_expiry_snapshots_unique ON public.v35_expiry_snapshots(market_slug);

-- Enable RLS
ALTER TABLE public.v35_expiry_snapshots ENABLE ROW LEVEL SECURITY;

-- Public read policy (for dashboard)
CREATE POLICY "Allow public read access"
  ON public.v35_expiry_snapshots
  FOR SELECT
  USING (true);

-- Service role insert policy (for runner-proxy)
CREATE POLICY "Allow service role insert"
  ON public.v35_expiry_snapshots
  FOR INSERT
  WITH CHECK (true);