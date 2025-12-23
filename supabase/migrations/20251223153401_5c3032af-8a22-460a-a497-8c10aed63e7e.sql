-- Add unique constraint to prevent duplicate trades per market/outcome
ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_market_outcome_unique 
UNIQUE (market_slug, outcome);