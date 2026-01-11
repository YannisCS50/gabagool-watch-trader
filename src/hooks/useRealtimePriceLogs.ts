import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface PriceLog {
  id: string;
  source: string;
  asset: string;
  price: number;
  raw_timestamp: number | null;
  received_at: string;
  created_at: string;
  outcome?: string | null;  // 'up' | 'down' for clob_shares source
}

interface LoggerStatus {
  totalLogs: number;
  lastHourLogs: number;
  latestLogs: PriceLog[];
}

export function useRealtimePriceLogs() {
  const [logs, setLogs] = useState<PriceLog[]>([]);
  const [status, setStatus] = useState<LoggerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      // Get counts from database directly
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const [totalResult, lastHourResult] = await Promise.all([
        supabase
          .from('realtime_price_logs')
          .select('*', { count: 'exact', head: true }),
        supabase
          .from('realtime_price_logs')
          .select('*', { count: 'exact', head: true })
          .gte('created_at', oneHourAgo.toISOString()),
      ]);

      setStatus({
        totalLogs: totalResult.count || 0,
        lastHourLogs: lastHourResult.count || 0,
        latestLogs: [],
      });
    } catch (e) {
      console.error('Failed to fetch logger status:', e);
    }
  }, []);

  const fetchRecentLogs = useCallback(async (limit = 100) => {
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: fetchError } = await supabase
        .from('realtime_price_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (fetchError) throw fetchError;
      setLogs(data || []);
      
      // Also refresh status
      await fetchStatus();
    } catch (e) {
      console.error('Failed to fetch logs:', e);
      setError(e instanceof Error ? e.message : 'Failed to fetch logs');
    } finally {
      setIsLoading(false);
    }
  }, [fetchStatus]);

  // Subscribe to realtime updates
  useEffect(() => {
    fetchStatus();
    fetchRecentLogs(100);

    const channel = supabase
      .channel('realtime_price_logs_changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'realtime_price_logs',
        },
        (payload) => {
          setLogs((prev) => [payload.new as PriceLog, ...prev.slice(0, 499)]);
        }
      )
      .subscribe();

    // Poll status every 30 seconds
    const statusInterval = setInterval(fetchStatus, 30000);

    return () => {
      channel.unsubscribe();
      clearInterval(statusInterval);
    };
  }, [fetchStatus, fetchRecentLogs]);

  return {
    logs,
    status,
    isLoading,
    error,
    fetchRecentLogs,
    fetchStatus,
  };
}
