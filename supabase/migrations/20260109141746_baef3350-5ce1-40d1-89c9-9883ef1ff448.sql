-- =============================================================
-- HISTORICAL & TIME-BASED PNL TABLES
-- =============================================================

-- Account cashflow timeseries for daily PnL charts
CREATE TABLE IF NOT EXISTS public.account_cashflow_timeseries (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts timestamp with time zone NOT NULL,
  date date NOT NULL,
  market_id text NOT NULL,
  outcome text,
  category text NOT NULL, -- BUY | SELL | REDEEM | FEE
  amount_usd numeric NOT NULL DEFAULT 0,
  shares_delta numeric NOT NULL DEFAULT 0,
  wallet text NOT NULL,
  source_event_id text,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(wallet, source_event_id)
);

-- Daily PnL aggregation
CREATE TABLE IF NOT EXISTS public.daily_pnl (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  date date NOT NULL,
  wallet text NOT NULL,
  realized_pnl numeric NOT NULL DEFAULT 0,
  unrealized_pnl numeric NOT NULL DEFAULT 0,
  total_pnl numeric NOT NULL DEFAULT 0,
  volume_traded numeric NOT NULL DEFAULT 0,
  markets_active integer NOT NULL DEFAULT 0,
  buy_count integer NOT NULL DEFAULT 0,
  sell_count integer NOT NULL DEFAULT 0,
  redeem_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  UNIQUE(wallet, date)
);

-- Account PnL summary (single row per wallet)
CREATE TABLE IF NOT EXISTS public.account_pnl_summary (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL UNIQUE,
  total_realized_pnl numeric NOT NULL DEFAULT 0,
  total_unrealized_pnl numeric NOT NULL DEFAULT 0,
  total_pnl numeric NOT NULL DEFAULT 0,
  first_trade_ts timestamp with time zone,
  last_trade_ts timestamp with time zone,
  total_trades integer NOT NULL DEFAULT 0,
  total_markets integer NOT NULL DEFAULT 0,
  total_volume numeric NOT NULL DEFAULT 0,
  claimed_markets integer NOT NULL DEFAULT 0,
  lost_markets integer NOT NULL DEFAULT 0,
  open_markets integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Sync state for tracking full historical ingestion
CREATE TABLE IF NOT EXISTS public.subgraph_ingest_state (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL UNIQUE,
  oldest_event_ts timestamp with time zone,
  newest_event_ts timestamp with time zone,
  total_events_ingested integer NOT NULL DEFAULT 0,
  last_sync_at timestamp with time zone DEFAULT now(),
  is_complete boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Indexes for time-based queries
CREATE INDEX IF NOT EXISTS idx_account_cashflow_ts ON public.account_cashflow_timeseries(wallet, ts DESC);
CREATE INDEX IF NOT EXISTS idx_account_cashflow_date ON public.account_cashflow_timeseries(wallet, date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON public.daily_pnl(wallet, date DESC);

-- Enable RLS
ALTER TABLE public.account_cashflow_timeseries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_pnl ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_pnl_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_ingest_state ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Public read account_cashflow_timeseries" ON public.account_cashflow_timeseries
  FOR SELECT USING (true);

CREATE POLICY "Public read daily_pnl" ON public.daily_pnl
  FOR SELECT USING (true);

CREATE POLICY "Public read account_pnl_summary" ON public.account_pnl_summary
  FOR SELECT USING (true);

CREATE POLICY "Public read subgraph_ingest_state" ON public.subgraph_ingest_state
  FOR SELECT USING (true);

-- View for daily PnL with running total
CREATE OR REPLACE VIEW public.v_daily_pnl_cumulative AS
SELECT 
  date,
  wallet,
  realized_pnl,
  unrealized_pnl,
  total_pnl,
  volume_traded,
  markets_active,
  SUM(realized_pnl) OVER (PARTITION BY wallet ORDER BY date) as cumulative_realized_pnl,
  SUM(total_pnl) OVER (PARTITION BY wallet ORDER BY date) as cumulative_total_pnl
FROM public.daily_pnl
ORDER BY date DESC;