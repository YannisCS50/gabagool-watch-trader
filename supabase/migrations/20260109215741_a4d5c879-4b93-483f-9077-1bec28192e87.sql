-- Create archive table for old order_queue records
CREATE TABLE public.order_queue_archive (
  id UUID NOT NULL,
  asset TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  order_type TEXT DEFAULT 'LIMIT',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  executed_at TIMESTAMPTZ,
  order_id TEXT,
  avg_fill_price NUMERIC,
  error_message TEXT,
  reasoning TEXT,
  event_start_time TIMESTAMPTZ,
  event_end_time TIMESTAMPTZ,
  run_id TEXT,
  correlation_id TEXT,
  intent_type TEXT,
  archived_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);

-- Add comment explaining the table purpose
COMMENT ON TABLE public.order_queue_archive IS 'Archived order_queue records from before V26 go-live (Jan 7, 2026 9:30 AM ET)';

-- Enable RLS (matching order_queue policies - assuming public read for bot data)
ALTER TABLE public.order_queue_archive ENABLE ROW LEVEL SECURITY;

-- Allow public read access (same as order_queue)
CREATE POLICY "Allow public read access to archived orders"
ON public.order_queue_archive
FOR SELECT
USING (true);