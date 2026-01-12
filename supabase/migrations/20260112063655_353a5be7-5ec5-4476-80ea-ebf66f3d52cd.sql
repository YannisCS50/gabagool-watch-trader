
-- Create empirical price lookup table for V27 strategy
-- This stores the average market price for each asset/delta/time bucket
CREATE TABLE IF NOT EXISTS public.v27_price_lookup (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asset TEXT NOT NULL,
  delta_bucket TEXT NOT NULL,  -- e.g. 'd50-100' for $50-100 delta
  time_bucket TEXT NOT NULL,   -- e.g. 't1-3min' for 1-3 minutes remaining
  sample_count INTEGER NOT NULL DEFAULT 0,
  avg_up_price NUMERIC(6,4) NOT NULL,
  avg_down_price NUMERIC(6,4) NOT NULL,
  std_up NUMERIC(6,4),
  std_down NUMERIC(6,4),
  min_up NUMERIC(6,4),
  max_up NUMERIC(6,4),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE(asset, delta_bucket, time_bucket)
);

-- Enable RLS but allow public read (this is reference data)
ALTER TABLE public.v27_price_lookup ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read price lookup"
  ON public.v27_price_lookup
  FOR SELECT
  USING (true);

-- Index for fast lookups
CREATE INDEX idx_v27_price_lookup_asset_buckets 
  ON public.v27_price_lookup(asset, delta_bucket, time_bucket);

-- Add comment
COMMENT ON TABLE public.v27_price_lookup IS 'Empirical price expectations for V27 mispricing detection based on historical market data';
