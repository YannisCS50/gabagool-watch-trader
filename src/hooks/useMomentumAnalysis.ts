import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Types for momentum analysis
export interface MomentumSignal {
  id: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  binance_price: number;
  strike_price: number;
  delta: number;
  delta_bucket: string;
  share_price_t0: number;
  price_at_1s: number | null;
  price_at_2s: number | null;
  price_at_3s: number | null;
  price_at_5s: number | null;
  price_before_5s: number | null;
  signal_ts: number;
  // Derived metrics
  price_path: number[];
  persistence: boolean;
  reversal_count: number;
  max_adverse_move: number;
  final_move: number;
  pnl_estimate: number; // Estimated P&L based on price movement
}

export interface DeltaBucketStats {
  bucket: string;
  count: number;
  winRate: number;
  avgPnl: number;
  avgPersistence: number;
  avgMove1s: number;
  avgMove5s: number;
  favorableMoveRate: number;
}

export interface DirectionStats {
  direction: 'UP' | 'DOWN';
  deltaSize: 'small' | 'large';
  count: number;
  winRate: number;
  persistence: number;
  volatility: number;
}

export interface MomentumConfidence {
  score: number;
  label: 'AGRESSIEF' | 'NORMAAL' | 'VOORZICHTIG' | 'VERMIJDEN';
  reasons: string[];
}

// Calculate delta bucket
function getDeltaBucket(delta: number): string {
  const abs = Math.abs(delta);
  if (abs < 10) return 'd<10';
  if (abs < 15) return 'd10-15';
  if (abs < 20) return 'd15-20';
  return 'd20+';
}

// Reconstruct signal from v29_ticks data
interface TickRow {
  id: string;
  ts: number;
  asset: string;
  binance_price: number;
  strike_price: number;
  up_best_bid: number | null;
  down_best_bid: number | null;
  signal_direction: 'UP' | 'DOWN';
}

interface SurroundingTick {
  ts: number;
  up_best_bid: number | null;
  down_best_bid: number | null;
  binance_price: number;
}

function reconstructSignal(
  signalTick: TickRow, 
  surroundingTicks: SurroundingTick[]
): MomentumSignal {
  const direction = signalTick.signal_direction;
  const signalTs = signalTick.ts;
  
  // Get price at signal time (t0)
  const t0Price = direction === 'UP' 
    ? signalTick.up_best_bid 
    : signalTick.down_best_bid;
  
  // Find ticks at specific offsets
  const findClosestTick = (targetOffset: number): SurroundingTick | null => {
    const targetTs = signalTs + targetOffset;
    let closest: SurroundingTick | null = null;
    let minDiff = Infinity;
    
    for (const tick of surroundingTicks) {
      const diff = Math.abs(tick.ts - targetTs);
      if (diff < minDiff && diff < 1000) { // Within 1 second tolerance
        minDiff = diff;
        closest = tick;
      }
    }
    return closest;
  };
  
  const tickBefore5s = findClosestTick(-5000);
  const tick1s = findClosestTick(1000);
  const tick2s = findClosestTick(2000);
  const tick3s = findClosestTick(3000);
  const tick5s = findClosestTick(5000);
  
  const getPrice = (tick: SurroundingTick | null): number | null => {
    if (!tick) return null;
    return direction === 'UP' ? tick.up_best_bid : tick.down_best_bid;
  };
  
  const priceBefore5s = getPrice(tickBefore5s);
  const price1s = getPrice(tick1s);
  const price2s = getPrice(tick2s);
  const price3s = getPrice(tick3s);
  const price5s = getPrice(tick5s);
  
  // Build price path
  const pricePath: number[] = [];
  if (t0Price !== null) pricePath.push(t0Price);
  if (price1s !== null) pricePath.push(price1s);
  if (price2s !== null) pricePath.push(price2s);
  if (price3s !== null) pricePath.push(price3s);
  if (price5s !== null) pricePath.push(price5s);
  
  // Calculate metrics
  const finalPrice = pricePath.length > 1 ? pricePath[pricePath.length - 1] : t0Price || 0;
  const entryPrice = t0Price || 0;
  const finalMove = finalPrice - entryPrice;
  
  // Persistence: did price move favorably?
  const persistence = finalMove >= 0; // For both UP and DOWN, higher bid = better
  
  // Count reversals
  let reversalCount = 0;
  for (let i = 2; i < pricePath.length; i++) {
    const prevMove = pricePath[i-1] - pricePath[i-2];
    const currMove = pricePath[i] - pricePath[i-1];
    if ((prevMove > 0 && currMove < 0) || (prevMove < 0 && currMove > 0)) {
      reversalCount++;
    }
  }
  
  // Max adverse move (price dropping after entry)
  let maxAdverse = 0;
  for (const price of pricePath) {
    const move = price - entryPrice;
    if (move < 0) {
      maxAdverse = Math.max(maxAdverse, Math.abs(move));
    }
  }
  
  // Estimate PnL: if we bought at t0 and could sell at t5, what's the gain?
  // Assume $10 position size, share price is probability
  const positionSize = 10;
  const sharesBought = entryPrice > 0 ? positionSize / entryPrice : 0;
  const exitValue = sharesBought * finalPrice;
  const pnlEstimate = exitValue - positionSize;
  
  const delta = signalTick.binance_price - signalTick.strike_price;
  
  return {
    id: signalTick.id,
    asset: signalTick.asset,
    direction,
    binance_price: signalTick.binance_price,
    strike_price: signalTick.strike_price,
    delta,
    delta_bucket: getDeltaBucket(delta),
    share_price_t0: t0Price || 0,
    price_at_1s: price1s,
    price_at_2s: price2s,
    price_at_3s: price3s,
    price_at_5s: price5s,
    price_before_5s: priceBefore5s,
    signal_ts: signalTs,
    price_path: pricePath,
    persistence,
    reversal_count: reversalCount,
    max_adverse_move: maxAdverse,
    final_move: finalMove,
    pnl_estimate: pnlEstimate,
  };
}

