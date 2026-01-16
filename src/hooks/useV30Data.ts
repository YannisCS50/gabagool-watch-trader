import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface V30Config {
  enabled: boolean;
  assets: string[];
  fair_value_model: string;
  base_theta: number;
  theta_time_decay_factor: number;
  theta_inventory_factor: number;
  i_max_base: number;
  bet_size_base: number;
  force_counter_at_pct: number;
  aggressive_exit_sec: number;
  min_share_price: number;
  max_share_price: number;
}

export interface V30Tick {
  id: string;
  ts: number;
  run_id: string;
  asset: string;
  market_slug: string | null;
  c_price: number | null;
  z_price: number | null;
  strike_price: number | null;
  seconds_remaining: number | null;
  delta_to_strike: number | null;
  up_best_ask: number | null;
  down_best_ask: number | null;
  fair_p_up: number | null;
  edge_up: number | null;
  edge_down: number | null;
  theta_current: number | null;
  inventory_up: number;
  inventory_down: number;
  inventory_net: number;
  action_taken: string | null;
  created_at: string;
}

export interface V30Position {
  id: string;
  run_id: string;
  asset: string;
  market_slug: string;
  direction: 'UP' | 'DOWN';
  shares: number;
  avg_entry_price: number;
  total_cost: number;
  created_at: string;
  updated_at: string;
}

export interface V30Stats {
  totalTicks: number;
  buysUp: number;
  buysDown: number;
  forceCounters: number;
  aggressiveExits: number;
  avgEdgeUp: number;
  avgEdgeDown: number;
  lastTickTs: number | null;
}

const DEFAULT_CONFIG: V30Config = {
  enabled: false,
  assets: ['BTC', 'ETH', 'SOL', 'XRP'],
  fair_value_model: 'empirical',
  base_theta: 0.03,
  theta_time_decay_factor: 0.5,
  theta_inventory_factor: 0.3,
  i_max_base: 500,
  bet_size_base: 50,
  force_counter_at_pct: 0.8,
  aggressive_exit_sec: 60,
  min_share_price: 0.05,
  max_share_price: 0.95,
};

