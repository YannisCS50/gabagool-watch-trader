-- Enable pg_cron and pg_net extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create a cron job to call the true-pnl-snapshot edge function every 15 minutes
SELECT cron.schedule(
  'true-pnl-snapshot-every-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/true-pnl-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1enBkanBsYXNuZHl2YnpobHpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYzNTE5OTEsImV4cCI6MjA4MTkyNzk5MX0.fIs55-6uaB2M5y0fovJGY65130G5PFMmurosL7BE1dM'
    ),
    body := '{}'::jsonb
  );
  $$
);