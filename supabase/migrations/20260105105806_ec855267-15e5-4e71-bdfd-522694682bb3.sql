-- Create cleanup function for old logs
CREATE OR REPLACE FUNCTION public.cleanup_old_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff_date TIMESTAMP WITH TIME ZONE := NOW() - INTERVAL '7 days';
  deleted_count INTEGER;
BEGIN
  -- Clean price_ticks
  DELETE FROM public.price_ticks WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from price_ticks', deleted_count;

  -- Clean snapshot_logs
  DELETE FROM public.snapshot_logs WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from snapshot_logs', deleted_count;

  -- Clean bot_events
  DELETE FROM public.bot_events WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from bot_events', deleted_count;

  -- Clean inventory_snapshots
  DELETE FROM public.inventory_snapshots WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from inventory_snapshots', deleted_count;

  -- Clean funding_snapshots
  DELETE FROM public.funding_snapshots WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from funding_snapshots', deleted_count;

  -- Clean hedge_intents
  DELETE FROM public.hedge_intents WHERE created_at < cutoff_date;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from hedge_intents', deleted_count;
  
  -- Clean order_queue (old completed/failed orders)
  DELETE FROM public.order_queue WHERE created_at < cutoff_date AND status IN ('filled', 'failed', 'cancelled');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rows from order_queue', deleted_count;
END;
$$;

-- Update RLS policies to allow DELETE on tables that need cleanup
DROP POLICY IF EXISTS "Allow service delete for price_ticks" ON public.price_ticks;
CREATE POLICY "Allow service delete for price_ticks" ON public.price_ticks FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow service delete for snapshot_logs" ON public.snapshot_logs;
CREATE POLICY "Allow service delete for snapshot_logs" ON public.snapshot_logs FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow service delete for bot_events" ON public.bot_events;
CREATE POLICY "Allow service delete for bot_events" ON public.bot_events FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow service delete for inventory_snapshots" ON public.inventory_snapshots;
CREATE POLICY "Allow service delete for inventory_snapshots" ON public.inventory_snapshots FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow service delete for funding_snapshots" ON public.funding_snapshots;
CREATE POLICY "Allow service delete for funding_snapshots" ON public.funding_snapshots FOR DELETE USING (true);

DROP POLICY IF EXISTS "Allow service delete for hedge_intents" ON public.hedge_intents;
CREATE POLICY "Allow service delete for hedge_intents" ON public.hedge_intents FOR DELETE USING (true);

-- Schedule cleanup to run daily at 3 AM UTC
SELECT cron.schedule(
  'cleanup-old-logs',
  '0 3 * * *',
  'SELECT public.cleanup_old_logs()'
);

-- Run cleanup immediately to clear existing old data
SELECT public.cleanup_old_logs();