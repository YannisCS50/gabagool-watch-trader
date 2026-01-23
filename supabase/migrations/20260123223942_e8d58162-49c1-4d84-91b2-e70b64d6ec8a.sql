-- V35 Settlements table for tracking completed markets
CREATE TABLE public.v35_settlements (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  up_qty NUMERIC DEFAULT 0,
  down_qty NUMERIC DEFAULT 0,
  up_cost NUMERIC DEFAULT 0,
  down_cost NUMERIC DEFAULT 0,
  paired NUMERIC DEFAULT 0,
  unpaired NUMERIC DEFAULT 0,
  combined_cost NUMERIC DEFAULT 0,
  locked_profit NUMERIC DEFAULT 0,
  winning_side TEXT,
  pnl NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add V35-specific columns to runner_heartbeats if they don't exist
ALTER TABLE public.runner_heartbeats 
ADD COLUMN IF NOT EXISTS mode TEXT,
ADD COLUMN IF NOT EXISTS dry_run BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS total_locked_profit NUMERIC DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_unpaired NUMERIC DEFAULT 0;

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_v35_settlements_created_at ON public.v35_settlements(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v35_settlements_asset ON public.v35_settlements(asset);

-- Enable RLS
ALTER TABLE public.v35_settlements ENABLE ROW LEVEL SECURITY;

-- Allow public read access (data is not user-specific)
CREATE POLICY "Allow public read access to v35_settlements" 
ON public.v35_settlements 
FOR SELECT 
USING (true);

-- Allow insert from service role
CREATE POLICY "Allow service role insert to v35_settlements" 
ON public.v35_settlements 
FOR INSERT 
WITH CHECK (true);