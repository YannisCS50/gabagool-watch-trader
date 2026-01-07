-- V26 Loveable Strategy Trades Table
CREATE TABLE public.v26_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  event_start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  event_end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- Order details
  order_id TEXT,
  side TEXT NOT NULL DEFAULT 'DOWN',
  price NUMERIC NOT NULL DEFAULT 0.48,
  shares INTEGER NOT NULL DEFAULT 10,
  notional NUMERIC GENERATED ALWAYS AS (price * shares) STORED,
  
  -- Order status
  status TEXT NOT NULL DEFAULT 'pending', -- pending, placed, filled, partial, cancelled, expired
  filled_shares INTEGER DEFAULT 0,
  avg_fill_price NUMERIC,
  fill_time_ms INTEGER, -- ms from order placed to fill
  
  -- Market result
  result TEXT, -- UP, DOWN, null if not settled
  pnl NUMERIC, -- calculated after settlement
  settled_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  run_id TEXT,
  error_message TEXT
);

-- Index for quick lookups
CREATE INDEX idx_v26_trades_asset ON public.v26_trades(asset);
CREATE INDEX idx_v26_trades_created ON public.v26_trades(created_at DESC);
CREATE INDEX idx_v26_trades_status ON public.v26_trades(status);
CREATE INDEX idx_v26_trades_market_id ON public.v26_trades(market_id);

-- Enable RLS (public read for dashboard, service role write from runner)
ALTER TABLE public.v26_trades ENABLE ROW LEVEL SECURITY;

-- Public can read all trades (dashboard)
CREATE POLICY "V26 trades are publicly readable" 
ON public.v26_trades 
FOR SELECT 
USING (true);

-- Service role can do everything (runner uses service role)
CREATE POLICY "Service role can manage V26 trades" 
ON public.v26_trades 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Enable realtime for live dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE public.v26_trades;

-- Summary view for dashboard stats
CREATE VIEW public.v26_stats AS
SELECT 
  COUNT(*) as total_trades,
  COUNT(*) FILTER (WHERE status = 'filled') as filled_trades,
  COUNT(*) FILTER (WHERE result IS NOT NULL) as settled_trades,
  COUNT(*) FILTER (WHERE result = 'DOWN') as wins,
  COUNT(*) FILTER (WHERE result = 'UP') as losses,
  ROUND(
    COUNT(*) FILTER (WHERE result = 'DOWN')::NUMERIC / 
    NULLIF(COUNT(*) FILTER (WHERE result IS NOT NULL), 0) * 100, 
    1
  ) as win_rate_pct,
  COALESCE(SUM(pnl), 0) as total_pnl,
  COALESCE(SUM(notional) FILTER (WHERE status = 'filled'), 0) as total_invested,
  MAX(created_at) as last_trade_at
FROM public.v26_trades;