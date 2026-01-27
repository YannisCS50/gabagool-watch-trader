-- Add columns needed for idempotent fill storage (dedupe)
ALTER TABLE public.v35_fills
ADD COLUMN IF NOT EXISTS token_id TEXT;

ALTER TABLE public.v35_fills
ADD COLUMN IF NOT EXISTS fill_ts TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.v35_fills
ADD COLUMN IF NOT EXISTS fill_key TEXT;
