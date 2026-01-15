-- V30 Market-Maker Strategy Tables

-- Configuration table
CREATE TABLE public.v30_config (
  id text PRIMARY KEY DEFAULT 'default',
  enabled boolean DEFAULT false,
  assets text[] DEFAULT ARRAY['BTC', 'ETH', 'SOL', 'XRP'],
  fair_value_model text DEFAULT 'empirical',
  base_theta numeric DEFAULT 0.03,
  theta_time_decay_factor numeric DEFAULT 0.5,
  theta_inventory_factor numeric DEFAULT 0.3,
  i_max_base integer DEFAULT 500,
  bet_size_base integer DEFAULT 50,
  bet_size_vol_factor numeric DEFAULT 0.5,
  force_counter_at_pct numeric DEFAULT 0.8,
  aggressive_exit_sec integer DEFAULT 60,
  min_share_price numeric DEFAULT 0.05,
  max_share_price numeric DEFAULT 0.95,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Per-tick data for analysis
CREATE TABLE public.v30_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts bigint NOT NULL,
  run_id text,
  asset text NOT NULL,
  market_slug text,
  c_price numeric,
  z_price numeric,
  strike_price numeric,
  seconds_remaining integer,
  delta_to_strike numeric,
  up_best_ask numeric,
  up_best_bid numeric,
  down_best_ask numeric,
  down_best_bid numeric,
  fair_p_up numeric,
  edge_up numeric,
  edge_down numeric,
  theta_current numeric,
  inventory_up integer DEFAULT 0,
  inventory_down integer DEFAULT 0,
  inventory_net integer DEFAULT 0,
  action_taken text,
  created_at timestamptz DEFAULT now()
);

-- Realtime position tracking
CREATE TABLE public.v30_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  asset text NOT NULL,
  market_slug text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('UP', 'DOWN')),
  shares integer DEFAULT 0,
  avg_entry_price numeric DEFAULT 0,
  total_cost numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(run_id, asset, market_slug, direction)
);

-- Enable RLS
ALTER TABLE public.v30_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v30_ticks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v30_positions ENABLE ROW LEVEL SECURITY;

-- Public read/write policies (internal trading system)
CREATE POLICY "Allow all on v30_config" ON public.v30_config FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on v30_ticks" ON public.v30_ticks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on v30_positions" ON public.v30_positions FOR ALL USING (true) WITH CHECK (true);

-- Indexes for performance
CREATE INDEX idx_v30_ticks_ts ON public.v30_ticks(ts DESC);
CREATE INDEX idx_v30_ticks_asset ON public.v30_ticks(asset, ts DESC);
CREATE INDEX idx_v30_ticks_run ON public.v30_ticks(run_id, ts DESC);
CREATE INDEX idx_v30_positions_run ON public.v30_positions(run_id, asset);

-- Insert default config
INSERT INTO public.v30_config (id) VALUES ('default');

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.v30_ticks;
ALTER PUBLICATION supabase_realtime ADD TABLE public.v30_positions;