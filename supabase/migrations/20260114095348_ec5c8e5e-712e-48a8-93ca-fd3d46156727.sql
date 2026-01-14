-- Create table for V29 tick-by-tick price and signal logging
CREATE TABLE public.v29_ticks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  run_id TEXT,
  asset TEXT NOT NULL,
  
  -- Prices
  binance_price NUMERIC,
  chainlink_price NUMERIC,
  binance_delta NUMERIC,
  
  -- Orderbook prices  
  up_best_ask NUMERIC,
  up_best_bid NUMERIC,
  down_best_ask NUMERIC,
  down_best_bid NUMERIC,
  
  -- Signal info
  alert_triggered BOOLEAN DEFAULT false,
  signal_direction TEXT,
  
  -- Order info
  order_placed BOOLEAN DEFAULT false,
  order_id TEXT,
  fill_price NUMERIC,
  fill_size NUMERIC,
  
  -- Market context
  market_slug TEXT,
  strike_price NUMERIC
);

-- Index for fast time-based queries
CREATE INDEX idx_v29_ticks_ts ON public.v29_ticks(ts DESC);
CREATE INDEX idx_v29_ticks_asset_ts ON public.v29_ticks(asset, ts DESC);

-- Enable RLS
ALTER TABLE public.v29_ticks ENABLE ROW LEVEL SECURITY;

-- Allow public read access (no auth required for dashboard)
CREATE POLICY "Allow public read access to v29_ticks" 
ON public.v29_ticks 
FOR SELECT 
USING (true);

-- Allow inserts from authenticated users or service role
CREATE POLICY "Allow inserts to v29_ticks" 
ON public.v29_ticks 
FOR INSERT 
WITH CHECK (true);

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_ticks;

COMMENT ON TABLE public.v29_ticks IS 'Tick-by-tick logging for V29 runner: prices, alerts, and fills';