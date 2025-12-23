-- Create strike_prices table to cache Chainlink prices at market start times
CREATE TABLE public.strike_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_slug TEXT NOT NULL UNIQUE,
  asset TEXT NOT NULL CHECK (asset IN ('BTC', 'ETH')),
  strike_price NUMERIC NOT NULL,
  event_start_time TIMESTAMPTZ NOT NULL,
  chainlink_timestamp BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.strike_prices ENABLE ROW LEVEL SECURITY;

-- Allow public read access (needed for edge functions)
CREATE POLICY "Allow public read for strike_prices"
ON public.strike_prices
FOR SELECT
USING (true);

-- Create index for fast lookups
CREATE INDEX idx_strike_prices_market_slug ON public.strike_prices(market_slug);
CREATE INDEX idx_strike_prices_event_start ON public.strike_prices(event_start_time DESC);