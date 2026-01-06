-- Add unique constraint for upsert if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'bot_positions_wallet_market_outcome_key'
  ) THEN
    ALTER TABLE public.bot_positions 
    ADD CONSTRAINT bot_positions_wallet_market_outcome_key 
    UNIQUE (wallet_address, market_slug, outcome);
  END IF;
END $$;