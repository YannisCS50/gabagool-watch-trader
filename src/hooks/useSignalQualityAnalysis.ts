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
      // If a specific limit is set, use simple query
      if (filters.limit) {
        let query = supabase
          .from('signal_quality_analysis')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(filters.limit);
        
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
        
        const { data, error } = await query;
        if (error) throw error;
        return (data || []) as unknown as SignalQualityAnalysis[];
      }
      
      // No limit - paginate to get ALL data
      const allData: SignalQualityAnalysis[] = [];
      let offset = 0;
      const pageSize = 1000;
      
      while (true) {
        let query = supabase
          .from('signal_quality_analysis')
          .select('*')
          .order('created_at', { ascending: false })
          .range(offset, offset + pageSize - 1);
        
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
        
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        
        allData.push(...(data as unknown as SignalQualityAnalysis[]));
        offset += pageSize;
        if (data.length < pageSize) break;
      }
      
      return allData;
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
  const { data: signals } = useSignalQualityData({ asset }); // No limit - get all
  
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

// ============================================
// POPULATE FROM BOTH v29_signals AND v29_signals_response
// ============================================
// These tables contain data from DIFFERENT time periods:
// - v29_signals: 13 jan - 16 jan 10:46 (6,557 rows) 
// - v29_signals_response: 16 jan 13:46 - now (159 rows)
// We merge both to get complete signal history.

interface RawSignalV29 {
  id: string;
  asset: string;
  direction: string;
  binance_price: number | null;
  delta_usd: number | null;
  share_price: number | null;
  market_slug: string | null;
  strike_price: number | null;
  status: string | null;
  entry_price: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  signal_ts: number | null;
  fill_ts: number | null;
  sell_ts: number | null;
  net_pnl: number | null;
  shares: number | null;
}

interface RawSignalV29Response {
  id: string;
  asset: string;
  direction: string;
  binance_price: number | null;
  binance_delta: number | null;
  binance_ts: number | null;
  share_price_t0: number | null;
  spread_t0: number | null;
  best_bid_t0: number | null;
  best_ask_t0: number | null;
  market_slug: string | null;
  strike_price: number | null;
  status: string | null;
  entry_price: number | null;
  exit_price: number | null;
  exit_type: string | null;
  exit_reason: string | null;
  signal_ts: number | null;
  fill_ts: number | null;
  exit_ts: number | null;
  net_pnl: number | null;
  gross_pnl: number | null;
  fees: number | null;
  shares: number | null;
  price_at_1s: number | null;
  price_at_2s: number | null;
  price_at_3s: number | null;
  price_at_5s: number | null;
  decision_latency_ms: number | null;
  order_latency_ms: number | null;
  fill_latency_ms: number | null;
}

function computeDeltaBucket(asset: string, deltaAbs: number): string {
  if (asset === 'BTC') {
    if (deltaAbs >= 100) return 'd100+';
    if (deltaAbs >= 50) return 'd50-100';
    if (deltaAbs >= 20) return 'd20-50';
    return 'd0-20';
  } else if (asset === 'ETH') {
    if (deltaAbs >= 10) return 'd10+';
    if (deltaAbs >= 5) return 'd5-10';
    if (deltaAbs >= 2) return 'd2-5';
    return 'd0-2';
  } else if (asset === 'SOL') {
    if (deltaAbs >= 2) return 'd2+';
    if (deltaAbs >= 1) return 'd1-2';
    if (deltaAbs >= 0.5) return 'd0.5-1';
    return 'd0-0.5';
  } else if (asset === 'XRP') {
    if (deltaAbs >= 0.02) return 'd0.02+';
    if (deltaAbs >= 0.01) return 'd0.01-0.02';
    if (deltaAbs >= 0.005) return 'd0.005-0.01';
    return 'd0-0.005';
  }
  return 'd0-20';
}

function computeSpotLeadBucket(spotLeadMs: number | null): string {
  if (spotLeadMs === null) return '<300ms';
  if (spotLeadMs >= 800) return '>800ms';
  if (spotLeadMs >= 300) return '300-800ms';
  return '<300ms';
}

