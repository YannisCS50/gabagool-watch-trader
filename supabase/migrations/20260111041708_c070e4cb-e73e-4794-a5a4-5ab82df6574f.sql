-- Add outcome column to realtime_price_logs for CLOB UP/DOWN share tracking
ALTER TABLE public.realtime_price_logs 
ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('up', 'down'));