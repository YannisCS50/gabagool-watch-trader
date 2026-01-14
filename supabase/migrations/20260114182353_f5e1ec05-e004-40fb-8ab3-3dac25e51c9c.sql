-- Add prevent_counter_scalping column to v29_config table
-- This flag controls whether the bot can buy opposite direction when position exists

ALTER TABLE public.v29_config 
ADD COLUMN IF NOT EXISTS prevent_counter_scalping BOOLEAN NOT NULL DEFAULT true;

-- Add comment explaining the field
COMMENT ON COLUMN public.v29_config.prevent_counter_scalping IS 'If true, prevents buying opposite direction when position exists in same market (e.g., won''t buy DOWN if already have UP shares)';