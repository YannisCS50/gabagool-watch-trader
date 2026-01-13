-- V29 Accumulation & Auto-Hedge: New table and config columns

-- 1. Create v29_positions table for aggregate position tracking
CREATE TABLE public.v29_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('UP', 'DOWN')),
  market_slug TEXT NOT NULL,
  token_id TEXT,
  total_shares INTEGER DEFAULT 0,
  total_cost NUMERIC(12,4) DEFAULT 0,
  hedge_shares INTEGER DEFAULT 0,
  hedge_cost NUMERIC(12,4) DEFAULT 0,
  is_fully_hedged BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(asset, side, market_slug)
);

-- Enable RLS
ALTER TABLE public.v29_positions ENABLE ROW LEVEL SECURITY;

-- Allow public access (runner uses service role, dashboard uses anon)
CREATE POLICY "Allow public read on v29_positions" 
ON public.v29_positions FOR SELECT USING (true);

CREATE POLICY "Allow public insert on v29_positions" 
ON public.v29_positions FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on v29_positions" 
ON public.v29_positions FOR UPDATE USING (true);

CREATE POLICY "Allow public delete on v29_positions" 
ON public.v29_positions FOR DELETE USING (true);

-- Add updated_at trigger
CREATE TRIGGER update_v29_positions_updated_at
BEFORE UPDATE ON public.v29_positions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Add new columns to v29_config for accumulation and hedge settings
ALTER TABLE public.v29_config 
ADD COLUMN IF NOT EXISTS accumulation_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS max_total_cost_usd NUMERIC(10,2) DEFAULT 75,
ADD COLUMN IF NOT EXISTS max_total_shares INTEGER DEFAULT 300,
ADD COLUMN IF NOT EXISTS auto_hedge_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS hedge_trigger_cents INTEGER DEFAULT 15,
ADD COLUMN IF NOT EXISTS hedge_min_profit_cents INTEGER DEFAULT 10;

-- Enable realtime for v29_positions
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_positions;