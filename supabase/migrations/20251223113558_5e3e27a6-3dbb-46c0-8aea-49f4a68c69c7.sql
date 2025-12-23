-- Add new columns to strike_prices for proper RTDS-based price capture
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS open_price NUMERIC;
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS open_timestamp BIGINT;
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS close_price NUMERIC;
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS close_timestamp BIGINT;
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'chainlink_delayed';
ALTER TABLE strike_prices ADD COLUMN IF NOT EXISTS quality TEXT DEFAULT 'unknown';

-- Migrate existing data: copy strike_price to open_price, chainlink_timestamp to open_timestamp
UPDATE strike_prices 
SET open_price = strike_price,
    open_timestamp = chainlink_timestamp,
    source = 'chainlink_delayed',
    quality = CASE 
      WHEN ABS(chainlink_timestamp - (EXTRACT(EPOCH FROM event_start_time) * 1000)) > 30000 THEN 'late'
      ELSE 'unknown'
    END
WHERE open_price IS NULL;

-- Add comment explaining the columns
COMMENT ON COLUMN strike_prices.open_price IS 'Price to Beat - first Chainlink tick at/after eventStartTime';
COMMENT ON COLUMN strike_prices.open_timestamp IS 'Timestamp of the open price tick in milliseconds';
COMMENT ON COLUMN strike_prices.close_price IS 'Settlement price - first Chainlink tick at/after eventEndTime';
COMMENT ON COLUMN strike_prices.close_timestamp IS 'Timestamp of the close price tick in milliseconds';
COMMENT ON COLUMN strike_prices.source IS 'Source of price: polymarket_rtds, chainlink_delayed, coingecko_fallback';
COMMENT ON COLUMN strike_prices.quality IS 'Quality indicator: exact (<5s), late (5-60s), estimated (>60s or fallback)';