-- Create v30_logs table for runner logs
CREATE TABLE public.v30_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ts bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  run_id text,
  level text NOT NULL DEFAULT 'info',
  category text NOT NULL DEFAULT 'system',
  asset text,
  message text NOT NULL,
  data jsonb
);

-- Create index for efficient querying
CREATE INDEX idx_v30_logs_ts ON public.v30_logs(ts DESC);
CREATE INDEX idx_v30_logs_category ON public.v30_logs(category);
CREATE INDEX idx_v30_logs_level ON public.v30_logs(level);

-- Enable RLS
ALTER TABLE public.v30_logs ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Allow public read for v30_logs" 
ON public.v30_logs 
FOR SELECT 
USING (true);

-- Allow service insert
CREATE POLICY "Allow service insert for v30_logs" 
ON public.v30_logs 
FOR INSERT 
WITH CHECK (true);

-- Allow service delete for cleanup
CREATE POLICY "Allow service delete for v30_logs" 
ON public.v30_logs 
FOR DELETE 
USING (true);

-- Enable realtime for logs
ALTER PUBLICATION supabase_realtime ADD TABLE public.v30_logs;