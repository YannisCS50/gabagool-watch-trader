-- Table to store market resolution truth from Data API
CREATE TABLE IF NOT EXISTS public.polymarket_market_resolution (
  id TEXT PRIMARY KEY, -- conditionId
  condition_id TEXT NOT NULL,
  market_slug TEXT,
  resolved_at TIMESTAMPTZ,
  is_resolved BOOLEAN DEFAULT false,
  winning_outcome TEXT, -- 'UP', 'DOWN', or token_id
  winning_token_id TEXT,
  payout_per_share_up NUMERIC DEFAULT 0,
  payout_per_share_down NUMERIC DEFAULT 0,
  resolution_source TEXT CHECK (resolution_source IN ('DATA_API', 'SUBGRAPH', 'MANUAL')),
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_market_resolution_condition ON polymarket_market_resolution(condition_id);
CREATE INDEX IF NOT EXISTS idx_market_resolution_resolved ON polymarket_market_resolution(is_resolved);

-- Enable RLS
ALTER TABLE public.polymarket_market_resolution ENABLE ROW LEVEL SECURITY;

-- Public read policy
CREATE POLICY "Allow public read access to market resolution"
ON public.polymarket_market_resolution
FOR SELECT
USING (true);

-- Add lifecycle state columns to pnl_markets
ALTER TABLE public.subgraph_pnl_markets 
ADD COLUMN IF NOT EXISTS lifecycle_bought BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lifecycle_sold BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lifecycle_claimed BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lifecycle_lost BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS lifecycle_state TEXT,
ADD COLUMN IF NOT EXISTS resolution_winning_outcome TEXT,
ADD COLUMN IF NOT EXISTS resolution_fetched_at TIMESTAMPTZ;

-- Add derived loss closure tracking columns
ALTER TABLE public.subgraph_pnl_markets
ADD COLUMN IF NOT EXISTS synthetic_closure_created BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS synthetic_closure_reason TEXT;

-- Add lifecycle counts to summary
ALTER TABLE public.subgraph_pnl_summary
ADD COLUMN IF NOT EXISTS markets_bought INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS markets_sold INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS markets_claimed INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS markets_lost INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS resolution_fetch_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS synthetic_closures_count INTEGER DEFAULT 0;