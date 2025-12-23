-- Enable required extensions for cron jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Create settings table for bot configuration
CREATE TABLE public.paper_bot_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default settings
INSERT INTO public.paper_bot_settings (is_enabled) VALUES (true);

-- Enable RLS
ALTER TABLE public.paper_bot_settings ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Allow public read for paper_bot_settings" 
ON public.paper_bot_settings FOR SELECT USING (true);

CREATE POLICY "Allow public update for paper_bot_settings" 
ON public.paper_bot_settings FOR UPDATE USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.paper_bot_settings;