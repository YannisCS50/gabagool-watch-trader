
-- Create polymarket_cashflows table for canonical cashflow-based PnL
CREATE TABLE IF NOT EXISTS public.polymarket_cashflows (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('FILL_BUY', 'FILL_SELL', 'REDEEM', 'CLAIM', 'SETTLEMENT_PAYOUT', 'FEE', 'TRANSFER', 'MERGE', 'SPLIT')),
  market_id TEXT,
  condition_id TEXT,
  token_id TEXT,
  outcome_side TEXT,
  amount_usd NUMERIC NOT NULL DEFAULT 0,
  shares NUMERIC,
  price NUMERIC,
  fee_usd NUMERIC,
  fee_known BOOLEAN DEFAULT false,
  source TEXT NOT NULL CHECK (source IN ('SUBGRAPH_ACTIVITY', 'SUBGRAPH_POSITIONS', 'DATA_API', 'CLAIM_LOGS', 'MANUAL')),
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  ingested_at TIMESTAMPTZ DEFAULT now()
);

-- Add indices for efficient queries
CREATE INDEX IF NOT EXISTS idx_cashflows_wallet ON public.polymarket_cashflows(wallet);
CREATE INDEX IF NOT EXISTS idx_cashflows_market ON public.polymarket_cashflows(market_id);
CREATE INDEX IF NOT EXISTS idx_cashflows_type ON public.polymarket_cashflows(type);
CREATE INDEX IF NOT EXISTS idx_cashflows_ts ON public.polymarket_cashflows(ts DESC);

-- Add RLS policy for public read
ALTER TABLE public.polymarket_cashflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access for cashflows"
ON public.polymarket_cashflows FOR SELECT
USING (true);

-- Add payout tracking columns to subgraph_pnl_markets
ALTER TABLE public.subgraph_pnl_markets 
ADD COLUMN IF NOT EXISTS payout_ingested BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS payout_amount_usd NUMERIC,
ADD COLUMN IF NOT EXISTS payout_source TEXT,
ADD COLUMN IF NOT EXISTS payout_tx_hash TEXT,
ADD COLUMN IF NOT EXISTS payout_ts TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS missing_payout_reason TEXT;

-- Add column to track payout sync status in sync state
ALTER TABLE public.subgraph_sync_state
ADD COLUMN IF NOT EXISTS payout_sync_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS payout_records_synced INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS payout_error TEXT;
