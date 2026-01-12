-- Create market-specific configuration table
CREATE TABLE public.market_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asset TEXT NOT NULL UNIQUE,
  
  -- Enable/disable
  enabled BOOLEAN NOT NULL DEFAULT true,
  shadow_only BOOLEAN NOT NULL DEFAULT false,
  
  -- Position limits
  max_shares NUMERIC NOT NULL DEFAULT 200,
  max_notional_usd NUMERIC NOT NULL DEFAULT 100,
  max_exposure_usd NUMERIC NOT NULL DEFAULT 150,
  
  -- Entry thresholds
  min_edge_pct NUMERIC NOT NULL DEFAULT 2.0,
  min_delta_usd NUMERIC NOT NULL DEFAULT 50,
  max_combined_price NUMERIC NOT NULL DEFAULT 0.98,
  min_ask_price NUMERIC NOT NULL DEFAULT 0.05,
  max_ask_price NUMERIC NOT NULL DEFAULT 0.55,
  
  -- TP/SL settings
  take_profit_pct NUMERIC NOT NULL DEFAULT 5.0,
  stop_loss_pct NUMERIC NOT NULL DEFAULT 10.0,
  trailing_stop_enabled BOOLEAN NOT NULL DEFAULT false,
  trailing_stop_pct NUMERIC DEFAULT 3.0,
  
  -- Timing
  min_seconds_remaining INTEGER NOT NULL DEFAULT 120,
  max_seconds_remaining INTEGER NOT NULL DEFAULT 600,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.market_config ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for now (no auth on this app)
CREATE POLICY "Allow all access to market_config"
ON public.market_config
FOR ALL
USING (true)
WITH CHECK (true);

-- Create trigger for updated_at
CREATE TRIGGER update_market_config_updated_at
BEFORE UPDATE ON public.market_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default configs for all assets
INSERT INTO public.market_config (asset, enabled) VALUES
  ('BTC', true),
  ('ETH', true),
  ('SOL', true),
  ('XRP', true);

-- Enable realtime for hot-reload in runner
ALTER PUBLICATION supabase_realtime ADD TABLE public.market_config;