// Aggregate stats by delta bucket
function aggregateByBucket(signals: MomentumSignal[]): DeltaBucketStats[] {
  const buckets: Record<string, MomentumSignal[]> = {};
  
  for (const s of signals) {
    if (!buckets[s.delta_bucket]) buckets[s.delta_bucket] = [];
    buckets[s.delta_bucket].push(s);
  }
  
  const order = ['d<10', 'd10-15', 'd15-20', 'd20+'];
  
  return order.filter(b => buckets[b]).map(bucket => {
    const group = buckets[bucket];
    const withPath = group.filter(s => s.price_at_5s !== null);
    
    const wins = withPath.filter(s => s.pnl_estimate > 0).length;
    const favorable = withPath.filter(s => s.persistence).length;
    
    return {
      bucket,
      count: group.length,
      winRate: withPath.length > 0 ? (wins / withPath.length) * 100 : 0,
      avgPnl: withPath.length > 0 
        ? withPath.reduce((sum, s) => sum + s.pnl_estimate, 0) / withPath.length 
        : 0,
      avgPersistence: withPath.length > 0 
        ? (favorable / withPath.length) * 100 
        : 0,
      avgMove1s: withPath.length > 0
        ? withPath.reduce((sum, s) => sum + ((s.price_at_1s || s.share_price_t0) - s.share_price_t0), 0) / withPath.length
        : 0,
      avgMove5s: withPath.length > 0
        ? withPath.reduce((sum, s) => sum + s.final_move, 0) / withPath.length
        : 0,
      favorableMoveRate: withPath.length > 0 ? (favorable / withPath.length) * 100 : 0,
    };
  });
}

