-- Create the update_updated_at_column function if it doesn't exist
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- V26 Configuration table for strategy settings
CREATE TABLE public.v26_config (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shares INTEGER NOT NULL DEFAULT 10,
  price NUMERIC(4,2) NOT NULL DEFAULT 0.48,
  side TEXT NOT NULL DEFAULT 'DOWN' CHECK (side IN ('UP', 'DOWN')),
  assets TEXT[] NOT NULL DEFAULT ARRAY['BTC', 'ETH', 'SOL', 'XRP'],
  enabled BOOLEAN NOT NULL DEFAULT true,
  max_lead_time_sec INTEGER NOT NULL DEFAULT 600,
  min_lead_time_sec INTEGER NOT NULL DEFAULT 60,
  cancel_after_start_sec INTEGER NOT NULL DEFAULT 30,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Insert default config row
INSERT INTO public.v26_config (shares, price, side, assets, enabled)
VALUES (10, 0.48, 'DOWN', ARRAY['BTC', 'ETH', 'SOL', 'XRP'], true);

-- Enable RLS
ALTER TABLE public.v26_config ENABLE ROW LEVEL SECURITY;

-- Public read access (runner needs to read)
CREATE POLICY "Anyone can read v26_config"
ON public.v26_config
FOR SELECT
USING (true);

-- Public update access (simple for now, could be restricted later)
CREATE POLICY "Anyone can update v26_config"
ON public.v26_config
FOR UPDATE
USING (true);

-- Trigger for updated_at
CREATE TRIGGER update_v26_config_updated_at
BEFORE UPDATE ON public.v26_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();