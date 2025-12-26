-- Bot configuration table
CREATE TABLE public.bot_config (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Polymarket API credentials
  polymarket_api_key text,
  polymarket_api_secret text,
  polymarket_passphrase text,
  polymarket_private_key text,
  polymarket_address text,
  
  -- Backend settings
  backend_url text,
  runner_shared_secret text,
  
  -- VPN settings
  vpn_required boolean DEFAULT true,
  vpn_endpoint text,
  
  -- Trading strategy settings
  trade_assets text[] DEFAULT ARRAY['BTC', 'ETH'],
  max_notional_per_trade numeric DEFAULT 5,
  opening_max_price numeric DEFAULT 0.52,
  min_order_interval_ms integer DEFAULT 1500,
  cloudflare_backoff_ms integer DEFAULT 60000,
  
  -- Strategy parameters
  strategy_enabled boolean DEFAULT true,
  min_edge_threshold numeric DEFAULT 0.02,
  max_position_size numeric DEFAULT 100,
  
  -- Timestamps
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.bot_config ENABLE ROW LEVEL SECURITY;

-- Allow public read (for now - no auth)
CREATE POLICY "Allow public read for bot_config"
ON public.bot_config
FOR SELECT
USING (true);

-- Allow public update
CREATE POLICY "Allow public update for bot_config"
ON public.bot_config
FOR UPDATE
USING (true);

-- Allow public insert
CREATE POLICY "Allow public insert for bot_config"
ON public.bot_config
FOR INSERT
WITH CHECK (true);

-- Insert default row
INSERT INTO public.bot_config (id) VALUES ('00000000-0000-0000-0000-000000000001');

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION public.update_bot_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_bot_config_updated_at
BEFORE UPDATE ON public.bot_config
FOR EACH ROW
EXECUTE FUNCTION public.update_bot_config_updated_at();