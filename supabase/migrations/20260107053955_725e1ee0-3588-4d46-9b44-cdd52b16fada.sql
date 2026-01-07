-- Decision snapshots - before every order
CREATE TABLE public.decision_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  correlation_id TEXT,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  window_start TIMESTAMP WITH TIME ZONE,
  seconds_remaining INTEGER NOT NULL,
  state TEXT NOT NULL,
  intent TEXT NOT NULL,
  chosen_side TEXT,
  reason_code TEXT NOT NULL,
  projected_cpp_maker NUMERIC,
  projected_cpp_taker NUMERIC,
  cpp_paired_only NUMERIC,
  avg_up NUMERIC,
  avg_down NUMERIC,
  up_shares NUMERIC NOT NULL DEFAULT 0,
  down_shares NUMERIC NOT NULL DEFAULT 0,
  paired_shares NUMERIC NOT NULL DEFAULT 0,
  unpaired_shares NUMERIC NOT NULL DEFAULT 0,
  best_bid_up NUMERIC,
  best_ask_up NUMERIC,
  best_bid_down NUMERIC,
  best_ask_down NUMERIC,
  depth_summary_up JSONB,
  depth_summary_down JSONB,
  book_ready_up BOOLEAN NOT NULL DEFAULT false,
  book_ready_down BOOLEAN NOT NULL DEFAULT false,
  guards_evaluated JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Account position snapshots - canonical truth
CREATE TABLE public.account_position_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  market_id TEXT NOT NULL,
  account_up_shares NUMERIC NOT NULL DEFAULT 0,
  account_down_shares NUMERIC NOT NULL DEFAULT 0,
  account_avg_up NUMERIC,
  account_avg_down NUMERIC,
  wallet_address TEXT,
  source_endpoint TEXT,
  source_version TEXT
);

-- State reconciliation results
CREATE TABLE public.state_reconciliation_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  market_id TEXT NOT NULL,
  local_up NUMERIC NOT NULL DEFAULT 0,
  local_down NUMERIC NOT NULL DEFAULT 0,
  account_up NUMERIC NOT NULL DEFAULT 0,
  account_down NUMERIC NOT NULL DEFAULT 0,
  delta_shares NUMERIC NOT NULL DEFAULT 0,
  delta_invested NUMERIC,
  reconciliation_result TEXT NOT NULL,
  action_taken TEXT
);

-- Fill attribution - economic truth per fill
CREATE TABLE public.fill_attributions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  correlation_id TEXT,
  order_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  liquidity TEXT NOT NULL,
  fee_paid NUMERIC NOT NULL DEFAULT 0,
  rebate_expected NUMERIC NOT NULL DEFAULT 0,
  fill_cost_gross NUMERIC NOT NULL,
  fill_cost_net NUMERIC NOT NULL,
  updated_avg_up NUMERIC,
  updated_avg_down NUMERIC,
  updated_cpp_gross NUMERIC,
  updated_cpp_net_expected NUMERIC
);

-- Hedge skip explanations
CREATE TABLE public.hedge_skip_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  correlation_id TEXT,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  side_not_hedged TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  best_bid NUMERIC,
  best_ask NUMERIC,
  projected_cpp NUMERIC,
  unpaired_shares NUMERIC,
  seconds_remaining INTEGER
);

-- Mark-to-market snapshots
CREATE TABLE public.mtm_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  market_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  up_mid NUMERIC,
  down_mid NUMERIC,
  combined_mid NUMERIC,
  book_ready_up BOOLEAN NOT NULL DEFAULT false,
  book_ready_down BOOLEAN NOT NULL DEFAULT false,
  fallback_used TEXT,
  unrealized_pnl NUMERIC,
  confidence TEXT NOT NULL DEFAULT 'LOW'
);

-- Gabagool metrics snapshots
CREATE TABLE public.gabagool_metrics (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  ts BIGINT NOT NULL,
  run_id TEXT,
  total_paired_shares NUMERIC NOT NULL DEFAULT 0,
  paired_cpp_under_100_shares NUMERIC NOT NULL DEFAULT 0,
  paired_cpp_under_100_pct NUMERIC,
  cpp_distribution JSONB,
  high_cpp_trade_count INTEGER NOT NULL DEFAULT 0,
  maker_fills INTEGER NOT NULL DEFAULT 0,
  taker_fills INTEGER NOT NULL DEFAULT 0,
  maker_fill_ratio NUMERIC,
  invariant_status JSONB
);

-- Indexes for performance
CREATE INDEX idx_decision_snapshots_ts ON public.decision_snapshots(ts DESC);
CREATE INDEX idx_decision_snapshots_market ON public.decision_snapshots(market_id, ts DESC);
CREATE INDEX idx_account_position_snapshots_ts ON public.account_position_snapshots(ts DESC);
CREATE INDEX idx_state_reconciliation_results_ts ON public.state_reconciliation_results(ts DESC);
CREATE INDEX idx_fill_attributions_ts ON public.fill_attributions(ts DESC);
CREATE INDEX idx_fill_attributions_order ON public.fill_attributions(order_id);
CREATE INDEX idx_hedge_skip_logs_ts ON public.hedge_skip_logs(ts DESC);
CREATE INDEX idx_mtm_snapshots_ts ON public.mtm_snapshots(ts DESC);
CREATE INDEX idx_gabagool_metrics_ts ON public.gabagool_metrics(ts DESC);

-- Enable realtime for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.decision_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.hedge_skip_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.gabagool_metrics;