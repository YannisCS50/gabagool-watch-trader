-- V29 Aggregate Positions table - tracks accumulated positions per asset/direction
CREATE TABLE public.v29_aggregate_positions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('UP', 'DOWN')),
  market_slug TEXT NOT NULL,
  token_id TEXT NOT NULL,
  
  -- Accumulation tracking
  total_shares NUMERIC NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  avg_entry_price NUMERIC GENERATED ALWAYS AS (
    CASE WHEN total_shares > 0 THEN total_cost / total_shares ELSE 0 END
  ) STORED,
  entry_count INTEGER NOT NULL DEFAULT 0,
  
  -- Hedge tracking
  hedge_shares NUMERIC NOT NULL DEFAULT 0,
  hedge_cost NUMERIC NOT NULL DEFAULT 0,
  avg_hedge_price NUMERIC GENERATED ALWAYS AS (
    CASE WHEN hedge_shares > 0 THEN hedge_cost / hedge_shares ELSE 0 END
  ) STORED,
  hedge_count INTEGER NOT NULL DEFAULT 0,
  
  -- Status
  is_fully_hedged BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'accumulating' CHECK (state IN ('accumulating', 'partially_hedged', 'fully_hedged', 'closed')),
  
  -- Timestamps
  first_entry_ts TIMESTAMPTZ,
  last_entry_ts TIMESTAMPTZ,
  first_hedge_ts TIMESTAMPTZ,
  last_hedge_ts TIMESTAMPTZ,
  closed_ts TIMESTAMPTZ,
  
  -- PnL (calculated at close)
  realized_pnl NUMERIC,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Unique per run/asset/side/market
  UNIQUE(run_id, asset, side, market_slug)
);

-- Index for fast lookups
CREATE INDEX idx_v29_agg_pos_run_asset ON public.v29_aggregate_positions(run_id, asset);
CREATE INDEX idx_v29_agg_pos_state ON public.v29_aggregate_positions(state) WHERE state != 'closed';

-- Auto-update updated_at
CREATE TRIGGER update_v29_agg_pos_updated_at
  BEFORE UPDATE ON public.v29_aggregate_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS but allow all (bot runs locally)
ALTER TABLE public.v29_aggregate_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for v29_aggregate_positions"
  ON public.v29_aggregate_positions
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add to realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_aggregate_positions;