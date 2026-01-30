-- V35 Orderbook Snapshots: logs full orderbook depth every tick
CREATE TABLE public.v35_orderbook_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts BIGINT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  market_slug TEXT NOT NULL,
  asset TEXT NOT NULL,
  
  -- Best prices (quick access)
  up_best_bid NUMERIC,
  up_best_ask NUMERIC,
  down_best_bid NUMERIC,
  down_best_ask NUMERIC,
  
  -- Combined metrics
  combined_ask NUMERIC,
  combined_mid NUMERIC,
  edge NUMERIC,
  
  -- Full depth as JSONB arrays [{price, size}, ...]
  up_bids JSONB,
  up_asks JSONB,
  down_bids JSONB,
  down_asks JSONB,
  
  -- Metadata
  spot_price NUMERIC,
  strike_price NUMERIC,
  seconds_to_expiry INTEGER
);

-- Index for time-series queries
CREATE INDEX idx_v35_orderbook_ts ON public.v35_orderbook_snapshots(ts DESC);
CREATE INDEX idx_v35_orderbook_asset ON public.v35_orderbook_snapshots(asset, ts DESC);
CREATE INDEX idx_v35_orderbook_market ON public.v35_orderbook_snapshots(market_slug, ts DESC);

-- Enable RLS (public insert for runner, public read for dashboard)
ALTER TABLE public.v35_orderbook_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON public.v35_orderbook_snapshots
  FOR SELECT USING (true);

CREATE POLICY "Allow service role insert" ON public.v35_orderbook_snapshots
  FOR INSERT WITH CHECK (true);

-- Enable realtime for live monitoring
ALTER PUBLICATION supabase_realtime ADD TABLE public.v35_orderbook_snapshots;

COMMENT ON TABLE public.v35_orderbook_snapshots IS 'V35 orderbook snapshots with full depth for analysis';