// Transform v29_signals (legacy format) to analysis record
function transformV29Signal(s: RawSignalV29) {
  const asset = s.asset || 'BTC';
  
  // Correct delta calculation: spot price (binance/chainlink) - strike price
  const spotPrice = s.binance_price || 0;
  const strikePrice = s.strike_price || 0;
  const deltaUsd = spotPrice - strikePrice;
  const deltaAbs = Math.abs(deltaUsd);
  const deltaBucket = computeDeltaBucket(asset, deltaAbs);
  
  // Legacy format doesn't have bid/ask, estimate from share_price
  const estimatedSpread = 0.02; // Typical spread ~2 cents
  const spreadUp = estimatedSpread;
  const effectiveSpreadSell = estimatedSpread;
  const effectiveSpreadHedge = estimatedSpread * 2;
  
  // No binance_ts in legacy, can't compute lead
  const spotLeadMs = null;
  const spotLeadBucket = '<300ms';
  
  // Estimate edge - legacy has less data
  const edgeAfterSpread = Math.abs(s.delta_usd || 0) / 100 - effectiveSpreadSell;
  const isFalseEdge = (s.delta_usd || 0) !== 0 && edgeAfterSpread < 0;
  const wouldHaveLost = (s.net_pnl || 0) < 0;
  
  return {
    signal_id: s.id,
    market_id: s.market_slug || '',
    asset,
    direction: s.direction || 'UP',
    timestamp_signal_detected: s.signal_ts || Date.now(),
    time_remaining_seconds: 0,
  strike_price: strikePrice,
    spot_price_at_signal: spotPrice,
    delta_usd: deltaUsd,
    delta_bucket: deltaBucket,
    
    up_bid: s.share_price ? s.share_price - 0.01 : null,
    up_ask: s.share_price,
    down_bid: null,
    down_ask: null,
    
    spread_up: spreadUp,
    spread_down: spreadUp,
    effective_spread_sell: effectiveSpreadSell,
    effective_spread_hedge: effectiveSpreadHedge,
    
    actual_price_at_5s: null,
    actual_price_at_7s: null,
    actual_price_at_10s: null,
    actual_pnl: s.net_pnl,
    
    binance_tick_ts: null,
    polymarket_tick_ts: s.signal_ts,
    spot_lead_ms: spotLeadMs,
    spot_lead_bucket: spotLeadBucket,
    
    edge_after_spread_7s: edgeAfterSpread,
    
    chosen_exit_type: s.exit_reason ? 'sell' : 'none',
    
    bucket_n: 50,
    bucket_confidence: 0.5, // Lower confidence for legacy data
    
    should_trade: edgeAfterSpread > 0,
    would_have_lost_money: wouldHaveLost,
    is_false_edge: isFalseEdge,
    source: 'v29_signals',
  };
}

// Transform v29_signals_response (new format) to analysis record
function transformV29ResponseSignal(s: RawSignalV29Response) {
  const asset = s.asset || 'BTC';
  
  // Correct delta calculation: spot price (binance/chainlink) - strike price
  const spotPrice = s.binance_price || 0;
  const strikePrice = s.strike_price || 0;
  const deltaUsd = spotPrice - strikePrice;
  const deltaAbs = Math.abs(deltaUsd);
  const deltaBucket = computeDeltaBucket(asset, deltaAbs);
  
  // New format has actual bid/ask
  const spreadUp = (s.best_ask_t0 || 0) - (s.best_bid_t0 || 0);
  const spreadDown = spreadUp;
  const effectiveSpreadSell = spreadUp;
  const effectiveSpreadHedge = ((s.best_ask_t0 || 0) * 2) - 1;
  
  // Compute lead/lag
  const spotLeadMs = s.signal_ts && s.binance_ts 
    ? (s.signal_ts - s.binance_ts) 
    : null;
  const spotLeadBucket = computeSpotLeadBucket(spotLeadMs);
  
  // Use actual price moves if available
  const priceMove5s = s.price_at_5s ? (s.price_at_5s - (s.share_price_t0 || 0)) : null;
  const edgeAfterSpread = priceMove5s !== null 
    ? priceMove5s - effectiveSpreadSell 
    : (Math.abs(s.binance_delta || 0) / 100 - effectiveSpreadSell);
  
  const isFalseEdge = (s.binance_delta || 0) !== 0 && edgeAfterSpread < 0;
  const wouldHaveLost = (s.net_pnl || 0) < 0;
  
  // should_trade logic: edge > 0, lead >= 500ms, bucket has samples
  const shouldTrade = edgeAfterSpread > 0 
    && (spotLeadMs === null || spotLeadMs >= 500);
  
  return {
    signal_id: s.id,
    market_id: s.market_slug || '',
    asset,
    direction: s.direction || 'UP',
    timestamp_signal_detected: s.signal_ts || Date.now(),
    time_remaining_seconds: 0,
  strike_price: strikePrice,
    spot_price_at_signal: spotPrice,
    delta_usd: deltaUsd,
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
    
    bucket_n: 50,
    bucket_confidence: 1.0,
    
    should_trade: shouldTrade,
    would_have_lost_money: wouldHaveLost,
    is_false_edge: isFalseEdge,
    source: 'v29_signals_response',
  };
}

