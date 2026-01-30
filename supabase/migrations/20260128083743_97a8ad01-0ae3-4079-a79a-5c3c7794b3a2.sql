-- Add wallet_address column to v35_fills for proper fill attribution
-- This fixes the bug where fills from OTHER traders were being logged
-- because the User WebSocket publishes all fills on our price levels, not just our own fills

ALTER TABLE public.v35_fills
ADD COLUMN wallet_address TEXT;

-- Add index for efficient filtering by wallet
CREATE INDEX IF NOT EXISTS idx_v35_fills_wallet_address 
ON public.v35_fills(wallet_address);

-- Composite index for common query pattern: wallet + market + time
CREATE INDEX IF NOT EXISTS idx_v35_fills_wallet_market_time 
ON public.v35_fills(wallet_address, market_slug, created_at DESC);

-- Comment for documentation
COMMENT ON COLUMN public.v35_fills.wallet_address IS 'The wallet address that executed this fill. Used to filter out fills from other traders on the same price levels.';