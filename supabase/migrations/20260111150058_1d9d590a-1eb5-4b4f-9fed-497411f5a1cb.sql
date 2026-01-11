-- ============================================================
-- SHADOW POSITION LIFECYCLE TABLES
-- ============================================================

-- 1. Shadow Positions - Core position tracking
CREATE TABLE public.shadow_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('UP', 'DOWN')),
  
  -- Entry details
  entry_timestamp BIGINT NOT NULL,
  entry_iso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price NUMERIC(10, 6) NOT NULL,
  entry_fill_type TEXT NOT NULL CHECK (entry_fill_type IN ('MAKER', 'TAKER')),
  best_bid_at_signal NUMERIC(10, 6) NOT NULL,
  best_ask_at_signal NUMERIC(10, 6) NOT NULL,
  spread_at_entry NUMERIC(10, 6),
  
  -- Size
  size_usd NUMERIC(12, 2) NOT NULL DEFAULT 50,
  size_shares NUMERIC(14, 6) NOT NULL,
  
  -- Context at entry
  signal_id TEXT NOT NULL,
  evaluation_id TEXT,
  time_to_expiry_at_entry NUMERIC(10, 2),
  spot_price_at_entry NUMERIC(14, 4),
  theoretical_price_at_entry NUMERIC(10, 6),
  delta_at_entry NUMERIC(10, 6),
  mispricing_at_entry NUMERIC(10, 6),
  adverse_filter_state JSONB,
  
  -- Hedge details
  hedge_timestamp BIGINT,
  hedge_iso TIMESTAMPTZ,
  hedge_price NUMERIC(10, 6),
  hedge_fill_type TEXT CHECK (hedge_fill_type IN ('MAKER', 'TAKER', 'EMERGENCY')),
  hedge_latency_ms BIGINT,
  hedge_spread NUMERIC(10, 6),
  paired BOOLEAN DEFAULT FALSE,
  
  -- Resolution
  resolution TEXT CHECK (resolution IN ('OPEN', 'PAIRED_HEDGED', 'EXPIRED_ONE_SIDED', 'EMERGENCY_EXITED', 'NO_FILL')),
  resolution_timestamp BIGINT,
  resolution_iso TIMESTAMPTZ,
  resolution_reason TEXT,
  
  -- PnL
  gross_pnl NUMERIC(12, 4),
  fees NUMERIC(10, 4) DEFAULT 0,
  net_pnl NUMERIC(12, 4),
  roi_pct NUMERIC(10, 4),
  combined_price_paid NUMERIC(10, 6),
  
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for shadow_positions
CREATE INDEX idx_shadow_positions_market ON public.shadow_positions(market_id);
CREATE INDEX idx_shadow_positions_asset ON public.shadow_positions(asset);
CREATE INDEX idx_shadow_positions_resolution ON public.shadow_positions(resolution);
CREATE INDEX idx_shadow_positions_entry_ts ON public.shadow_positions(entry_timestamp DESC);
CREATE INDEX idx_shadow_positions_signal ON public.shadow_positions(signal_id);

