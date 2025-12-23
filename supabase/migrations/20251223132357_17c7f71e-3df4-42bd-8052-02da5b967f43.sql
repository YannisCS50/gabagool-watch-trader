-- Create market_history table to store all markets (active and expired)
CREATE TABLE public.market_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  question TEXT,
  event_start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  event_end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  strike_price NUMERIC,
  close_price NUMERIC,
  up_price_at_close NUMERIC,
  down_price_at_close NUMERIC,
  result TEXT, -- 'UP', 'DOWN', 'UNKNOWN'
  up_token_id TEXT,
  down_token_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(slug)
);

-- Enable RLS
ALTER TABLE public.market_history ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Allow public read for market_history"
ON public.market_history
FOR SELECT
USING (true);

-- Allow service role to insert/update (for edge functions)
CREATE POLICY "Allow service role insert for market_history"
ON public.market_history
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service role update for market_history"
ON public.market_history
FOR UPDATE
USING (true);

-- Create index for faster lookups by asset and time
CREATE INDEX idx_market_history_asset_time ON public.market_history(asset, event_end_time DESC);
CREATE INDEX idx_market_history_slug ON public.market_history(slug);

-- Enable realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.market_history;