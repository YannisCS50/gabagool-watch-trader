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

// Raw evaluation from v27_evaluations
interface V27Evaluation {
  id: string;
  ts: number;
  created_at: string;
  market_id: string;
  asset: string;
  action: string;
  mispricing_side: string | null;
  mispricing_magnitude: number | null;
  theoretical_up: number | null;
  theoretical_down: number | null;
  pm_up_bid: number | null;
  pm_up_ask: number | null;
  pm_down_bid: number | null;
  pm_down_ask: number | null;
  spot_price: number | null;
  delta_up: number | null;
  delta_down: number | null;
  signal_valid: boolean | null;
  adverse_blocked: boolean | null;
  adverse_reason: string | null;
  skip_reason: string | null;
}

// ============================================
// HOOK
// ============================================

export function useShadowPositions(limit: number = 500) {
  const [positions, setPositions] = useState<ShadowPosition[]>([]);
  const [executions, setExecutions] = useState<ShadowExecution[]>([]);
  const [dailyPnlData, setDailyPnlData] = useState<ShadowDailyPnL[]>([]);
  const [accountingData, setAccountingData] = useState<ShadowAccounting[]>([]);
  const [hedgeAttemptsData, setHedgeAttemptsData] = useState<ShadowHedgeAttempt[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      // Fetch from ACTUAL shadow tables (not derived from evaluations)
      const [positionsRes, executionsRes, dailyRes, accountingRes, hedgeRes] = await Promise.all([
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
          .limit(1000),
        supabase
          .from('shadow_hedge_attempts')
          .select('*')
          .order('timestamp', { ascending: false })
          .limit(500),
      ]);

      // Map positions from DB format to interface
      if (positionsRes.data && positionsRes.data.length > 0) {
        setPositions(positionsRes.data.map((p: any) => ({
          id: p.id,
          market_id: p.market_id,
          asset: p.asset,
          side: p.side as 'UP' | 'DOWN',
          entry_timestamp: Number(p.entry_timestamp),
          entry_iso: p.entry_iso,
          entry_price: Number(p.entry_price),
          entry_fill_type: p.entry_fill_type as 'MAKER' | 'TAKER',
          best_bid_at_signal: Number(p.best_bid_at_signal) || 0,
          best_ask_at_signal: Number(p.best_ask_at_signal) || 0,
          spread_at_entry: Number(p.spread_at_entry) || 0,
          size_usd: Number(p.size_usd) || 50,
          size_shares: Number(p.size_shares) || 0,
          signal_id: p.signal_id || p.id,
          time_to_expiry_at_entry: Number(p.time_to_expiry_at_entry) || 900,
          spot_price_at_entry: Number(p.spot_price_at_entry) || 0,
          theoretical_price_at_entry: Number(p.theoretical_price_at_entry) || 0.5,
          delta_at_entry: Number(p.delta_at_entry) || 0,
          mispricing_at_entry: Number(p.mispricing_at_entry) || 0,
          hedge_timestamp: p.hedge_timestamp ? Number(p.hedge_timestamp) : null,
          hedge_iso: p.hedge_iso,
          hedge_price: p.hedge_price ? Number(p.hedge_price) : null,
          hedge_fill_type: p.hedge_fill_type as 'MAKER' | 'TAKER' | 'EMERGENCY' | null,
          hedge_latency_ms: p.hedge_latency_ms ? Number(p.hedge_latency_ms) : null,
          hedge_spread: p.hedge_spread ? Number(p.hedge_spread) : null,
          paired: Boolean(p.paired),
          resolution: p.resolution as ShadowPosition['resolution'],
          resolution_timestamp: p.resolution_timestamp ? Number(p.resolution_timestamp) : null,
          resolution_reason: p.resolution_reason,
          gross_pnl: p.gross_pnl ? Number(p.gross_pnl) : null,
          fees: Number(p.fees) || 0,
          net_pnl: p.net_pnl ? Number(p.net_pnl) : null,
          roi_pct: p.roi_pct ? Number(p.roi_pct) : null,
          combined_price_paid: p.combined_price_paid ? Number(p.combined_price_paid) : null,
          created_at: p.created_at,
        })));
      }

      // Map executions
      if (executionsRes.data && executionsRes.data.length > 0) {
        setExecutions(executionsRes.data.map((e: any) => ({
          id: e.id,
          position_id: e.position_id,
          execution_type: e.execution_type as 'ENTRY' | 'HEDGE' | 'EMERGENCY_EXIT',
          timestamp: Number(e.timestamp),
          iso: e.iso,
          side: e.side as 'UP' | 'DOWN',
          price: Number(e.price),
          shares: Number(e.shares),
          cost_usd: Number(e.cost_usd),
          fill_type: e.fill_type as 'MAKER' | 'TAKER',
          fill_latency_assumed_ms: Number(e.fill_latency_assumed_ms) || 0,
          fill_confidence: (e.fill_confidence || 'MEDIUM') as 'HIGH' | 'MEDIUM' | 'LOW',
          best_bid: Number(e.best_bid) || 0,
          best_ask: Number(e.best_ask) || 0,
          spread: Number(e.spread) || 0,
          slippage_cents: Number(e.slippage_cents) || 0,
          fee_usd: Number(e.fee_usd) || 0,
        })));
      }

      // Map daily PnL
      if (dailyRes.data && dailyRes.data.length > 0) {
        setDailyPnlData(dailyRes.data.map((d: any) => ({
          id: d.id || d.date,
          date: d.date,
          realized_pnl: Number(d.realized_pnl) || 0,
          unrealized_pnl: Number(d.unrealized_pnl) || 0,
          total_pnl: Number(d.total_pnl) || 0,
          cumulative_pnl: Number(d.cumulative_pnl) || 0,
          trades: Number(d.trades) || 0,
          wins: Number(d.wins) || 0,
          losses: Number(d.losses) || 0,
          paired_hedged: Number(d.paired_hedged) || 0,
          expired_one_sided: Number(d.expired_one_sided) || 0,
          emergency_exited: Number(d.emergency_exited) || 0,
          no_fill: Number(d.no_fill) || 0,
          total_fees: Number(d.total_fees) || 0,
          win_rate: Number(d.win_rate) || 0,
          avg_win: Number(d.avg_win) || 0,
          avg_loss: Number(d.avg_loss) || 0,
          profit_factor: Number(d.profit_factor) || 0,
          starting_equity: Number(d.starting_equity) || 3000,
          ending_equity: Number(d.ending_equity) || 3000,
          max_drawdown: Number(d.max_drawdown) || 0,
        })));
      }

      // Map accounting
      if (accountingRes.data && accountingRes.data.length > 0) {
        setAccountingData(accountingRes.data.map((a: any) => ({
          id: a.id,
          timestamp: Number(a.timestamp),
          iso: a.iso,
          equity: Number(a.equity) || 3000,
          starting_equity: Number(a.starting_equity) || 3000,
          realized_pnl: Number(a.realized_pnl) || 0,
          unrealized_pnl: Number(a.unrealized_pnl) || 0,
          total_fees: Number(a.total_fees) || 0,
          open_positions: Number(a.open_positions) || 0,
          total_trades: Number(a.total_trades) || 0,
          peak_equity: Number(a.peak_equity) || 3000,
          drawdown_usd: Number(a.drawdown_usd) || 0,
          drawdown_pct: Number(a.drawdown_pct) || 0,
          max_drawdown_pct: Number(a.max_drawdown_pct) || 0,
        })));
      }

      // Map hedge attempts
      if (hedgeRes.data && hedgeRes.data.length > 0) {
        setHedgeAttemptsData(hedgeRes.data.map((h: any) => ({
          id: h.id,
          position_id: h.position_id,
          attempt_number: Number(h.attempt_number) || 1,
          timestamp: Number(h.timestamp),
          seconds_since_entry: Number(h.seconds_since_entry) || 0,
          hedge_side: h.hedge_side as 'UP' | 'DOWN',
          target_price: Number(h.target_price) || 0,
          actual_price: h.actual_price ? Number(h.actual_price) : null,
          spread_at_attempt: Number(h.spread_at_attempt) || 0,
          success: Boolean(h.success),
          failure_reason: h.failure_reason,
          is_emergency: Boolean(h.is_emergency),
          hedge_cpp: Number(h.hedge_cpp) || 0,
          projected_pnl: Number(h.projected_pnl) || 0,
        })));
      }

    } catch (err) {
      console.error('Error fetching shadow data:', err);
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shadow_executions' }, () => {
        fetchData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shadow_accounting' }, () => {
        fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  // Use DB data if available, otherwise derive from positions
  // For backwards compatibility with derived approach
  const finalExecutions = useMemo(() => {
    if (executions.length > 0) return executions;
    
    // Fallback: derive from positions if DB is empty
    const execs: ShadowExecution[] = [];
    positions.forEach((p) => {
      execs.push({
        id: `${p.id}-entry`,
        position_id: p.id,
        execution_type: 'ENTRY' as const,
        timestamp: p.entry_timestamp,
        iso: p.entry_iso,
        side: p.side,
        price: p.entry_price,
        shares: p.size_shares,
        cost_usd: p.size_usd,
        fill_type: p.entry_fill_type || 'TAKER',
        fill_latency_assumed_ms: 100,
        fill_confidence: 'HIGH' as const,
        best_bid: p.best_bid_at_signal,
        best_ask: p.best_ask_at_signal,
        spread: p.spread_at_entry,
        slippage_cents: 0.5,
        fee_usd: p.fees / 2,
      });
      
      if (p.hedge_timestamp && p.hedge_price) {
        execs.push({
          id: `${p.id}-hedge`,
          position_id: p.id,
          execution_type: 'HEDGE' as const,
          timestamp: p.hedge_timestamp,
          iso: p.hedge_iso || '',
          side: p.side === 'UP' ? 'DOWN' : 'UP',
          price: p.hedge_price,
          shares: p.size_shares,
          cost_usd: p.hedge_price * p.size_shares,
          fill_type: p.hedge_fill_type === 'EMERGENCY' ? 'TAKER' : 'MAKER',
          fill_latency_assumed_ms: p.hedge_latency_ms || 0,
          fill_confidence: 'MEDIUM' as const,
          best_bid: p.hedge_price - 0.01,
          best_ask: p.hedge_price,
          spread: p.hedge_spread || 0.02,
          slippage_cents: 1,
          fee_usd: p.fees / 2,
        });
      }
    });
    return execs.sort((a, b) => b.timestamp - a.timestamp);
  }, [executions, positions]);

  const finalDailyPnl = useMemo(() => {
    if (dailyPnlData.length > 0) return dailyPnlData;
    
    // Fallback: derive from positions
    const byDate: Record<string, ShadowPosition[]> = {};
    positions.forEach((p) => {
      const date = new Date(p.entry_iso).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(p);
    });

    const days = Object.entries(byDate)
      .map(([date, dayPositions]) => {
        const wins = dayPositions.filter((p) => (p.net_pnl || 0) > 0).length;
        const losses = dayPositions.filter((p) => (p.net_pnl || 0) < 0).length;
        const totalPnl = dayPositions.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
        const totalFees = dayPositions.reduce((sum, p) => sum + (p.fees || 0), 0);

        return {
          id: date,
          date,
          realized_pnl: totalPnl,
          unrealized_pnl: 0,
          total_pnl: totalPnl,
          cumulative_pnl: 0,
          trades: dayPositions.length,
          wins,
          losses,
          paired_hedged: dayPositions.filter((p) => p.resolution === 'PAIRED_HEDGED').length,
          expired_one_sided: dayPositions.filter((p) => p.resolution === 'EXPIRED_ONE_SIDED').length,
          emergency_exited: dayPositions.filter((p) => p.resolution === 'EMERGENCY_EXITED').length,
          no_fill: dayPositions.filter((p) => p.resolution === 'NO_FILL').length,
          total_fees: totalFees,
          win_rate: wins + losses > 0 ? wins / (wins + losses) : 0,
          avg_win: wins > 0 ? dayPositions.filter((p) => (p.net_pnl || 0) > 0).reduce((sum, p) => sum + (p.net_pnl || 0), 0) / wins : 0,
          avg_loss: losses > 0 ? Math.abs(dayPositions.filter((p) => (p.net_pnl || 0) < 0).reduce((sum, p) => sum + (p.net_pnl || 0), 0) / losses) : 0,
          profit_factor: 0,
          starting_equity: 3000,
          ending_equity: 3000 + totalPnl,
          max_drawdown: 0,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    let cumulative = 0;
    const reversed = [...days].reverse();
    reversed.forEach((d) => {
      cumulative += d.total_pnl;
      d.cumulative_pnl = cumulative;
    });

    return days;
  }, [dailyPnlData, positions]);

  const finalAccounting = useMemo(() => {
    if (accountingData.length > 0) return accountingData;
    
    // Fallback: derive from positions
    const startingEquity = 3000;
    let equity = startingEquity;
    let peakEquity = startingEquity;
    let totalFees = 0;
    let totalRealizedPnl = 0;

    const sortedPositions = [...positions].sort((a, b) => a.entry_timestamp - b.entry_timestamp);

    return sortedPositions.map((p, idx) => {
      totalRealizedPnl += p.net_pnl || 0;
      totalFees += p.fees;
      equity = startingEquity + totalRealizedPnl;
      peakEquity = Math.max(peakEquity, equity);
      const drawdownUsd = peakEquity - equity;
      const drawdownPct = peakEquity > 0 ? (drawdownUsd / peakEquity) * 100 : 0;

      return {
        id: `${p.id}-acc`,
        timestamp: p.entry_timestamp,
        iso: p.entry_iso,
        equity,
        starting_equity: startingEquity,
        realized_pnl: totalRealizedPnl,
        unrealized_pnl: 0,
        total_fees: totalFees,
        open_positions: positions.filter((op) => op.resolution === 'OPEN').length,
        total_trades: idx + 1,
        peak_equity: peakEquity,
        drawdown_usd: drawdownUsd,
        drawdown_pct: drawdownPct,
        max_drawdown_pct: drawdownPct,
      };
    });
  }, [accountingData, positions]);

  const finalHedgeAttempts = useMemo(() => {
    return hedgeAttemptsData;
  }, [hedgeAttemptsData]);

  // Computed: Equity curve from accounting snapshots
  const equityCurve = useMemo(() => {
    return finalAccounting.map((a) => ({
      timestamp: a.timestamp,
      iso: a.iso,
      equity: a.equity,
      realizedPnl: a.realized_pnl,
      unrealizedPnl: a.unrealized_pnl,
      drawdown: a.drawdown_pct,
      fees: a.total_fees,
    }));
  }, [finalAccounting]);

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
    const latestAccounting = finalAccounting[finalAccounting.length - 1];
    const totalPnl = positions.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
    const wins = positions.filter((p) => (p.net_pnl || 0) > 0).length;
    const losses = positions.filter((p) => (p.net_pnl || 0) < 0).length;
    const totalFees = positions.reduce((sum, p) => sum + (p.fees || 0), 0);

    const startingEquity = 3000;
    const currentEquity = latestAccounting?.equity || startingEquity + totalPnl;

    const allTimeHigh = finalAccounting.reduce((max, a) => Math.max(max, a.peak_equity || a.equity), startingEquity);
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
      totalPositions: positions.length,
      openPositions: positions.filter((p) => p.resolution === 'OPEN').length,
      pnlByAsset,
      pnlByResolution,
    };
  }, [positions, finalAccounting]);

  return {
    positions,
    executions: finalExecutions,
    dailyPnl: finalDailyPnl,
    accounting: finalAccounting,
    hedgeAttempts: finalHedgeAttempts,
    equityCurve,
    hedgeAnalysis,
    stats,
    loading,
    refetch: fetchData,
  };
}