-- 2. Shadow Executions - Detailed execution simulation logs
CREATE TABLE public.shadow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID REFERENCES public.shadow_positions(id) ON DELETE CASCADE,
  execution_type TEXT NOT NULL CHECK (execution_type IN ('ENTRY', 'HEDGE', 'EMERGENCY_EXIT')),
  
  -- Execution details
  timestamp BIGINT NOT NULL,
  iso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  side TEXT NOT NULL CHECK (side IN ('UP', 'DOWN')),
  price NUMERIC(10, 6) NOT NULL,
  shares NUMERIC(14, 6) NOT NULL,
  cost_usd NUMERIC(12, 4) NOT NULL,
  
  -- Fill simulation
  fill_type TEXT NOT NULL CHECK (fill_type IN ('MAKER', 'TAKER')),
  fill_latency_assumed_ms INTEGER,
  fill_confidence TEXT CHECK (fill_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  
  -- Orderbook state
  best_bid NUMERIC(10, 6),
  best_ask NUMERIC(10, 6),
  spread NUMERIC(10, 6),
  depth_at_best NUMERIC(12, 4),
  
  -- Slippage
  slippage_cents NUMERIC(10, 4) DEFAULT 0,
  
  -- Fees
  fee_usd NUMERIC(10, 4) DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shadow_executions_position ON public.shadow_executions(position_id);
CREATE INDEX idx_shadow_executions_ts ON public.shadow_executions(timestamp DESC);

-- 3. Shadow Accounting - Equity snapshots over time
CREATE TABLE public.shadow_accounting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp BIGINT NOT NULL,
  iso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Equity state
  equity NUMERIC(14, 4) NOT NULL,
  starting_equity NUMERIC(14, 4) NOT NULL DEFAULT 3000,
  
  -- PnL breakdown
  realized_pnl NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(14, 4) NOT NULL DEFAULT 0,
  total_fees NUMERIC(12, 4) NOT NULL DEFAULT 0,
  
  -- Positions
  open_positions INTEGER DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  
  -- Risk metrics
  peak_equity NUMERIC(14, 4),
  drawdown_usd NUMERIC(14, 4),
  drawdown_pct NUMERIC(10, 4),
  max_drawdown_pct NUMERIC(10, 4),
  
  -- Daily aggregates
  daily_pnl NUMERIC(12, 4),
  daily_trades INTEGER,
  daily_wins INTEGER,
  daily_losses INTEGER,
  
  -- Exposure
  exposure_by_asset JSONB,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shadow_accounting_ts ON public.shadow_accounting(timestamp DESC);
CREATE INDEX idx_shadow_accounting_date ON public.shadow_accounting(iso);

-- 4. Shadow Daily PnL - Aggregated daily stats
CREATE TABLE public.shadow_daily_pnl (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL UNIQUE,
  
  -- PnL
  realized_pnl NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC(14, 4) DEFAULT 0,
  total_pnl NUMERIC(14, 4) NOT NULL DEFAULT 0,
  cumulative_pnl NUMERIC(14, 4) NOT NULL DEFAULT 0,
  
  -- Trade counts
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  
  -- Position outcomes
  paired_hedged INTEGER DEFAULT 0,
  expired_one_sided INTEGER DEFAULT 0,
  emergency_exited INTEGER DEFAULT 0,
  no_fill INTEGER DEFAULT 0,
  
  -- Fees
  total_fees NUMERIC(12, 4) DEFAULT 0,
  
  -- Win/Loss stats
  win_rate NUMERIC(6, 4),
  avg_win NUMERIC(12, 4),
  avg_loss NUMERIC(12, 4),
  profit_factor NUMERIC(10, 4),
  
  -- Equity
  starting_equity NUMERIC(14, 4),
  ending_equity NUMERIC(14, 4),
  max_drawdown NUMERIC(10, 4),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shadow_daily_pnl_date ON public.shadow_daily_pnl(date DESC);

-- 5. Shadow Hedge Attempts - Track hedge attempts per position
CREATE TABLE public.shadow_hedge_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID REFERENCES public.shadow_positions(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  
  -- Timing
  timestamp BIGINT NOT NULL,
  iso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seconds_since_entry INTEGER NOT NULL,
  
  -- Attempt details
  hedge_side TEXT NOT NULL CHECK (hedge_side IN ('UP', 'DOWN')),
  target_price NUMERIC(10, 6) NOT NULL,
  actual_price NUMERIC(10, 6),
  spread_at_attempt NUMERIC(10, 6),
  
  -- Result
  success BOOLEAN DEFAULT FALSE,
  failure_reason TEXT,
  is_emergency BOOLEAN DEFAULT FALSE,
  
  -- Cost analysis
  hedge_cpp NUMERIC(10, 6),
  projected_pnl NUMERIC(12, 4),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shadow_hedge_attempts_position ON public.shadow_hedge_attempts(position_id);
CREATE INDEX idx_shadow_hedge_attempts_ts ON public.shadow_hedge_attempts(timestamp DESC);

-- Enable RLS
ALTER TABLE public.shadow_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_accounting ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_daily_pnl ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadow_hedge_attempts ENABLE ROW LEVEL SECURITY;

-- Allow public read access (this is a monitoring dashboard)
CREATE POLICY "Anyone can read shadow_positions"
  ON public.shadow_positions FOR SELECT USING (true);
CREATE POLICY "Anyone can read shadow_executions"
  ON public.shadow_executions FOR SELECT USING (true);
CREATE POLICY "Anyone can read shadow_accounting"
  ON public.shadow_accounting FOR SELECT USING (true);
CREATE POLICY "Anyone can read shadow_daily_pnl"
  ON public.shadow_daily_pnl FOR SELECT USING (true);
CREATE POLICY "Anyone can read shadow_hedge_attempts"
  ON public.shadow_hedge_attempts FOR SELECT USING (true);

-- Allow insert/update for backend operations (unauthenticated for edge functions)
CREATE POLICY "Service can insert shadow_positions"
  ON public.shadow_positions FOR INSERT WITH CHECK (true);
CREATE POLICY "Service can update shadow_positions"
  ON public.shadow_positions FOR UPDATE USING (true);
CREATE POLICY "Service can insert shadow_executions"
  ON public.shadow_executions FOR INSERT WITH CHECK (true);
CREATE POLICY "Service can insert shadow_accounting"
  ON public.shadow_accounting FOR INSERT WITH CHECK (true);
CREATE POLICY "Service can insert shadow_daily_pnl"
  ON public.shadow_daily_pnl FOR INSERT WITH CHECK (true);
CREATE POLICY "Service can update shadow_daily_pnl"
  ON public.shadow_daily_pnl FOR UPDATE USING (true);
CREATE POLICY "Service can insert shadow_hedge_attempts"
  ON public.shadow_hedge_attempts FOR INSERT WITH CHECK (true);

-- Enable realtime for dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE public.shadow_positions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.shadow_accounting;
ALTER PUBLICATION supabase_realtime ADD TABLE public.shadow_daily_pnl;