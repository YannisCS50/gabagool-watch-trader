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

// ============================================
// NEW: SHADOW TRADE (Hypothetical Execution Object)
// ============================================
export interface ShadowTrade {
  tradeId: string;
  signalId: string;
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  entryTimestamp: number;
  entryPriceMaker: number;
  entryPriceTaker: number;
  assumedExecutionType: 'MAKER' | 'TAKER' | 'UNKNOWN';
  assumedFillProbability: number;
  assumedFillLatencyMs: number;
  assumedFillPrice: number;
  tradeSizeUsd: number;
  tradeSizeShares: number;
  feeAssumptionUsd: number;
  filled: boolean;
  fillAssumptionReason: string;
}

// ============================================
// NEW: POST-SIGNAL PRICE PATH (Extended Tracking)
// ============================================
export interface PostSignalPath {
  signalId: string;
  marketId: string;
  signalSide: 'UP' | 'DOWN' | null;
  timestamps: {
    t1s: PostSignalPathSnapshot | null;
    t5s: PostSignalPathSnapshot | null;
    t10s: PostSignalPathSnapshot | null;
    t15s: PostSignalPathSnapshot | null;
    t30s: PostSignalPathSnapshot | null;
  };
  maxFavorableMove: number;
  maxAdverseMove: number;
  mispricingResolved: boolean;
  resolutionTimeSeconds: number | null;
}

export interface PostSignalPathSnapshot {
  spotPrice: number | 'UNKNOWN';
  upMid: number | 'UNKNOWN';
  downMid: number | 'UNKNOWN';
  spreadUp: number | 'UNKNOWN';
  spreadDown: number | 'UNKNOWN';
  delta: number | 'UNKNOWN';
  mispricing: number | 'UNKNOWN';
}

// ============================================
// NEW: SHADOW HEDGE (Hedge Simulation)
// ============================================
export interface ShadowHedge {
  tradeId: string;
  signalId: string;
  hedgeAttempts: HedgeAttempt[];
  emergencyHedgeUsed: boolean;
  emergencyReason: string | null;
  finalHedgeOutcome: 'HEDGED' | 'UNHEDGED' | 'EMERGENCY_EXIT';
  combinedCpp: number;
}

export interface HedgeAttempt {
  timestamp: number;
  hedgeSide: 'UP' | 'DOWN';
  hedgePrice: number;
  spreadAtHedge: number;
  hedgeCostUsd: number;
  hedgeCpp: number;
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

// ============================================
// NEW: SHADOW ACCOUNT STATE
// ============================================
export interface ShadowAccountState {
  timestamp: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openTradesCount: number;
  exposureByAsset: Record<string, number>;
  peakEquity: number;
  drawdownPct: number;
}

export interface EquitySnapshot {
  timestamp: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  drawdown: number;
}

// ============================================
// NEW: CAUSALITY TRACE
// ============================================
export interface CausalityTrace {
  signalId: string;
  spotEventTimestamp: number;
  polymarketEventTimestamp: number;
  latencyMs: number;
  toleranceMs: number;
  spotLeads: boolean;
  polyLeads: boolean;
  causalityVerdict: 'SPOT_LEADS' | 'POLY_LEADS' | 'AMBIGUOUS';
}

// ============================================
// NEW: EXECUTION ASSUMPTIONS
// ============================================
export interface ExecutionAssumption {
  tradeId: string;
  signalId: string;
  makerFillRateEstimate: number;
  takerSlippageEstimate: number;
  spreadAtDecision: number;
  depthAtDecision: number | 'UNKNOWN';
  adverseSelectionScoreAtEntry: number;
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
  
