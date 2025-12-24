-- Create live_bot_settings table for persistent bot state
CREATE TABLE IF NOT EXISTS public.live_bot_settings (
  id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid PRIMARY KEY,
  is_enabled BOOLEAN DEFAULT false,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Insert default row
INSERT INTO public.live_bot_settings (id, is_enabled) 
VALUES ('00000000-0000-0000-0000-000000000001', false)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS
ALTER TABLE public.live_bot_settings ENABLE ROW LEVEL SECURITY;

-- Allow public read/write for bot settings (no auth required for this app)
CREATE POLICY "Allow public read on live_bot_settings" 
ON public.live_bot_settings FOR SELECT 
USING (true);

CREATE POLICY "Allow public write on live_bot_settings" 
ON public.live_bot_settings FOR UPDATE 
USING (true);