-- Paper trading signals table
CREATE TABLE public.paper_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  run_id TEXT,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  signal_ts BIGINT NOT NULL,
  binance_price NUMERIC NOT NULL,
  binance_delta NUMERIC NOT NULL,
  chainlink_price NUMERIC,
  share_price NUMERIC NOT NULL,
  market_slug TEXT,
  strike_price NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'filled', 'sold', 'expired', 'failed')),
  entry_price NUMERIC,
  exit_price NUMERIC,
  fill_ts BIGINT,
  sell_ts BIGINT,
  order_type TEXT CHECK (order_type IN ('maker', 'taker')),
  entry_fee NUMERIC,
  exit_fee NUMERIC,
  total_fees NUMERIC,
  gross_pnl NUMERIC,
  net_pnl NUMERIC,
  tp_price NUMERIC,
  tp_status TEXT CHECK (tp_status IN ('pending', 'filled', 'cancelled')),
  sl_price NUMERIC,
  sl_status TEXT CHECK (sl_status IN ('pending', 'filled', 'cancelled')),
  exit_type TEXT CHECK (exit_type IN ('tp', 'sl', 'timeout')),
  trade_size_usd NUMERIC DEFAULT 25,
  shares NUMERIC,
  notes TEXT,
  config_snapshot JSONB,
  is_live BOOLEAN DEFAULT false
);

-- Index for fast queries
CREATE INDEX idx_paper_signals_asset_ts ON public.paper_signals(asset, signal_ts DESC);
CREATE INDEX idx_paper_signals_status ON public.paper_signals(status);
CREATE INDEX idx_paper_signals_run_id ON public.paper_signals(run_id);

-- TP/SL monitoring events
CREATE TABLE public.paper_tp_sl_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  signal_id UUID REFERENCES public.paper_signals(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  current_bid NUMERIC NOT NULL,
  tp_price NUMERIC,
  sl_price NUMERIC,
  tp_distance_cents NUMERIC,
  sl_distance_cents NUMERIC,
  triggered TEXT CHECK (triggered IN ('tp', 'sl', NULL))
);

CREATE INDEX idx_paper_tp_sl_signal ON public.paper_tp_sl_events(signal_id, ts DESC);

-- Price snapshots for analysis
CREATE TABLE public.paper_price_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  asset TEXT NOT NULL,
  binance_price NUMERIC,
  chainlink_price NUMERIC,
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  market_slug TEXT,
  strike_price NUMERIC
);

CREATE INDEX idx_paper_price_snapshots_asset_ts ON public.paper_price_snapshots(asset, ts DESC);

-- Paper trading config
CREATE TABLE public.paper_trading_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  enabled BOOLEAN DEFAULT true,
  is_live BOOLEAN DEFAULT false,
  trade_size_usd NUMERIC DEFAULT 5,
  min_delta_usd NUMERIC DEFAULT 10,
  min_share_price NUMERIC DEFAULT 0.35,
  max_share_price NUMERIC DEFAULT 0.65,
  tp_cents NUMERIC DEFAULT 3,
  tp_enabled BOOLEAN DEFAULT true,
  sl_cents NUMERIC DEFAULT 3,
  sl_enabled BOOLEAN DEFAULT true,
  timeout_ms INTEGER DEFAULT 15000,
  assets TEXT[] DEFAULT ARRAY['BTC', 'ETH', 'SOL', 'XRP']
);

-- Insert default config
INSERT INTO public.paper_trading_config (enabled, is_live, trade_size_usd) 
VALUES (true, false, 5);

-- Enable RLS
ALTER TABLE public.paper_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_tp_sl_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_trading_config ENABLE ROW LEVEL SECURITY;

-- Public read/write for now (internal bot use)
CREATE POLICY "Allow all for paper_signals" ON public.paper_signals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for paper_tp_sl_events" ON public.paper_tp_sl_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for paper_price_snapshots" ON public.paper_price_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for paper_trading_config" ON public.paper_trading_config FOR ALL USING (true) WITH CHECK (true);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_signals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_tp_sl_events;