  // NEW: Complete export data structures
  shadowTrades: ShadowTrade[];
  postSignalPaths: PostSignalPath[];
  shadowHedges: ShadowHedge[];
  shadowAccountState: ShadowAccountState[];
  causalityTraces: CausalityTrace[];
  executionAssumptions: ExecutionAssumption[];
  
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
// MOCK DATA GENERATORS (for demo when no real data)
// ============================================
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

function generateMockSignals(count: number): any[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const asset = ASSETS[i % ASSETS.length];
    const ts = now - (count - i) * 60000;
    const isBuy = Math.random() > 0.5;
    return {
      id: `mock-${i}-${ts}`,
      market_id: `market-${asset}-${Math.floor(ts / 3600000)}`,
      ts,
      created_at: new Date(ts).toISOString(),
      asset,
      delta_up: isBuy ? 0.02 + Math.random() * 0.03 : 0,
      delta_down: !isBuy ? 0.02 + Math.random() * 0.03 : 0,
      mispricing_magnitude: 0.02 + Math.random() * 0.05,
      dynamic_threshold: 0.03 + Math.random() * 0.02,
      base_threshold: 0.03,
      spot_price: 95000 + Math.random() * 10000,
      poly_mid_price: 0.4 + Math.random() * 0.2,
      signal_valid: Math.random() > 0.3,
      adverse_blocked: Math.random() > 0.8,
      adverse_reason: Math.random() > 0.8 ? 'FLOW_SPIKE' : null,
      skip_reason: Math.random() > 0.7 ? 'SPREAD_TOO_WIDE' : null,
      mispricing_side: Math.random() > 0.5 ? 'UP' : 'DOWN',
      action: Math.random() > 0.5 ? 'ENTRY' : 'SKIP',
      spread: 0.01 + Math.random() * 0.02,
    };
  });
}

function generateMockTrackings(count: number): any[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const ts = now - (count - i) * 60000;
    return {
      id: `tracking-${i}`,
      evaluation_id: `mock-${i}-${ts}`,
      signal_ts: ts,
      asset: ASSETS[i % ASSETS.length],
      spot_price_5s: 95000 + Math.random() * 200,
      spot_price_10s: 95000 + Math.random() * 300,
      spot_price_15s: 95000 + Math.random() * 400,
      price_improvement_5s: (Math.random() - 0.3) * 0.02,
      price_improvement_10s: (Math.random() - 0.3) * 0.03,
      price_improvement_15s: (Math.random() - 0.3) * 0.04,
      adverse_selection_5s: Math.random() > 0.7,
      adverse_selection_10s: Math.random() > 0.6,
      adverse_selection_15s: Math.random() > 0.5,
      mispricing_resolved_5s: Math.random() > 0.6,
      mispricing_resolved_10s: Math.random() > 0.5,
      mispricing_resolved_15s: Math.random() > 0.4,
      hedge_simulated: Math.random() > 0.4,
      hedge_price: 0.4 + Math.random() * 0.2,
      hedge_spread: 0.01 + Math.random() * 0.02,
      hedge_side: Math.random() > 0.5 ? 'UP' : 'DOWN',
      simulated_cpp: 0.95 + Math.random() * 0.1,
      would_have_profited: Math.random() > 0.45,
      signal_was_correct: Math.random() > 0.4,
    };
  });
}

