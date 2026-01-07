-- Add columns to track accurate timing for V26 trades
ALTER TABLE public.v26_trades
ADD COLUMN IF NOT EXISTS placed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS fill_matched_at TIMESTAMPTZ;

-- Backfill placed_at from created_at for existing records
UPDATE public.v26_trades
SET placed_at = created_at
WHERE placed_at IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.v26_trades.placed_at IS 'Timestamp when order was placed (from created_at or CLOB)';
COMMENT ON COLUMN public.v26_trades.fill_matched_at IS 'Actual exchange match_time from CLOB trades API';