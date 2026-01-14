-- Add signal_key column for deduplication across runners
ALTER TABLE public.v29_signals 
ADD COLUMN IF NOT EXISTS signal_key TEXT;

-- Create unique index to prevent duplicate signals from multiple runners
CREATE UNIQUE INDEX IF NOT EXISTS v29_signals_signal_key_unique 
ON public.v29_signals(signal_key) 
WHERE signal_key IS NOT NULL;