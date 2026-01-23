-- Add metadata column to runner_heartbeats for V35 extended data
ALTER TABLE public.runner_heartbeats 
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;