import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface V27Evaluation {
  id: string;
  ts: number;
  iso: string;
  run_id: string | null;
  market_id: string;
  asset: string;
  strike_price: number;
  spot_price: number;
  delta_abs: number;
  delta_pct: number;
  threshold: number;
  time_remaining: number;
  up_mid: number | null;
  down_mid: number | null;
  causality_pass: boolean;
  spot_lead_ms: number | null;
  mispricing_exists: boolean;
  mispriced_side: string | null;
  expected_price: number | null;
  actual_price: number | null;
  price_lag: number | null;
  confidence: string | null;
  filter_pass: boolean;
  failed_filter: string | null;
  aggressive_flow: Record<string, unknown> | null;
  book_shape: Record<string, unknown> | null;
  spread_expansion: Record<string, unknown> | null;
  decision: string;
  reason: string;
  order_side: string | null;
  order_price: number | null;
  order_shares: number | null;
  created_at: string;
}

export interface V27Config {
  id: string;
  enabled: boolean;
  shadow_mode: boolean;
  assets: string[];
  asset_thresholds: Record<string, { min: number; max: number; current: number }>;
  causality_min_ms: number;
  causality_max_ms: number;
  correction_threshold_pct: number;
  updated_at: string;
}

interface UseV27EvaluationsResult {
  evaluations: V27Evaluation[];
  config: V27Config | null;
  loading: boolean;
  error: string | null;
  stats: {
    total: number;
    skipped: number;
    entered: number;
    entryRate: number;
    mispricingsDetected: number;
    filtersPassed: number;
    byAsset: Record<string, { total: number; entered: number }>;
    byReason: Record<string, number>;
  };
  refetch: () => Promise<void>;
}

export function useV27Evaluations(limit: number = 1000): UseV27EvaluationsResult {
  const [evaluations, setEvaluations] = useState<V27Evaluation[]>([]);
  const [config, setConfig] = useState<V27Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch evaluations
      const { data: evalData, error: evalError } = await supabase
        .from('v27_evaluations')
        .select('*')
        .order('ts', { ascending: false })
        .limit(limit);

      if (evalError) throw evalError;
      // Map database columns to our interface
      const mapped: V27Evaluation[] = (evalData || []).map((row: Record<string, unknown>) => ({
        id: row.id as string,
        ts: row.ts as number,
        iso: row.iso as string || new Date(row.created_at as string).toISOString(),
        run_id: row.run_id as string | null,
        market_id: row.market_id as string,
        asset: row.asset as string,
        strike_price: Number(row.strike_price) || 0,
        spot_price: Number(row.spot_price) || 0,
        delta_abs: Number(row.delta_abs) || 0,
        delta_pct: Number(row.delta_pct) || 0,
        threshold: Number(row.threshold) || Number(row.base_threshold) || 0,
        time_remaining: Number(row.time_remaining) || 0,
        up_mid: row.up_mid != null ? Number(row.up_mid) : null,
        down_mid: row.down_mid != null ? Number(row.down_mid) : null,
        causality_pass: Boolean(row.causality_pass ?? row.causality_passed),
        spot_lead_ms: row.spot_lead_ms as number | null,
        mispricing_exists: Boolean(row.mispricing_exists),
        mispriced_side: row.mispriced_side as string | null,
        expected_price: row.expected_price != null ? Number(row.expected_price) : null,
        actual_price: row.actual_price != null ? Number(row.actual_price) : null,
        price_lag: row.price_lag != null ? Number(row.price_lag) : null,
        confidence: row.confidence as string | null,
        filter_pass: Boolean(row.filter_pass ?? !row.adverse_blocked),
        failed_filter: (row.failed_filter ?? row.adverse_reason) as string | null,
        aggressive_flow: row.aggressive_flow as Record<string, unknown> | null,
        book_shape: row.book_shape as Record<string, unknown> | null,
        spread_expansion: row.spread_expansion as Record<string, unknown> | null,
        decision: (row.decision ?? row.action) as string,
        reason: (row.reason ?? row.adverse_reason ?? 'UNKNOWN') as string,
        order_side: row.order_side as string | null,
        order_price: row.order_price != null ? Number(row.order_price) : null,
        order_shares: row.order_shares != null ? Number(row.order_shares) : null,
        created_at: row.created_at as string,
      }));
      setEvaluations(mapped);

      // Fetch config
      const { data: configData, error: configError } = await supabase
        .from('v27_config')
        .select('*')
        .eq('id', 'default')
        .single();

      if (configError && configError.code !== 'PGRST116') {
        console.warn('Failed to load config:', configError);
      }
      if (configData) {
        setConfig({
          id: configData.id,
          enabled: configData.enabled,
          shadow_mode: configData.shadow_mode,
          assets: configData.assets,
          asset_thresholds: configData.asset_thresholds as Record<string, { min: number; max: number; current: number }>,
          causality_min_ms: configData.causality_min_ms,
          causality_max_ms: configData.causality_max_ms,
          correction_threshold_pct: Number(configData.correction_threshold_pct),
          updated_at: configData.updated_at,
        });
      }

    } catch (err) {
      console.error('Failed to fetch V27 data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchData();

    // Set up realtime subscription for evaluations
    const channel = supabase
      .channel('v27_evaluations_changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'v27_evaluations',
        },
        (payload) => {
          setEvaluations((prev) => [payload.new as V27Evaluation, ...prev.slice(0, limit - 1)]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData, limit]);

  // Calculate stats
  const stats = {
    total: evaluations.length,
    skipped: evaluations.filter((e) => e.decision === 'SKIP').length,
    entered: evaluations.filter((e) => e.decision === 'ENTER').length,
    entryRate: evaluations.length > 0 
      ? (evaluations.filter((e) => e.decision === 'ENTER').length / evaluations.length) * 100 
      : 0,
    mispricingsDetected: evaluations.filter((e) => e.mispricing_exists).length,
    filtersPassed: evaluations.filter((e) => e.filter_pass).length,
    byAsset: evaluations.reduce((acc, e) => {
      if (!acc[e.asset]) acc[e.asset] = { total: 0, entered: 0 };
      acc[e.asset].total++;
      if (e.decision === 'ENTER') acc[e.asset].entered++;
      return acc;
    }, {} as Record<string, { total: number; entered: number }>),
    byReason: evaluations
      .filter((e) => e.decision === 'SKIP')
      .reduce((acc, e) => {
        const key = e.reason.includes('below threshold') ? 'Delta below threshold' : e.reason;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
  };

  return {
    evaluations,
    config,
    loading,
    error,
    stats,
    refetch: fetchData,
  };
}
