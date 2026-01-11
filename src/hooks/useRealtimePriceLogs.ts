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
}

interface LoggerStatus {
  totalLogs: number;
  lastHourLogs: number;
  latestLogs: PriceLog[];
}

interface CollectResult {
  success: boolean;
  collected: number;
  polymarket: number;
  chainlink: number;
  logs: { source: string; asset: string; price: number }[];
}

export function useRealtimePriceLogs() {
  const [logs, setLogs] = useState<PriceLog[]>([]);
  const [status, setStatus] = useState<LoggerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCollect, setLastCollect] = useState<CollectResult | null>(null);
  const [autoCollectInterval, setAutoCollectInterval] = useState<number | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/price-feed-logger?action=status`,
        {
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
        }
      );
      const data = await response.json();
      if (data.success) {
        setStatus({
          totalLogs: data.totalLogs,
          lastHourLogs: data.lastHourLogs,
          latestLogs: data.latestLogs || []
        });
      }
    } catch (e) {
      console.error('Failed to fetch logger status:', e);
    }
  }, []);

  const collectNow = useCallback(async () => {
    setIsCollecting(true);
    setError(null);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/price-feed-logger?action=collect`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
        }
      );
      const data = await response.json();
      if (data.success) {
        setLastCollect(data);
        // Refresh status after collect
        await fetchStatus();
      } else {
        setError(data.error || 'Failed to collect prices');
      }
      return data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to collect prices';
      setError(msg);
      return { success: false, error: msg };
    } finally {
      setIsCollecting(false);
    }
  }, [fetchStatus]);

  const startAutoCollect = useCallback((intervalSeconds: number = 10) => {
    if (autoCollectInterval !== null) return;
    
    // Collect immediately
    collectNow();
    
    // Then collect at interval
    const interval = window.setInterval(() => {
      collectNow();
    }, intervalSeconds * 1000);
    
    setAutoCollectInterval(interval);
  }, [collectNow, autoCollectInterval]);

  const stopAutoCollect = useCallback(() => {
    if (autoCollectInterval !== null) {
      window.clearInterval(autoCollectInterval);
      setAutoCollectInterval(null);
    }
  }, [autoCollectInterval]);

  const fetchRecentLogs = useCallback(async (limit = 100) => {
    setIsLoading(true);
    try {
      const { data, error: fetchError } = await supabase
        .from('realtime_price_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (fetchError) throw fetchError;
      setLogs(data || []);
    } catch (e) {
      console.error('Failed to fetch logs:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Subscribe to realtime updates
  useEffect(() => {
    fetchStatus();
    fetchRecentLogs();

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
          setLogs((prev) => [payload.new as PriceLog, ...prev.slice(0, 99)]);
        }
      )
      .subscribe();

    // Poll status every 30 seconds
    const statusInterval = setInterval(fetchStatus, 30000);

    return () => {
      channel.unsubscribe();
      clearInterval(statusInterval);
      if (autoCollectInterval !== null) {
        clearInterval(autoCollectInterval);
      }
    };
  }, [fetchStatus, fetchRecentLogs]);

  return {
    logs,
    status,
    isLoading,
    isCollecting,
    error,
    lastCollect,
    isAutoCollecting: autoCollectInterval !== null,
    collectNow,
    startAutoCollect,
    stopAutoCollect,
    fetchRecentLogs,
    fetchStatus,
  };
}
