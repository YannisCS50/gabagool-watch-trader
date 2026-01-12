import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PriceTick {
  source: 'binance_ws' | 'polymarket_rtds' | 'chainlink_rtds' | 'clob_shares';
  asset: string;
  price: number;
  raw_timestamp: number;
  outcome?: string;
}

export interface SyncedPricePoint {
  timestamp: number;
  binance: number | null;
  polymarket: number | null;
  chainlink: number | null;
  upShare: number | null;
  downShare: number | null;
  // Calculated fields
  binanceDelta: number | null; // Change from previous tick
  polymarketDelta: number | null;
  chainlinkDelta: number | null;
  upShareDelta: number | null;
  downShareDelta: number | null;
  // Spread between sources
  binanceVsChainlink: number | null;
  polymarketVsBinance: number | null;
}

export interface LatencyStats {
  avgBinanceLeadMs: number;
  maxBinanceLeadMs: number;
  priceCorrelation: number;
  binanceTickCount: number;
  polymarketTickCount: number;
  chainlinkTickCount: number;
  upShareTickCount: number;
  downShareTickCount: number;
}

export function usePriceLatencyAnalysis(
  asset: string,
  startTimestamp: number,
  endTimestamp: number
) {
  const [data, setData] = useState<SyncedPricePoint[]>([]);
  const [stats, setStats] = useState<LatencyStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!asset || !startTimestamp || !endTimestamp) return;
    
    setLoading(true);
    setError(null);

    try {
      // Fetch all ticks in the time range
      const { data: ticks, error: fetchError } = await supabase
        .from('realtime_price_logs')
        .select('source, asset, price, raw_timestamp, outcome')
        .eq('asset', asset)
        .gte('raw_timestamp', startTimestamp)
        .lte('raw_timestamp', endTimestamp)
        .order('raw_timestamp', { ascending: true })
        .limit(5000);

      if (fetchError) throw fetchError;
      if (!ticks || ticks.length === 0) {
        setData([]);
        setStats(null);
        setLoading(false);
        return;
      }

      // Group ticks by second for synchronized view
      const ticksBySecond = new Map<number, {
        binance: number[];
        polymarket: number[];
        chainlink: number[];
        upShare: number[];
        downShare: number[];
      }>();

      let binanceCount = 0, polymarketCount = 0, chainlinkCount = 0;
      let upShareCount = 0, downShareCount = 0;

      for (const tick of ticks) {
        const second = Math.floor(tick.raw_timestamp / 1000) * 1000;
        
        if (!ticksBySecond.has(second)) {
          ticksBySecond.set(second, {
            binance: [],
            polymarket: [],
            chainlink: [],
            upShare: [],
            downShare: [],
          });
        }
        
        const bucket = ticksBySecond.get(second)!;
        
        switch (tick.source) {
          case 'binance_ws':
            bucket.binance.push(tick.price);
            binanceCount++;
            break;
          case 'polymarket_rtds':
            bucket.polymarket.push(tick.price);
            polymarketCount++;
            break;
          case 'chainlink_rtds':
            bucket.chainlink.push(tick.price);
            chainlinkCount++;
            break;
          case 'clob_shares':
            if (tick.outcome === 'up') {
              bucket.upShare.push(tick.price);
              upShareCount++;
            } else if (tick.outcome === 'down') {
              bucket.downShare.push(tick.price);
              downShareCount++;
            }
            break;
        }
      }

      // Convert to synchronized points
      const sortedSeconds = Array.from(ticksBySecond.keys()).sort((a, b) => a - b);
      const syncedPoints: SyncedPricePoint[] = [];
      
      let prevBinance: number | null = null;
      let prevPolymarket: number | null = null;
      let prevChainlink: number | null = null;
      let prevUpShare: number | null = null;
      let prevDownShare: number | null = null;

      for (const second of sortedSeconds) {
        const bucket = ticksBySecond.get(second)!;
        
        const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
        
        const binance = avg(bucket.binance);
        const polymarket = avg(bucket.polymarket);
        const chainlink = avg(bucket.chainlink);
        const upShare = avg(bucket.upShare);
        const downShare = avg(bucket.downShare);

        const point: SyncedPricePoint = {
          timestamp: second,
          binance,
          polymarket,
          chainlink,
          upShare,
          downShare,
          binanceDelta: binance !== null && prevBinance !== null ? binance - prevBinance : null,
          polymarketDelta: polymarket !== null && prevPolymarket !== null ? polymarket - prevPolymarket : null,
          chainlinkDelta: chainlink !== null && prevChainlink !== null ? chainlink - prevChainlink : null,
          upShareDelta: upShare !== null && prevUpShare !== null ? upShare - prevUpShare : null,
          downShareDelta: downShare !== null && prevDownShare !== null ? downShare - prevDownShare : null,
          binanceVsChainlink: binance !== null && chainlink !== null ? binance - chainlink : null,
          polymarketVsBinance: polymarket !== null && binance !== null ? polymarket - binance : null,
        };

        syncedPoints.push(point);

        if (binance !== null) prevBinance = binance;
        if (polymarket !== null) prevPolymarket = polymarket;
        if (chainlink !== null) prevChainlink = chainlink;
        if (upShare !== null) prevUpShare = upShare;
        if (downShare !== null) prevDownShare = downShare;
      }

      setData(syncedPoints);

      // Calculate stats
      const binanceLeads: number[] = [];
      for (let i = 1; i < syncedPoints.length; i++) {
        const curr = syncedPoints[i];
        const prev = syncedPoints[i - 1];
        
        // If Binance moved and Polymarket follows, calculate lead time
        if (curr.binanceDelta !== null && Math.abs(curr.binanceDelta) > 1) {
          // Look ahead for matching Polymarket move
          for (let j = i; j < Math.min(i + 10, syncedPoints.length); j++) {
            const future = syncedPoints[j];
            if (future.polymarketDelta !== null && Math.abs(future.polymarketDelta) > 0.5) {
              binanceLeads.push(future.timestamp - curr.timestamp);
              break;
            }
          }
        }
      }

      setStats({
        avgBinanceLeadMs: binanceLeads.length > 0 
          ? binanceLeads.reduce((a, b) => a + b, 0) / binanceLeads.length 
          : 0,
        maxBinanceLeadMs: binanceLeads.length > 0 ? Math.max(...binanceLeads) : 0,
        priceCorrelation: 0, // TODO: calculate correlation
        binanceTickCount: binanceCount,
        polymarketTickCount: polymarketCount,
        chainlinkTickCount: chainlinkCount,
        upShareTickCount: upShareCount,
        downShareTickCount: downShareCount,
      });

    } catch (err) {
      console.error('Error fetching latency data:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [asset, startTimestamp, endTimestamp]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, stats, loading, error, refetch: fetchData };
}
