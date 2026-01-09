-- =====================================================
-- POLYMARKET SUBGRAPH CANONICAL DATA TABLES
-- For 100% truthful PnL tracking via Goldsky subgraphs
-- =====================================================

-- 1) Canonical fills from Activity subgraph
CREATE TABLE public.subgraph_fills (
  id TEXT PRIMARY KEY,                    -- Subgraph-provided ID (canonical)
  wallet TEXT NOT NULL,
  block_number BIGINT,
  tx_hash TEXT,
  log_index INTEGER,
  timestamp TIMESTAMPTZ NOT NULL,
  market_id TEXT,                         -- conditionId
  token_id TEXT,                          -- tokenId
  outcome_side TEXT,                      -- UP/DOWN derived from outcome
  side TEXT NOT NULL,                     -- BUY/SELL
  price DECIMAL(18,8) NOT NULL,
  size DECIMAL(18,8) NOT NULL,
  notional DECIMAL(18,8) NOT NULL,
  liquidity TEXT,                         -- MAKER/TAKER
  fee_usd DECIMAL(18,8),                  -- If available, NULL if unknown
  fee_known BOOLEAN DEFAULT FALSE,
  raw_json JSONB,                         -- Full raw payload for audits
  created_at TIMESTAMPTZ DEFAULT now(),
  ingested_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_subgraph_fills_wallet ON public.subgraph_fills(wallet);
CREATE INDEX idx_subgraph_fills_market ON public.subgraph_fills(market_id);
CREATE INDEX idx_subgraph_fills_timestamp ON public.subgraph_fills(timestamp DESC);
CREATE INDEX idx_subgraph_fills_wallet_ts ON public.subgraph_fills(wallet, timestamp DESC);

-- 2) Position snapshots from Positions subgraph
CREATE TABLE public.subgraph_positions (
  id TEXT PRIMARY KEY,                    -- wallet:tokenId composite
  snapshot_id TEXT,
  wallet TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  market_id TEXT,                         -- conditionId
  token_id TEXT NOT NULL,
  outcome_side TEXT,                      -- UP/DOWN
  shares DECIMAL(18,8) NOT NULL,
  avg_cost DECIMAL(18,8),                 -- If derivable from fills
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_subgraph_positions_wallet ON public.subgraph_positions(wallet);
CREATE INDEX idx_subgraph_positions_market ON public.subgraph_positions(market_id);

-- 3) Market-level PnL aggregation (computed)
CREATE TABLE public.subgraph_pnl_markets (
  id TEXT PRIMARY KEY,                    -- wallet:market_id composite
  wallet TEXT NOT NULL,
  market_id TEXT NOT NULL,                -- conditionId
  market_slug TEXT,                       -- Human-readable slug
  
  -- Position state
  up_shares DECIMAL(18,8) DEFAULT 0,
  down_shares DECIMAL(18,8) DEFAULT 0,
  avg_up_cost DECIMAL(18,8),
  avg_down_cost DECIMAL(18,8),
  total_cost DECIMAL(18,8) DEFAULT 0,
  
  -- Realized PnL (only from actual sells/settlements)
  realized_pnl_usd DECIMAL(18,8) DEFAULT 0,
  realized_confidence TEXT DEFAULT 'HIGH',  -- HIGH/MEDIUM/LOW
  
  -- Unrealized PnL (mark-to-market)
  unrealized_pnl_usd DECIMAL(18,8),
  unrealized_confidence TEXT DEFAULT 'LOW',
  mark_source TEXT,                        -- 'orderbook_mid', 'last_trade', 'stale', 'unknown'
  mark_price_up DECIMAL(18,8),
  mark_price_down DECIMAL(18,8),
  mark_timestamp TIMESTAMPTZ,
  
  -- Fee tracking
  fees_known_usd DECIMAL(18,8) DEFAULT 0,
  fees_unknown_count INTEGER DEFAULT 0,
  
  -- Settlement
  is_settled BOOLEAN DEFAULT FALSE,
  settlement_outcome TEXT,                 -- UP/DOWN/null
  settlement_payout DECIMAL(18,8),
  settled_at TIMESTAMPTZ,
  
  -- Reconciliation
  last_reconciled_at TIMESTAMPTZ,
  drift_flags JSONB,
  confidence TEXT DEFAULT 'MEDIUM',        -- Overall confidence
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_subgraph_pnl_wallet ON public.subgraph_pnl_markets(wallet);
CREATE UNIQUE INDEX idx_subgraph_pnl_wallet_market ON public.subgraph_pnl_markets(wallet, market_id);

-- 4) Reconciliation events log
CREATE TABLE public.subgraph_reconciliation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT now(),
  wallet TEXT NOT NULL,
  market_id TEXT,
  
  -- Subgraph values (canonical)
  subgraph_shares_up DECIMAL(18,8),
  subgraph_shares_down DECIMAL(18,8),
  subgraph_source TEXT DEFAULT 'positions_subgraph',
  
  -- Local/alternative source values
  local_shares_up DECIMAL(18,8),
  local_shares_down DECIMAL(18,8),
  local_source TEXT,                       -- 'bot_positions', 'v26_trades', 'fill_logs'
  
  -- Delta (subgraph - local)
  delta_shares_up DECIMAL(18,8),
  delta_shares_down DECIMAL(18,8),
  
  -- Status
  severity TEXT NOT NULL,                  -- OK, DRIFT, UNKNOWN
  status TEXT DEFAULT 'open',              -- open, acknowledged, resolved
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_subgraph_recon_wallet ON public.subgraph_reconciliation(wallet);
CREATE INDEX idx_subgraph_recon_severity ON public.subgraph_reconciliation(severity);
CREATE INDEX idx_subgraph_recon_ts ON public.subgraph_reconciliation(timestamp DESC);

