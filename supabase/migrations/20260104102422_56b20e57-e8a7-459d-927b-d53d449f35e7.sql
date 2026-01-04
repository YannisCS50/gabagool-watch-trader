-- ============================================
-- OBSERVABILITY V1 - Database Upgrade
-- ============================================

-- 1) CANONICAL EVENT LOG TABLE
-- Central events table with correlation tracking
CREATE TABLE public.bot_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts bigint NOT NULL,
  run_id uuid,
  market_id text,
  asset text NOT NULL,
  event_type text NOT NULL, -- SNAPSHOT | ORDER_INTENT | ORDER_ACK | ORDER_FAIL | FILL | CANCEL_ACK | SETTLEMENT | BALANCE
  correlation_id uuid,
  reason_code text, -- EDGE_OK | EDGE_TOO_SMALL | NO_DEPTH | SPREAD_TOO_WIDE | FUNDS_BLOCKED_BAL | FUNDS_BLOCKED_ALLOW | RESERVED_TOO_HIGH | SURVIVAL_MODE | PAIR_COST_WORSENING
  data jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.bot_events ENABLE ROW LEVEL SECURITY;

-- RLS Policies for bot_events
CREATE POLICY "Allow public read for bot_events" 
  ON public.bot_events FOR SELECT USING (true);

CREATE POLICY "Allow service insert for bot_events" 
  ON public.bot_events FOR INSERT WITH CHECK (true);

-- 2) ORDERS TABLE (LIFECYCLE TRACKING)
CREATE TABLE public.orders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_order_id text NOT NULL,
  exchange_order_id text,
  correlation_id uuid,
  market_id text NOT NULL,
  asset text NOT NULL,
  side text NOT NULL, -- UP | DOWN
  price numeric NOT NULL,
  qty numeric NOT NULL,
  status text NOT NULL DEFAULT 'NEW', -- NEW | ACK | PARTIAL | FILLED | CANCELLED | REJECTED | EXPIRED
  intent_type text NOT NULL, -- ENTRY | HEDGE | PANIC | UNWIND
  filled_qty numeric DEFAULT 0,
  avg_fill_price numeric,
  reserved_notional numeric,
  released_notional numeric,
  created_ts bigint NOT NULL,
  last_update_ts bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- RLS Policies for orders
CREATE POLICY "Allow public read for orders" 
  ON public.orders FOR SELECT USING (true);

CREATE POLICY "Allow service insert for orders" 
  ON public.orders FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow service update for orders" 
  ON public.orders FOR UPDATE USING (true);

-- 3) INVENTORY SNAPSHOTS (per market)
CREATE TABLE public.inventory_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts bigint NOT NULL,
  market_id text NOT NULL,
  asset text NOT NULL,
  up_shares numeric NOT NULL DEFAULT 0,
  down_shares numeric NOT NULL DEFAULT 0,
  avg_up_cost numeric,
  avg_down_cost numeric,
  unpaired_shares numeric GENERATED ALWAYS AS (ABS(up_shares - down_shares)) STORED,
  pair_cost numeric,
  state text NOT NULL, -- FLAT | ONE_SIDED | HEDGED | SKEWED | UNWIND
  state_age_ms integer,
  hedge_lag_ms integer,
  trigger_type text, -- INTERVAL | FILL
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.inventory_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies for inventory_snapshots
CREATE POLICY "Allow public read for inventory_snapshots" 
  ON public.inventory_snapshots FOR SELECT USING (true);

CREATE POLICY "Allow service insert for inventory_snapshots" 
  ON public.inventory_snapshots FOR INSERT WITH CHECK (true);

-- 4) FUNDING SNAPSHOTS (CRITICAL)
CREATE TABLE public.funding_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts bigint NOT NULL,
  balance_total numeric NOT NULL,
  balance_available numeric NOT NULL,
  reserved_total numeric NOT NULL DEFAULT 0,
  reserved_by_market jsonb, -- { "market_id": amount }
  allowance_remaining numeric,
  spendable numeric,
  blocked_reason text, -- NONE | INSUFFICIENT_BAL | INSUFFICIENT_ALLOW | RESERVED_TOO_HIGH
  trigger_type text, -- INTERVAL | PRE_ORDER
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.funding_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies for funding_snapshots
CREATE POLICY "Allow public read for funding_snapshots" 
  ON public.funding_snapshots FOR SELECT USING (true);

CREATE POLICY "Allow service insert for funding_snapshots" 
  ON public.funding_snapshots FOR INSERT WITH CHECK (true);

-- 5) MARKET SNAPSHOTS (Mispricing & Delta) - Already exists as snapshot_logs, add missing columns
-- Adding correlation_id to existing snapshot_logs
ALTER TABLE public.snapshot_logs 
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS reason_code text;

-- 6) Add correlation_id to fill_logs
ALTER TABLE public.fill_logs
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS run_id uuid;

-- 7) Add correlation_id to settlement_logs
ALTER TABLE public.settlement_logs
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS fees numeric,
  ADD COLUMN IF NOT EXISTS failure_flag text; -- OK | ONE_SIDED | UNREDEEMED

-- 8) Add run_id to order_queue
ALTER TABLE public.order_queue
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS intent_type text;

-- 9) Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_bot_events_ts ON public.bot_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_correlation ON public.bot_events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_bot_events_market ON public.bot_events(market_id);
CREATE INDEX IF NOT EXISTS idx_bot_events_type ON public.bot_events(event_type);
CREATE INDEX IF NOT EXISTS idx_orders_client_id ON public.orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_correlation ON public.orders(correlation_id);
CREATE INDEX IF NOT EXISTS idx_orders_market ON public.orders(market_id);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_ts ON public.inventory_snapshots(ts DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_market ON public.inventory_snapshots(market_id);
CREATE INDEX IF NOT EXISTS idx_funding_snapshots_ts ON public.funding_snapshots(ts DESC);

-- Enable realtime for new tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.bot_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.funding_snapshots;