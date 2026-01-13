-- Add new fields for delta-based direction logic
ALTER TABLE public.v29_config
ADD COLUMN IF NOT EXISTS min_share_price NUMERIC DEFAULT 0.30,
ADD COLUMN IF NOT EXISTS delta_threshold NUMERIC DEFAULT 70,
ADD COLUMN IF NOT EXISTS tick_delta_usd NUMERIC DEFAULT 6;

-- Update the default config with new values
UPDATE public.v29_config 
SET 
  min_share_price = 0.30,
  max_share_price = 0.75,
  delta_threshold = 70,
  tick_delta_usd = 6,
  tp_cents = 4,
  min_delta_usd = 6
WHERE id = 'default';