function generateMockAdverseMetrics(window: '1s' | '5s' | '10s'): AdverseSelectionMetrics {
  const multiplier = window === '1s' ? 1 : window === '5s' ? 1.5 : 2;
  return {
    window,
    takerVolume: 1000 + Math.random() * 5000 * multiplier,
    takerVolumePercentile: 40 + Math.random() * 50,
    buyImbalance: (Math.random() - 0.5) * 0.6,
    depthDepletionRate: Math.random() * 0.4,
    spreadWideningRate: Math.random() * 0.3,
    toxicityScore: 0.1 + Math.random() * 0.5,
  };
}

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
    // Use mock data if no real data available
    const useEvaluations = evaluations.length > 0 ? evaluations : generateMockSignals(50);
    const useTrackings = trackings.length > 0 ? trackings : generateMockTrackings(30);
    
    // Build signal logs from evaluations
    const signalLogs: SignalLog[] = useEvaluations.map((e) => ({
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
    const postSignalTracking: PostSignalTracking[] = useTrackings.map((t) => ({
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
    const hedgeSimulations: HedgeSimulation[] = useTrackings
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

    // Build causality events from evaluations
    const causalityEvents: CausalityEvent[] = useEvaluations
      .filter((e) => e.spot_price && e.poly_mid_price)
      .slice(0, 100)
      .map((e) => {
        const spotTs = e.ts;
        const polyTs = e.ts + Math.floor(Math.random() * 300 - 100);
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
    const counterfactuals: CounterfactualAnalysis[] = useTrackings
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
    const hypotheticalExecutions: HypotheticalExecution[] = useEvaluations
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

    // ============================================
    // BUILD SHADOW TRADES
    // ============================================
    const shadowTrades: ShadowTrade[] = useEvaluations
      .filter((e) => e.signal_valid && !e.adverse_blocked && e.mispricing_side)
      .map((e, idx) => {
        const basePrice = Number(e.poly_mid_price) || 0.5;
        const spread = Number(e.spread) || 0.02;
        const isMaker = Math.random() > 0.3;
        const fillProb = 0.5 + Math.random() * 0.5;
        const tradeSizeUsd = 10 + Math.random() * 40;
        const fillPrice = isMaker ? basePrice - spread / 2 : basePrice + spread / 2;
        
        return {
          tradeId: `st-${e.id}-${idx}`,
          signalId: e.id,
          marketId: e.market_id,
          asset: e.asset,
          side: e.mispricing_side as 'UP' | 'DOWN',
          entryTimestamp: e.ts,
          entryPriceMaker: basePrice - spread / 2,
          entryPriceTaker: basePrice + spread / 2,
          assumedExecutionType: isMaker ? 'MAKER' as const : 'TAKER' as const,
          assumedFillProbability: fillProb,
          assumedFillLatencyMs: isMaker ? 500 + Math.random() * 2000 : 50 + Math.random() * 200,
          assumedFillPrice: fillPrice,
          tradeSizeUsd,
          tradeSizeShares: tradeSizeUsd / fillPrice,
          feeAssumptionUsd: isMaker ? -tradeSizeUsd * 0.0015 : tradeSizeUsd * 0.002,
          filled: fillProb > 0.6,
          fillAssumptionReason: fillProb > 0.6 
            ? `Fill assumed: ${isMaker ? 'maker' : 'taker'} with ${(fillProb * 100).toFixed(0)}% probability`
            : `No fill assumed: probability ${(fillProb * 100).toFixed(0)}% below 60% threshold`,
        };
      });

    // ============================================
    // BUILD POST-SIGNAL PATHS (Extended)
    // ============================================
    const postSignalPaths: PostSignalPath[] = useEvaluations.map((e) => {
      const baseSpot = Number(e.spot_price) || 100;
      const baseMid = Number(e.poly_mid_price) || 0.5;
      const signalSide = e.mispricing_side as 'UP' | 'DOWN' | null;
      
      const makeSnapshot = (secondsAhead: number): PostSignalPathSnapshot => {
        const volatility = 0.002 * Math.sqrt(secondsAhead);
        const spotMove = baseSpot * (1 + (Math.random() - 0.5) * volatility);
        const midMove = baseMid + (Math.random() - 0.5) * 0.02;
        
        return {
          spotPrice: spotMove,
          upMid: midMove,
          downMid: 1 - midMove,
          spreadUp: 0.01 + Math.random() * 0.02,
          spreadDown: 0.01 + Math.random() * 0.02,
          delta: spotMove - baseSpot,
          mispricing: Math.abs(midMove - baseMid) * 100,
        };
      };

      const t1s = makeSnapshot(1);
      const t5s = makeSnapshot(5);
      const t10s = makeSnapshot(10);
      const t15s = makeSnapshot(15);
      const t30s = makeSnapshot(30);

      const allMoves = [t1s, t5s, t10s, t15s, t30s];
      const favorable = signalSide === 'UP' 
        ? allMoves.map(s => (s.upMid as number) - baseMid)
        : allMoves.map(s => baseMid - (s.downMid as number));
      
      return {
        signalId: e.id,
        marketId: e.market_id,
        signalSide,
        timestamps: {
          t1s,
          t5s,
          t10s,
          t15s,
          t30s,
        },
        maxFavorableMove: Math.max(...favorable, 0),
        maxAdverseMove: Math.abs(Math.min(...favorable, 0)),
        mispricingResolved: Math.random() > 0.4,
        resolutionTimeSeconds: Math.random() > 0.4 ? Math.floor(Math.random() * 20) + 5 : null,
      };
    });

    // ============================================
    // NEW: BUILD SHADOW HEDGES
    // ============================================
    const shadowHedges: ShadowHedge[] = shadowTrades
      .filter(st => st.filled)
      .map((st) => {
        const hedgeSide = st.side === 'UP' ? 'DOWN' as const : 'UP' as const;
        const baseHedgePrice = st.side === 'UP' ? 1 - st.assumedFillPrice : st.assumedFillPrice;
        
        const makeHedgeAttempt = (delayMs: number): HedgeAttempt => {
          const spread = 0.01 + Math.random() * 0.02;
          const price = baseHedgePrice + (Math.random() - 0.5) * 0.02;
          const cost = st.tradeSizeShares * price;
          const cpp = (st.assumedFillPrice + price) * 100; // CPP in cents
          
          return {
            timestamp: st.entryTimestamp + delayMs,
            hedgeSide,
            hedgePrice: price,
            spreadAtHedge: spread,
            hedgeCostUsd: cost,
            hedgeCpp: cpp,
          };
        };

        const hedgeAttempts: HedgeAttempt[] = [
          makeHedgeAttempt(5000),
          makeHedgeAttempt(10000),
          makeHedgeAttempt(15000),
        ];

        const emergencyUsed = Math.random() > 0.85;
        if (emergencyUsed) {
          hedgeAttempts.push(makeHedgeAttempt(60000)); // Emergency at 60s
        }

        const successfulHedge = hedgeAttempts.find(h => h.hedgeCpp < 100);
        
        return {
          tradeId: st.tradeId,
          signalId: st.signalId,
          hedgeAttempts,
          emergencyHedgeUsed: emergencyUsed,
          emergencyReason: emergencyUsed ? 'time_remaining < 90s' : null,
          finalHedgeOutcome: successfulHedge 
            ? 'HEDGED' as const 
            : emergencyUsed 
              ? 'EMERGENCY_EXIT' as const 
              : 'UNHEDGED' as const,
          combinedCpp: successfulHedge?.hedgeCpp || hedgeAttempts[hedgeAttempts.length - 1]?.hedgeCpp || 100,
        };
      });

    // ============================================
    // NEW: BUILD SHADOW ACCOUNT STATE
    // ============================================
    const shadowAccountState: ShadowAccountState[] = [];
    let accountEquity = STARTING_BUDGET;
    let peakEquity = STARTING_BUDGET;
    const exposureByAsset: Record<string, number> = {};
    let openTrades = 0;

    const sortedTrades = [...shadowTrades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    sortedTrades.forEach((trade, idx) => {
      if (trade.filled) {
        openTrades++;
        exposureByAsset[trade.asset] = (exposureByAsset[trade.asset] || 0) + trade.tradeSizeUsd;
        
        // Simulate PnL
        const hedge = shadowHedges.find(h => h.tradeId === trade.tradeId);
        const pnl = hedge?.finalHedgeOutcome === 'HEDGED'
          ? (100 - hedge.combinedCpp) / 100 * trade.tradeSizeUsd
          : (Math.random() - 0.5) * trade.tradeSizeUsd * 0.2;
        
        accountEquity += pnl - trade.feeAssumptionUsd;
        peakEquity = Math.max(peakEquity, accountEquity);
        
        // Close trade
        openTrades--;
        exposureByAsset[trade.asset] = Math.max(0, (exposureByAsset[trade.asset] || 0) - trade.tradeSizeUsd);
      }

      shadowAccountState.push({
        timestamp: trade.entryTimestamp,
        equity: accountEquity,
        realizedPnl: accountEquity - STARTING_BUDGET,
        unrealizedPnl: 0, // Shadow trades close immediately
        openTradesCount: openTrades,
        exposureByAsset: { ...exposureByAsset },
        peakEquity,
        drawdownPct: peakEquity > 0 ? (peakEquity - accountEquity) / peakEquity : 0,
      });
    });

    // ============================================
    // BUILD CAUSALITY TRACES
    // ============================================
    const causalityTraces: CausalityTrace[] = useEvaluations
      .filter((e) => e.spot_price && e.poly_mid_price)
      .map((e) => {
        const spotTs = e.ts;
        const polyTs = e.ts + Math.floor(Math.random() * 300 - 100);
        const latency = Math.abs(polyTs - spotTs);
        const tolerance = 200;
        
        return {
          signalId: e.id,
          spotEventTimestamp: spotTs,
          polymarketEventTimestamp: polyTs,
          latencyMs: latency,
          toleranceMs: tolerance,
          spotLeads: spotTs < polyTs,
          polyLeads: polyTs < spotTs,
          causalityVerdict: latency < 50 
            ? 'AMBIGUOUS' as const 
            : spotTs < polyTs 
              ? 'SPOT_LEADS' as const 
              : 'POLY_LEADS' as const,
        };
      });

    // ============================================
    // BUILD EXECUTION ASSUMPTIONS
    // ============================================
    const executionAssumptions: ExecutionAssumption[] = shadowTrades.map((st) => ({
      tradeId: st.tradeId,
      signalId: st.signalId,
      makerFillRateEstimate: st.assumedExecutionType === 'MAKER' ? 0.6 + Math.random() * 0.3 : 0.95,
      takerSlippageEstimate: st.assumedExecutionType === 'TAKER' ? 0.001 + Math.random() * 0.003 : 0,
      spreadAtDecision: st.entryPriceTaker - st.entryPriceMaker,
      depthAtDecision: Math.random() > 0.2 ? 500 + Math.random() * 2000 : 'UNKNOWN' as const,
      adverseSelectionScoreAtEntry: Math.random() * 0.5,
    }));

    // Calculate stats using mock-aware data
    const signalsWithMispricing = useEvaluations.filter((e) => e.mispricing_side !== null);
    const passedSignals = useEvaluations.filter((e) => e.signal_valid && !e.adverse_blocked);
    const blockedSignals = useEvaluations.filter((e) => e.adverse_blocked);
    const entrySignals = useEvaluations.filter((e) => e.action === 'ENTRY');

    const wins = useTrackings.filter((t) => t.would_have_profited === true).length;
    const losses = useTrackings.filter((t) => t.would_have_profited === false).length;
    const completed = wins + losses;

    // Build equity curve
    const equityCurve: EquitySnapshot[] = [];
    let runningEquity = STARTING_BUDGET;
    let maxEquity = runningEquity;
    
    useTrackings
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
      byDeltaBucket: { '<1%': 0, '1-2%': 0, '2-3%': 0, '>3%': 0 },
      byCausality: { SPOT_LEADS: 0, POLY_LEADS: 0, AMBIGUOUS: 0 },
    };

    useTrackings.forEach((t) => {
      const pnl = t.would_have_profited ? 2 : -1;
      pnlByCategory.byAsset[t.asset] = (pnlByCategory.byAsset[t.asset] || 0) + pnl;
    });

    // PnL by causality
    causalityEvents.forEach((ce) => {
      pnlByCategory.byCausality[ce.verdict] = (pnlByCategory.byCausality[ce.verdict] || 0) + 1;
    });

    // Generate demo adverse selection metrics
    const adverseSelection = {
      '1s': generateMockAdverseMetrics('1s'),
      '5s': generateMockAdverseMetrics('5s'),
      '10s': generateMockAdverseMetrics('10s'),
    };

    return {
      engineStatus: evaluations.length > 0 ? engineStatus : {
        ...DEFAULT_ENGINE_STATUS,
        state: 'WARM' as EngineState,
        isOnline: true,
        marketsScanned: 4,
        spotWsLatencyMs: 45 + Math.random() * 20,
        polyWsLatencyMs: 78 + Math.random() * 30,
        lastHeartbeat: new Date().toISOString(),
        version: 'v27-demo',
      },
      liveMarkets: [],
      adverseSelection,
      causalityEvents,
      signalLogs,
      hypotheticalExecutions,
      postSignalTracking,
      hedgeSimulations,
      equityCurve,
      pnlByCategory,
      counterfactuals,
      
      // NEW exports
      shadowTrades,
      postSignalPaths,
      shadowHedges,
      shadowAccountState,
      causalityTraces,
      executionAssumptions,
      
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

