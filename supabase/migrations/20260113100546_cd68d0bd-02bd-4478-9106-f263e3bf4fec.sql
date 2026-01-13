-- Create V29 config table for simple live runner settings
CREATE TABLE public.v29_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  enabled BOOLEAN NOT NULL DEFAULT true,
  min_delta_usd NUMERIC NOT NULL DEFAULT 150,
  max_share_price NUMERIC NOT NULL DEFAULT 0.65,
  trade_size_usd NUMERIC NOT NULL DEFAULT 5,
  max_shares INTEGER NOT NULL DEFAULT 10,
  price_buffer_cents NUMERIC NOT NULL DEFAULT 1,
  assets TEXT[] NOT NULL DEFAULT ARRAY['BTC', 'ETH', 'SOL', 'XRP'],
  tp_enabled BOOLEAN NOT NULL DEFAULT true,
  tp_cents NUMERIC NOT NULL DEFAULT 2,
  sl_enabled BOOLEAN NOT NULL DEFAULT true,
  sl_cents NUMERIC NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  binance_poll_ms INTEGER NOT NULL DEFAULT 100,
  orderbook_poll_ms INTEGER NOT NULL DEFAULT 2000,
  order_cooldown_ms INTEGER NOT NULL DEFAULT 3000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.v29_config ENABLE ROW LEVEL SECURITY;

-- Allow public read access (config is not user-specific)
CREATE POLICY "V29 config is publicly readable" 
ON public.v29_config 
FOR SELECT 
USING (true);

-- Allow public update access (for UI editing)
CREATE POLICY "V29 config is publicly updatable" 
ON public.v29_config 
FOR UPDATE 
USING (true);

-- Allow public insert (for initial setup)
CREATE POLICY "V29 config is publicly insertable" 
ON public.v29_config 
FOR INSERT 
WITH CHECK (true);

-- Create trigger for updated_at
CREATE TRIGGER update_v29_config_updated_at
BEFORE UPDATE ON public.v29_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default config
INSERT INTO public.v29_config (
  id, enabled, min_delta_usd, max_share_price, trade_size_usd, max_shares,
  price_buffer_cents, assets, tp_enabled, tp_cents, sl_enabled, sl_cents,
  timeout_ms, binance_poll_ms, orderbook_poll_ms, order_cooldown_ms
) VALUES (
  'default', true, 150, 0.65, 5, 10,
  1, ARRAY['BTC', 'ETH', 'SOL', 'XRP'], true, 2, true, 3,
  30000, 100, 2000, 3000
);

-- Enable realtime for v29_config
ALTER PUBLICATION supabase_realtime ADD TABLE public.v29_config;