-- v6.3.0: Skew Explainability Logging

-- 1) Add skew_allowed_reason to inventory_snapshots
ALTER TABLE public.inventory_snapshots 
ADD COLUMN skew_allowed_reason text DEFAULT NULL;

-- 2) Create hedge_intents table for tracking hedge intent lifecycle
CREATE TABLE public.hedge_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  ts bigint NOT NULL,
  correlation_id uuid DEFAULT NULL,
  run_id uuid DEFAULT NULL,
  market_id text NOT NULL,
  asset text NOT NULL,
  side text NOT NULL,  -- UP or DOWN
  intent_type text NOT NULL,  -- ENTRY_HEDGE, REBAL_HEDGE, PANIC_HEDGE
  intended_qty numeric NOT NULL,
  filled_qty numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',  -- PENDING, FILLED, ABORTED_NO_EDGE, ABORTED_FUNDS, etc.
  abort_reason text DEFAULT NULL,
  price_at_intent numeric DEFAULT NULL,
  price_at_resolution numeric DEFAULT NULL,
  resolution_ts bigint DEFAULT NULL
);

-- Enable RLS
ALTER TABLE public.hedge_intents ENABLE ROW LEVEL SECURITY;

-- Policies for hedge_intents
CREATE POLICY "Allow public read for hedge_intents" 
ON public.hedge_intents 
FOR SELECT 
USING (true);

CREATE POLICY "Allow service insert for hedge_intents" 
ON public.hedge_intents 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Allow service update for hedge_intents" 
ON public.hedge_intents 
FOR UPDATE 
USING (true);

-- Add index for efficient querying
CREATE INDEX idx_hedge_intents_market_id ON public.hedge_intents(market_id);
CREATE INDEX idx_hedge_intents_correlation_id ON public.hedge_intents(correlation_id);
CREATE INDEX idx_hedge_intents_status ON public.hedge_intents(status);

-- Comments
COMMENT ON TABLE public.hedge_intents IS 'Tracks hedge intent lifecycle for skew explainability';
COMMENT ON COLUMN public.hedge_intents.status IS 'PENDING, FILLED, ABORTED_NO_EDGE, ABORTED_FUNDS, ABORTED_NO_DEPTH, ABORTED_TIMEOUT, ABORTED_RATE_LIMIT, ABORTED_PAIR_COST_WORSENING';
COMMENT ON COLUMN public.inventory_snapshots.skew_allowed_reason IS 'PAIR_COST_IMPROVING, DELTA_LOW, TIME_SUFFICIENT, SURVIVAL_MODE, EXECUTION_FAILURE, UNKNOWN';