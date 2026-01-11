-- Create v27_signal_tracking table for post-signal outcome tracking
CREATE TABLE IF NOT EXISTS public.v27_signal_tracking (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  signal_ts BIGINT NOT NULL,
  signal_side TEXT NOT NULL,
  signal_price NUMERIC,
  signal_spot_price NUMERIC,
  signal_mispricing NUMERIC,
  
  -- State after 5s
  spot_price_5s NUMERIC,
  mispricing_resolved_5s BOOLEAN,
  adverse_selection_5s BOOLEAN,
  
  -- State after 10s
  spot_price_10s NUMERIC,
  mispricing_resolved_10s BOOLEAN,
  adverse_selection_10s BOOLEAN,
  
  -- State after 15s
  spot_price_15s NUMERIC,
  mispricing_resolved_15s BOOLEAN,
  adverse_selection_15s BOOLEAN,
  
  -- Hedge simulation
  hedge_simulated BOOLEAN DEFAULT FALSE,
  hedge_side TEXT,
  hedge_price NUMERIC,
  hedge_spread NUMERIC,
  simulated_cpp NUMERIC,
  hedge_would_execute BOOLEAN,
  
  -- Final determination
  signal_was_correct BOOLEAN,
  would_have_profited BOOLEAN,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create index for querying by market and time
CREATE INDEX IF NOT EXISTS idx_v27_signal_tracking_market ON public.v27_signal_tracking(market_id, signal_ts DESC);
CREATE INDEX IF NOT EXISTS idx_v27_signal_tracking_asset ON public.v27_signal_tracking(asset, signal_ts DESC);

-- Disable RLS (internal tracking data)
ALTER TABLE public.v27_signal_tracking DISABLE ROW LEVEL SECURITY;