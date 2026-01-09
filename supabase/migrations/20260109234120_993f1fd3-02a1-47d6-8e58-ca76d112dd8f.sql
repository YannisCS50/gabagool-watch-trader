-- Create archive table for live_trades
CREATE TABLE public.live_trades_archive (
  id UUID NOT NULL,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  outcome TEXT NOT NULL,
  price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  created_at TIMESTAMPTZ,
  event_start_time TIMESTAMPTZ,
  event_end_time TIMESTAMPTZ,
  order_id TEXT,
  status TEXT,
  avg_fill_price NUMERIC,
  reasoning TEXT,
  arbitrage_edge NUMERIC,
  estimated_slippage NUMERIC,
  wallet_address TEXT,
  archived_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);

COMMENT ON TABLE public.live_trades_archive IS 'Archived live_trades from before V26 go-live (Jan 7, 2026 9:30 AM ET)';

ALTER TABLE public.live_trades_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to archived live_trades"
ON public.live_trades_archive FOR SELECT USING (true);

-- Create archive table for live_trade_results
CREATE TABLE public.live_trade_results_archive (
  id UUID NOT NULL,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  event_end_time TIMESTAMPTZ,
  up_shares NUMERIC,
  down_shares NUMERIC,
  up_avg_price NUMERIC,
  down_avg_price NUMERIC,
  up_cost NUMERIC,
  down_cost NUMERIC,
  total_invested NUMERIC,
  result TEXT,
  payout NUMERIC,
  profit_loss NUMERIC,
  profit_loss_percent NUMERIC,
  settled_at TIMESTAMPTZ,
  wallet_address TEXT,
  claim_status TEXT,
  claim_tx_hash TEXT,
  claim_usdc NUMERIC,
  claimed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id)
);

COMMENT ON TABLE public.live_trade_results_archive IS 'Archived live_trade_results from before V26 go-live (Jan 7, 2026 9:30 AM ET)';

ALTER TABLE public.live_trade_results_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access to archived live_trade_results"
ON public.live_trade_results_archive FOR SELECT USING (true);