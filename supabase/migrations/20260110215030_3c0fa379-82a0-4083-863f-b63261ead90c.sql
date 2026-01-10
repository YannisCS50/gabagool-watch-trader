-- Toxicity Features table for self-calibrating filter
-- Stores pre-computed features per market for decision-making and calibration

CREATE TABLE public.toxicity_features (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Market identification
  market_id TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  market_start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  
  -- Data quality flags
  n_ticks INTEGER NOT NULL DEFAULT 0,
  max_gap_seconds NUMERIC NOT NULL DEFAULT 0,
  data_quality TEXT NOT NULL DEFAULT 'UNKNOWN', -- GOOD, SPARSE, INSUFFICIENT
  
  -- Core features (Section 5)
  ask_volatility NUMERIC,
  ask_change_count INTEGER,
  min_distance_to_target NUMERIC,
  mean_distance_to_target NUMERIC,
  time_near_target_pct NUMERIC,
  
  -- Liquidity pull detection (Section 5.4)
  ask_median_early NUMERIC,
  ask_median_late NUMERIC,
  liquidity_pull_detected BOOLEAN NOT NULL DEFAULT false,
  
  -- Spread dynamics (Section 5.5)
  spread_volatility NUMERIC,
  spread_jump_last_20s NUMERIC,
  
  -- Bid-side pressure (Section 5.6)
  bid_drift NUMERIC,
  mid_drift NUMERIC,
  
  -- Scoring output (Section 7-8)
  toxicity_score NUMERIC,
  percentile_rank INTEGER,
  classification TEXT NOT NULL DEFAULT 'UNKNOWN', -- HEALTHY, BORDERLINE, TOXIC
  decision TEXT NOT NULL DEFAULT 'PENDING', -- TRADE, SKIP, REDUCED
  confidence TEXT DEFAULT 'LOW', -- LOW, MEDIUM, HIGH
  
  -- Outcome tracking for calibration (Section 8)
  outcome TEXT, -- WIN, LOSS, null if unsettled
  pnl NUMERIC,
  settled_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  run_id TEXT,
  target_price NUMERIC NOT NULL DEFAULT 0.48,
  filter_version TEXT NOT NULL DEFAULT 'v2-bootstrap',
  
  CONSTRAINT unique_market_asset UNIQUE (market_id, asset)
);

-- Enable RLS
ALTER TABLE public.toxicity_features ENABLE ROW LEVEL SECURITY;

-- Public read policy (dashboard needs to read)
CREATE POLICY "Allow public read access" 
ON public.toxicity_features 
FOR SELECT 
USING (true);

-- Service role insert/update
CREATE POLICY "Allow service role full access" 
ON public.toxicity_features 
FOR ALL 
USING (true);

-- Indexes for efficient queries
CREATE INDEX idx_toxicity_features_asset ON public.toxicity_features(asset);
CREATE INDEX idx_toxicity_features_created ON public.toxicity_features(created_at DESC);
CREATE INDEX idx_toxicity_features_classification ON public.toxicity_features(classification);
CREATE INDEX idx_toxicity_features_outcome ON public.toxicity_features(outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_toxicity_features_market_start ON public.toxicity_features(market_start_time DESC);

-- Add to realtime for dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.toxicity_features;