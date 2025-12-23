-- Drop the unique constraint that blocks multiple trades per market/outcome
ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_market_outcome_unique;

-- Also truncate the tables to reset all trades
TRUNCATE TABLE paper_trades;
TRUNCATE TABLE paper_trade_results;