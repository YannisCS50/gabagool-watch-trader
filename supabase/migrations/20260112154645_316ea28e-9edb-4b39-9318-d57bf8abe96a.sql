-- Add binance_chainlink_delta and binance_chainlink_latency_ms columns to paper_signals
ALTER TABLE public.paper_signals 
ADD COLUMN IF NOT EXISTS binance_chainlink_delta numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS binance_chainlink_latency_ms integer DEFAULT NULL;