-- Create v29_logs table for runner event logging
CREATE TABLE public.v29_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL,
  asset TEXT,
  message TEXT NOT NULL,
  data JSONB
);

-- Create index for fast querying
CREATE INDEX idx_v29_logs_ts ON public.v29_logs(ts DESC);
CREATE INDEX idx_v29_logs_category ON public.v29_logs(category);
CREATE INDEX idx_v29_logs_asset ON public.v29_logs(asset);

-- Enable RLS (public read for dashboard, insert from edge functions)
ALTER TABLE public.v29_logs ENABLE ROW LEVEL SECURITY;

-- Allow public read access (logs are not sensitive)
CREATE POLICY "Anyone can read v29_logs"
ON public.v29_logs
FOR SELECT
USING (true);

-- Allow insert from service role (runner uses service key)
CREATE POLICY "Service role can insert v29_logs"
ON public.v29_logs
FOR INSERT
WITH CHECK (true);

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_logs;