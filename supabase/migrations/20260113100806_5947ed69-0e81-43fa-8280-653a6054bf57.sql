-- Create V29 signals table for storing trade signals
CREATE TABLE public.v29_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  signal_ts BIGINT NOT NULL,
  binance_price NUMERIC NOT NULL,
  delta_usd NUMERIC,
  share_price NUMERIC,
  market_slug TEXT,
  strike_price NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',
  entry_price NUMERIC,
  exit_price NUMERIC,
  fill_ts BIGINT,
  sell_ts BIGINT,
  net_pnl NUMERIC,
  shares NUMERIC,
  exit_reason TEXT
);

-- Enable RLS
ALTER TABLE public.v29_signals ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "V29 signals are publicly readable" 
ON public.v29_signals 
FOR SELECT 
USING (true);

-- Allow public insert (for runner)
CREATE POLICY "V29 signals are publicly insertable" 
ON public.v29_signals 
FOR INSERT 
WITH CHECK (true);

-- Allow public update (for runner)
CREATE POLICY "V29 signals are publicly updatable" 
ON public.v29_signals 
FOR UPDATE 
USING (true);

-- Create indexes for common queries
CREATE INDEX idx_v29_signals_signal_ts ON public.v29_signals (signal_ts DESC);
CREATE INDEX idx_v29_signals_asset ON public.v29_signals (asset);
CREATE INDEX idx_v29_signals_status ON public.v29_signals (status);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_signals;