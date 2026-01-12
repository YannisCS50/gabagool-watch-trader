-- Create a table for paper trader decision logs
CREATE TABLE IF NOT EXISTS public.paper_trader_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  asset TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason TEXT,
  binance_price NUMERIC,
  share_price NUMERIC,
  delta_usd NUMERIC,
  config_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add index for fast lookups
CREATE INDEX idx_paper_trader_logs_ts ON public.paper_trader_logs (ts DESC);
CREATE INDEX idx_paper_trader_logs_asset ON public.paper_trader_logs (asset);

-- Enable RLS
ALTER TABLE public.paper_trader_logs ENABLE ROW LEVEL SECURITY;

-- Allow public read/write (internal tool)
CREATE POLICY "Allow all access to paper_trader_logs"
  ON public.paper_trader_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);