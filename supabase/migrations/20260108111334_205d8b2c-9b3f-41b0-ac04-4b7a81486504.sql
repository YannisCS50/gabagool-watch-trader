-- Create per-asset configuration table
CREATE TABLE public.v26_asset_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  asset TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  shares INTEGER NOT NULL DEFAULT 10,
  price NUMERIC(4,2) NOT NULL DEFAULT 0.48,
  side TEXT NOT NULL DEFAULT 'DOWN',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Insert default config for each asset
INSERT INTO public.v26_asset_config (asset, enabled, shares, price, side)
VALUES 
  ('BTC', true, 10, 0.48, 'DOWN'),
  ('ETH', true, 10, 0.48, 'DOWN'),
  ('SOL', true, 10, 0.48, 'DOWN'),
  ('XRP', true, 10, 0.48, 'DOWN');

-- Enable RLS
ALTER TABLE public.v26_asset_config ENABLE ROW LEVEL SECURITY;

-- Allow public read access (runner needs to read)
CREATE POLICY "Allow public read access" 
ON public.v26_asset_config 
FOR SELECT 
USING (true);

-- Allow public update access (dashboard needs to update)
CREATE POLICY "Allow public update access" 
ON public.v26_asset_config 
FOR UPDATE 
USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_v26_asset_config_updated_at
BEFORE UPDATE ON public.v26_asset_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();