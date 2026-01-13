-- Drop old columns and add new trailing stop columns to v29_config
ALTER TABLE public.v29_config 
  DROP COLUMN IF EXISTS tp_enabled,
  DROP COLUMN IF EXISTS tp_cents,
  DROP COLUMN IF EXISTS sl_enabled,
  DROP COLUMN IF EXISTS sl_cents;

ALTER TABLE public.v29_config
  ADD COLUMN IF NOT EXISTS min_profit_cents NUMERIC DEFAULT 4,
  ADD COLUMN IF NOT EXISTS trailing_trigger_cents NUMERIC DEFAULT 7,
  ADD COLUMN IF NOT EXISTS trailing_distance_cents NUMERIC DEFAULT 3,
  ADD COLUMN IF NOT EXISTS emergency_sl_cents NUMERIC DEFAULT 10;

-- Update existing row if it exists
UPDATE public.v29_config 
SET 
  min_profit_cents = 4,
  trailing_trigger_cents = 7,
  trailing_distance_cents = 3,
  emergency_sl_cents = 10
WHERE id = 'default';