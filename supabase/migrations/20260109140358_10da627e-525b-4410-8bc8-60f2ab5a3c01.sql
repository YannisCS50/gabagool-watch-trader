
-- Create canonical tables for the event → reducer → state pipeline
-- Following the specification exactly

-- 1. Raw subgraph events table (stores exactly what we ingest)
CREATE TABLE IF NOT EXISTS public.raw_subgraph_events (
  id TEXT PRIMARY KEY,
  tx_hash TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('BUY', 'SELL', 'REDEEM', 'TRANSFER', 'MERGE', 'SPLIT')),
  market_id TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('UP', 'DOWN')),
  shares NUMERIC NOT NULL DEFAULT 0,
  price NUMERIC,
  amount_usd NUMERIC NOT NULL DEFAULT 0,
  fee_usd NUMERIC,
  wallet TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  ingested_at TIMESTAMPTZ DEFAULT now()
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_raw_events_wallet_market ON raw_subgraph_events(wallet, market_id);
CREATE INDEX IF NOT EXISTS idx_raw_events_timestamp ON raw_subgraph_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_subgraph_events(event_type);

-- 2. Normalized cashflow ledger (one row = one economic cashflow)
CREATE TABLE IF NOT EXISTS public.cashflow_ledger (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('UP', 'DOWN')),
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  category TEXT NOT NULL CHECK (category IN ('BUY', 'SELL', 'REDEEM', 'FEE', 'LOSS', 'TRANSFER')),
  amount_usd NUMERIC NOT NULL DEFAULT 0,
  shares_delta NUMERIC NOT NULL DEFAULT 0,
  wallet TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  source_event_id TEXT REFERENCES raw_subgraph_events(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_wallet_market ON cashflow_ledger(wallet, market_id);
CREATE INDEX IF NOT EXISTS idx_cashflow_timestamp ON cashflow_ledger(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_cashflow_category ON cashflow_ledger(category);

-- 3. Canonical positions table (one row per market+outcome)
CREATE TABLE IF NOT EXISTS public.canonical_positions (
  id TEXT PRIMARY KEY, -- wallet:market_id:outcome
  wallet TEXT NOT NULL,
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN')),
  shares_held NUMERIC NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC NOT NULL DEFAULT 0,
  avg_cost NUMERIC GENERATED ALWAYS AS (
    CASE WHEN shares_held > 0 THEN total_cost_usd / shares_held ELSE 0 END
  ) STORED,
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CLAIMED', 'LOST', 'SOLD')),
  last_fill_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(wallet, market_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_canonical_positions_wallet ON canonical_positions(wallet);
CREATE INDEX IF NOT EXISTS idx_canonical_positions_market ON canonical_positions(market_id);
CREATE INDEX IF NOT EXISTS idx_canonical_positions_state ON canonical_positions(state);

-- 4. Market lifecycle table (one row per market)
CREATE TABLE IF NOT EXISTS public.market_lifecycle (
  id TEXT PRIMARY KEY, -- wallet:market_id
  wallet TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_slug TEXT,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'SETTLED')),
  resolved_outcome TEXT CHECK (resolved_outcome IN ('UP', 'DOWN', 'SPLIT')),
  settlement_ts TIMESTAMPTZ,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  total_payout NUMERIC NOT NULL DEFAULT 0,
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  has_buy BOOLEAN DEFAULT false,
  has_sell BOOLEAN DEFAULT false,
  has_redeem BOOLEAN DEFAULT false,
  is_claimed BOOLEAN DEFAULT false,
  is_lost BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(wallet, market_id)
);

CREATE INDEX IF NOT EXISTS idx_market_lifecycle_wallet ON market_lifecycle(wallet);
CREATE INDEX IF NOT EXISTS idx_market_lifecycle_state ON market_lifecycle(state);

-- 5. PnL snapshots for dashboard (materialized state)
CREATE TABLE IF NOT EXISTS public.pnl_snapshots (
  id TEXT PRIMARY KEY, -- wallet:timestamp
  wallet TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  realized_pnl NUMERIC NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC NOT NULL DEFAULT 0,
  total_pnl NUMERIC NOT NULL DEFAULT 0,
  total_markets INTEGER NOT NULL DEFAULT 0,
  settled_markets INTEGER NOT NULL DEFAULT 0,
  open_markets INTEGER NOT NULL DEFAULT 0,
  claimed_markets INTEGER NOT NULL DEFAULT 0,
  lost_markets INTEGER NOT NULL DEFAULT 0,
  total_cost NUMERIC NOT NULL DEFAULT 0,
  total_fees NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_wallet ON pnl_snapshots(wallet, ts DESC);

-- 6. Create a view for real-time dashboard summary (always reads fresh)
CREATE OR REPLACE VIEW public.v_dashboard_pnl_summary AS
SELECT 
  wallet,
  COUNT(*) as total_markets,
  SUM(CASE WHEN state = 'SETTLED' THEN 1 ELSE 0 END) as settled_markets,
  SUM(CASE WHEN state = 'OPEN' THEN 1 ELSE 0 END) as open_markets,
  SUM(CASE WHEN is_claimed THEN 1 ELSE 0 END) as claimed_markets,
  SUM(CASE WHEN is_lost THEN 1 ELSE 0 END) as lost_markets,
  SUM(CASE WHEN has_buy THEN 1 ELSE 0 END) as markets_bought,
  SUM(CASE WHEN has_sell THEN 1 ELSE 0 END) as markets_sold,
  SUM(realized_pnl) as total_realized_pnl,
  SUM(total_cost) as total_cost,
  SUM(total_payout) as total_payout,
  MAX(updated_at) as last_updated
FROM market_lifecycle
GROUP BY wallet;

-- 7. Create a view for per-market PnL (dashboard reads this)
CREATE OR REPLACE VIEW public.v_market_pnl AS
SELECT 
  ml.id,
  ml.wallet,
  ml.market_id,
  ml.market_slug,
  ml.state,
  ml.resolved_outcome,
  ml.settlement_ts,
  ml.total_cost,
  ml.total_payout,
  ml.realized_pnl,
  ml.has_buy,
  ml.has_sell,
  ml.has_redeem,
  ml.is_claimed,
  ml.is_lost,
  ml.updated_at,
  COALESCE(pos_up.shares_held, 0) as up_shares,
  COALESCE(pos_down.shares_held, 0) as down_shares,
  pos_up.avg_cost as avg_up_cost,
  pos_down.avg_cost as avg_down_cost,
  CASE 
    WHEN ml.state = 'SETTLED' THEN 'HIGH'
    WHEN ml.has_redeem THEN 'HIGH'
    ELSE 'MEDIUM'
  END as confidence
FROM market_lifecycle ml
LEFT JOIN canonical_positions pos_up 
  ON pos_up.wallet = ml.wallet 
  AND pos_up.market_id = ml.market_id 
  AND pos_up.outcome = 'UP'
LEFT JOIN canonical_positions pos_down 
  ON pos_down.wallet = ml.wallet 
  AND pos_down.market_id = ml.market_id 
  AND pos_down.outcome = 'DOWN';

-- Enable RLS on new tables
ALTER TABLE raw_subgraph_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashflow_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE pnl_snapshots ENABLE ROW LEVEL SECURITY;

-- Public read policies
CREATE POLICY "Public read raw_subgraph_events" ON raw_subgraph_events FOR SELECT USING (true);
CREATE POLICY "Public read cashflow_ledger" ON cashflow_ledger FOR SELECT USING (true);
CREATE POLICY "Public read canonical_positions" ON canonical_positions FOR SELECT USING (true);
CREATE POLICY "Public read market_lifecycle" ON market_lifecycle FOR SELECT USING (true);
CREATE POLICY "Public read pnl_snapshots" ON pnl_snapshots FOR SELECT USING (true);
