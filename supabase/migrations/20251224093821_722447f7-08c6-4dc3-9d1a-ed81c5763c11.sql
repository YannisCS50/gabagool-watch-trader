-- Create live_trades table (similar to paper_trades)
CREATE TABLE public.live_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  order_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  event_start_time TIMESTAMP WITH TIME ZONE,
  event_end_time TIMESTAMP WITH TIME ZONE,
  reasoning TEXT,
  arbitrage_edge NUMERIC,
  avg_fill_price NUMERIC,
  estimated_slippage NUMERIC
);

-- Create live_trade_results table (similar to paper_trade_results)
CREATE TABLE public.live_trade_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  up_shares NUMERIC DEFAULT 0,
  up_cost NUMERIC DEFAULT 0,
  up_avg_price NUMERIC DEFAULT 0,
  down_shares NUMERIC DEFAULT 0,
  down_cost NUMERIC DEFAULT 0,
  down_avg_price NUMERIC DEFAULT 0,
  total_invested NUMERIC DEFAULT 0,
  payout NUMERIC,
  profit_loss NUMERIC,
  profit_loss_percent NUMERIC,
  result TEXT,
  event_end_time TIMESTAMP WITH TIME ZONE,
  settled_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.live_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_trade_results ENABLE ROW LEVEL SECURITY;

-- RLS policies for live_trades
CREATE POLICY "Allow public read for live_trades" ON public.live_trades FOR SELECT USING (true);
CREATE POLICY "Allow service insert for live_trades" ON public.live_trades FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service update for live_trades" ON public.live_trades FOR UPDATE USING (true);

-- RLS policies for live_trade_results
CREATE POLICY "Allow public read for live_trade_results" ON public.live_trade_results FOR SELECT USING (true);
CREATE POLICY "Allow service insert for live_trade_results" ON public.live_trade_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service update for live_trade_results" ON public.live_trade_results FOR UPDATE USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_trades;
ALTER PUBLICATION supabase_realtime ADD TABLE public.live_trade_results;