export function usePopulateSignalQuality() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async () => {
      // Fetch existing signal IDs to avoid duplicates
      const { data: existingData } = await supabase
        .from('signal_quality_analysis')
        .select('signal_id');
      const existingIds = new Set((existingData || []).map(e => e.signal_id));
      
      // Fetch from both sources - no limits, get ALL signals
      // Supabase default limit is 1000, so we need to paginate
      const fetchAllV29Signals = async () => {
        const allData: RawSignalV29[] = [];
        let offset = 0;
        const pageSize = 1000;
        
        while (true) {
          const { data, error } = await supabase
            .from('v29_signals')
            .select('*')
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);
          
          if (error) throw error;
          if (!data || data.length === 0) break;
          
          allData.push(...(data as unknown as RawSignalV29[]));
          offset += pageSize;
          if (data.length < pageSize) break;
        }
        
        return allData;
      };
      
      const fetchAllV29Response = async () => {
        const allData: RawSignalV29Response[] = [];
        let offset = 0;
        const pageSize = 1000;
        
        while (true) {
          const { data, error } = await supabase
            .from('v29_signals_response')
            .select('*')
            .order('created_at', { ascending: false })
            .range(offset, offset + pageSize - 1);
          
          if (error) throw error;
          if (!data || data.length === 0) break;
          
          allData.push(...(data as unknown as RawSignalV29Response[]));
          offset += pageSize;
          if (data.length < pageSize) break;
        }
        
        return allData;
      };
      
      const [v29Signals, v29ResponseSignals] = await Promise.all([
        fetchAllV29Signals(),
        fetchAllV29Response(),
      ]);
      
      // Filter out already processed signals
      const newV29 = v29Signals.filter(s => !existingIds.has(s.id));
      const newV29Response = v29ResponseSignals.filter(s => !existingIds.has(s.id));
      
      if (newV29.length === 0 && newV29Response.length === 0) {
        return { processed: 0, fromV29: 0, fromV29Response: 0 };
      }
      
      // Transform both sources
      const recordsV29 = newV29.map(transformV29Signal);
      const recordsV29Response = newV29Response.map(transformV29ResponseSignal);
      const allRecords = [...recordsV29, ...recordsV29Response];
      
      // Insert in batches of 100
      const batchSize = 100;
      let inserted = 0;
      
      for (let i = 0; i < allRecords.length; i += batchSize) {
        const batch = allRecords.slice(i, i + batchSize);
        const { error: insertError } = await supabase
          .from('signal_quality_analysis')
          .insert(batch);
        
        if (insertError) {
          console.error('Batch insert error:', insertError);
          // Continue with next batch
        } else {
          inserted += batch.length;
        }
      }
      
      return { 
        processed: inserted, 
        fromV29: recordsV29.length, 
        fromV29Response: recordsV29Response.length 
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signal-quality-analysis'] });
    },
  });
}
