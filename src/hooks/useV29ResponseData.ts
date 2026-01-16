import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Matches the actual v29_signals_response table
export interface V29RSignal {
  id: string;
  run_id: string;
  asset: string;
  direction: string;
  binance_price: number | null;
  binance_delta: number | null;
  binance_ts: number | null;
  share_price_t0: number | null;
  spread_t0: number | null;
  best_bid_t0: number | null;
  best_ask_t0: number | null;
  market_slug: string | null;
  strike_price: number | null;
  status: string;
  skip_reason: string | null;
  entry_price: number | null;
  exit_price: number | null;
  shares: number | null;
  signal_ts: number | null;
  decision_ts: number | null;
  fill_ts: number | null;
  exit_ts: number | null;
  exit_type: string | null;
  exit_reason: string | null;
  gross_pnl: number | null;
  fees: number | null;
  net_pnl: number | null;
  price_at_1s: number | null;
  price_at_2s: number | null;
  price_at_3s: number | null;
  price_at_5s: number | null;
  decision_latency_ms: number | null;
  order_latency_ms: number | null;
  fill_latency_ms: number | null;
  exit_latency_ms: number | null;
  created_at: string | null;
}

// Matches the actual v29_config_response table
export interface V29RConfig {
  id: string;
  enabled: boolean;
  signal_delta_usd: number;
  signal_window_ms: number;
  shares_per_trade: number;
  up_target_min: number;
  up_target_max: number;
  up_max_hold_sec: number;
  down_target_min: number;
  down_target_max: number;
  down_max_hold_sec: number;
  // Filter settings
  max_spread_cents: number;
  min_share_price: number;
  max_share_price: number;
  max_share_move_cents: number;
  cooldown_ms: number;
  max_exposure_usd: number;
  updated_at: string | null;
}

export interface V29RStats {
  totalSignals: number;
  filledSignals: number;
  skippedSignals: number;
  avgHoldTimeMs: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  exitReasonDistribution: Record<string, number>;
}

const DEFAULT_CONFIG: V29RConfig = {
  id: 'v29-response',
  enabled: true,
  signal_delta_usd: 6,
  signal_window_ms: 300,
  shares_per_trade: 5,
  up_target_min: 1.8,
  up_target_max: 2.0,
  up_max_hold_sec: 6,
  down_target_min: 2.0,
  down_target_max: 2.4,
  down_max_hold_sec: 7,
  // Filter settings
  max_spread_cents: 1.0,
  min_share_price: 0.15,
  max_share_price: 0.85,
  max_share_move_cents: 0.5,
  cooldown_ms: 2000,
  max_exposure_usd: 50,
  updated_at: null,
};

export function useV29ResponseData() {
  const [config, setConfig] = useState<V29RConfig>(DEFAULT_CONFIG);
  const [signals, setSignals] = useState<V29RSignal[]>([]);
  const [stats, setStats] = useState<V29RStats>({
    totalSignals: 0,
    filledSignals: 0,
    skippedSignals: 0,
    avgHoldTimeMs: 0,
    winRate: 0,
    totalPnl: 0,
    avgPnlPerTrade: 0,
    exitReasonDistribution: {},
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('v29_config_response')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setConfig(data as unknown as V29RConfig);
      }
    } catch (err) {
      console.error('Error fetching V29R config:', err);
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('v29_signals_response')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) throw error;
      if (data) {
        setSignals(data as unknown as V29RSignal[]);
        
        // Calculate stats
        const filled = data.filter(s => s.status === 'filled' || s.status === 'closed');
        const skipped = data.filter(s => s.status === 'skipped');
        const wins = filled.filter(s => (s.net_pnl || 0) > 0);
        const totalPnl = filled.reduce((sum, s) => sum + (s.net_pnl || 0), 0);
        
        // Calculate hold time from signal_ts and exit_ts
        const avgHold = filled.length > 0
          ? filled.reduce((sum, s) => {
              if (s.signal_ts && s.exit_ts) {
                return sum + (s.exit_ts - s.signal_ts);
              }
              return sum;
            }, 0) / filled.length
          : 0;
        
        // Exit reason distribution
        const exitReasons: Record<string, number> = {};
        filled.forEach(s => {
          const reason = s.exit_reason || 'unknown';
          exitReasons[reason] = (exitReasons[reason] || 0) + 1;
        });
        
        setStats({
          totalSignals: data.length,
          filledSignals: filled.length,
          skippedSignals: skipped.length,
          avgHoldTimeMs: avgHold,
          winRate: filled.length > 0 ? (wins.length / filled.length) * 100 : 0,
          totalPnl,
          avgPnlPerTrade: filled.length > 0 ? totalPnl / filled.length : 0,
          exitReasonDistribution: exitReasons,
        });
      }
    } catch (err) {
      console.error('Error fetching V29R signals:', err);
    }
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchConfig(), fetchSignals()]);
    setLastUpdate(new Date());
    setLoading(false);
    setIsConnected(true);
  }, [fetchConfig, fetchSignals]);

  const updateConfig = useCallback(async (updates: Partial<V29RConfig>): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('v29_config_response')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', config.id);

      if (error) throw error;
      
      setConfig(prev => ({ ...prev, ...updates }));
      return true;
    } catch (err) {
      console.error('Error updating V29R config:', err);
      setError('Failed to update config');
      return false;
    }
  }, [config.id]);

  // Initial fetch
  useEffect(() => {
    refetch();
  }, [refetch]);

  // Set up realtime subscriptions for signals AND config
  useEffect(() => {
    const channel = supabase
      .channel('v29_response_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v29_signals_response' }, () => {
        fetchSignals();
        setLastUpdate(new Date());
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v29_config_response' }, () => {
        fetchConfig();
        setLastUpdate(new Date());
      })
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    // Fallback polling every 5s in case realtime misses events
    const pollInterval = setInterval(() => {
      fetchSignals();
      setLastUpdate(new Date());
    }, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [fetchSignals, fetchConfig]);

  return {
    config,
    signals,
    stats,
    loading,
    error,
    isConnected,
    lastUpdate,
    updateConfig,
    refetch,
  };
}
