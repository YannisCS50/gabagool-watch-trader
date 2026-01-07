-- Drop the old asset check constraint that only allows BTC and ETH
ALTER TABLE public.strike_prices DROP CONSTRAINT strike_prices_asset_check;

-- Add new constraint that also allows SOL and XRP
ALTER TABLE public.strike_prices ADD CONSTRAINT strike_prices_asset_check 
  CHECK (asset = ANY (ARRAY['BTC'::text, 'ETH'::text, 'SOL'::text, 'XRP'::text]));