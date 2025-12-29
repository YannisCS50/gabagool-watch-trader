-- Add wallet_address column to live_trades
ALTER TABLE public.live_trades 
ADD COLUMN wallet_address text;

-- Add wallet_address column to live_trade_results
ALTER TABLE public.live_trade_results 
ADD COLUMN wallet_address text;

-- Create index for faster filtering
CREATE INDEX idx_live_trades_wallet ON public.live_trades(wallet_address);
CREATE INDEX idx_live_trade_results_wallet ON public.live_trade_results(wallet_address);