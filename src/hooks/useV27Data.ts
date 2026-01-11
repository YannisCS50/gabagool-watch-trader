import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface V27Entry {
  id: string;
  created_at: string;
  ts: number;
  asset: string;
  market_id: string;
  market_slug: string | null;
  side: string;
  entry_price: number;
  shares: number;
  notional: number;
  mispricing_at_entry: number | null;
  threshold_at_entry: number | null;
  expected_correction: number | null;
  order_id: string | null;
  order_status: string;
  filled_shares: number;
  avg_fill_price: number | null;
  correction_started_at: string | null;
  correction_completed_at: string | null;
  peak_correction: number | null;
  hedge_triggered: boolean;
  hedge_order_id: string | null;
  hedge_filled_shares: number | null;
  hedge_avg_price: number | null;
  hedge_at: string | null;
  status: string;
  exit_price: number | null;
  pnl: number | null;
  result: string | null;
}

export interface V27Signal {
  id: string;
  created_at: string;
  ts: number;
  asset: string;
  market_id: string;
  signal_side: string;
  mispricing: number;
  threshold: number;
  confidence: number | null;
  action_taken: boolean;
  entry_id: string | null;
}

export interface V27Metrics {
  id: string;
  created_at: string;
  ts: number;
  run_id: string | null;
  total_signals: number;
  valid_signals: number;
  signal_quality_pct: number | null;
  adverse_blocks: number;
  adverse_block_reasons: Record<string, number> | null;
  entries_attempted: number;
  entries_filled: number;
  fill_rate: number | null;
  avg_fill_time_ms: number | null;
  corrections_detected: number;
  corrections_completed: number;
  avg_correction_pct: number | null;
  avg_correction_time_ms: number | null;
  hedges_triggered: number;
  emergency_hedges: number;
  hedge_success_rate: number | null;
  gross_pnl: number;
  fees_paid: number;
  net_pnl: number;
  wins: number;
  losses: number;
  win_rate: number | null;
}

export interface V27Stats {
  totalSignals: number;
  validSignals: number;
  signalQuality: number;
  totalEntries: number;
  filledEntries: number;
  fillRate: number;
  openPositions: number;
  correctionsCompleted: number;
  avgCorrectionPct: number;
  hedgesTriggered: number;
  emergencyHedges: number;
  adverseBlocks: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnl: number;
  netPnl: number;
  roi: number;
}

export function useV27Data() {
  const [entries, setEntries] = useState<V27Entry[]>([]);
  const [signals, setSignals] = useState<V27Signal[]>([]);
  const [metrics, setMetrics] = useState<V27Metrics | null>(null);
  const [stats, setStats] = useState<V27Stats>({
    totalSignals: 0,
    validSignals: 0,
    signalQuality: 0,
    totalEntries: 0,
    filledEntries: 0,
    fillRate: 0,
    openPositions: 0,
    correctionsCompleted: 0,
    avgCorrectionPct: 0,
    hedgesTriggered: 0,
    emergencyHedges: 0,
    adverseBlocks: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossPnl: 0,
    netPnl: 0,
    roi: 0,
  });
  const [loading, setLoading] = useState(true);
  const [runnerStatus, setRunnerStatus] = useState<{
    isOnline: boolean;
    lastHeartbeat: string | null;
    version: string | null;
    shadowMode: boolean;
  }>({
    isOnline: false,
    lastHeartbeat: null,
    version: null,
    shadowMode: true,
  });

  const fetchData = useCallback(async () => {
    setLoading(entries.length === 0);

    try {
      // Fetch entries, signals, and latest metrics in parallel
      const [entriesRes, signalsRes, metricsRes, heartbeatRes] = await Promise.all([
        supabase
          .from('v27_entries')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('v27_signals')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('v27_metrics')
          .select('*')
          .order('ts', { ascending: false })
          .limit(1)
          .single(),
        supabase
          .from('runner_heartbeats')
          .select('*')
          .eq('runner_type', 'v27')
          .order('last_heartbeat', { ascending: false })
          .limit(1)
          .single(),
      ]);

      const entriesData = (entriesRes.data || []) as V27Entry[];
      const signalsData = (signalsRes.data || []) as V27Signal[];
      const metricsData = metricsRes.data as V27Metrics | null;

      setEntries(entriesData);
      setSignals(signalsData);
      setMetrics(metricsData);

      // Calculate stats from entries
      const openPositions = entriesData.filter(e => e.status === 'open').length;
      const filledEntries = entriesData.filter(e => e.filled_shares > 0).length;
      const wins = entriesData.filter(e => e.result === 'WIN').length;
      const losses = entriesData.filter(e => e.result === 'LOSS').length;
      const settled = wins + losses;
      const winRate = settled > 0 ? (wins / settled) * 100 : 0;
      
      const grossPnl = entriesData.reduce((sum, e) => sum + (e.pnl || 0), 0);
      const totalInvested = entriesData.reduce((sum, e) => sum + (e.notional || 0), 0);
      const roi = totalInvested > 0 ? (grossPnl / totalInvested) * 100 : 0;

      const correctionsCompleted = entriesData.filter(e => e.correction_completed_at).length;
      const avgCorrectionPct = correctionsCompleted > 0
        ? entriesData
            .filter(e => e.peak_correction !== null)
            .reduce((sum, e) => sum + (e.peak_correction || 0), 0) / correctionsCompleted
        : 0;

      const hedgesTriggered = entriesData.filter(e => e.hedge_triggered).length;

      setStats({
        totalSignals: metricsData?.total_signals || signalsData.length,
        validSignals: metricsData?.valid_signals || signalsData.filter(s => s.action_taken).length,
        signalQuality: metricsData?.signal_quality_pct || 0,
        totalEntries: entriesData.length,
        filledEntries,
        fillRate: entriesData.length > 0 ? (filledEntries / entriesData.length) * 100 : 0,
        openPositions,
        correctionsCompleted,
        avgCorrectionPct,
        hedgesTriggered,
        emergencyHedges: metricsData?.emergency_hedges || 0,
        adverseBlocks: metricsData?.adverse_blocks || 0,
        wins,
        losses,
        winRate,
        grossPnl,
        netPnl: metricsData?.net_pnl || grossPnl,
        roi,
      });

      // Runner status
      if (heartbeatRes.data) {
        const lastHeartbeat = new Date(heartbeatRes.data.last_heartbeat);
        const now = new Date();
        const diffMs = now.getTime() - lastHeartbeat.getTime();
        const isOnline = diffMs < 60000; // Online if heartbeat within 60s

        setRunnerStatus({
          isOnline,
          lastHeartbeat: heartbeatRes.data.last_heartbeat,
          version: heartbeatRes.data.version || 'v27',
          shadowMode: true, // V27 starts in shadow mode by default
        });
      }
    } catch (err) {
      console.error('Error fetching V27 data:', err);
    } finally {
      setLoading(false);
    }
  }, [entries.length]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  // Realtime subscriptions
  useEffect(() => {
    const channel = supabase
      .channel('v27_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v27_entries' }, () => {
        fetchData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v27_signals' }, () => {
        fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  return {
    entries,
    signals,
    metrics,
    stats,
    loading,
    runnerStatus,
    refetch: fetchData,
  };
}
