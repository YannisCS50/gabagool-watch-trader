-- Add missing filter columns to v29_config_response
ALTER TABLE public.v29_config_response 
ADD COLUMN IF NOT EXISTS max_spread_cents NUMERIC DEFAULT 1.0,
ADD COLUMN IF NOT EXISTS min_share_price NUMERIC DEFAULT 0.15,
ADD COLUMN IF NOT EXISTS max_share_price NUMERIC DEFAULT 0.85,
ADD COLUMN IF NOT EXISTS max_share_move_cents NUMERIC DEFAULT 0.5,
ADD COLUMN IF NOT EXISTS cooldown_ms INTEGER DEFAULT 2000,
ADD COLUMN IF NOT EXISTS max_exposure_usd NUMERIC DEFAULT 50;

-- Update existing row with defaults
UPDATE public.v29_config_response 
SET max_spread_cents = 1.0,
    min_share_price = 0.15,
    max_share_price = 0.85,
    max_share_move_cents = 0.5,
    cooldown_ms = 2000,
    max_exposure_usd = 50
WHERE max_spread_cents IS NULL;