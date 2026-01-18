import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface GabagoolTradeWithContext {
  id: string;
  timestamp: string;
  market_slug: string;
  outcome: string;
  price: number;
  shares: number;
  total: number;
  side: string;
}

export interface PriceBucketStats {
  bucket: string;
  upTrades: number;
  downTrades: number;
  upVolume: number;
  downVolume: number;
  avgUpPrice: number;
  avgDownPrice: number;
}

export interface HourlyPattern {
  hour: number;
  trades: number;
  volume: number;
  avgPrice: number;
  upPct: number;
}

export interface MarketTypeStats {
  type: string;
  upTrades: number;
  downTrades: number;
  upVolume: number;
  downVolume: number;
  avgUpPrice: number;
  avgDownPrice: number;
}

export interface AssetBreakdown {
  asset: string;
  upTrades: number;
  downTrades: number;
  upVolume: number;
  downVolume: number;
  avgUpPrice: number;
  avgDownPrice: number;
  combinedEntry: number;
}

export interface DailyVolume {
  date: string;
  trades: number;
  volume: number;
  avgPrice: number;
}

export interface GabagoolDeltaAnalysis {
  summary: {
    totalTrades: number;
    totalVolume: number;
    upVolume: number;
    downVolume: number;
    upShares: number;
    downShares: number;
    avgUpPrice: number;
    avgDownPrice: number;
    combinedEntry: number;
    upPct: number;
    is15mPct: number;
  };
  priceBuckets: PriceBucketStats[];
  hourlyPatterns: HourlyPattern[];
  marketTypeStats: MarketTypeStats[];
  assetBreakdown: AssetBreakdown[];
  dailyVolume: DailyVolume[];
  insights: string[];
}

