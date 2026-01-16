import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface SignalTick {
  ts: number;
  signal_direction: string;
  binance_price: number;
  chainlink_price: number;
  up_best_bid: number | null;
  down_best_bid: number | null;
  market_slug: string;
  asset: string;
}

interface FollowupTick {
  ts: number;
  binance_price: number;
  chainlink_price: number;
  up_best_bid: number | null;
  down_best_bid: number | null;
}

export interface SecondStats {
  seconds_after: number;
  sample_count: number;
  avg_price_change_pct: number;
  avg_share_price_change_pct: number;
  median_price_change_pct: number;
  median_share_price_change_pct: number;
  positive_rate: number; // % of cases where price moved in expected direction
}

export interface SignalAnalysis {
  direction: 'UP' | 'DOWN';
  total_signals: number;
  stats_by_second: SecondStats[];
}

export function useSignalAnalysis(asset?: string) {
  return useQuery({
    queryKey: ['signal-analysis', asset],
    queryFn: async () => {
      // Fetch all ticks for analysis
      let query = supabase
        .from('v29_ticks')
        .select('ts, signal_direction, binance_price, chainlink_price, up_best_bid, down_best_bid, market_slug, asset')
        .order('ts', { ascending: true });

      if (asset && asset !== 'all') {
        query = query.eq('asset', asset);
      }

      const { data: allTicks, error } = await query;
      if (error) throw error;

      // Group ticks by market_slug for efficient lookup
      const ticksByMarket = new Map<string, FollowupTick[]>();
      for (const tick of allTicks || []) {
        const existing = ticksByMarket.get(tick.market_slug);
        if (existing) {
          existing.push(tick);
        } else {
          ticksByMarket.set(tick.market_slug, [tick]);
        }
      }

      // Find signal ticks
      const upSignals: SignalTick[] = [];
      const downSignals: SignalTick[] = [];

      for (const tick of allTicks || []) {
        if (tick.signal_direction === 'UP') {
          upSignals.push(tick as SignalTick);
        } else if (tick.signal_direction === 'DOWN') {
          downSignals.push(tick as SignalTick);
        }
      }

      // Analyze each direction
      const upAnalysis = analyzeDirection(upSignals, ticksByMarket, 'UP');
      const downAnalysis = analyzeDirection(downSignals, ticksByMarket, 'DOWN');

      return { up: upAnalysis, down: downAnalysis };
    },
    staleTime: 60000,
  });
}

function analyzeDirection(
  signals: SignalTick[],
  ticksByMarket: Map<string, FollowupTick[]>,
  direction: 'UP' | 'DOWN'
): SignalAnalysis {
  const statsBySecond: Map<number, {
    price_changes: number[];
    share_changes: number[];
    positive_count: number;
  }> = new Map();

  // Initialize 1-9 seconds
  for (let s = 1; s <= 9; s++) {
    statsBySecond.set(s, { price_changes: [], share_changes: [], positive_count: 0 });
  }

  for (const signal of signals) {
    const marketTicks = ticksByMarket.get(signal.market_slug);
    if (!marketTicks) continue;

    // Find ticks after this signal
    for (let seconds = 1; seconds <= 9; seconds++) {
      const targetTs = signal.ts + seconds * 1000;
      
      // Find closest tick to target timestamp (within 500ms tolerance)
      let closestTick: FollowupTick | null = null;
      let closestDiff = Infinity;

      for (const tick of marketTicks) {
        const diff = Math.abs(tick.ts - targetTs);
        if (diff < closestDiff && diff < 500) {
          closestDiff = diff;
          closestTick = tick;
        }
      }

      if (closestTick) {
        const stats = statsBySecond.get(seconds)!;
        
        // Price change (Chainlink)
        const priceChange = ((closestTick.chainlink_price - signal.chainlink_price) / signal.chainlink_price) * 100;
        stats.price_changes.push(priceChange);

        // Share price change (use up_best_bid for UP signals, down_best_bid for DOWN)
        const signalSharePrice = direction === 'UP' ? signal.up_best_bid : signal.down_best_bid;
        const followupSharePrice = direction === 'UP' ? closestTick.up_best_bid : closestTick.down_best_bid;

        if (signalSharePrice && followupSharePrice && signalSharePrice > 0) {
          const shareChange = ((followupSharePrice - signalSharePrice) / signalSharePrice) * 100;
          stats.share_changes.push(shareChange);
        }

        // Did price move in expected direction?
        if (direction === 'UP' && priceChange > 0) stats.positive_count++;
        if (direction === 'DOWN' && priceChange < 0) stats.positive_count++;
      }
    }
  }

  // Calculate statistics
  const statsArray: SecondStats[] = [];
  for (let s = 1; s <= 9; s++) {
    const data = statsBySecond.get(s)!;
    
    statsArray.push({
      seconds_after: s,
      sample_count: data.price_changes.length,
      avg_price_change_pct: average(data.price_changes),
      avg_share_price_change_pct: average(data.share_changes),
      median_price_change_pct: median(data.price_changes),
      median_share_price_change_pct: median(data.share_changes),
      positive_rate: data.price_changes.length > 0 
        ? (data.positive_count / data.price_changes.length) * 100 
        : 0,
    });
  }

  return {
    direction,
    total_signals: signals.length,
    stats_by_second: statsArray,
  };
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
