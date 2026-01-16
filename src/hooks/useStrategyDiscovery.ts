import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ============ DATA TYPES ============
export interface TickSnapshot {
  ts: number;
  binancePrice: number;
  chainlinkPrice: number;
  strikePrice: number;
  upBid: number;
  downBid: number;
  marketEndTs: number;
  asset: string;
}

export interface OpportunityWindow {
  startTs: number;
  endTs: number;
  asset: string;
  marketSlug: string;
  ticks: TickSnapshot[];
  outcome: 'UP' | 'DOWN';
  
  // Computed metrics
  avgSharePrice: number;
  avgDelayMs: number;
  avgDeltaToStrike: number;
  timeRemainingAtStart: number;
  counterTickCount: number;
  maxAdverseMove: number;
  volatility: number;
  
  // Path analysis
  pricePath: number[];
  deltaPath: number[];
  
  // Would-be result
  entryPrice: number;
  finalPrice: number;
  theoreticalPnl: number;
}

export interface StrategyBucket {
  // Bucketing dimensions
  sharePriceBucket: string;    // e.g., "0.40-0.50"
  deltaBucket: string;          // e.g., "+$20-40"
  timeRemainingBucket: string;  // e.g., "5-10min"
  volatilityBucket: string;     // e.g., "low", "medium", "high"
  
  // Statistics
  sampleCount: number;
  winRate: number;
  avgPnl: number;
  avgCounterTicks: number;
  avgMaxAdverse: number;
  
  // Significance
  zScore: number;
  isSignificant: boolean;
  
  // Opportunity windows in this bucket
  windows: OpportunityWindow[];
}

export interface DelayStats {
  asset: string;
  avgDelayMs: number;
  medianDelayMs: number;
  p95DelayMs: number;
  sampleCount: number;
}

export interface StrategyDiscoveryResult {
  buckets: StrategyBucket[];
  delayStats: DelayStats[];
  bestOpportunities: StrategyBucket[];
  worstOpportunities: StrategyBucket[];
  recommendations: string[];
  totalWindows: number;
  overallWinRate: number;
}

// ============ BUCKETING FUNCTIONS ============
function getSharePriceBucket(price: number): string {
  if (price < 0.20) return '< 0.20';
  if (price < 0.30) return '0.20-0.30';
  if (price < 0.40) return '0.30-0.40';
  if (price < 0.50) return '0.40-0.50';
  if (price < 0.60) return '0.50-0.60';
  if (price < 0.70) return '0.60-0.70';
  if (price < 0.80) return '0.70-0.80';
  return '> 0.80';
}

function getDeltaBucket(delta: number): string {
  const absDelta = Math.abs(delta);
  const sign = delta >= 0 ? '+' : '-';
  if (absDelta < 10) return `${sign}$0-10`;
  if (absDelta < 25) return `${sign}$10-25`;
  if (absDelta < 50) return `${sign}$25-50`;
  if (absDelta < 100) return `${sign}$50-100`;
  return `${sign}$100+`;
}

function getTimeRemainingBucket(seconds: number): string {
  if (seconds < 60) return '< 1min';
  if (seconds < 180) return '1-3min';
  if (seconds < 300) return '3-5min';
  if (seconds < 600) return '5-10min';
  if (seconds < 900) return '10-15min';
  return '> 15min';
}

function getVolatilityBucket(volatility: number): string {
  if (volatility < 0.02) return 'low';
  if (volatility < 0.05) return 'medium';
  return 'high';
}

// ============ DELAY CALCULATION ============
// Delay = how long until Polymarket reflects Binance move
function calculateDelay(ticks: TickSnapshot[]): number {
  if (ticks.length < 10) return 0;
  
  let totalDelay = 0;
  let delayCount = 0;
  
  for (let i = 5; i < ticks.length; i++) {
    const currentBinance = ticks[i].binancePrice;
    const prevBinance = ticks[i - 5].binancePrice;
    const binanceMove = currentBinance - prevBinance;
    
    if (Math.abs(binanceMove) < 5) continue; // Ignore tiny moves
    
    // When did Polymarket catch up?
    const expectedDirection = binanceMove > 0 ? 'up' : 'down';
    const priceToWatch = expectedDirection === 'up' ? 'upBid' : 'downBid';
    
    const startPolyPrice = ticks[i - 5][priceToWatch];
    
    for (let j = i; j < Math.min(i + 20, ticks.length); j++) {
      const polyChange = ticks[j][priceToWatch] - startPolyPrice;
      // Did Poly move in same direction?
      if ((expectedDirection === 'up' && polyChange > 0.02) ||
          (expectedDirection === 'down' && polyChange > 0.02)) {
        totalDelay += ticks[j].ts - ticks[i].ts;
        delayCount++;
        break;
      }
    }
  }
  
  return delayCount > 0 ? totalDelay / delayCount : 0;
}

