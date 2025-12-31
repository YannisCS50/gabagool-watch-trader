-- v4.4: Settlement failures tracking table
-- This is THE critical metric: optimize for settlement_failures = 0

CREATE TABLE public.settlement_failures (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  up_shares NUMERIC NOT NULL DEFAULT 0,
  down_shares NUMERIC NOT NULL DEFAULT 0,
  up_cost NUMERIC NOT NULL DEFAULT 0,
  down_cost NUMERIC NOT NULL DEFAULT 0,
  lost_side TEXT NOT NULL,
  lost_cost NUMERIC NOT NULL,
  seconds_remaining INTEGER NOT NULL,
  reason TEXT NOT NULL,
  panic_hedge_attempted BOOLEAN NOT NULL DEFAULT false,
  wallet_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.settlement_failures ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "Allow public read for settlement_failures"
ON public.settlement_failures
FOR SELECT
USING (true);

-- Allow service insert
CREATE POLICY "Allow service insert for settlement_failures"
ON public.settlement_failures
FOR INSERT
WITH CHECK (true);

-- Create index for querying by market and date
CREATE INDEX idx_settlement_failures_created_at ON public.settlement_failures(created_at DESC);
CREATE INDEX idx_settlement_failures_market ON public.settlement_failures(market_slug);

-- Add comment for documentation
COMMENT ON TABLE public.settlement_failures IS 'v4.4: Tracks unredeemed positions (100% losses). Optimize for COUNT = 0.';