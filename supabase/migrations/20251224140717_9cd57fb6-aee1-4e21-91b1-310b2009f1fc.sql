-- Create table for runner heartbeats
CREATE TABLE public.runner_heartbeats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  runner_id text NOT NULL UNIQUE,
  runner_type text NOT NULL DEFAULT 'local',
  last_heartbeat timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  markets_count integer DEFAULT 0,
  positions_count integer DEFAULT 0,
  trades_count integer DEFAULT 0,
  balance numeric DEFAULT 0,
  ip_address text,
  version text DEFAULT '1.0.0',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.runner_heartbeats ENABLE ROW LEVEL SECURITY;

-- Allow public read
CREATE POLICY "Allow public read for runner_heartbeats"
ON public.runner_heartbeats
FOR SELECT
USING (true);

-- Allow service role insert/update
CREATE POLICY "Allow service insert for runner_heartbeats"
ON public.runner_heartbeats
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow service update for runner_heartbeats"
ON public.runner_heartbeats
FOR UPDATE
USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.runner_heartbeats;