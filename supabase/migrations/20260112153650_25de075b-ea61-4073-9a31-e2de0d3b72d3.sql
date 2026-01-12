-- Add tp_pct column for percentage-based take-profit (default 4% = 0.04)
ALTER TABLE public.paper_trading_config 
ADD COLUMN IF NOT EXISTS tp_pct numeric DEFAULT 0.04;