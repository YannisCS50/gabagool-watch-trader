-- Add new simplified V29 config columns
ALTER TABLE public.v29_config 
ADD COLUMN IF NOT EXISTS shares_per_trade integer DEFAULT 5,
ADD COLUMN IF NOT EXISTS take_profit_cents numeric DEFAULT 4,
ADD COLUMN IF NOT EXISTS timeout_seconds integer DEFAULT 10,
ADD COLUMN IF NOT EXISTS max_sell_retries integer DEFAULT 5;

-- Update existing row with defaults
UPDATE public.v29_config 
SET 
  shares_per_trade = COALESCE(shares_per_trade, 5),
  take_profit_cents = COALESCE(take_profit_cents, 4),
  timeout_seconds = COALESCE(timeout_seconds, 10),
  max_sell_retries = COALESCE(max_sell_retries, 5)
WHERE id = 'default';