-- Create v35_positions table for position snapshots
CREATE TABLE public.v35_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  up_qty NUMERIC NOT NULL DEFAULT 0,
  down_qty NUMERIC NOT NULL DEFAULT 0,
  up_cost NUMERIC NOT NULL DEFAULT 0,
  down_cost NUMERIC NOT NULL DEFAULT 0,
  paired NUMERIC NOT NULL DEFAULT 0,
  unpaired NUMERIC NOT NULL DEFAULT 0,
  combined_cost NUMERIC NOT NULL DEFAULT 0,
  locked_profit NUMERIC NOT NULL DEFAULT 0,
  seconds_to_expiry INTEGER,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for efficient querying
CREATE INDEX idx_v35_positions_market ON public.v35_positions(market_slug, asset);
CREATE INDEX idx_v35_positions_timestamp ON public.v35_positions(timestamp DESC);

-- Enable RLS (public read for dashboard)
ALTER TABLE public.v35_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "V35 positions are publicly readable" 
  ON public.v35_positions 
  FOR SELECT 
  USING (true);

CREATE POLICY "Service role can insert V35 positions"
  ON public.v35_positions
  FOR INSERT
  WITH CHECK (true);