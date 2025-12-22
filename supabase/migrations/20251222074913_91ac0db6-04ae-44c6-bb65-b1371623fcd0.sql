-- Create trades table to store scraped trades
CREATE TABLE public.trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  external_id TEXT UNIQUE,
  trader_username TEXT NOT NULL DEFAULT 'gabagool22',
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  market TEXT NOT NULL,
  market_slug TEXT,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  status TEXT DEFAULT 'filled',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create positions table for active positions
CREATE TABLE public.positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL DEFAULT 'gabagool22',
  market TEXT NOT NULL,
  market_slug TEXT,
  outcome TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  avg_price NUMERIC NOT NULL,
  current_price NUMERIC,
  pnl NUMERIC DEFAULT 0,
  pnl_percent NUMERIC DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(trader_username, market_slug, outcome)
);

-- Create trader stats table
CREATE TABLE public.trader_stats (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trader_username TEXT NOT NULL UNIQUE DEFAULT 'gabagool22',
  total_trades INTEGER DEFAULT 0,
  total_volume NUMERIC DEFAULT 0,
  win_rate NUMERIC DEFAULT 0,
  avg_trade_size NUMERIC DEFAULT 0,
  active_since TIMESTAMP WITH TIME ZONE,
  last_active TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trader_stats ENABLE ROW LEVEL SECURITY;

-- Public read access for all tables (tracking is public)
CREATE POLICY "Public read access for trades" 
  ON public.trades FOR SELECT USING (true);

CREATE POLICY "Public read access for positions" 
  ON public.positions FOR SELECT USING (true);

CREATE POLICY "Public read access for trader_stats" 
  ON public.trader_stats FOR SELECT USING (true);

-- Insert initial trader stats
INSERT INTO public.trader_stats (trader_username, active_since, last_active)
VALUES ('gabagool22', '2023-06-15', now());