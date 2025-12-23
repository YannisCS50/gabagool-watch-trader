-- Create paper_trades table for individual paper trades
CREATE TABLE public.paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  
  -- Trade details
  outcome TEXT NOT NULL,
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  
  -- Context at decision moment
  combined_price NUMERIC,
  arbitrage_edge NUMERIC,
  crypto_price NUMERIC,
  open_price NUMERIC,
  price_delta NUMERIC,
  price_delta_percent NUMERIC,
  remaining_seconds INTEGER,
  
  -- Decision metadata
  trade_type TEXT,
  reasoning TEXT,
  
  -- Timing
  event_start_time TIMESTAMPTZ,
  event_end_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create paper_trade_results table for settled markets
CREATE TABLE public.paper_trade_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_slug TEXT UNIQUE NOT NULL,
  asset TEXT NOT NULL,
  
  -- Position summary
  up_shares NUMERIC DEFAULT 0,
  up_cost NUMERIC DEFAULT 0,
  up_avg_price NUMERIC DEFAULT 0,
  down_shares NUMERIC DEFAULT 0,
  down_cost NUMERIC DEFAULT 0,
  down_avg_price NUMERIC DEFAULT 0,
  total_invested NUMERIC DEFAULT 0,
  
  -- Result
  result TEXT,
  payout NUMERIC,
  profit_loss NUMERIC,
  profit_loss_percent NUMERIC,
  
  event_end_time TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_trade_results ENABLE ROW LEVEL SECURITY;

-- RLS policies for paper_trades
CREATE POLICY "Allow public read for paper_trades" 
ON public.paper_trades FOR SELECT USING (true);

CREATE POLICY "Allow service insert for paper_trades" 
ON public.paper_trades FOR INSERT WITH CHECK (true);

-- RLS policies for paper_trade_results
CREATE POLICY "Allow public read for paper_trade_results" 
ON public.paper_trade_results FOR SELECT USING (true);

CREATE POLICY "Allow service insert for paper_trade_results" 
ON public.paper_trade_results FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow service update for paper_trade_results" 
ON public.paper_trade_results FOR UPDATE USING (true);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_trade_results;

-- Create indexes for performance
CREATE INDEX idx_paper_trades_market_slug ON public.paper_trades(market_slug);
CREATE INDEX idx_paper_trades_event_end_time ON public.paper_trades(event_end_time);
CREATE INDEX idx_paper_trade_results_settled ON public.paper_trade_results(settled_at);