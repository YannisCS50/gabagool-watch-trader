-- Create table to track external wallet trades
CREATE TABLE public.tracked_wallet_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  trade_id TEXT NOT NULL UNIQUE,
  timestamp TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL, -- BUY or SELL
  asset TEXT,
  market_slug TEXT,
  outcome TEXT,
  size NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  fee NUMERIC,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index for efficient querying
CREATE INDEX idx_tracked_wallet_trades_wallet ON public.tracked_wallet_trades(wallet_address);
CREATE INDEX idx_tracked_wallet_trades_timestamp ON public.tracked_wallet_trades(timestamp DESC);

-- Enable RLS
ALTER TABLE public.tracked_wallet_trades ENABLE ROW LEVEL SECURITY;

-- Allow public read (since we're tracking public blockchain data)
CREATE POLICY "Anyone can view tracked trades" 
ON public.tracked_wallet_trades 
FOR SELECT 
USING (true);

-- Only backend can insert
CREATE POLICY "Service role can insert" 
ON public.tracked_wallet_trades 
FOR INSERT 
WITH CHECK (true);

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.tracked_wallet_trades;