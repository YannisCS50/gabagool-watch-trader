-- Add latency tracking columns to v29_ticks
ALTER TABLE public.v29_ticks 
ADD COLUMN IF NOT EXISTS order_latency_ms integer,
ADD COLUMN IF NOT EXISTS fill_latency_ms integer,
ADD COLUMN IF NOT EXISTS signal_to_fill_ms integer,
ADD COLUMN IF NOT EXISTS sign_latency_ms integer,
ADD COLUMN IF NOT EXISTS post_latency_ms integer,
ADD COLUMN IF NOT EXISTS used_cache boolean DEFAULT false;