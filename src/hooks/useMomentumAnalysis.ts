import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Types for momentum analysis
export interface MomentumSignal {
  id: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  binance_price: number;
  strike_price: number;
  delta: number; // Calculated: binance_price - strike_price
  delta_bucket: string;
  share_price_t0: number;
  price_at_1s: number | null;
  price_at_2s: number | null;
  price_at_3s: number | null;
  price_at_5s: number | null;
  net_pnl: number | null;
  signal_ts: number;
  exit_ts: number | null;
  // Derived metrics
  price_path: number[];
  persistence: boolean; // Did price move in our direction?
  reversal_count: number; // How many times did price reverse?
  max_adverse_move: number; // Biggest move against us
  final_move: number; // Final price - entry price
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
  score: number; // 0-100
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

// Analyze a single signal's price path
function analyzeSignal(raw: any): MomentumSignal {
  const binancePrice = Number(raw.binance_price) || 0;
  const strikePrice = Number(raw.strike_price) || 0;
  const delta = binancePrice - strikePrice;
  
  const t0 = Number(raw.share_price_t0) || 0;
  const p1 = raw.price_at_1s !== null ? Number(raw.price_at_1s) : null;
  const p2 = raw.price_at_2s !== null ? Number(raw.price_at_2s) : null;
  const p3 = raw.price_at_3s !== null ? Number(raw.price_at_3s) : null;
  const p5 = raw.price_at_5s !== null ? Number(raw.price_at_5s) : null;
  
  // Build price path (only non-null values)
  const pricePath = [t0];
  if (p1 !== null) pricePath.push(p1);
  if (p2 !== null) pricePath.push(p2);
  if (p3 !== null) pricePath.push(p3);
  if (p5 !== null) pricePath.push(p5);
  
  const direction = raw.direction as 'UP' | 'DOWN';
  const finalPrice = pricePath[pricePath.length - 1];
  const finalMove = finalPrice - t0;
  
  // Persistence: did price move in our direction?
  const persistence = direction === 'UP' 
    ? finalMove >= 0 
    : finalMove <= 0;
  
  // Count reversals (direction changes in path)
  let reversalCount = 0;
  for (let i = 2; i < pricePath.length; i++) {
    const prevMove = pricePath[i-1] - pricePath[i-2];
    const currMove = pricePath[i] - pricePath[i-1];
    if ((prevMove > 0 && currMove < 0) || (prevMove < 0 && currMove > 0)) {
      reversalCount++;
    }
  }
  
  // Max adverse move
  let maxAdverse = 0;
  for (let i = 1; i < pricePath.length; i++) {
    const move = pricePath[i] - t0;
    const isAdverse = direction === 'UP' ? move < 0 : move > 0;
    if (isAdverse) {
      maxAdverse = Math.max(maxAdverse, Math.abs(move));
    }
  }
  
  return {
    id: raw.id,
    asset: raw.asset || 'BTC',
    direction,
    binance_price: binancePrice,
    strike_price: strikePrice,
    delta,
    delta_bucket: getDeltaBucket(delta),
    share_price_t0: t0,
    price_at_1s: p1,
    price_at_2s: p2,
    price_at_3s: p3,
    price_at_5s: p5,
    net_pnl: raw.net_pnl !== null ? Number(raw.net_pnl) : null,
    signal_ts: Number(raw.signal_ts) || 0,
    exit_ts: raw.exit_ts ? Number(raw.exit_ts) : null,
    price_path: pricePath,
    persistence,
    reversal_count: reversalCount,
    max_adverse_move: maxAdverse,
    final_move: finalMove,
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
    const withPnl = group.filter(s => s.net_pnl !== null);
    const withPath = group.filter(s => s.price_at_5s !== null);
    
    const wins = withPnl.filter(s => s.net_pnl! > 0).length;
    const favorable = withPath.filter(s => s.persistence).length;
    
    return {
      bucket,
      count: group.length,
      winRate: withPnl.length > 0 ? (wins / withPnl.length) * 100 : 0,
      avgPnl: withPnl.length > 0 
        ? withPnl.reduce((sum, s) => sum + s.net_pnl!, 0) / withPnl.length 
        : 0,
      avgPersistence: withPath.length > 0 
        ? (favorable / withPath.length) * 100 
        : 0,
      avgMove1s: withPath.length > 0
        ? withPath.reduce((sum, s) => sum + (s.price_at_1s! - s.share_price_t0), 0) / withPath.length
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
    const withPnl = group.filter(s => s.net_pnl !== null);
    const withPath = group.filter(s => s.price_at_5s !== null);
    
    const wins = withPnl.filter(s => s.net_pnl! > 0).length;
    const persistent = withPath.filter(s => s.persistence).length;
    
    return {
      direction,
      deltaSize,
      count: group.length,
      winRate: withPnl.length > 0 ? (wins / withPnl.length) * 100 : 0,
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
  let score = 50; // Start neutral
  
  // Find best bucket
  const bestBucket = bucketStats.reduce((a, b) => a.winRate > b.winRate ? a : b, bucketStats[0]);
  if (bestBucket) {
    if (bestBucket.winRate >= 80) {
      score += 25;
      reasons.push(`${bestBucket.bucket} heeft ${bestBucket.winRate.toFixed(0)}% win rate - uitstekend`);
    } else if (bestBucket.winRate >= 65) {
      score += 15;
      reasons.push(`${bestBucket.bucket} heeft ${bestBucket.winRate.toFixed(0)}% win rate - goed`);
    }
  }
  
  // Check direction asymmetry
  const upLarge = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'large');
  const downLarge = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'large');
  
  if (upLarge && upLarge.winRate >= 70) {
    score += 10;
    reasons.push(`UP-signalen met grote delta: ${upLarge.winRate.toFixed(0)}% win rate`);
  }
  if (downLarge && downLarge.winRate < 40) {
    score -= 10;
    reasons.push(`DOWN-signalen met grote delta: slechts ${downLarge.winRate.toFixed(0)}% win rate`);
  }
  
  // Persistence bonus
  const avgPersistence = bucketStats.reduce((sum, b) => sum + b.avgPersistence, 0) / bucketStats.length;
  if (avgPersistence >= 60) {
    score += 10;
    reasons.push(`Hoge persistence: ${avgPersistence.toFixed(0)}% van trades beweegt in goede richting`);
  } else if (avgPersistence < 40) {
    score -= 15;
    reasons.push(`Lage persistence: ${avgPersistence.toFixed(0)}% - signalen zijn fragiel`);
  }
  
  // Clamp score
  score = Math.max(0, Math.min(100, score));
  
  // Determine label
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
  
  // Find best performing bucket
  const bestBucket = bucketStats.reduce((a, b) => 
    a.winRate > b.winRate && a.count >= 5 ? a : b, bucketStats[0]);
  
  if (bestBucket && bestBucket.winRate >= 70) {
    recommendations.push(
      `✅ Focus op ${bestBucket.bucket} signalen - ${bestBucket.winRate.toFixed(0)}% win rate`
    );
  }
  
  // Check UP vs DOWN
  const upLarge = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'large');
  const downLarge = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'large');
  
