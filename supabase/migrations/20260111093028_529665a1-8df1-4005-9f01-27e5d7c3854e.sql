-- V27 Delta Mispricing Strategy Tables

-- Main evaluations table (every tick evaluation)
CREATE TABLE IF NOT EXISTS public.v27_evaluations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  
  -- Spot data
  spot_price NUMERIC,
  spot_source TEXT,
  
  -- Polymarket prices
  pm_up_bid NUMERIC,
  pm_up_ask NUMERIC,
  pm_down_bid NUMERIC,
  pm_down_ask NUMERIC,
  
  -- Delta / Mispricing
  theoretical_up NUMERIC,
  theoretical_down NUMERIC,
  delta_up NUMERIC,
  delta_down NUMERIC,
  mispricing_side TEXT, -- 'UP', 'DOWN', or null
  mispricing_magnitude NUMERIC,
  
  -- Thresholds
  base_threshold NUMERIC,
  dynamic_threshold NUMERIC,
  threshold_source TEXT, -- 'base', 'p90', 'rolling'
  
  -- Adverse selection filter
  taker_flow_p90 NUMERIC,
  book_imbalance NUMERIC,
  spread_expansion NUMERIC,
  adverse_blocked BOOLEAN DEFAULT false,
  adverse_reason TEXT,
  
  -- Causality check
  causality_passed BOOLEAN,
  spot_leading_ms NUMERIC,
  
  -- Decision
  signal_valid BOOLEAN DEFAULT false,
  action TEXT, -- 'ENTRY', 'HOLD', 'SKIP'
  skip_reason TEXT
);

-- V27 Entries (opened positions via passive limit)
CREATE TABLE IF NOT EXISTS public.v27_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_slug TEXT,
  
  -- Entry details
  side TEXT NOT NULL, -- 'UP' or 'DOWN'
  entry_price NUMERIC NOT NULL,
  shares NUMERIC NOT NULL,
  notional NUMERIC NOT NULL,
  
  -- Mispricing at entry
  mispricing_at_entry NUMERIC,
  threshold_at_entry NUMERIC,
  expected_correction NUMERIC,
  
  -- Order tracking
  order_id TEXT,
  order_status TEXT DEFAULT 'pending',
  filled_shares NUMERIC DEFAULT 0,
  avg_fill_price NUMERIC,
  
  -- Correction tracking
  correction_started_at TIMESTAMP WITH TIME ZONE,
  correction_completed_at TIMESTAMP WITH TIME ZONE,
  peak_correction NUMERIC,
  
  -- Hedge
  hedge_triggered BOOLEAN DEFAULT false,
  hedge_order_id TEXT,
  hedge_filled_shares NUMERIC,
  hedge_avg_price NUMERIC,
  hedge_at TIMESTAMP WITH TIME ZONE,
  
  -- Result
  status TEXT DEFAULT 'open', -- 'open', 'corrected', 'hedged', 'expired', 'settled'
  exit_price NUMERIC,
  pnl NUMERIC,
  result TEXT -- 'WIN', 'LOSS', or null
);

-- V27 Corrections (price movement tracking)
CREATE TABLE IF NOT EXISTS public.v27_corrections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  entry_id UUID REFERENCES public.v27_entries(id),
  ts BIGINT NOT NULL,
  
  -- Price movement
  current_price NUMERIC NOT NULL,
  expected_price NUMERIC NOT NULL,
  correction_pct NUMERIC NOT NULL,
  
  -- Status
  is_complete BOOLEAN DEFAULT false
);

-- V27 Signals (detected mispricing signals)
CREATE TABLE IF NOT EXISTS public.v27_signals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  
  -- Signal details
  signal_side TEXT NOT NULL, -- 'UP' or 'DOWN'
  mispricing NUMERIC NOT NULL,
  threshold NUMERIC NOT NULL,
  confidence NUMERIC,
  
  -- Whether acted upon
  action_taken BOOLEAN DEFAULT false,
  entry_id UUID REFERENCES public.v27_entries(id)
);

-- V27 Metrics (aggregated KPIs)
CREATE TABLE IF NOT EXISTS public.v27_metrics (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  
  -- Signal quality
  total_signals INTEGER DEFAULT 0,
  valid_signals INTEGER DEFAULT 0,
  signal_quality_pct NUMERIC,
  
  -- Adverse selection
  adverse_blocks INTEGER DEFAULT 0,
  adverse_block_reasons JSONB,
  
  -- Entry stats
  entries_attempted INTEGER DEFAULT 0,
  entries_filled INTEGER DEFAULT 0,
  fill_rate NUMERIC,
  avg_fill_time_ms NUMERIC,
  
  -- Correction stats
  corrections_detected INTEGER DEFAULT 0,
  corrections_completed INTEGER DEFAULT 0,
  avg_correction_pct NUMERIC,
  avg_correction_time_ms NUMERIC,
  
  -- Hedge stats
  hedges_triggered INTEGER DEFAULT 0,
  emergency_hedges INTEGER DEFAULT 0,
  hedge_success_rate NUMERIC,
  
  -- PnL
  gross_pnl NUMERIC DEFAULT 0,
  fees_paid NUMERIC DEFAULT 0,
  net_pnl NUMERIC DEFAULT 0,
  
  -- Win/Loss
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  win_rate NUMERIC
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_v27_evaluations_ts ON public.v27_evaluations(ts DESC);
CREATE INDEX IF NOT EXISTS idx_v27_evaluations_asset ON public.v27_evaluations(asset);
CREATE INDEX IF NOT EXISTS idx_v27_entries_status ON public.v27_entries(status);
CREATE INDEX IF NOT EXISTS idx_v27_entries_asset ON public.v27_entries(asset);
CREATE INDEX IF NOT EXISTS idx_v27_signals_ts ON public.v27_signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_v27_metrics_ts ON public.v27_metrics(ts DESC);

-- Enable RLS
ALTER TABLE public.v27_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v27_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v27_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v27_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v27_metrics ENABLE ROW LEVEL SECURITY;

-- Public read policies (internal bot data, no user ownership)
CREATE POLICY "Allow public read v27_evaluations" ON public.v27_evaluations FOR SELECT USING (true);
CREATE POLICY "Allow public read v27_entries" ON public.v27_entries FOR SELECT USING (true);
CREATE POLICY "Allow public read v27_corrections" ON public.v27_corrections FOR SELECT USING (true);
CREATE POLICY "Allow public read v27_signals" ON public.v27_signals FOR SELECT USING (true);
CREATE POLICY "Allow public read v27_metrics" ON public.v27_metrics FOR SELECT USING (true);

-- Service role insert policies
CREATE POLICY "Allow service insert v27_evaluations" ON public.v27_evaluations FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert v27_entries" ON public.v27_entries FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert v27_corrections" ON public.v27_corrections FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert v27_signals" ON public.v27_signals FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow service insert v27_metrics" ON public.v27_metrics FOR INSERT WITH CHECK (true);

-- Service role update policies
CREATE POLICY "Allow service update v27_entries" ON public.v27_entries FOR UPDATE USING (true);
CREATE POLICY "Allow service update v27_corrections" ON public.v27_corrections FOR UPDATE USING (true);

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.v27_entries;
ALTER PUBLICATION supabase_realtime ADD TABLE public.v27_signals;
ALTER PUBLICATION supabase_realtime ADD TABLE public.v27_metrics;