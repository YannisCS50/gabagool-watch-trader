-- Create a dedicated table for real-time price logging from WebSocket feeds
-- This is separate from price_ticks for high-frequency data with source tracking

CREATE TABLE IF NOT EXISTS public.realtime_price_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL, -- 'polymarket_rtds' or 'chainlink_rtds'
  asset TEXT NOT NULL,  -- 'BTC', 'ETH', 'SOL', 'XRP', etc.
  price NUMERIC NOT NULL,
  raw_timestamp BIGINT, -- Original timestamp from the feed
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX idx_realtime_price_logs_source ON public.realtime_price_logs(source);
CREATE INDEX idx_realtime_price_logs_asset ON public.realtime_price_logs(asset);
CREATE INDEX idx_realtime_price_logs_created_at ON public.realtime_price_logs(created_at DESC);
CREATE INDEX idx_realtime_price_logs_asset_source_created ON public.realtime_price_logs(asset, source, created_at DESC);

-- Enable RLS but allow service role full access
ALTER TABLE public.realtime_price_logs ENABLE ROW LEVEL SECURITY;

-- Allow service role to insert (edge functions use service role)
CREATE POLICY "Service role can insert logs"
  ON public.realtime_price_logs
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Allow anyone to read logs (for dashboard)
CREATE POLICY "Anyone can read logs"
  ON public.realtime_price_logs
  FOR SELECT
  USING (true);

-- Add to realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.realtime_price_logs;