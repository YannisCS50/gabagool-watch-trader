
-- Create hedge_feasibility table to track if each bet could have been hedged
CREATE TABLE public.hedge_feasibility (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  
  -- Opening trade info
  opening_side TEXT NOT NULL, -- 'UP' or 'DOWN'
  opening_price NUMERIC NOT NULL,
  opening_shares NUMERIC NOT NULL,
  opening_at TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- Hedge requirement
  hedge_side TEXT NOT NULL, -- opposite of opening
  max_hedge_price NUMERIC NOT NULL, -- max price to break even (1.00 - opening_price)
  
  -- What we observed
  min_hedge_ask_seen NUMERIC, -- lowest ask we saw for hedge side
  min_hedge_ask_at TIMESTAMP WITH TIME ZONE,
  hedge_window_seconds INTEGER, -- how long hedge was possible
  
  -- Actual outcome
  was_hedged BOOLEAN NOT NULL DEFAULT false,
  actual_hedge_price NUMERIC,
  actual_hedge_at TIMESTAMP WITH TIME ZONE,
  
  -- Feasibility verdict
  hedge_was_possible BOOLEAN NOT NULL DEFAULT false, -- could we have hedged at <=1.00 combined?
  hedge_was_profitable BOOLEAN NOT NULL DEFAULT false, -- could we have hedged at <0.97 combined?
  
  -- Timing
  event_end_time TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  UNIQUE(market_id)
);

-- Enable RLS
ALTER TABLE public.hedge_feasibility ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Allow public read for hedge_feasibility" 
ON public.hedge_feasibility 
FOR SELECT 
USING (true);

CREATE POLICY "Allow service insert for hedge_feasibility" 
ON public.hedge_feasibility 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow service update for hedge_feasibility" 
ON public.hedge_feasibility 
FOR UPDATE 
USING (true);

-- Add index for querying
CREATE INDEX idx_hedge_feasibility_asset ON public.hedge_feasibility(asset);
CREATE INDEX idx_hedge_feasibility_created ON public.hedge_feasibility(created_at DESC);
