import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Shadow engine evaluation from v27_evaluations
export interface ShadowEvaluation {
  id: string;
  created_at: string;
  ts: number;
  asset: string;
  market_id: string;
  spot_price: number;
  spot_source: string;
  pm_up_bid: number;
  pm_up_ask: number;
  pm_down_bid: number;
  pm_down_ask: number;
  theoretical_up: number;
  theoretical_down: number;
  delta_up: number;
  delta_down: number;
  mispricing_side: string | null;
  mispricing_magnitude: number;
  base_threshold: number;
  dynamic_threshold: number;
  taker_flow_p90: number;
  book_imbalance: number;
  spread_expansion: number;
  adverse_blocked: boolean;
  adverse_reason: string | null;
  causality_passed: boolean;
  spot_leading_ms: number;
  signal_valid: boolean;
  action: string;
  skip_reason: string | null;
}

// Signal tracking outcome from v27_signal_tracking
export interface SignalTracking {
  id: string;
  evaluation_id: string;
  market_id: string;
  asset: string;
  signal_ts: number;
  signal_side: string;
  signal_price: number;
  signal_spot_price: number;
  signal_mispricing: number;
  up_mid_5s: number | null;
  down_mid_5s: number | null;
  spot_price_5s: number | null;
  mispricing_resolved_5s: boolean | null;
  price_improvement_5s: number | null;
  adverse_selection_5s: boolean | null;
  up_mid_10s: number | null;
  down_mid_10s: number | null;
  spot_price_10s: number | null;
  mispricing_resolved_10s: boolean | null;
  price_improvement_10s: number | null;
  adverse_selection_10s: boolean | null;
  up_mid_15s: number | null;
  down_mid_15s: number | null;
  spot_price_15s: number | null;
  mispricing_resolved_15s: boolean | null;
  price_improvement_15s: number | null;
  adverse_selection_15s: boolean | null;
  hedge_simulated: boolean;
  hedge_side: string | null;
  hedge_price: number | null;
  hedge_spread: number | null;
  hedge_maker_taker: string | null;
  simulated_cpp: number | null;
  hedge_would_execute: boolean | null;
  signal_was_correct: boolean | null;
  would_have_profited: boolean | null;
  completed: boolean;
  created_at: string;
}

export interface ShadowStats {
  // Evaluation counts
  totalEvaluations: number;
  signalsDetected: number;
  cleanSignals: number;
  toxicSkips: number;
  entrySignals: number;
  
  // By action type
  byAction: Record<string, number>;
  
  // By asset
  byAsset: Record<string, { total: number; signals: number; entries: number }>;
  
  // Signal tracking outcomes
  trackingsCompleted: number;
  mispricingsResolved5s: number;
  mispricingsResolved10s: number;
  mispricingsResolved15s: number;
  adverseSelection5s: number;
  adverseSelection10s: number;
  adverseSelection15s: number;
  signalsCorrect: number;
  wouldHaveProfited: number;
  
  // Hedge analysis
  hedgesSimulated: number;
  hedgesWouldExecute: number;
  avgSimulatedCpp: number;
  
  // Adverse selection reasons
  adverseReasons: Record<string, number>;
}

export interface RunnerStatus {
  isOnline: boolean;
  lastHeartbeat: string | null;
  version: string | null;
  marketsCount: number;
  balance: number;
}

export function useShadowEngineData(limit: number = 500) {
  const [evaluations, setEvaluations] = useState<ShadowEvaluation[]>([]);
  const [trackings, setTrackings] = useState<SignalTracking[]>([]);
  const [loading, setLoading] = useState(true);
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>({
    isOnline: false,
    lastHeartbeat: null,
    version: null,
    marketsCount: 0,
    balance: 0,
  });

  const fetchData = useCallback(async () => {
    try {
      // Fetch evaluations, trackings, and runner status in parallel
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
          .limit(200),
        supabase
          .from('runner_heartbeats')
          .select('*')
          .or('runner_type.eq.v27-shadow,runner_type.eq.v27')
          .order('last_heartbeat', { ascending: false })
          .limit(1)
          .single(),
      ]);

      if (evalsRes.data) {
        setEvaluations(evalsRes.data as ShadowEvaluation[]);
      }

      if (trackingsRes.data) {
        setTrackings(trackingsRes.data as SignalTracking[]);
      }

      if (heartbeatRes.data) {
        const hb = heartbeatRes.data;
        const lastHeartbeat = new Date(hb.last_heartbeat);
        const diffMs = Date.now() - lastHeartbeat.getTime();
        
        setRunnerStatus({
          isOnline: diffMs < 60000,
          lastHeartbeat: hb.last_heartbeat,
          version: hb.version,
          marketsCount: hb.markets_count || 0,
          balance: hb.balance || 0,
        });
      }
    } catch (err) {
      console.error('Error fetching shadow engine data:', err);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [fetchData]);

  // Set up realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel('shadow_engine_realtime')
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

  // Calculate stats
  const stats: ShadowStats = {
    totalEvaluations: evaluations.length,
    signalsDetected: evaluations.filter(e => e.mispricing_side !== null).length,
    cleanSignals: evaluations.filter(e => e.signal_valid && !e.adverse_blocked).length,
    toxicSkips: evaluations.filter(e => e.adverse_blocked).length,
    entrySignals: evaluations.filter(e => e.action === 'ENTRY').length,
    
    byAction: evaluations.reduce((acc, e) => {
      const action = e.action || 'NONE';
      acc[action] = (acc[action] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    
    byAsset: evaluations.reduce((acc, e) => {
      if (!acc[e.asset]) acc[e.asset] = { total: 0, signals: 0, entries: 0 };
      acc[e.asset].total++;
      if (e.mispricing_side !== null) acc[e.asset].signals++;
      if (e.action === 'ENTRY') acc[e.asset].entries++;
      return acc;
    }, {} as Record<string, { total: number; signals: number; entries: number }>),
    
    trackingsCompleted: trackings.filter(t => t.completed).length,
    mispricingsResolved5s: trackings.filter(t => t.mispricing_resolved_5s === true).length,
    mispricingsResolved10s: trackings.filter(t => t.mispricing_resolved_10s === true).length,
    mispricingsResolved15s: trackings.filter(t => t.mispricing_resolved_15s === true).length,
    adverseSelection5s: trackings.filter(t => t.adverse_selection_5s === true).length,
    adverseSelection10s: trackings.filter(t => t.adverse_selection_10s === true).length,
    adverseSelection15s: trackings.filter(t => t.adverse_selection_15s === true).length,
    signalsCorrect: trackings.filter(t => t.signal_was_correct === true).length,
    wouldHaveProfited: trackings.filter(t => t.would_have_profited === true).length,
    
    hedgesSimulated: trackings.filter(t => t.hedge_simulated).length,
    hedgesWouldExecute: trackings.filter(t => t.hedge_would_execute === true).length,
    avgSimulatedCpp: trackings.filter(t => t.simulated_cpp !== null).length > 0
      ? trackings.filter(t => t.simulated_cpp !== null)
          .reduce((sum, t) => sum + (t.simulated_cpp || 0), 0) / 
        trackings.filter(t => t.simulated_cpp !== null).length
      : 0,
    
    adverseReasons: evaluations.filter(e => e.adverse_reason).reduce((acc, e) => {
      const reason = e.adverse_reason || 'UNKNOWN';
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  return {
    evaluations,
    trackings,
    stats,
    loading,
    runnerStatus,
    refetch: fetchData,
  };
}