-- 5) Sync state tracking
CREATE TABLE public.subgraph_sync_state (
  id TEXT PRIMARY KEY,                     -- 'activity', 'positions', 'orders'
  wallet TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,
  last_block_number BIGINT,
  last_timestamp TIMESTAMPTZ,
  records_synced INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6) Wallet PnL summary (aggregated)
CREATE TABLE public.subgraph_pnl_summary (
  wallet TEXT PRIMARY KEY,
  
  -- Totals
  total_realized_pnl DECIMAL(18,8) DEFAULT 0,
  total_unrealized_pnl DECIMAL(18,8),
  total_pnl DECIMAL(18,8),
  
  -- Confidence
  realized_confidence TEXT DEFAULT 'HIGH',
  unrealized_confidence TEXT DEFAULT 'LOW',
  overall_confidence TEXT DEFAULT 'MEDIUM',
  
  -- Fee accounting
  total_fees_known DECIMAL(18,8) DEFAULT 0,
  total_fees_unknown_count INTEGER DEFAULT 0,
  
  -- Counts
  total_fills INTEGER DEFAULT 0,
  total_markets INTEGER DEFAULT 0,
  settled_markets INTEGER DEFAULT 0,
  open_markets INTEGER DEFAULT 0,
  
  -- Reconciliation
  drift_count INTEGER DEFAULT 0,
  last_reconciled_at TIMESTAMPTZ,
  
  -- Timestamps
  first_trade_at TIMESTAMPTZ,
  last_trade_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subgraph_fills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_pnl_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subgraph_pnl_summary ENABLE ROW LEVEL SECURITY;

-- Public read policies (dashboard is read-only)
CREATE POLICY "Public read access" ON public.subgraph_fills FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.subgraph_positions FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.subgraph_pnl_markets FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.subgraph_reconciliation FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.subgraph_sync_state FOR SELECT USING (true);
CREATE POLICY "Public read access" ON public.subgraph_pnl_summary FOR SELECT USING (true);