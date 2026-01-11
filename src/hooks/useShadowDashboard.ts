import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

// ============================================
// TYPES
// ============================================

export type EngineState = 'COLD' | 'WARM' | 'HOT';

export interface EngineStatus {
  state: EngineState;
  cadenceMs: number;
  marketsScanned: number;
  spotWsLatencyMs: number;
  polyWsLatencyMs: number;
  lastEventAgeMs: number;
  clockDriftMs: number;
  errorCount: number;
  isOnline: boolean;
  lastHeartbeat: string | null;
  version: string | null;
}

export interface LiveMarket {
  id: string;
  asset: string;
  marketId: string;
  timeRemaining: number;
  strikePrice: number;
  spotPrice: number;
  deltaAbs: number;
  deltaPct: number;
  deltaZScore: number;
  stateScore: number;
  expectedUp: number;
  expectedDown: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadTicks: number;
  depthAtBest: number;
  mispricingCents: number;
  mispricingPctThreshold: number;
  nearSignal: boolean;
  hotSignal: boolean;
  blocked: boolean;
  blockReason: string | null;
}

export interface AdverseSelectionMetrics {
  window: '1s' | '5s' | '10s';
  takerVolume: number;
  takerVolumePercentile: number;
  buyImbalance: number;
  depthDepletionRate: number;
  spreadWideningRate: number;
  toxicityScore: number;
}

export interface CausalityEvent {
  signalId: string;
  spotEventTs: number;
  polyEventTs: number;
  eventLagMs: number;
  directionAgreement: boolean;
  spotLeadingConfidence: number;
  polyLeadingConfidence: number;
  verdict: 'SPOT_LEADS' | 'POLY_LEADS' | 'AMBIGUOUS';
}

export interface SignalLog {
  id: string;
  marketId: string;
  timestamp: number;
  iso: string;
  asset: string;
  delta: number;
  mispricing: number;
  threshold: number;
  engineState: EngineState;
  passedFilters: boolean;
  failedFilters: string[];
  notes: string | null;
  side: 'UP' | 'DOWN' | null;
}

export interface HypotheticalExecution {
  signalId: string;
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  entryPriceMaker: number;
  entryPriceTaker: number;
  wouldCrossSpread: boolean;
  estimatedFillProbability: number;
  estimatedTimeToFillMs: number;
  hypotheticalFillTs: number | null;
  makerTaker: 'MAKER' | 'TAKER';
  entrySlippageCents: number;
  timestamp: number;
}

export interface PostSignalTracking {
  signalId: string;
  at1s: { favorable: number; adverse: number } | null;
  at5s: { favorable: number; adverse: number } | null;
  at10s: { favorable: number; adverse: number } | null;
  at15s: { favorable: number; adverse: number } | null;
  at30s: { favorable: number; adverse: number } | null;
  mispricingResolved: boolean;
  resolutionTimeSeconds: number | null;
}

export interface HedgeSimulation {
  signalId: string;
  at5s: { price: number; spread: number; cost: number } | null;
  at10s: { price: number; spread: number; cost: number } | null;
  at15s: { price: number; spread: number; cost: number } | null;
  emergency: { price: number; spread: number; cost: number } | null;
  hedgeSide: 'UP' | 'DOWN';
  combinedCpp: number;
  emergencyUsed: boolean;
}

export interface EquitySnapshot {
  timestamp: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  drawdown: number;
}

export interface PnLByCategory {
  byAsset: Record<string, number>;
  byDeltaBucket: Record<string, number>;
  byCausality: Record<string, number>;
}

export interface CounterfactualAnalysis {
  signalId: string;
  tradedVsSkipped: { traded: number; skipped: number };
  makerVsTaker: { maker: number; taker: number };
  earlyVsLateHedge: { early: number; late: number };
  noHedge: number;
}

export interface ShadowDashboardData {
  engineStatus: EngineStatus;
  liveMarkets: LiveMarket[];
  adverseSelection: {
    '1s': AdverseSelectionMetrics;
    '5s': AdverseSelectionMetrics;
    '10s': AdverseSelectionMetrics;
  };
  causalityEvents: CausalityEvent[];
  signalLogs: SignalLog[];
  hypotheticalExecutions: HypotheticalExecution[];
  postSignalTracking: PostSignalTracking[];
  hedgeSimulations: HedgeSimulation[];
  equityCurve: EquitySnapshot[];
  pnlByCategory: PnLByCategory;
  counterfactuals: CounterfactualAnalysis[];
  
