-- Enable realtime for trades table (paper_trades already enabled)
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;

-- Add orderbook-related columns to paper_trades for slippage tracking
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS best_bid numeric;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS best_ask numeric;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS estimated_slippage numeric;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS available_liquidity numeric;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS avg_fill_price numeric;