// Aggregate by direction + delta size
function aggregateByDirection(signals: MomentumSignal[]): DirectionStats[] {
  const groups: Record<string, MomentumSignal[]> = {};
  
  for (const s of signals) {
    const deltaSize = Math.abs(s.delta) >= 12 ? 'large' : 'small';
    const key = `${s.direction}-${deltaSize}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }
  
  return Object.entries(groups).map(([key, group]) => {
    const [direction, deltaSize] = key.split('-') as ['UP' | 'DOWN', 'small' | 'large'];
    const withPath = group.filter(s => s.price_at_5s !== null);
    
    const wins = withPath.filter(s => s.pnl_estimate > 0).length;
    const persistent = withPath.filter(s => s.persistence).length;
    
    return {
      direction,
      deltaSize,
      count: group.length,
      winRate: withPath.length > 0 ? (wins / withPath.length) * 100 : 0,
      persistence: withPath.length > 0 ? (persistent / withPath.length) * 100 : 0,
      volatility: withPath.length > 0
        ? withPath.reduce((sum, s) => sum + s.max_adverse_move, 0) / withPath.length
        : 0,
    };
  });
}

// Calculate momentum confidence score
function calculateConfidence(
  bucketStats: DeltaBucketStats[],
  directionStats: DirectionStats[]
): MomentumConfidence {
  const reasons: string[] = [];
  let score = 50;
  
  const bestBucket = bucketStats.reduce((a, b) => a.winRate > b.winRate ? a : b, bucketStats[0]);
  if (bestBucket) {
    if (bestBucket.winRate >= 70) {
      score += 25;
      reasons.push(`${bestBucket.bucket} heeft ${bestBucket.winRate.toFixed(0)}% win rate - uitstekend`);
    } else if (bestBucket.winRate >= 55) {
      score += 15;
      reasons.push(`${bestBucket.bucket} heeft ${bestBucket.winRate.toFixed(0)}% win rate - goed`);
    } else if (bestBucket.winRate < 45) {
      score -= 15;
      reasons.push(`Beste bucket heeft slechts ${bestBucket.winRate.toFixed(0)}% win rate`);
    }
  }
  
  const upLarge = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'large');
  const downLarge = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'large');
  
  if (upLarge && upLarge.winRate >= 60) {
    score += 10;
    reasons.push(`UP grote delta: ${upLarge.winRate.toFixed(0)}% win rate`);
  }
  if (downLarge && downLarge.winRate < 45) {
    score -= 10;
    reasons.push(`DOWN grote delta: slechts ${downLarge.winRate.toFixed(0)}% win rate`);
  }
  
  const avgPersistence = bucketStats.length > 0 
    ? bucketStats.reduce((sum, b) => sum + b.avgPersistence, 0) / bucketStats.length
    : 0;
  if (avgPersistence >= 55) {
    score += 10;
    reasons.push(`Hoge persistence: ${avgPersistence.toFixed(0)}%`);
  } else if (avgPersistence < 45) {
    score -= 15;
    reasons.push(`Lage persistence: ${avgPersistence.toFixed(0)}% - signalen zijn fragiel`);
  }
  
  score = Math.max(0, Math.min(100, score));
  
  let label: MomentumConfidence['label'];
  if (score >= 75) label = 'AGRESSIEF';
  else if (score >= 55) label = 'NORMAAL';
  else if (score >= 35) label = 'VOORZICHTIG';
  else label = 'VERMIJDEN';
  
  return { score, label, reasons };
}

// Generate actionable recommendations
function generateRecommendations(
  bucketStats: DeltaBucketStats[],
  directionStats: DirectionStats[]
): string[] {
  const recommendations: string[] = [];
  
  const bestBucket = bucketStats.reduce((a, b) => 
    a.winRate > b.winRate && a.count >= 50 ? a : b, bucketStats[0]);
  
  if (bestBucket && bestBucket.winRate >= 60) {
    recommendations.push(
      `✅ Focus op ${bestBucket.bucket} signalen - ${bestBucket.winRate.toFixed(0)}% win rate (n=${bestBucket.count})`
    );
  }
  
  const upLarge = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'large');
  const downLarge = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'large');
  
  if (upLarge && downLarge) {
    if (upLarge.winRate > downLarge.winRate + 10) {
      recommendations.push(
        `📈 UP-signalen presteren ${(upLarge.winRate - downLarge.winRate).toFixed(0)}% beter dan DOWN bij grote delta`
      );
    }
    if (downLarge.winRate < 50) {
      recommendations.push(
        `⚠️ Overweeg DOWN-signalen met grote delta te skippen (${downLarge.winRate.toFixed(0)}% win)`
      );
    }
  }
  
  const highPersistence = bucketStats.filter(b => b.avgPersistence >= 55);
  if (highPersistence.length > 0) {
    recommendations.push(
      `🎯 ${highPersistence.map(b => b.bucket).join(', ')}: hoge persistence - counter-ticks negeren`
    );
  }
  
  const largeDelta = bucketStats.find(b => b.bucket === 'd20+' || b.bucket === 'd15-20');
  if (largeDelta && largeDelta.winRate >= 60) {
    recommendations.push(
      `🚀 Bij grote delta (${largeDelta.bucket}): agressiever kopen, dips zijn koopkansen`
    );
  }
  
  const smallDelta = bucketStats.find(b => b.bucket === 'd<10');
  if (smallDelta && smallDelta.winRate < 55) {
    recommendations.push(
      `⏸️ Kleine delta (${smallDelta.bucket}): wacht op bevestiging, signaal is fragiel`
    );
  }
  
  // Statistical significance warning
  const totalSamples = bucketStats.reduce((sum, b) => sum + b.count, 0);
  if (totalSamples < 500) {
    recommendations.push(
      `📊 Let op: n=${totalSamples} - meer data nodig voor statistische significantie`
    );
  }
  
  return recommendations;
}

// Main hook - now uses v29_ticks directly
export function useMomentumAnalysis(asset?: string) {
  return useQuery({
    queryKey: ['momentum-analysis-v2', asset],
    queryFn: async () => {
      console.log('[useMomentumAnalysis] Fetching signal ticks from v29_ticks...');
      
      // 1. Fetch all signal moments (where signal_direction is not null)
      let signalQuery = supabase
        .from('v29_ticks')
        .select('id, ts, asset, binance_price, strike_price, up_best_bid, down_best_bid, signal_direction')
        .not('signal_direction', 'is', null)
        .not('strike_price', 'eq', 0)
        .order('ts', { ascending: false })
        .limit(2000); // Get last 2000 signals
      
      if (asset && asset !== 'all') {
        signalQuery = signalQuery.eq('asset', asset);
      }
      
      const { data: signalTicks, error: signalError } = await signalQuery;
      
      if (signalError) throw signalError;
      if (!signalTicks || signalTicks.length === 0) {
        return {
          signals: [],
          bucketStats: [],
          directionStats: [],
          confidence: { score: 0, label: 'VERMIJDEN' as const, reasons: ['Geen data beschikbaar'] },
          recommendations: ['Geen data beschikbaar voor analyse'],
          totalSignals: 0,
          signalsWithPath: 0,
        };
      }
      
      console.log(`[useMomentumAnalysis] Found ${signalTicks.length} signal ticks`);
      
      // 2. For each signal, we need surrounding ticks
      // To avoid N+1 queries, we'll fetch all ticks in one go for the time range
      const minTs = Math.min(...signalTicks.map(t => t.ts)) - 10000;
      const maxTs = Math.max(...signalTicks.map(t => t.ts)) + 10000;
      
      const { data: allTicks, error: ticksError } = await supabase
        .from('v29_ticks')
        .select('ts, up_best_bid, down_best_bid, binance_price, asset')
        .gte('ts', minTs)
        .lte('ts', maxTs)
        .order('ts', { ascending: true });
      
      if (ticksError) throw ticksError;
      
      console.log(`[useMomentumAnalysis] Fetched ${allTicks?.length || 0} surrounding ticks`);
      
      // Group ticks by asset for faster lookup
      const ticksByAsset: Record<string, SurroundingTick[]> = {};
      for (const tick of (allTicks || [])) {
        if (!ticksByAsset[tick.asset]) ticksByAsset[tick.asset] = [];
        ticksByAsset[tick.asset].push(tick);
      }
      
      // 3. Reconstruct each signal
      const signals: MomentumSignal[] = [];
      for (const signalTick of signalTicks) {
        const surrounding = ticksByAsset[signalTick.asset] || [];
        // Filter to ticks within ±10s of this signal
        const relevantTicks = surrounding.filter(
          t => t.ts >= signalTick.ts - 10000 && t.ts <= signalTick.ts + 10000
        );
        
        const signal = reconstructSignal(signalTick as TickRow, relevantTicks);
        signals.push(signal);
      }
      
      const signalsWithPath = signals.filter(s => s.price_at_5s !== null);
      console.log(`[useMomentumAnalysis] Reconstructed ${signals.length} signals, ${signalsWithPath.length} with full path`);
      
      // 4. Aggregate statistics
      const bucketStats = aggregateByBucket(signals);
      const directionStats = aggregateByDirection(signals);
      const confidence = calculateConfidence(bucketStats, directionStats);
      const recommendations = generateRecommendations(bucketStats, directionStats);
      
      return {
        signals,
        bucketStats,
        directionStats,
        confidence,
        recommendations,
        totalSignals: signals.length,
        signalsWithPath: signalsWithPath.length,
      };
    },
    staleTime: 60_000,
  });
}