  if (upLarge && downLarge) {
    if (upLarge.winRate > downLarge.winRate + 20) {
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
  
  // Persistence advice
  const highPersistence = bucketStats.filter(b => b.avgPersistence >= 60);
  if (highPersistence.length > 0) {
    recommendations.push(
      `🎯 ${highPersistence.map(b => b.bucket).join(', ')}: hoge persistence - counter-ticks negeren`
    );
  }
  
  // Aggression advice
  const largeDelta = bucketStats.find(b => b.bucket === 'd20+' || b.bucket === 'd15-20');
  if (largeDelta && largeDelta.winRate >= 75) {
    recommendations.push(
      `🚀 Bij grote delta (${largeDelta.bucket}): agressiever kopen, dips zijn koopkansen`
    );
  }
  
  // Small delta warning
  const smallDelta = bucketStats.find(b => b.bucket === 'd<10');
  if (smallDelta && smallDelta.winRate < 60) {
    recommendations.push(
      `⏸️ Kleine delta (${smallDelta.bucket}): wacht op bevestiging, signaal is fragiel`
    );
  }
  
  return recommendations;
}

// Main hook
export function useMomentumAnalysis(asset?: string) {
  return useQuery({
    queryKey: ['momentum-analysis', asset],
    queryFn: async () => {
      // Fetch raw signals with price path data
      let query = supabase
        .from('v29_signals_response')
        .select('*')
        .not('share_price_t0', 'is', null)
        .order('created_at', { ascending: false });
      
      if (asset && asset !== 'all') {
        query = query.eq('asset', asset);
      }
      
      const { data, error } = await query;
      
      if (error) throw error;
      if (!data || data.length === 0) {
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
      
      // Analyze all signals
      const signals = data.map(analyzeSignal);
      const signalsWithPath = signals.filter(s => s.price_at_5s !== null);
      
      // Aggregate statistics
      const bucketStats = aggregateByBucket(signals);
      const directionStats = aggregateByDirection(signals);
      
      // Calculate confidence
      const confidence = calculateConfidence(bucketStats, directionStats);
      
      // Generate recommendations
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
    staleTime: 60_000, // 1 minute
  });
}
