-- Add missing run_id column to v27_evaluations table
ALTER TABLE public.v27_evaluations 
ADD COLUMN IF NOT EXISTS run_id TEXT;