export function useV30Data() {
  const [config, setConfig] = useState<V30Config>(DEFAULT_CONFIG);
  const [ticks, setTicks] = useState<V30Tick[]>([]);
  const [positions, setPositions] = useState<V30Position[]>([]);
  const [stats, setStats] = useState<V30Stats>({
    totalTicks: 0,
    buysUp: 0,
    buysDown: 0,
    forceCounters: 0,
    aggressiveExits: 0,
    avgEdgeUp: 0,
    avgEdgeDown: 0,
    lastTickTs: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number>(Date.now());
  
  const ticksRef = useRef<V30Tick[]>([]);

  // Calculate stats from ticks
  const calculateStats = useCallback((tickData: V30Tick[]) => {
    const actions = tickData.map(t => t.action_taken).filter(Boolean);
    const edgesUp = tickData.map(t => t.edge_up).filter((e): e is number => e !== null);
    const edgesDown = tickData.map(t => t.edge_down).filter((e): e is number => e !== null);

    setStats({
      totalTicks: tickData.length,
      buysUp: actions.filter(a => a === 'buy_up').length,
      buysDown: actions.filter(a => a === 'buy_down').length,
      forceCounters: actions.filter(a => a?.includes('force_counter')).length,
      aggressiveExits: actions.filter(a => a === 'aggressive_exit').length,
      avgEdgeUp: edgesUp.length > 0 ? edgesUp.reduce((a, b) => a + b, 0) / edgesUp.length : 0,
      avgEdgeDown: edgesDown.length > 0 ? edgesDown.reduce((a, b) => a + b, 0) / edgesDown.length : 0,
      lastTickTs: tickData[0]?.ts ?? null,
    });
  }, []);

  // Fetch config
  const fetchConfig = useCallback(async () => {
    const { data, error } = await supabase
      .from('v30_config')
      .select('*')
      .eq('id', 'default')
      .single();

    if (error) {
      console.error('Failed to fetch V30 config:', error);
      return;
    }

    if (data) {
      setConfig({
        enabled: data.enabled ?? false,
        assets: (data.assets as string[]) ?? ['BTC', 'ETH', 'SOL', 'XRP'],
        fair_value_model: data.fair_value_model ?? 'empirical',
        base_theta: Number(data.base_theta) || 0.03,
        theta_time_decay_factor: Number(data.theta_time_decay_factor) || 0.5,
        theta_inventory_factor: Number(data.theta_inventory_factor) || 0.3,
        i_max_base: Number(data.i_max_base) || 500,
        bet_size_base: Number(data.bet_size_base) || 50,
        force_counter_at_pct: Number(data.force_counter_at_pct) || 0.8,
        aggressive_exit_sec: Number(data.aggressive_exit_sec) || 60,
        min_share_price: Number(data.min_share_price) || 0.05,
        max_share_price: Number(data.max_share_price) || 0.95,
      });
    }
  }, []);

  // Fetch recent ticks
  const fetchTicks = useCallback(async () => {
    const { data, error } = await supabase
      .from('v30_ticks')
      .select('*')
      .order('ts', { ascending: false })
      .limit(500);

    if (error) {
      console.error('Failed to fetch V30 ticks:', error);
      return;
    }

    const tickData = (data || []) as V30Tick[];
    ticksRef.current = tickData;
    setTicks(tickData);
    calculateStats(tickData);
    setLastUpdate(Date.now());
  }, [calculateStats]);

  // Fetch positions
  const fetchPositions = useCallback(async () => {
    const { data, error } = await supabase
      .from('v30_positions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch V30 positions:', error);
      return;
    }

    setPositions((data || []) as V30Position[]);
    setLastUpdate(Date.now());
  }, []);

  // Update config
  const updateConfig = useCallback(async (updates: Partial<V30Config>) => {
    const { error } = await supabase
      .from('v30_config')
      .upsert({
        id: 'default',
        ...updates,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Failed to update V30 config:', error);
      return false;
    }

    setConfig(prev => ({ ...prev, ...updates }));
    return true;
  }, []);

  // Initial fetch
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        await Promise.all([fetchConfig(), fetchTicks(), fetchPositions()]);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [fetchConfig, fetchTicks, fetchPositions]);

  // Realtime subscriptions
  useEffect(() => {
    const channel = supabase
      .channel('v30-realtime-all')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v30_ticks' },
        (payload) => {
          const newTick = payload.new as V30Tick;
          setTicks(prev => {
            const updated = [newTick, ...prev.slice(0, 499)];
            ticksRef.current = updated;
            calculateStats(updated);
            return updated;
          });
          setLastUpdate(Date.now());
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v30_positions' },
        (payload) => {
          const newPos = payload.new as V30Position;
          setPositions(prev => [newPos, ...prev]);
          setLastUpdate(Date.now());
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'v30_positions' },
        (payload) => {
          const updated = payload.new as V30Position;
          setPositions(prev => prev.map(p => p.id === updated.id ? updated : p));
          setLastUpdate(Date.now());
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'v30_positions' },
        (payload) => {
          const deleted = payload.old as { id: string };
          setPositions(prev => prev.filter(p => p.id !== deleted.id));
          setLastUpdate(Date.now());
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'v30_config' },
        () => {
          fetchConfig();
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchConfig, calculateStats]);

  // Heartbeat - check connection and refetch if stale
  useEffect(() => {
    const interval = setInterval(() => {
      const age = Date.now() - lastUpdate;
      // If no updates for 30 seconds, refetch
      if (age > 30000) {
        fetchTicks();
        fetchPositions();
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [lastUpdate, fetchTicks, fetchPositions]);

  return {
    config,
    ticks,
    positions,
    stats,
    loading,
    error,
    isConnected,
    lastUpdate,
    updateConfig,
    refetch: () => Promise.all([fetchConfig(), fetchTicks(), fetchPositions()]),
  };
}
