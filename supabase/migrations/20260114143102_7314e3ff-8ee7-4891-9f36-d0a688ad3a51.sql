-- Add missing V29 columns for force close and profit settings
ALTER TABLE v29_config 
ADD COLUMN IF NOT EXISTS force_close_after_sec INTEGER DEFAULT 20,
ADD COLUMN IF NOT EXISTS aggregate_after_sec INTEGER DEFAULT 15,
ADD COLUMN IF NOT EXISTS stop_loss_cents NUMERIC DEFAULT 10;

-- Update with new values: 35s force close, 2.5¢ min profit
UPDATE v29_config 
SET 
  force_close_after_sec = 35,
  aggregate_after_sec = 25,
  min_profit_cents = 2.5,
  timeout_seconds = 35
WHERE id = 'default';