export function useGabagoolDeltaAnalysis() {
  return useQuery({
    queryKey: ['gabagool-delta-analysis'],
    queryFn: async (): Promise<GabagoolDeltaAnalysis> => {
      // Fetch all gabagool trades
      const { data: trades, error } = await supabase
        .from('trades')
        .select('id, timestamp, market_slug, outcome, price, shares, total, side')
        .eq('trader_username', 'gabagool22')
        .order('timestamp', { ascending: false })
        .limit(50000); // Get recent 50k trades for analysis

      if (error) throw error;

      const allTrades = (trades || []) as GabagoolTradeWithContext[];
      
      // Basic summary
      const upTrades = allTrades.filter(t => t.outcome === 'Up');
      const downTrades = allTrades.filter(t => t.outcome === 'Down');
      
      const upVolume = upTrades.reduce((sum, t) => sum + t.total, 0);
      const downVolume = downTrades.reduce((sum, t) => sum + t.total, 0);
      const upShares = upTrades.reduce((sum, t) => sum + t.shares, 0);
      const downShares = downTrades.reduce((sum, t) => sum + t.shares, 0);
      
      const avgUpPrice = upVolume / upShares;
      const avgDownPrice = downVolume / downShares;
      const combinedEntry = avgUpPrice + avgDownPrice;

      // Count 15m markets
      const is15m = allTrades.filter(t => 
        t.market_slug.includes('15m') || t.market_slug.includes('-15-')
      ).length;

      // Price bucket analysis
      const priceBuckets: PriceBucketStats[] = [
        { bucket: '< 30¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
        { bucket: '30-40¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
        { bucket: '40-50¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
        { bucket: '50-60¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
        { bucket: '60-70¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
        { bucket: '> 70¢', upTrades: 0, downTrades: 0, upVolume: 0, downVolume: 0, avgUpPrice: 0, avgDownPrice: 0 },
      ];

      const upPriceSum = [0, 0, 0, 0, 0, 0];
      const downPriceSum = [0, 0, 0, 0, 0, 0];

      allTrades.forEach(t => {
        let idx = 5; // > 70¢
        if (t.price < 0.30) idx = 0;
        else if (t.price < 0.40) idx = 1;
        else if (t.price < 0.50) idx = 2;
        else if (t.price < 0.60) idx = 3;
        else if (t.price < 0.70) idx = 4;

        if (t.outcome === 'Up') {
          priceBuckets[idx].upTrades++;
          priceBuckets[idx].upVolume += t.total;
          upPriceSum[idx] += t.price;
        } else {
          priceBuckets[idx].downTrades++;
          priceBuckets[idx].downVolume += t.total;
          downPriceSum[idx] += t.price;
        }
      });

      // Calculate averages
      priceBuckets.forEach((b, i) => {
        b.avgUpPrice = b.upTrades > 0 ? upPriceSum[i] / b.upTrades : 0;
        b.avgDownPrice = b.downTrades > 0 ? downPriceSum[i] / b.downTrades : 0;
      });

      // Hourly patterns
      const hourlyMap = new Map<number, { trades: number; volume: number; priceSum: number; upCount: number }>();
      allTrades.forEach(t => {
        const hour = new Date(t.timestamp).getUTCHours();
        if (!hourlyMap.has(hour)) {
          hourlyMap.set(hour, { trades: 0, volume: 0, priceSum: 0, upCount: 0 });
        }
        const h = hourlyMap.get(hour)!;
        h.trades++;
        h.volume += t.total;
        h.priceSum += t.price;
        if (t.outcome === 'Up') h.upCount++;
      });

      const hourlyPatterns: HourlyPattern[] = Array.from(hourlyMap.entries())
        .map(([hour, data]) => ({
          hour,
          trades: data.trades,
          volume: data.volume,
          avgPrice: data.priceSum / data.trades,
          upPct: (data.upCount / data.trades) * 100,
        }))
        .sort((a, b) => a.hour - b.hour);

      // Market type stats (15m vs 1hr)
      const market15m = allTrades.filter(t => t.market_slug.includes('15m') || t.market_slug.includes('-15-'));
      const market1hr = allTrades.filter(t => !t.market_slug.includes('15m') && !t.market_slug.includes('-15-'));

      const calcTypeStats = (trades: GabagoolTradeWithContext[], type: string): MarketTypeStats => {
        const up = trades.filter(t => t.outcome === 'Up');
        const down = trades.filter(t => t.outcome === 'Down');
        const upVol = up.reduce((s, t) => s + t.total, 0);
        const downVol = down.reduce((s, t) => s + t.total, 0);
        const upSh = up.reduce((s, t) => s + t.shares, 0);
        const downSh = down.reduce((s, t) => s + t.shares, 0);
        return {
          type,
          upTrades: up.length,
          downTrades: down.length,
          upVolume: upVol,
          downVolume: downVol,
          avgUpPrice: upSh > 0 ? upVol / upSh : 0,
          avgDownPrice: downSh > 0 ? downVol / downSh : 0,
        };
      };

      const marketTypeStats: MarketTypeStats[] = [
        calcTypeStats(market15m, '15-minute'),
        calcTypeStats(market1hr, '1-hour'),
      ];

      // Asset breakdown
      const btcTrades = allTrades.filter(t => t.market_slug.includes('btc') || t.market_slug.includes('bitcoin'));
      const ethTrades = allTrades.filter(t => t.market_slug.includes('eth') || t.market_slug.includes('ethereum'));

      const calcAssetStats = (trades: GabagoolTradeWithContext[], asset: string): AssetBreakdown => {
        const up = trades.filter(t => t.outcome === 'Up');
        const down = trades.filter(t => t.outcome === 'Down');
        const upVol = up.reduce((s, t) => s + t.total, 0);
        const downVol = down.reduce((s, t) => s + t.total, 0);
        const upSh = up.reduce((s, t) => s + t.shares, 0);
        const downSh = down.reduce((s, t) => s + t.shares, 0);
        const avgUp = upSh > 0 ? upVol / upSh : 0;
        const avgDown = downSh > 0 ? downVol / downSh : 0;
        return {
          asset,
          upTrades: up.length,
          downTrades: down.length,
          upVolume: upVol,
          downVolume: downVol,
          avgUpPrice: avgUp,
          avgDownPrice: avgDown,
          combinedEntry: avgUp + avgDown,
        };
      };

      const assetBreakdown: AssetBreakdown[] = [
        calcAssetStats(btcTrades, 'BTC'),
        calcAssetStats(ethTrades, 'ETH'),
      ];

      // Daily volume (last 14 days)
      const dailyMap = new Map<string, { trades: number; volume: number; priceSum: number }>();
      allTrades.forEach(t => {
        const date = t.timestamp.split('T')[0];
        if (!dailyMap.has(date)) {
          dailyMap.set(date, { trades: 0, volume: 0, priceSum: 0 });
        }
        const d = dailyMap.get(date)!;
        d.trades++;
        d.volume += t.total;
        d.priceSum += t.price;
      });

      const dailyVolume: DailyVolume[] = Array.from(dailyMap.entries())
        .map(([date, data]) => ({
          date,
          trades: data.trades,
          volume: data.volume,
          avgPrice: data.priceSum / data.trades,
        }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-14);

      // Generate insights
      const insights: string[] = [];
      
      // 1. Combined entry insight
      if (combinedEntry < 0.95) {
        insights.push(`🎯 Uitstekende combined entry: ${(combinedEntry * 100).toFixed(1)}¢ - gegarandeerde ~${((1 - combinedEntry) * 100).toFixed(1)}% winst per markt`);
      } else if (combinedEntry < 1.0) {
        insights.push(`⚡ Combined entry: ${(combinedEntry * 100).toFixed(1)}¢ - kleine marge voor winst, afhankelijk van shares balans`);
      } else {
        insights.push(`⚠️ Combined entry boven $1: ${(combinedEntry * 100).toFixed(1)}¢ - alleen winstgevend als shares niet 1:1 zijn`);
      }

      // 2. 15m vs 1hr preference
      const pct15m = (is15m / allTrades.length) * 100;
      if (pct15m > 70) {
        insights.push(`⏱️ Sterke voorkeur voor 15-minute markten (${pct15m.toFixed(0)}%) - snelle turnaround strategie`);
      } else if (pct15m > 50) {
        insights.push(`⏱️ Lichte voorkeur voor 15-minute markten (${pct15m.toFixed(0)}%)`);
      } else {
        insights.push(`⏱️ Focus op 1-hour markten (${(100 - pct15m).toFixed(0)}%) - langere tijdsframes`);
      }

      // 3. BTC vs ETH
      const btcVol = assetBreakdown[0].upVolume + assetBreakdown[0].downVolume;
      const ethVol = assetBreakdown[1].upVolume + assetBreakdown[1].downVolume;
      const btcPct = (btcVol / (btcVol + ethVol)) * 100;
      insights.push(`📊 Asset verdeling: ${btcPct.toFixed(0)}% BTC / ${(100 - btcPct).toFixed(0)}% ETH`);

      // 4. Price zone insight
      const cheapTrades = priceBuckets[0].upTrades + priceBuckets[0].downTrades;
      const expensiveTrades = priceBuckets[5].upTrades + priceBuckets[5].downTrades;
      const cheapPct = (cheapTrades / allTrades.length) * 100;
      const expPct = (expensiveTrades / allTrades.length) * 100;
      
      if (cheapPct > 20) {
        insights.push(`💰 "Cheap hunting": ${cheapPct.toFixed(0)}% van trades bij < 30¢ - zoekt naar goedkope hedges`);
      }
      if (expPct > 30) {
        insights.push(`💎 "Premium plays": ${expPct.toFixed(0)}% van trades bij > 70¢ - koopt "zekere" winnaars`);
      }

      // 5. Hedging balance
      const upPctOverall = (upTrades.length / allTrades.length) * 100;
      if (Math.abs(upPctOverall - 50) < 2) {
        insights.push(`⚖️ Perfect gebalanceerd: ${upPctOverall.toFixed(1)}% Up / ${(100 - upPctOverall).toFixed(1)}% Down trades`);
      } else if (upPctOverall > 52) {
        insights.push(`📈 Bullish bias: ${upPctOverall.toFixed(1)}% Up trades - verwacht vaker stijging`);
      } else {
        insights.push(`📉 Bearish bias: ${(100 - upPctOverall).toFixed(1)}% Down trades - verwacht vaker daling`);
      }

      // 6. Active hours
      const peakHour = hourlyPatterns.reduce((max, h) => h.volume > max.volume ? h : max, hourlyPatterns[0]);
      insights.push(`🕐 Meest actief: ${peakHour.hour}:00 UTC ($${(peakHour.volume / 1000).toFixed(0)}K volume)`);

      return {
        summary: {
          totalTrades: allTrades.length,
          totalVolume: upVolume + downVolume,
          upVolume,
          downVolume,
          upShares,
          downShares,
          avgUpPrice,
          avgDownPrice,
          combinedEntry,
          upPct: upPctOverall,
          is15mPct: pct15m,
        },
        priceBuckets,
        hourlyPatterns,
        marketTypeStats,
        assetBreakdown,
        dailyVolume,
        insights,
      };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
