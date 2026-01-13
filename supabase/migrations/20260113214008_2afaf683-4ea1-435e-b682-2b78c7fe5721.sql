-- Create runner_leases table for mutex/singleton pattern
-- Only ONE runner can hold the active lease at a time

CREATE TABLE IF NOT EXISTS public.runner_leases (
  id TEXT PRIMARY KEY DEFAULT 'v29-live',
  runner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 seconds'),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.runner_leases ENABLE ROW LEVEL SECURITY;

-- Allow all operations (this is backend-only, accessed via service key)
CREATE POLICY "Allow all for runner_leases" ON public.runner_leases
  FOR ALL USING (true) WITH CHECK (true);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_runner_leases_expires ON public.runner_leases(expires_at);

-- Add v29_fills table to track individual fills from burst orders
CREATE TABLE IF NOT EXISTS public.v29_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT,
  run_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  market_slug TEXT NOT NULL,
  order_id TEXT,
  price NUMERIC(10,4) NOT NULL,
  shares NUMERIC(10,2) NOT NULL,
  cost_usd NUMERIC(10,4) NOT NULL,
  fill_ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.v29_fills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for v29_fills" ON public.v29_fills
  FOR ALL USING (true) WITH CHECK (true);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_v29_fills_signal ON public.v29_fills(signal_id);
CREATE INDEX IF NOT EXISTS idx_v29_fills_market ON public.v29_fills(market_slug);
CREATE INDEX IF NOT EXISTS idx_v29_fills_ts ON public.v29_fills(fill_ts DESC);

-- Enable realtime for monitoring
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_fills;