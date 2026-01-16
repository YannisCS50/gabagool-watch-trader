-- V29 Response-Based Strategy Tables

-- Signals table (with exit tracking)
CREATE TABLE IF NOT EXISTS public.v29_signals_response (
  id UUID PRIMARY KEY,
  run_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  
  binance_price NUMERIC,
  binance_delta NUMERIC,
  binance_ts BIGINT,
  
  share_price_t0 NUMERIC,
  spread_t0 NUMERIC,
  best_bid_t0 NUMERIC,
  best_ask_t0 NUMERIC,
  
  market_slug TEXT,
  strike_price NUMERIC,
  
  status TEXT NOT NULL,
  skip_reason TEXT,
  entry_price NUMERIC,
  exit_price NUMERIC,
  shares NUMERIC,
  
  signal_ts BIGINT,
  decision_ts BIGINT,
  fill_ts BIGINT,
  exit_ts BIGINT,
  
  exit_type TEXT,
  exit_reason TEXT,
  
  gross_pnl NUMERIC,
  fees NUMERIC,
  net_pnl NUMERIC,
  
  price_at_1s NUMERIC,
  price_at_2s NUMERIC,
  price_at_3s NUMERIC,
  price_at_5s NUMERIC,
  
  decision_latency_ms INTEGER,
  order_latency_ms INTEGER,
  fill_latency_ms INTEGER,
  exit_latency_ms INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v29_signals_response_asset ON public.v29_signals_response(asset);
CREATE INDEX IF NOT EXISTS idx_v29_signals_response_created ON public.v29_signals_response(created_at);
CREATE INDEX IF NOT EXISTS idx_v29_signals_response_status ON public.v29_signals_response(status);

-- Ticks table
CREATE TABLE IF NOT EXISTS public.v29_ticks_response (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT,
  asset TEXT NOT NULL,
  ts BIGINT NOT NULL,
  binance_price NUMERIC,
  binance_delta NUMERIC,
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  market_slug TEXT,
  strike_price NUMERIC,
  signal_triggered BOOLEAN DEFAULT false,
  signal_direction TEXT,
  signal_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v29_ticks_response_asset_ts ON public.v29_ticks_response(asset, ts);

-- Logs table
CREATE TABLE IF NOT EXISTS public.v29_logs_response (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT,
  level TEXT,
  category TEXT,
  message TEXT,
  asset TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v29_logs_response_created ON public.v29_logs_response(created_at);

-- Config table
CREATE TABLE IF NOT EXISTS public.v29_config_response (
  id TEXT PRIMARY KEY DEFAULT 'v29-response',
  enabled BOOLEAN DEFAULT true,
  signal_delta_usd NUMERIC DEFAULT 6,
  signal_window_ms INTEGER DEFAULT 300,
  shares_per_trade INTEGER DEFAULT 5,
  up_target_min NUMERIC DEFAULT 1.8,
  up_target_max NUMERIC DEFAULT 2.0,
  up_max_hold_sec INTEGER DEFAULT 6,
  down_target_min NUMERIC DEFAULT 2.0,
  down_target_max NUMERIC DEFAULT 2.4,
  down_max_hold_sec INTEGER DEFAULT 7,
  config_json JSONB,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.v29_config_response (id) VALUES ('v29-response') ON CONFLICT DO NOTHING;