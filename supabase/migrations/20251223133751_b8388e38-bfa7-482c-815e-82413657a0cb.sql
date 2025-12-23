-- Add open_price columns to market_history
ALTER TABLE market_history 
  ADD COLUMN IF NOT EXISTS open_price numeric,
  ADD COLUMN IF NOT EXISTS open_timestamp bigint,
  ADD COLUMN IF NOT EXISTS close_timestamp bigint;

-- Create index on slug for faster lookups
CREATE INDEX IF NOT EXISTS idx_market_history_slug ON market_history(slug);

-- Create index on asset + event_end_time for previous market lookups
CREATE INDEX IF NOT EXISTS idx_market_history_asset_end ON market_history(asset, event_end_time DESC);

-- Update existing rows: set open_price = strike_price where not null
UPDATE market_history SET open_price = strike_price WHERE strike_price IS NOT NULL AND open_price IS NULL;