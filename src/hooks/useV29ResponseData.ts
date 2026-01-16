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

export interface V29RConfig {
  id: string;
  enabled: boolean;
  assets: string[];
  binance_min_move_usd: number;
  binance_window_ms: number;
  max_spread_cents: number;
  max_poly_move_cents: number;
  up_target_cents_min: number;
  up_target_cents_max: number;
  down_target_cents_min: number;
  down_target_cents_max: number;
  up_max_hold_ms: number;
  down_max_hold_ms: number;
  repricing_exhaustion_pct: number;
  stall_threshold_cents: number;
  stall_window_ms: number;
  adverse_spread_cents: number;
  cooldown_ms: number;
  shares_per_trade: number;
  max_slippage_cents: number;
  monitor_interval_ms: number;
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
  id: 'default',
  enabled: false,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_min_move_usd: 6,
  binance_window_ms: 300,
  max_spread_cents: 1.0,
  max_poly_move_cents: 0.5,
  up_target_cents_min: 1.8,
  up_target_cents_max: 2.0,
  down_target_cents_min: 2.0,
  down_target_cents_max: 2.4,
  up_max_hold_ms: 6000,
  down_max_hold_ms: 7000,
  repricing_exhaustion_pct: 0.65,
  stall_threshold_cents: 0.1,
  stall_window_ms: 1000,
  adverse_spread_cents: 1.5,
  cooldown_ms: 2500,
  shares_per_trade: 5,
  max_slippage_cents: 1.0,
  monitor_interval_ms: 150,
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
        .update(updates)
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

  // Set up realtime subscription
  useEffect(() => {
    const signalsChannel = supabase
      .channel('v29_signals_response_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v29_signals_response' }, () => {
        fetchSignals();
        setLastUpdate(new Date());
      })
      .subscribe();

    return () => {
      supabase.removeChannel(signalsChannel);
    };
  }, [fetchSignals]);

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
