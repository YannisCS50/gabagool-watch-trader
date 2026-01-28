-- Fix duplicate fills root cause: add unique constraint
-- First delete duplicates keeping only first entry
DELETE FROM v35_fills a
USING v35_fills b
WHERE a.id > b.id 
  AND a.order_id = b.order_id 
  AND a.wallet_address = b.wallet_address 
  AND a.market_slug = b.market_slug;

-- Add unique constraint to prevent future duplicates
ALTER TABLE v35_fills ADD CONSTRAINT v35_fills_unique_order 
  UNIQUE (order_id, wallet_address, market_slug);