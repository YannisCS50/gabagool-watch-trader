
-- Create position snapshots table to track position changes over time
CREATE TABLE public.position_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL DEFAULT 'gabagool22',
  market_slug TEXT NOT NULL,
  market_title TEXT,
  outcome TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  avg_price NUMERIC NOT NULL,
  current_price NUMERIC,
  value NUMERIC,
  pnl NUMERIC,
  pnl_percent NUMERIC,
  is_closed BOOLEAN DEFAULT false,
  snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add index for efficient querying
CREATE INDEX idx_position_snapshots_trader ON public.position_snapshots(trader_username);
CREATE INDEX idx_position_snapshots_market ON public.position_snapshots(market_slug);
CREATE INDEX idx_position_snapshots_time ON public.position_snapshots(snapshot_at DESC);
CREATE INDEX idx_position_snapshots_closed ON public.position_snapshots(is_closed);

-- Enable RLS
ALTER TABLE public.position_snapshots ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "Allow public read for position_snapshots" 
ON public.position_snapshots 
FOR SELECT 
USING (true);

-- Allow service insert
CREATE POLICY "Allow service insert for position_snapshots" 
ON public.position_snapshots 
FOR INSERT 
WITH CHECK (true);

-- Enable realtime for position updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.position_snapshots;
