import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

// ============================================
// TYPES
// ============================================

export interface ShadowPosition {
  id: string;
  market_id: string;
  asset: string;
  side: 'UP' | 'DOWN';
  entry_timestamp: number;
  entry_iso: string;
  entry_price: number;
  entry_fill_type: 'MAKER' | 'TAKER';
  best_bid_at_signal: number;
  best_ask_at_signal: number;
  spread_at_entry: number;
  size_usd: number;
  size_shares: number;
  signal_id: string;
  time_to_expiry_at_entry: number;
  spot_price_at_entry: number;
  theoretical_price_at_entry: number;
  delta_at_entry: number;
  mispricing_at_entry: number;
  hedge_timestamp: number | null;
  hedge_iso: string | null;
  hedge_price: number | null;
  hedge_fill_type: 'MAKER' | 'TAKER' | 'EMERGENCY' | null;
  hedge_latency_ms: number | null;
  hedge_spread: number | null;
  paired: boolean;
  resolution: 'OPEN' | 'PAIRED_HEDGED' | 'EXPIRED_ONE_SIDED' | 'EMERGENCY_EXITED' | 'NO_FILL';
  resolution_timestamp: number | null;
  resolution_reason: string | null;
  gross_pnl: number | null;
  fees: number;
  net_pnl: number | null;
  roi_pct: number | null;
  combined_price_paid: number | null;
  created_at: string;
}

export interface ShadowExecution {
  id: string;
  position_id: string;
  execution_type: 'ENTRY' | 'HEDGE' | 'EMERGENCY_EXIT';
  timestamp: number;
  iso: string;
  side: 'UP' | 'DOWN';
  price: number;
  shares: number;
  cost_usd: number;
  fill_type: 'MAKER' | 'TAKER';
  fill_latency_assumed_ms: number;
  fill_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  best_bid: number;
  best_ask: number;
  spread: number;
  slippage_cents: number;
  fee_usd: number;
}

export interface ShadowDailyPnL {
  id: string;
  date: string;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  cumulative_pnl: number;
  trades: number;
  wins: number;
  losses: number;
  paired_hedged: number;
  expired_one_sided: number;
  emergency_exited: number;
  no_fill: number;
  total_fees: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  starting_equity: number;
  ending_equity: number;
  max_drawdown: number;
}

export interface ShadowAccounting {
  id: string;
  timestamp: number;
  iso: string;
  equity: number;
  starting_equity: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_fees: number;
  open_positions: number;
  total_trades: number;
  peak_equity: number;
  drawdown_usd: number;
  drawdown_pct: number;
  max_drawdown_pct: number;
}

export interface ShadowHedgeAttempt {
  id: string;
  position_id: string;
  attempt_number: number;
  timestamp: number;
  seconds_since_entry: number;
  hedge_side: 'UP' | 'DOWN';
  target_price: number;
  actual_price: number | null;
  spread_at_attempt: number;
  success: boolean;
  failure_reason: string | null;
  is_emergency: boolean;
  hedge_cpp: number;
  projected_pnl: number;
}

export interface HedgeAnalysisStats {
  totalPositions: number;
  hedgedSuccessfully: number;
  hedgeSuccessRate: number;
  avgHedgeLatencyMs: number;
  emergencyHedgeCount: number;
  emergencyHedgeRate: number;
  unhedgedExpiryCount: number;
  unhedgedExpiryRate: number;
  hedgeLatencyDistribution: { bucket: string; count: number }[];
}

export interface CounterfactualComparison {
  signalOnlyPnl: number;
  executedPnl: number;
  signalSuccessRate: number;
  executionSuccessRate: number;
  goodSignalsFailedExecution: number;
  badSignalsSavedByHedge: number;
}

// ============================================
// HOOK
// ============================================

