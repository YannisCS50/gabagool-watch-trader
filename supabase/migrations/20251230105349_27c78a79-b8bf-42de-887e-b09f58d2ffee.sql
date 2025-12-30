
-- Create table for synced bot positions from Polymarket
CREATE TABLE public.bot_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  outcome TEXT NOT NULL,
  shares NUMERIC NOT NULL DEFAULT 0,
  avg_price NUMERIC NOT NULL DEFAULT 0,
  current_price NUMERIC,
  value NUMERIC,
  cost NUMERIC,
  pnl NUMERIC,
  pnl_percent NUMERIC,
  token_id TEXT,
  synced_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(wallet_address, market_slug, outcome)
);

-- Enable RLS
ALTER TABLE public.bot_positions ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "Allow public read for bot_positions"
ON public.bot_positions
FOR SELECT
USING (true);

-- Allow service insert/update/delete
CREATE POLICY "Allow service insert for bot_positions"
ON public.bot_positions
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service update for bot_positions"
ON public.bot_positions
FOR UPDATE
USING (true);

CREATE POLICY "Allow service delete for bot_positions"
ON public.bot_positions
FOR DELETE
USING (true);

-- Add to realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_positions;
