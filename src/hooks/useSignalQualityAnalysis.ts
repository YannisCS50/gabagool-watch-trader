import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { 
  SignalQualityAnalysis, 
  SignalQualityStats, 
  BucketAggregation,
  BucketStatistics,
  DeltaBucketConfig 
} from '@/types/signalQuality';

// ============================================
// SIGNAL QUALITY ANALYSIS HOOK
// ============================================
// Fetches and manages signal quality data for edge truth analysis.
// This is the core hook for the Signal Quality & Edge Truth dashboard.

export interface SignalQualityFilters {
  asset?: string;
  deltaBucket?: string;
  timeRemaining?: { min: number; max: number };
  spotLeadBucket?: string;
  shouldTrade?: boolean;
  limit?: number;
}

export function useSignalQualityData(filters: SignalQualityFilters = {}) {
  return useQuery({
    queryKey: ['signal-quality-analysis', filters],
    queryFn: async (): Promise<SignalQualityAnalysis[]> => {
      let query = supabase
        .from('signal_quality_analysis')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (filters.asset && filters.asset !== 'all') {
        query = query.eq('asset', filters.asset);
      }
      if (filters.deltaBucket) {
        query = query.eq('delta_bucket', filters.deltaBucket);
      }
      if (filters.spotLeadBucket) {
        query = query.eq('spot_lead_bucket', filters.spotLeadBucket);
      }
      if (filters.shouldTrade !== undefined) {
        query = query.eq('should_trade', filters.shouldTrade);
      }
      if (filters.timeRemaining) {
        query = query
          .gte('time_remaining_seconds', filters.timeRemaining.min)
          .lte('time_remaining_seconds', filters.timeRemaining.max);
      }
      if (filters.limit) {
        query = query.limit(filters.limit);
      } else {
        query = query.limit(500);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      return (data || []) as unknown as SignalQualityAnalysis[];
    },
    staleTime: 30000,
  });
}

// Compute aggregated stats from signal data
export function useSignalQualityStats(filters: SignalQualityFilters = {}) {
  const { data: signals, ...rest } = useSignalQualityData(filters);
  
  const stats: SignalQualityStats | null = signals && signals.length > 0 ? (() => {
    const total = signals.length;
    const positiveEdge = signals.filter(s => (s.edge_after_spread_7s ?? 0) > 0);
    const shouldTrade = signals.filter(s => s.should_trade);
    const shouldNotTrade = signals.filter(s => !s.should_trade);
    const falseEdge = signals.filter(s => s.is_false_edge);
    const lowConfidence = signals.filter(s => (s.bucket_confidence ?? 0) < 0.6);
    
    // Win rate calculations
    const shouldTradeWins = shouldTrade.filter(s => (s.actual_pnl ?? 0) > 0);
    const shouldNotTradeWins = shouldNotTrade.filter(s => (s.actual_pnl ?? 0) > 0);
    
    return {
      totalSignals: total,
      signalsWithPositiveEdge: positiveEdge.length,
      pctPositiveEdge: total > 0 ? (positiveEdge.length / total) * 100 : 0,
      avgEdgeAfterSpread: signals.reduce((sum, s) => sum + (s.edge_after_spread_7s ?? 0), 0) / total,
      
      shouldTradeCount: shouldTrade.length,
      shouldNotTradeCount: shouldNotTrade.length,
      winRateWhenShouldTrade: shouldTrade.length > 0 
        ? (shouldTradeWins.length / shouldTrade.length) * 100 
        : 0,
      winRateWhenShouldNotTrade: shouldNotTrade.length > 0 
        ? (shouldNotTradeWins.length / shouldNotTrade.length) * 100 
        : 0,
      
      falseEdgeCount: falseEdge.length,
      falseEdgePct: total > 0 ? (falseEdge.length / total) * 100 : 0,
      
      lowConfidenceCount: lowConfidence.length,
      lowConfidencePct: total > 0 ? (lowConfidence.length / total) * 100 : 0,
    };
  })() : null;
  
  return { stats, signals, ...rest };
}

// Aggregation by delta bucket
export function useBucketAggregations(asset?: string) {
  const { data: signals } = useSignalQualityData({ asset, limit: 1000 });
  
  const aggregations: BucketAggregation[] = signals ? (() => {
    const bucketMap = new Map<string, SignalQualityAnalysis[]>();
    
    signals.forEach(s => {
      const bucket = s.delta_bucket;
      if (!bucketMap.has(bucket)) {
        bucketMap.set(bucket, []);
      }
      bucketMap.get(bucket)!.push(s);
    });
    
    return Array.from(bucketMap.entries()).map(([bucket, items]) => {
      const wins = items.filter(s => (s.actual_pnl ?? 0) > 0);
      const avgEdge = items.reduce((sum, s) => sum + (s.edge_after_spread_7s ?? 0), 0) / items.length;
      const avgLead = items.reduce((sum, s) => sum + (s.spot_lead_ms ?? 0), 0) / items.length;
      const avgConf = items.reduce((sum, s) => sum + (s.bucket_confidence ?? 0), 0) / items.length;
      
      return {
        bucket,
        count: items.length,
        avgEdge,
        winRate: items.length > 0 ? (wins.length / items.length) * 100 : 0,
        avgSpotLead: avgLead,
        confidence: avgConf,
        isLowSample: items.length < 30,
      };
    }).sort((a, b) => {
      // Sort by bucket label numerically
      const aNum = parseInt(a.bucket.replace(/[^0-9]/g, '')) || 0;
      const bNum = parseInt(b.bucket.replace(/[^0-9]/g, '')) || 0;
      return aNum - bNum;
    });
  })() : [];
  
  return { aggregations };
}

// Fetch bucket statistics (pre-computed)
export function useBucketStatistics(asset?: string) {
  return useQuery({
    queryKey: ['bucket-statistics', asset],
    queryFn: async (): Promise<BucketStatistics[]> => {
      let query = supabase
        .from('bucket_statistics')
        .select('*')
        .order('delta_bucket', { ascending: true });
      
      if (asset && asset !== 'all') {
        query = query.eq('asset', asset);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as BucketStatistics[];
    },
    staleTime: 60000,
  });
}

// Fetch delta bucket config
export function useDeltaBucketConfig(asset?: string) {
  return useQuery({
    queryKey: ['delta-bucket-config', asset],
    queryFn: async (): Promise<DeltaBucketConfig[]> => {
      let query = supabase
        .from('delta_bucket_config')
        .select('*')
        .order('bucket_index', { ascending: true });
      
      if (asset && asset !== 'all') {
        query = query.eq('asset', asset);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as unknown as DeltaBucketConfig[];
    },
    staleTime: 300000, // 5 min - doesn't change often
  });
}

// Populate signal quality analysis from v29_signals_response
export function usePopulateSignalQuality() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async () => {
      // Fetch recent signals from v29_signals_response that aren't yet in signal_quality_analysis
      const { data: signals, error: fetchError } = await supabase
        .from('v29_signals_response')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      
      if (fetchError) throw fetchError;
      if (!signals || signals.length === 0) return { processed: 0 };
      
      // Check which ones already exist
      const signalIds = signals.map(s => s.id);
      const { data: existing } = await supabase
        .from('signal_quality_analysis')
        .select('signal_id')
        .in('signal_id', signalIds);
      
      const existingIds = new Set((existing || []).map(e => e.signal_id));
      const newSignals = signals.filter(s => !existingIds.has(s.id));
      
      if (newSignals.length === 0) return { processed: 0 };
      
      // Transform and insert
      const records = newSignals.map(s => {
        const deltaAbs = Math.abs(s.binance_delta || 0);
        const asset = s.asset || 'BTC';
        
        // Compute delta bucket
        let deltaBucket = 'd0-20';
        if (asset === 'BTC') {
          if (deltaAbs >= 100) deltaBucket = 'd100+';
          else if (deltaAbs >= 50) deltaBucket = 'd50-100';
          else if (deltaAbs >= 20) deltaBucket = 'd20-50';
        } else if (asset === 'ETH') {
          if (deltaAbs >= 10) deltaBucket = 'd10+';
          else if (deltaAbs >= 5) deltaBucket = 'd5-10';
          else if (deltaAbs >= 2) deltaBucket = 'd2-5';
          else deltaBucket = 'd0-2';
        }
        
        // Compute spreads
        const spreadUp = (s.best_ask_t0 || 0) - (s.best_bid_t0 || 0);
        const spreadDown = spreadUp; // Approximate if not available
        const effectiveSpreadSell = spreadUp;
        const effectiveSpreadHedge = ((s.best_ask_t0 || 0) + (s.best_ask_t0 || 0)) - 1;
        
        // Compute lead/lag
        const spotLeadMs = s.signal_ts && s.binance_ts 
          ? (s.signal_ts - s.binance_ts) 
          : null;
        let spotLeadBucket = '<300ms';
        if (spotLeadMs !== null) {
          if (spotLeadMs >= 800) spotLeadBucket = '>800ms';
          else if (spotLeadMs >= 300) spotLeadBucket = '300-800ms';
        }
        
        // Truth flags
        const edgeAfterSpread = (s.price_at_5s || s.share_price_t0 || 0) - (s.share_price_t0 || 0) - effectiveSpreadSell;
        const isFalseEdge = (s.binance_delta || 0) > 0 && edgeAfterSpread < 0;
        const wouldHaveLost = (s.net_pnl || 0) < 0;
        
        return {
          signal_id: s.id,
          market_id: s.market_slug || '',
          asset,
          direction: s.direction || 'UP',
          timestamp_signal_detected: s.signal_ts || Date.now(),
          time_remaining_seconds: 0, // Would need to compute from market data
          strike_price: s.strike_price || 0,
          spot_price_at_signal: s.binance_price || 0,
          delta_usd: s.binance_delta || 0,
          delta_bucket: deltaBucket,
          
          up_bid: s.best_bid_t0,
          up_ask: s.best_ask_t0,
          down_bid: s.best_bid_t0,
          down_ask: s.best_ask_t0,
          
          spread_up: spreadUp,
          spread_down: spreadDown,
          effective_spread_sell: effectiveSpreadSell,
          effective_spread_hedge: effectiveSpreadHedge,
          
          actual_price_at_5s: s.price_at_5s,
          actual_price_at_7s: s.price_at_5s, // Approximate
          actual_price_at_10s: s.price_at_5s,
          actual_pnl: s.net_pnl,
          
          binance_tick_ts: s.binance_ts,
          polymarket_tick_ts: s.signal_ts,
          spot_lead_ms: spotLeadMs,
          spot_lead_bucket: spotLeadBucket,
          
          edge_after_spread_7s: edgeAfterSpread,
          
          chosen_exit_type: s.exit_type || 'none',
          
          bucket_n: 50, // Will be updated by aggregation
          bucket_confidence: 1.0,
          
          should_trade: edgeAfterSpread > 0 && (spotLeadMs || 0) >= 500,
          would_have_lost_money: wouldHaveLost,
          is_false_edge: isFalseEdge,
        };
      });
      
      const { error: insertError } = await supabase
        .from('signal_quality_analysis')
        .insert(records);
      
      if (insertError) throw insertError;
      
      return { processed: records.length };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signal-quality-analysis'] });
    },
  });
}
