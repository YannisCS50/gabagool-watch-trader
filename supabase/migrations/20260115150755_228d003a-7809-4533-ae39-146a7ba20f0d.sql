-- Track individual orders with P&L
CREATE TABLE public.v29_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id TEXT,
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  token_id TEXT,
  side TEXT NOT NULL, -- BUY or SELL
  direction TEXT NOT NULL, -- UP or DOWN
  shares NUMERIC NOT NULL,
  price NUMERIC NOT NULL, -- limit price
  cost NUMERIC, -- shares * price for buys
  status TEXT NOT NULL DEFAULT 'pending', -- pending, filled, partial, cancelled, failed
  fill_price NUMERIC,
  fill_shares NUMERIC,
  fill_cost NUMERIC,
  pnl NUMERIC, -- realized P&L (for sells: revenue - cost basis)
  order_id TEXT, -- polymarket order ID
  signal_id TEXT, -- link to v29_signals
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  filled_at TIMESTAMPTZ,
  notes TEXT
);

-- Track P&L per 15-min betting window
CREATE TABLE public.v29_bets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id TEXT,
  asset TEXT NOT NULL,
  market_id TEXT NOT NULL,
  market_slug TEXT,
  strike_price NUMERIC,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  
  -- Position tracking
  up_shares NUMERIC DEFAULT 0,
  up_avg_price NUMERIC,
  up_cost NUMERIC DEFAULT 0,
  down_shares NUMERIC DEFAULT 0,
  down_avg_price NUMERIC,
  down_cost NUMERIC DEFAULT 0,
  
  -- Trade counts
  buy_count INTEGER DEFAULT 0,
  sell_count INTEGER DEFAULT 0,
  
  -- P&L
  total_cost NUMERIC DEFAULT 0,
  total_revenue NUMERIC DEFAULT 0,
  realized_pnl NUMERIC DEFAULT 0,
  unrealized_pnl NUMERIC DEFAULT 0,
  
  -- Outcome
  status TEXT NOT NULL DEFAULT 'active', -- active, closed, settled
  result TEXT, -- win, loss, breakeven, pending
  settled_outcome TEXT, -- UP or DOWN (from oracle)
  payout NUMERIC,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX idx_v29_orders_asset ON public.v29_orders(asset);
CREATE INDEX idx_v29_orders_market ON public.v29_orders(market_id);
CREATE INDEX idx_v29_orders_created ON public.v29_orders(created_at DESC);
CREATE INDEX idx_v29_orders_run ON public.v29_orders(run_id);

CREATE INDEX idx_v29_bets_asset ON public.v29_bets(asset);
CREATE INDEX idx_v29_bets_market ON public.v29_bets(market_id);
CREATE INDEX idx_v29_bets_window ON public.v29_bets(window_start DESC);
CREATE INDEX idx_v29_bets_run ON public.v29_bets(run_id);
CREATE INDEX idx_v29_bets_status ON public.v29_bets(status);

-- Trigger for updated_at
CREATE TRIGGER update_v29_bets_updated_at
  BEFORE UPDATE ON public.v29_bets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS (but allow all for now since this is backend data)
ALTER TABLE public.v29_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v29_bets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for v29_orders" ON public.v29_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for v29_bets" ON public.v29_bets FOR ALL USING (true) WITH CHECK (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_bets;