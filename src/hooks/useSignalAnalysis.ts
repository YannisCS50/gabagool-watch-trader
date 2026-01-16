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
  // Price changes
  avg_price_change_pct: number;
  up_tick_pct: number;      // % of cases where price went UP
  down_tick_pct: number;    // % of cases where price went DOWN
  // Share price changes in cents
  avg_share_change_cents: number;
  up_share_pct: number;     // % of cases where share price went UP
  down_share_pct: number;   // % of cases where share price went DOWN
}

export interface SignalAnalysis {
  direction: 'UP' | 'DOWN';
  total_signals: number;
  avg_signal_size: number;  // Average binance delta that triggered the signal
  stats_by_second: SecondStats[];
}

export function useSignalAnalysis(asset?: string) {
  return useQuery({
    queryKey: ['signal-analysis', asset],
    queryFn: async () => {
      // Fetch all ticks for analysis
      let query = supabase
        .from('v29_ticks')
        .select('ts, signal_direction, binance_price, binance_delta, chainlink_price, up_best_bid, down_best_bid, market_slug, asset')
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
      const upSignals: (SignalTick & { binance_delta: number })[] = [];
      const downSignals: (SignalTick & { binance_delta: number })[] = [];

      for (const tick of allTicks || []) {
        if (tick.signal_direction === 'UP') {
          upSignals.push(tick as SignalTick & { binance_delta: number });
        } else if (tick.signal_direction === 'DOWN') {
          downSignals.push(tick as SignalTick & { binance_delta: number });
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
  signals: (SignalTick & { binance_delta: number })[],
  ticksByMarket: Map<string, FollowupTick[]>,
  direction: 'UP' | 'DOWN'
): SignalAnalysis {
  const statsBySecond: Map<number, {
    price_changes: number[];
    share_changes_cents: number[];
    price_up_count: number;
    price_down_count: number;
    share_up_count: number;
    share_down_count: number;
  }> = new Map();

  // Initialize 1-9 seconds
  for (let s = 1; s <= 9; s++) {
    statsBySecond.set(s, { 
      price_changes: [], 
      share_changes_cents: [],
      price_up_count: 0,
      price_down_count: 0,
      share_up_count: 0,
      share_down_count: 0,
    });
  }

  let totalDelta = 0;

  for (const signal of signals) {
    totalDelta += Math.abs(signal.binance_delta || 0);
    
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

        if (priceChange > 0) stats.price_up_count++;
        if (priceChange < 0) stats.price_down_count++;

        // Share price change in cents
        const signalSharePrice = direction === 'UP' ? signal.up_best_bid : signal.down_best_bid;
        const followupSharePrice = direction === 'UP' ? closestTick.up_best_bid : closestTick.down_best_bid;

        if (signalSharePrice != null && followupSharePrice != null) {
          const shareChangeCents = (followupSharePrice - signalSharePrice) * 100; // Convert to cents
          stats.share_changes_cents.push(shareChangeCents);

          if (shareChangeCents > 0) stats.share_up_count++;
          if (shareChangeCents < 0) stats.share_down_count++;
        }
      }
    }
  }

  // Calculate statistics
  const statsArray: SecondStats[] = [];
  for (let s = 1; s <= 9; s++) {
    const data = statsBySecond.get(s)!;
    const totalSamples = data.price_changes.length;
    const totalShareSamples = data.share_changes_cents.length;
    
    statsArray.push({
      seconds_after: s,
      sample_count: totalSamples,
      avg_price_change_pct: average(data.price_changes),
      up_tick_pct: totalSamples > 0 ? (data.price_up_count / totalSamples) * 100 : 0,
      down_tick_pct: totalSamples > 0 ? (data.price_down_count / totalSamples) * 100 : 0,
      avg_share_change_cents: average(data.share_changes_cents),
      up_share_pct: totalShareSamples > 0 ? (data.share_up_count / totalShareSamples) * 100 : 0,
      down_share_pct: totalShareSamples > 0 ? (data.share_down_count / totalShareSamples) * 100 : 0,
    });
  }

  return {
    direction,
    total_signals: signals.length,
    avg_signal_size: signals.length > 0 ? totalDelta / signals.length : 0,
    stats_by_second: statsArray,
  };
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}