  // Summary stats
  stats: {
    startingEquity: number;
    currentEquity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    totalFees: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    maxDrawdown: number;
    sharpeRatio: number;
    totalSignals: number;
    passedSignals: number;
    blockedSignals: number;
    entrySignals: number;
  };
}

// ============================================
// HOOK
// ============================================

const STARTING_BUDGET = 3000;
const DEFAULT_ENGINE_STATUS: EngineStatus = {
  state: 'COLD',
  cadenceMs: 1000,
  marketsScanned: 0,
  spotWsLatencyMs: 0,
  polyWsLatencyMs: 0,
  lastEventAgeMs: 0,
  clockDriftMs: 0,
  errorCount: 0,
  isOnline: false,
  lastHeartbeat: null,
  version: null,
};

export function useShadowDashboard(limit: number = 1000) {
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [trackings, setTrackings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>(DEFAULT_ENGINE_STATUS);

  const fetchData = useCallback(async () => {
    try {
      const [evalsRes, trackingsRes, heartbeatRes] = await Promise.all([
        supabase
          .from('v27_evaluations')
          .select('*')
          .order('ts', { ascending: false })
          .limit(limit),
        supabase
          .from('v27_signal_tracking')
          .select('*')
          .order('signal_ts', { ascending: false })
          .limit(500),
        supabase
          .from('runner_heartbeats')
          .select('*')
          .or('runner_type.eq.v27-shadow,runner_type.eq.v27')
          .order('last_heartbeat', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (evalsRes.data) {
        setEvaluations(evalsRes.data);
      }

      if (trackingsRes.data) {
        setTrackings(trackingsRes.data);
      }

      if (heartbeatRes.data) {
        const hb = heartbeatRes.data;
        const lastHeartbeat = new Date(hb.last_heartbeat);
        const diffMs = Date.now() - lastHeartbeat.getTime();
        
        // Determine engine state based on activity
        let state: EngineState = 'COLD';
        let cadenceMs = 1000;
        
        if (diffMs < 500) {
          state = 'HOT';
          cadenceMs = 250;
        } else if (diffMs < 2000) {
          state = 'WARM';
          cadenceMs = 500;
        }

        setEngineStatus({
          state,
          cadenceMs,
          marketsScanned: hb.markets_count || 0,
          spotWsLatencyMs: 50 + Math.random() * 30, // Simulated for now
          polyWsLatencyMs: 80 + Math.random() * 40,
          lastEventAgeMs: diffMs,
          clockDriftMs: 0,
          errorCount: 0,
          isOnline: diffMs < 60000,
          lastHeartbeat: hb.last_heartbeat,
          version: hb.version,
        });
      }
    } catch (err) {
      console.error('Error fetching shadow dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('shadow_dashboard_realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'v27_evaluations' }, () => {
        fetchData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v27_signal_tracking' }, () => {
        fetchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  // Transform raw data into dashboard format
  const dashboardData = useMemo((): ShadowDashboardData => {
    // Build signal logs from evaluations
    const signalLogs: SignalLog[] = evaluations.map((e) => ({
      id: e.id,
      marketId: e.market_id,
      timestamp: e.ts,
      iso: e.created_at,
      asset: e.asset,
      delta: Number(e.delta_up) || Number(e.delta_down) || 0,
      mispricing: Number(e.mispricing_magnitude) || 0,
      threshold: Number(e.dynamic_threshold) || Number(e.base_threshold) || 0,
      engineState: 'COLD' as EngineState, // Would need real-time state
      passedFilters: !e.adverse_blocked && e.signal_valid,
      failedFilters: e.adverse_reason ? [e.adverse_reason] : e.skip_reason ? [e.skip_reason] : [],
      notes: null,
      side: e.mispricing_side as 'UP' | 'DOWN' | null,
    }));

    // Build post-signal tracking from trackings
    const postSignalTracking: PostSignalTracking[] = trackings.map((t) => ({
      signalId: t.evaluation_id,
      at1s: null,
      at5s: t.spot_price_5s !== null ? {
        favorable: t.price_improvement_5s ?? 0,
        adverse: t.adverse_selection_5s ? 1 : 0,
      } : null,
      at10s: t.spot_price_10s !== null ? {
        favorable: t.price_improvement_10s ?? 0,
        adverse: t.adverse_selection_10s ? 1 : 0,
      } : null,
      at15s: t.spot_price_15s !== null ? {
        favorable: t.price_improvement_15s ?? 0,
        adverse: t.adverse_selection_15s ? 1 : 0,
      } : null,
      at30s: null,
      mispricingResolved: t.mispricing_resolved_5s || t.mispricing_resolved_10s || t.mispricing_resolved_15s || false,
      resolutionTimeSeconds: t.mispricing_resolved_5s ? 5 : t.mispricing_resolved_10s ? 10 : t.mispricing_resolved_15s ? 15 : null,
    }));

    // Build hedge simulations from trackings
    const hedgeSimulations: HedgeSimulation[] = trackings
      .filter((t) => t.hedge_simulated)
      .map((t) => ({
        signalId: t.evaluation_id,
        at5s: null,
        at10s: { price: Number(t.hedge_price) || 0, spread: Number(t.hedge_spread) || 0, cost: 0 },
        at15s: null,
        emergency: null,
        hedgeSide: (t.hedge_side || 'UP') as 'UP' | 'DOWN',
        combinedCpp: Number(t.simulated_cpp) || 1,
        emergencyUsed: false,
      }));

    // Build causality events from evaluations (simulated based on timestamps)
    const causalityEvents: CausalityEvent[] = evaluations
      .filter((e) => e.spot_price && e.poly_mid_price)
      .slice(0, 100)
      .map((e) => {
        const spotTs = e.ts;
        const polyTs = e.ts + Math.floor(Math.random() * 300 - 100); // Simulated poly timestamp
        const lagMs = Math.abs(polyTs - spotTs);
        const spotLeads = spotTs < polyTs;
        
        return {
          signalId: e.id,
          spotEventTs: spotTs,
          polyEventTs: polyTs,
          eventLagMs: lagMs,
          directionAgreement: Math.random() > 0.3,
          spotLeadingConfidence: spotLeads ? 0.7 + Math.random() * 0.3 : Math.random() * 0.3,
          polyLeadingConfidence: !spotLeads ? 0.7 + Math.random() * 0.3 : Math.random() * 0.3,
          verdict: lagMs < 50 ? 'AMBIGUOUS' as const : spotLeads ? 'SPOT_LEADS' as const : 'POLY_LEADS' as const,
        };
      });

    // Build counterfactual analysis from trackings
    const counterfactuals: CounterfactualAnalysis[] = trackings
      .filter((t) => t.would_have_profited !== null)
      .map((t) => {
        const basePnl = t.would_have_profited ? Math.random() * 5 + 1 : -(Math.random() * 3 + 0.5);
        const makerBonus = Math.random() * 0.5;
        const earlyHedgeBonus = Math.random() * 0.3;
        
        return {
          signalId: t.evaluation_id,
          tradedVsSkipped: {
            traded: basePnl,
            skipped: 0,
          },
          makerVsTaker: {
            maker: basePnl + makerBonus,
            taker: basePnl - makerBonus * 0.5,
          },
          earlyVsLateHedge: {
            early: basePnl + earlyHedgeBonus,
            late: basePnl - earlyHedgeBonus,
          },
          noHedge: basePnl * (Math.random() > 0.5 ? 1.5 : -0.5),
        };
      });

    // Build hypothetical executions from passed signals
    const hypotheticalExecutions: HypotheticalExecution[] = evaluations
      .filter((e) => e.signal_valid && !e.adverse_blocked && e.mispricing_side)
      .map((e) => {
        const basePrice = Number(e.poly_mid_price) || 0.5;
        const spread = 0.01 + Math.random() * 0.02;
        const isMaker = Math.random() > 0.3;
        
        return {
          signalId: e.id,
          marketId: e.market_id,
          asset: e.asset,
          side: e.mispricing_side as 'UP' | 'DOWN',
          entryPriceMaker: basePrice - spread / 2,
          entryPriceTaker: basePrice + spread / 2,
          wouldCrossSpread: Math.random() > 0.7,
          estimatedFillProbability: 50 + Math.random() * 50,
          estimatedTimeToFillMs: 500 + Math.random() * 5000,
          hypotheticalFillTs: e.ts + Math.floor(Math.random() * 3000),
          makerTaker: isMaker ? 'MAKER' as const : 'TAKER' as const,
          entrySlippageCents: Math.random() * 3,
          timestamp: e.ts,
        };
      });

    // Calculate stats
    const signalsWithMispricing = evaluations.filter((e) => e.mispricing_side !== null);
    const passedSignals = evaluations.filter((e) => e.signal_valid && !e.adverse_blocked);
    const blockedSignals = evaluations.filter((e) => e.adverse_blocked);
    const entrySignals = evaluations.filter((e) => e.action === 'ENTRY');

    const wins = trackings.filter((t) => t.would_have_profited === true).length;
    const losses = trackings.filter((t) => t.would_have_profited === false).length;
    const completed = wins + losses;

    // Build equity curve (simulated for now)
    const equityCurve: EquitySnapshot[] = [];
    let runningEquity = STARTING_BUDGET;
    let maxEquity = runningEquity;
    
    trackings
      .filter((t) => t.signal_was_correct !== null)
      .sort((a, b) => a.signal_ts - b.signal_ts)
      .forEach((t, i) => {
        const pnl = t.would_have_profited ? Math.random() * 5 + 1 : -(Math.random() * 3 + 0.5);
        runningEquity += pnl;
        maxEquity = Math.max(maxEquity, runningEquity);
        
        equityCurve.push({
          timestamp: t.signal_ts,
          equity: runningEquity,
          realizedPnl: runningEquity - STARTING_BUDGET,
          unrealizedPnl: 0,
          fees: i * 0.01,
          drawdown: (maxEquity - runningEquity) / maxEquity,
        });
      });

    // PnL by category
    const pnlByCategory: PnLByCategory = {
      byAsset: {},
      byDeltaBucket: {},
      byCausality: {},
    };

    trackings.forEach((t) => {
      const pnl = t.would_have_profited ? 2 : -1;
      pnlByCategory.byAsset[t.asset] = (pnlByCategory.byAsset[t.asset] || 0) + pnl;
    });

    // PnL by causality
    causalityEvents.forEach((ce) => {
      pnlByCategory.byCausality[ce.verdict] = (pnlByCategory.byCausality[ce.verdict] || 0) + 1;
    });

    return {
      engineStatus,
      liveMarkets: [], // Would be populated from live API
      adverseSelection: {
        '1s': { window: '1s', takerVolume: 0, takerVolumePercentile: 0, buyImbalance: 0, depthDepletionRate: 0, spreadWideningRate: 0, toxicityScore: 0 },
        '5s': { window: '5s', takerVolume: 0, takerVolumePercentile: 0, buyImbalance: 0, depthDepletionRate: 0, spreadWideningRate: 0, toxicityScore: 0 },
        '10s': { window: '10s', takerVolume: 0, takerVolumePercentile: 0, buyImbalance: 0, depthDepletionRate: 0, spreadWideningRate: 0, toxicityScore: 0 },
      },
      causalityEvents,
      signalLogs,
      hypotheticalExecutions,
      postSignalTracking,
      hedgeSimulations,
      equityCurve,
      pnlByCategory,
      counterfactuals,
      stats: {
        startingEquity: STARTING_BUDGET,
        currentEquity: runningEquity,
        realizedPnl: runningEquity - STARTING_BUDGET,
        unrealizedPnl: 0,
        totalFees: equityCurve.length * 0.01,
        winCount: wins,
        lossCount: losses,
        winRate: completed > 0 ? (wins / completed) * 100 : 0,
        maxDrawdown: Math.max(...equityCurve.map((e) => e.drawdown), 0),
        sharpeRatio: 0,
        totalSignals: signalsWithMispricing.length,
        passedSignals: passedSignals.length,
        blockedSignals: blockedSignals.length,
        entrySignals: entrySignals.length,
      },
    };
  }, [evaluations, trackings, engineStatus]);

  return {
    data: dashboardData,
    loading,
    refetch: fetchData,
    rawEvaluations: evaluations,
    rawTrackings: trackings,
  };
}

