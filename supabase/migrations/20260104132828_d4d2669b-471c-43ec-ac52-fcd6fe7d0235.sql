-- 1) Add orderbook_ready to snapshot_logs
ALTER TABLE public.snapshot_logs 
ADD COLUMN orderbook_ready boolean DEFAULT NULL;

-- 2) Add theoretical_pnl to settlement_logs
ALTER TABLE public.settlement_logs 
ADD COLUMN theoretical_pnl numeric DEFAULT NULL;

COMMENT ON COLUMN public.snapshot_logs.orderbook_ready IS 'True if bids and asks present + depth initialized, false if orderbook not safe for trading';
COMMENT ON COLUMN public.settlement_logs.theoretical_pnl IS 'Theoretical PnL = 1.0 - pair_cost, for comparing theoretical edge vs realized PnL';