// ============ COUNTER-TICK ANALYSIS ============
function countCounterTicks(ticks: TickSnapshot[], direction: 'UP' | 'DOWN'): number {
  if (ticks.length < 3) return 0;
  
  let counterTicks = 0;
  const priceKey = direction === 'UP' ? 'upBid' : 'downBid';
  
  for (let i = 2; i < ticks.length; i++) {
    const prevMove = ticks[i - 1][priceKey] - ticks[i - 2][priceKey];
    const currMove = ticks[i][priceKey] - ticks[i - 1][priceKey];
    
    // A counter-tick is when price reverses direction
    if ((direction === 'UP' && prevMove > 0 && currMove < -0.01) ||
        (direction === 'DOWN' && prevMove > 0 && currMove < -0.01)) {
      counterTicks++;
    }
  }
  
  return counterTicks;
}

// ============ VOLATILITY CALCULATION ============
function calculateVolatility(ticks: TickSnapshot[], direction: 'UP' | 'DOWN'): number {
  if (ticks.length < 5) return 0;
  
  const priceKey = direction === 'UP' ? 'upBid' : 'downBid';
  const prices = ticks.map(t => t[priceKey]).filter(p => p > 0);
  
  if (prices.length < 5) return 0;
  
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
  
  return Math.sqrt(variance);
}

// ============ MARKET END TIMESTAMP FROM SLUG ============
function getMarketEndTs(slug: string): number {
  const parts = slug.split('-');
  const epochStr = parts[parts.length - 1];
  return parseInt(epochStr, 10) * 1000;
}

