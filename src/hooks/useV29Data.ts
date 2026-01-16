import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Config matches the actual v29_config table
export interface V29Config {
  id: string;
  enabled: boolean;
  tick_delta_usd: number;
  delta_threshold: number;
  min_share_price: number;
  max_share_price: number;
  shares_per_trade: number;
  price_buffer_cents: number;
  assets: string[];
  binance_poll_ms: number;
  orderbook_poll_ms: number;
  order_cooldown_ms: number;
  
  // Legacy fields still in DB
  min_profit_cents: number;
  trailing_trigger_cents: number;
  trailing_distance_cents: number;
  emergency_sl_cents: number;
  accumulation_enabled: boolean;
  max_total_cost_usd: number;
  max_total_shares: number;
  auto_hedge_enabled: boolean;
  hedge_trigger_cents: number;
  hedge_min_profit_cents: number;
  take_profit_cents: number;
  timeout_seconds: number;
  max_sell_retries: number;
  force_close_after_sec: number;
  aggregate_after_sec: number;
  stop_loss_cents: number;
  prevent_counter_scalping: boolean;
}

// Signal matches the actual v29_signals table
export interface V29Signal {
  id: string;
  asset: string;
  direction: string;
  delta_usd: number;
  binance_price: number;
  strike_price: number;
  share_price: number;
  status: string;
  entry_price: number;
  exit_price: number;
  shares: number;
  net_pnl: number;
  exit_reason: string;
  created_at: string;
}

// Position matches the actual v29_positions table
export interface V29Position {
  id: string;
  asset: string;
  side: string;
  market_slug: string;
  token_id: string;
  total_shares: number;
  total_cost: number;
  hedge_shares: number;
  hedge_cost: number;
  is_fully_hedged: boolean;
  created_at: string;
  updated_at: string;
}

export interface V29Stats {
  totalSignals: number;
  buyCount: number;
  pairCount: number;
  avgDeltaUsd: number;
  unpairedPositions: number;
  pairedPositions: number;
  totalPnl: number;
}

const DEFAULT_CONFIG: V29Config = {
  id: 'default',
  enabled: false,
  tick_delta_usd: 6,
  delta_threshold: 75,
  min_share_price: 0.08,
  max_share_price: 0.92,
  shares_per_trade: 5,
  price_buffer_cents: 2,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  binance_poll_ms: 100,
  orderbook_poll_ms: 1500,
  order_cooldown_ms: 1500,
  min_profit_cents: 2,
  trailing_trigger_cents: 3,
  trailing_distance_cents: 1,
  emergency_sl_cents: 5,
  accumulation_enabled: false,
  max_total_cost_usd: 100,
  max_total_shares: 200,
  auto_hedge_enabled: true,
  hedge_trigger_cents: 2,
  hedge_min_profit_cents: 1,
  take_profit_cents: 5,
  timeout_seconds: 120,
  max_sell_retries: 3,
  force_close_after_sec: 120,
  aggregate_after_sec: 60,
  stop_loss_cents: 5,
  prevent_counter_scalping: false,
};

export function useV29Data() {
  const [config, setConfig] = useState<V29Config>(DEFAULT_CONFIG);
  const [signals, setSignals] = useState<V29Signal[]>([]);
  const [positions, setPositions] = useState<V29Position[]>([]);
  const [stats, setStats] = useState<V29Stats>({
    totalSignals: 0,
    buyCount: 0,
    pairCount: 0,
    avgDeltaUsd: 0,
    unpairedPositions: 0,
    pairedPositions: 0,
    totalPnl: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchConfig = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('v29_config')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        setConfig(data as unknown as V29Config);
      }
    } catch (err) {
      console.error('Error fetching V29 config:', err);
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('v29_signals')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      if (data) {
        setSignals(data as unknown as V29Signal[]);
        
        // Calculate stats
        const filledSignals = data.filter(s => s.status === 'filled' || s.status === 'closed');
        const totalPnl = data.reduce((sum, s) => sum + (s.net_pnl || 0), 0);
        const avgDelta = data.length > 0 
          ? data.reduce((sum, s) => sum + Math.abs(s.delta_usd || 0), 0) / data.length 
          : 0;
        
        setStats(prev => ({
          ...prev,
          totalSignals: data.length,
          buyCount: filledSignals.length,
          avgDeltaUsd: avgDelta,
          totalPnl,
        }));
      }
    } catch (err) {
      console.error('Error fetching V29 signals:', err);
    }
  }, []);

  const fetchPositions = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('v29_positions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      if (data) {
        setPositions(data as unknown as V29Position[]);
        
        const unpaired = data.filter(p => !p.is_fully_hedged).length;
        const paired = data.filter(p => p.is_fully_hedged).length;
        
        setStats(prev => ({
          ...prev,
          unpairedPositions: unpaired,
          pairedPositions: paired,
          pairCount: paired,
        }));
      }
    } catch (err) {
      console.error('Error fetching V29 positions:', err);
    }
  }, []);

  const refetch = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchConfig(), fetchSignals(), fetchPositions()]);
    setLastUpdate(new Date());
    setLoading(false);
    setIsConnected(true);
  }, [fetchConfig, fetchSignals, fetchPositions]);

  const updateConfig = useCallback(async (updates: Partial<V29Config>): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('v29_config')
        .update(updates)
        .eq('id', config.id);

      if (error) throw error;
      
      setConfig(prev => ({ ...prev, ...updates }));
      return true;
    } catch (err) {
      console.error('Error updating V29 config:', err);
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
      .channel('v29_signals_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v29_signals' }, () => {
        fetchSignals();
        setLastUpdate(new Date());
      })
      .subscribe();

    const positionsChannel = supabase
      .channel('v29_positions_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v29_positions' }, () => {
        fetchPositions();
        setLastUpdate(new Date());
      })
      .subscribe();

    return () => {
      supabase.removeChannel(signalsChannel);
      supabase.removeChannel(positionsChannel);
    };
  }, [fetchSignals, fetchPositions]);

  return {
    config,
    signals,
    positions,
    stats,
    loading,
    error,
    isConnected,
    lastUpdate,
    updateConfig,
    refetch,
  };
}
