-- Create table for arbitrage simulator paper trades
CREATE TABLE public.arbitrage_paper_trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Trade identification
  signal_id TEXT NOT NULL,
  session_id TEXT,
  
  -- Market info
  asset TEXT NOT NULL,
  market_slug TEXT,
  strike_price NUMERIC,
  
  -- Trade details
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  order_type TEXT CHECK (order_type IN ('maker', 'taker')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'sold', 'failed', 'expired')),
  
  -- Prices
  binance_price NUMERIC,
  chainlink_price NUMERIC,
  delta_usd NUMERIC,
  share_price NUMERIC,
  entry_price NUMERIC,
  exit_price NUMERIC,
  
  -- Timing
  signal_ts BIGINT NOT NULL,
  fill_ts BIGINT,
  sell_ts BIGINT,
  fill_time_ms INTEGER,
  hold_time_ms INTEGER,
  
  -- PnL
  gross_pnl NUMERIC,
  entry_fee NUMERIC,
  exit_fee NUMERIC,
  total_fees NUMERIC,
  net_pnl NUMERIC,
  
  -- Metadata
  reason TEXT,
  config_snapshot JSONB
);

-- Enable RLS
ALTER TABLE public.arbitrage_paper_trades ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for paper trades (no auth required for simulator)
CREATE POLICY "Allow public read access"
ON public.arbitrage_paper_trades
FOR SELECT
USING (true);

CREATE POLICY "Allow public insert access"
ON public.arbitrage_paper_trades
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public update access"
ON public.arbitrage_paper_trades
FOR UPDATE
USING (true);

-- Index for querying by asset and time
CREATE INDEX idx_arbitrage_paper_trades_asset_ts ON public.arbitrage_paper_trades(asset, signal_ts DESC);
CREATE INDEX idx_arbitrage_paper_trades_session ON public.arbitrage_paper_trades(session_id, created_at DESC);
CREATE INDEX idx_arbitrage_paper_trades_status ON public.arbitrage_paper_trades(status);

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.arbitrage_paper_trades;