
-- Create table for True P&L hourly snapshots
CREATE TABLE public.true_pnl_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  hour TIMESTAMP WITH TIME ZONE NOT NULL,
  total_deposits NUMERIC NOT NULL DEFAULT 0,
  clob_balance NUMERIC NOT NULL DEFAULT 0,
  open_orders_value NUMERIC NOT NULL DEFAULT 0,
  running_bets_value NUMERIC NOT NULL DEFAULT 0,
  portfolio_value NUMERIC NOT NULL DEFAULT 0,
  true_pnl NUMERIC NOT NULL DEFAULT 0,
  true_pnl_percent NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(hour)
);

-- Enable RLS
ALTER TABLE public.true_pnl_snapshots ENABLE ROW LEVEL SECURITY;

-- Allow public read access (no auth required for dashboard)
CREATE POLICY "Anyone can view true_pnl_snapshots" 
ON public.true_pnl_snapshots 
FOR SELECT 
USING (true);

-- Allow insert from service role (edge functions)
CREATE POLICY "Service role can insert snapshots" 
ON public.true_pnl_snapshots 
FOR INSERT 
WITH CHECK (true);

-- Allow update for upsert operations
CREATE POLICY "Service role can update snapshots" 
ON public.true_pnl_snapshots 
FOR UPDATE 
USING (true);

-- Add index for efficient queries
CREATE INDEX idx_true_pnl_snapshots_hour ON public.true_pnl_snapshots(hour DESC);

-- Add comment
COMMENT ON TABLE public.true_pnl_snapshots IS 'Hourly snapshots of True P&L for tracking performance over time';
