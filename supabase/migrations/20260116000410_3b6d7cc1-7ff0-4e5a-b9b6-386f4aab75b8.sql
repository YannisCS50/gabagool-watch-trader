-- Add markets_active column to runner_heartbeats table
ALTER TABLE public.runner_heartbeats 
ADD COLUMN IF NOT EXISTS markets_active integer DEFAULT 0;