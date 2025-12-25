-- Create order queue table for edge function -> runner communication
CREATE TABLE public.order_queue (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  outcome TEXT NOT NULL,
  token_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'GTC',
  reasoning TEXT,
  event_start_time TIMESTAMP WITH TIME ZONE,
  event_end_time TIMESTAMP WITH TIME ZONE,
  -- Execution results (filled by runner)
  executed_at TIMESTAMP WITH TIME ZONE,
  order_id TEXT,
  avg_fill_price NUMERIC,
  error_message TEXT
);

-- Enable RLS
ALTER TABLE public.order_queue ENABLE ROW LEVEL SECURITY;

-- Allow public read (for dashboard)
CREATE POLICY "Allow public read for order_queue"
ON public.order_queue
FOR SELECT
USING (true);

-- Allow service insert (from edge functions)
CREATE POLICY "Allow service insert for order_queue"
ON public.order_queue
FOR INSERT
WITH CHECK (true);

-- Allow service update (from runner proxy)
CREATE POLICY "Allow service update for order_queue"
ON public.order_queue
FOR UPDATE
USING (true);

-- Allow service delete (for cleanup)
CREATE POLICY "Allow service delete for order_queue"
ON public.order_queue
FOR DELETE
USING (true);

-- Index for efficient polling
CREATE INDEX idx_order_queue_pending ON public.order_queue (status, created_at) WHERE status = 'pending';