
-- Enable FULL replica identity for realtime updates with complete row data
-- This ensures all row data is included in realtime change events
ALTER TABLE public.live_trades REPLICA IDENTITY FULL;
ALTER TABLE public.live_trade_results REPLICA IDENTITY FULL;
ALTER TABLE public.order_queue REPLICA IDENTITY FULL;