export function useShadowPositions(limit: number = 500) {
  const [positions, setPositions] = useState<ShadowPosition[]>([]);
  const [executions, setExecutions] = useState<ShadowExecution[]>([]);
  const [dailyPnl, setDailyPnl] = useState<ShadowDailyPnL[]>([]);
  const [accounting, setAccounting] = useState<ShadowAccounting[]>([]);
  const [hedgeAttempts, setHedgeAttempts] = useState<ShadowHedgeAttempt[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [posRes, execRes, dailyRes, accRes, hedgeRes] = await Promise.all([
        supabase
          .from('shadow_positions')
          .select('*')
          .order('entry_timestamp', { ascending: false })
          .limit(limit),
        supabase
          .from('shadow_executions')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(limit * 2),
        supabase
          .from('shadow_daily_pnl')
          .select('*')
          .order('date', { ascending: false })
          .limit(90),
        supabase
          .from('shadow_accounting')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(500),
        supabase
          .from('shadow_hedge_attempts')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(limit * 3),
      ]);

      if (posRes.data) setPositions(posRes.data as ShadowPosition[]);
      if (execRes.data) setExecutions(execRes.data as ShadowExecution[]);
      if (dailyRes.data) setDailyPnl(dailyRes.data as ShadowDailyPnL[]);
      if (accRes.data) setAccounting(accRes.data as ShadowAccounting[]);
      if (hedgeRes.data) setHedgeAttempts(hedgeRes.data as ShadowHedgeAttempt[]);
    } catch (err) {
      console.error('Error fetching shadow positions:', err);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('shadow_positions_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shadow_positions' }, () => {
        fetchData();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'shadow_accounting' }, () => {
        fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  // Computed: Equity curve from accounting snapshots
  const equityCurve = useMemo(() => {
    return accounting
      .slice()
      .reverse()
      .map((a) => ({
        timestamp: a.timestamp,
        iso: a.iso,
        equity: a.equity,
        realizedPnl: a.realized_pnl,
        unrealizedPnl: a.unrealized_pnl,
        drawdown: a.drawdown_pct,
        fees: a.total_fees,
      }));
  }, [accounting]);

  // Computed: Hedge analysis stats
  const hedgeAnalysis = useMemo((): HedgeAnalysisStats => {
    const total = positions.length;
    const hedged = positions.filter((p) => p.resolution === 'PAIRED_HEDGED').length;
    const emergency = positions.filter((p) => p.hedge_fill_type === 'EMERGENCY').length;
    const unhedgedExpiry = positions.filter((p) => p.resolution === 'EXPIRED_ONE_SIDED').length;

    const hedgedPositions = positions.filter((p) => p.hedge_latency_ms !== null);
    const avgLatency = hedgedPositions.length > 0
      ? hedgedPositions.reduce((sum, p) => sum + (p.hedge_latency_ms || 0), 0) / hedgedPositions.length
      : 0;

    // Latency distribution buckets
    const buckets = [
      { min: 0, max: 1000, label: '<1s' },
      { min: 1000, max: 5000, label: '1-5s' },
      { min: 5000, max: 10000, label: '5-10s' },
      { min: 10000, max: 30000, label: '10-30s' },
      { min: 30000, max: Infinity, label: '>30s' },
    ];

    const latencyDist = buckets.map((b) => ({
      bucket: b.label,
      count: hedgedPositions.filter(
        (p) => (p.hedge_latency_ms || 0) >= b.min && (p.hedge_latency_ms || 0) < b.max
      ).length,
    }));

    return {
      totalPositions: total,
      hedgedSuccessfully: hedged,
      hedgeSuccessRate: total > 0 ? hedged / total : 0,
      avgHedgeLatencyMs: avgLatency,
      emergencyHedgeCount: emergency,
      emergencyHedgeRate: total > 0 ? emergency / total : 0,
      unhedgedExpiryCount: unhedgedExpiry,
      unhedgedExpiryRate: total > 0 ? unhedgedExpiry / total : 0,
      hedgeLatencyDistribution: latencyDist,
    };
  }, [positions]);

  // Computed: Summary stats
  const stats = useMemo(() => {
    const latestAccounting = accounting[0];
    const totalPnl = positions.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
    const wins = positions.filter((p) => (p.net_pnl || 0) > 0).length;
    const losses = positions.filter((p) => (p.net_pnl || 0) < 0).length;
    const totalFees = positions.reduce((sum, p) => sum + (p.fees || 0), 0);

    const startingEquity = 3000;
    const currentEquity = latestAccounting?.equity || startingEquity + totalPnl;

    const allTimeHigh = accounting.reduce((max, a) => Math.max(max, a.peak_equity || a.equity), startingEquity);
    const maxDrawdown = latestAccounting?.max_drawdown_pct || 0;

    // PnL by asset
    const pnlByAsset: Record<string, number> = {};
    positions.forEach((p) => {
      pnlByAsset[p.asset] = (pnlByAsset[p.asset] || 0) + (p.net_pnl || 0);
    });

    // PnL by resolution
    const pnlByResolution: Record<string, number> = {};
    positions.forEach((p) => {
      pnlByResolution[p.resolution] = (pnlByResolution[p.resolution] || 0) + (p.net_pnl || 0);
    });

    return {
      startingEquity,
      currentEquity,
      realizedPnl: totalPnl,
      unrealizedPnl: latestAccounting?.unrealized_pnl || 0,
      totalFees,
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      maxDrawdown,
      allTimeHigh,
      totalTrades: positions.length,
      openPositions: positions.filter((p) => p.resolution === 'OPEN').length,
      pnlByAsset,
      pnlByResolution,
    };
  }, [positions, accounting]);

  return {
    positions,
    executions,
    dailyPnl,
    accounting,
    hedgeAttempts,
    equityCurve,
    hedgeAnalysis,
    stats,
    loading,
    refetch: fetchData,
  };
}