// ============ MAIN HOOK ============
export function useStrategyDiscovery(asset: string = 'BTC', hoursBack: number = 24) {
  return useQuery({
    queryKey: ['strategy-discovery', asset, hoursBack],
    queryFn: async (): Promise<StrategyDiscoveryResult> => {
      // We want COMPLETED markets, so fetch older data, not the most recent
      // hoursBack now means "go back X hours from now and find completed markets in that range"
      const currentTime = Date.now();
      const startTs = currentTime - (hoursBack * 60 * 60 * 1000);
      // Only get markets that ended at least 15 minutes ago (to ensure they're settled)
      const maxEndTs = currentTime - (15 * 60 * 1000);
      
      // Fetch ticks - we'll filter completed markets in code
      const { data: ticks, error } = await supabase
        .from('v29_ticks')
        .select('ts, binance_price, chainlink_price, strike_price, up_best_bid, down_best_bid, market_slug, asset')
        .eq('asset', asset)
        .gte('ts', startTs)
        .lte('ts', maxEndTs)
        .not('binance_price', 'is', null)
        .not('strike_price', 'is', null)
        .order('ts', { ascending: true })
        .limit(100000);
      
      if (error) throw error;
      
      console.log('[StrategyDiscovery] Fetched ticks:', ticks?.length || 0);
      
      if (!ticks || ticks.length === 0) {
        return {
          buckets: [],
          delayStats: [],
          bestOpportunities: [],
          worstOpportunities: [],
          recommendations: ['Geen data beschikbaar voor analyse'],
          totalWindows: 0,
          overallWinRate: 0,
        };
      }
      
      // Convert to typed snapshots and group by market
      const marketGroups = new Map<string, TickSnapshot[]>();
      
      for (const tick of ticks) {
        if (!tick.market_slug) continue;
        
        const snapshot: TickSnapshot = {
          ts: Number(tick.ts),
          binancePrice: Number(tick.binance_price),
          chainlinkPrice: Number(tick.chainlink_price),
          strikePrice: Number(tick.strike_price),
          upBid: Number(tick.up_best_bid) || 0,
          downBid: Number(tick.down_best_bid) || 0,
          marketEndTs: getMarketEndTs(tick.market_slug),
          asset: tick.asset,
        };
        
        if (!marketGroups.has(tick.market_slug)) {
          marketGroups.set(tick.market_slug, []);
        }
        marketGroups.get(tick.market_slug)!.push(snapshot);
      }
      
      console.log('[StrategyDiscovery] Market groups:', marketGroups.size);
      
      // Analyze each market window
      const opportunityWindows: OpportunityWindow[] = [];
      const now = Date.now();
      
      // Debug: count skipped markets
      let skippedTooFewTicks = 0;
      let skippedNotEnded = 0;
      
      for (const [slug, marketTicks] of marketGroups) {
        if (marketTicks.length < 20) {
          skippedTooFewTicks++;
          continue;
        }
        
        const sortedTicks = marketTicks.sort((a, b) => a.ts - b.ts);
        const firstTick = sortedTicks[0];
        const lastTick = sortedTicks[sortedTicks.length - 1];
        const marketEndTs = firstTick.marketEndTs;
        
        // Only analyze COMPLETED markets (market end time has passed)
        if (now < marketEndTs) {
          skippedNotEnded++;
          continue;
        }
        
        // Determine outcome based on final price vs strike at market end
        // Find the tick closest to market end
        const ticksNearEnd = sortedTicks.filter(t => t.ts >= marketEndTs - 60000);
        const endTick = ticksNearEnd.length > 0 ? ticksNearEnd[ticksNearEnd.length - 1] : lastTick;
        
        const finalBinance = endTick.binancePrice;
        const strike = firstTick.strikePrice;
        const outcome: 'UP' | 'DOWN' = finalBinance >= strike ? 'UP' : 'DOWN';
        
        // Calculate all metrics
        const upBids = sortedTicks.map(t => t.upBid).filter(b => b > 0);
        const downBids = sortedTicks.map(t => t.downBid).filter(b => b > 0);
        const avgUpBid = upBids.length > 0 ? upBids.reduce((a, b) => a + b, 0) / upBids.length : 0;
        const avgDownBid = downBids.length > 0 ? downBids.reduce((a, b) => a + b, 0) / downBids.length : 0;
        
        const avgSharePrice = (avgUpBid + avgDownBid) / 2;
        const avgDelayMs = calculateDelay(sortedTicks);
        
        // Delta = binance - strike (positive = price above strike)
        const avgDelta = sortedTicks.reduce((sum, t) => sum + (t.binancePrice - t.strikePrice), 0) / sortedTicks.length;
        
        const timeRemainingAtStart = (firstTick.marketEndTs - firstTick.ts) / 1000;
        
        // Analyze for UP side
        const counterTicksUp = countCounterTicks(sortedTicks, 'UP');
        const volatilityUp = calculateVolatility(sortedTicks, 'UP');
        
        // Max adverse move (how much did price drop against us)
        let maxAdverse = 0;
        const entryUpBid = sortedTicks[0].upBid;
        for (const tick of sortedTicks) {
          const drop = entryUpBid - tick.upBid;
          if (drop > maxAdverse) maxAdverse = drop;
        }
        
        // Price path for visualization
        const pricePath = sortedTicks.map(t => t.upBid).filter(p => p > 0);
        const deltaPath = sortedTicks.map(t => t.binancePrice - t.strikePrice);
        
        // Theoretical PnL if we bought UP at start
        const entryPrice = sortedTicks[0].upBid || 0.5;
        const finalUpPrice = outcome === 'UP' ? 1.0 : 0.0;
        const theoreticalPnl = finalUpPrice - entryPrice;
        
        opportunityWindows.push({
          startTs: firstTick.ts,
          endTs: lastTick.ts,
          asset: firstTick.asset,
          marketSlug: slug,
          ticks: sortedTicks,
          outcome,
          avgSharePrice,
          avgDelayMs,
          avgDeltaToStrike: avgDelta,
          timeRemainingAtStart,
          counterTickCount: counterTicksUp,
          maxAdverseMove: maxAdverse,
          volatility: volatilityUp,
          pricePath,
          deltaPath,
          entryPrice,
          finalPrice: finalUpPrice,
          theoreticalPnl,
        });
      }
      
      console.log('[StrategyDiscovery] Analysis results:', {
        skippedTooFewTicks,
        skippedNotEnded,
        analyzedWindows: opportunityWindows.length,
      });
      
      // Bucket the opportunities
      const bucketMap = new Map<string, StrategyBucket>();
      
      for (const window of opportunityWindows) {
        const sharePriceBucket = getSharePriceBucket(window.avgSharePrice);
        const deltaBucket = getDeltaBucket(window.avgDeltaToStrike);
        const timeBucket = getTimeRemainingBucket(window.timeRemainingAtStart);
        const volBucket = getVolatilityBucket(window.volatility);
        
        const key = `${sharePriceBucket}|${deltaBucket}|${timeBucket}|${volBucket}`;
        
        if (!bucketMap.has(key)) {
          bucketMap.set(key, {
            sharePriceBucket,
            deltaBucket,
            timeRemainingBucket: timeBucket,
            volatilityBucket: volBucket,
            sampleCount: 0,
            winRate: 0,
            avgPnl: 0,
            avgCounterTicks: 0,
            avgMaxAdverse: 0,
            zScore: 0,
            isSignificant: false,
            windows: [],
          });
        }
        
        bucketMap.get(key)!.windows.push(window);
      }
      
      // Calculate statistics for each bucket
      const buckets: StrategyBucket[] = [];
      
      for (const [, bucket] of bucketMap) {
        const n = bucket.windows.length;
        if (n < 3) continue; // Need minimum samples
        
        const wins = bucket.windows.filter(w => w.theoreticalPnl > 0).length;
        bucket.sampleCount = n;
        bucket.winRate = (wins / n) * 100;
        bucket.avgPnl = bucket.windows.reduce((s, w) => s + w.theoreticalPnl, 0) / n;
        bucket.avgCounterTicks = bucket.windows.reduce((s, w) => s + w.counterTickCount, 0) / n;
        bucket.avgMaxAdverse = bucket.windows.reduce((s, w) => s + w.maxAdverseMove, 0) / n;
        
        // Z-score for significance (vs 50% baseline)
        const p = wins / n;
        const se = Math.sqrt(0.5 * 0.5 / n);
        bucket.zScore = (p - 0.5) / se;
        bucket.isSignificant = Math.abs(bucket.zScore) >= 1.96 && n >= 10;
        
        buckets.push(bucket);
      }
      
      // Sort by significance and win rate
      buckets.sort((a, b) => {
        if (a.isSignificant !== b.isSignificant) return a.isSignificant ? -1 : 1;
        return b.winRate - a.winRate;
      });
      
      // Delay stats
      const delayStats: DelayStats[] = [{
        asset,
        avgDelayMs: opportunityWindows.reduce((s, w) => s + w.avgDelayMs, 0) / opportunityWindows.length || 0,
        medianDelayMs: 0,
        p95DelayMs: 0,
        sampleCount: opportunityWindows.length,
      }];
      
      // Best and worst
      const significantBuckets = buckets.filter(b => b.isSignificant);
      const bestOpportunities = significantBuckets.filter(b => b.winRate > 55).slice(0, 5);
      const worstOpportunities = significantBuckets.filter(b => b.winRate < 45).slice(-5).reverse();
      
      // Generate recommendations
      const recommendations: string[] = [];
      
      if (bestOpportunities.length > 0) {
        const best = bestOpportunities[0];
        recommendations.push(
          `🎯 Beste kans: ${best.sharePriceBucket} shares, ${best.deltaBucket} delta, ${best.timeRemainingBucket} remaining → ${best.winRate.toFixed(0)}% win rate (n=${best.sampleCount})`
        );
      }
      
      if (worstOpportunities.length > 0) {
        const worst = worstOpportunities[0];
        recommendations.push(
          `⚠️ Vermijd: ${worst.sharePriceBucket} shares, ${worst.deltaBucket} delta → slechts ${worst.winRate.toFixed(0)}% win rate`
        );
      }
      
      const avgCounterTicks = buckets.reduce((s, b) => s + b.avgCounterTicks, 0) / buckets.length || 0;
      if (avgCounterTicks > 5) {
        recommendations.push(`📊 Hoge counter-tick activiteit (${avgCounterTicks.toFixed(1)} gemiddeld) - markt is gevoelig voor reversals`);
      }
      
      const overallWinRate = opportunityWindows.length > 0
        ? (opportunityWindows.filter(w => w.theoreticalPnl > 0).length / opportunityWindows.length) * 100
        : 0;
      
      return {
        buckets,
        delayStats,
        bestOpportunities,
        worstOpportunities,
        recommendations,
        totalWindows: opportunityWindows.length,
        overallWinRate,
      };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });
}
