import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface BetSummary {
  market_id: string;
  asset: string;
  window_start: number;
  window_end: number;
  strike_price: number | null;
  up_shares: number;
  down_shares: number;
  up_avg_price: number | null;
  down_avg_price: number | null;
  total_cost: number;
  result: string | null;
  pnl: number | null;
  fill_count: number;
}

export interface PricePoint {
  ts: number;
  price: number;
  asset: string;
}

export function useBetsHistory() {
  // Fetch aggregated bet data from fill_logs
  const { data: bets, isLoading: betsLoading, error: betsError, refetch } = useQuery({
    queryKey: ['bets-history'],
    queryFn: async () => {
      // Get unique markets from fill_logs
      const { data: fills, error } = await supabase
        .from('fill_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(500);

      if (error) throw error;

      // Group fills by market_id
      const marketMap = new Map<string, {
        market_id: string;
        asset: string;
        fills: typeof fills;
        min_ts: number;
        max_ts: number;
      }>();

      for (const fill of fills || []) {
        const existing = marketMap.get(fill.market_id);
        if (existing) {
          existing.fills.push(fill);
          existing.min_ts = Math.min(existing.min_ts, fill.ts);
          existing.max_ts = Math.max(existing.max_ts, fill.ts);
        } else {
          marketMap.set(fill.market_id, {
            market_id: fill.market_id,
            asset: fill.asset,
            fills: [fill],
            min_ts: fill.ts,
            max_ts: fill.ts,
          });
        }
      }

      // Calculate summary for each market
      const summaries: BetSummary[] = [];
      for (const [market_id, data] of marketMap) {
        // Parse window from market_id (e.g., "btc-updown-15m-1768135500")
        const parts = market_id.split('-');
        const windowStart = parseInt(parts[parts.length - 1]) * 1000;
        const windowEnd = windowStart + 15 * 60 * 1000;

        let up_shares = 0, down_shares = 0;
        let up_cost = 0, down_cost = 0;
        let total_cost = 0;

        for (const fill of data.fills) {
          const notional = fill.fill_notional || 0;
          if (fill.side === 'Up') {
            up_shares += fill.fill_qty;
            up_cost += notional;
          } else {
            down_shares += fill.fill_qty;
            down_cost += notional;
          }
          total_cost += notional;
        }

        summaries.push({
          market_id,
          asset: data.asset,
          window_start: windowStart,
          window_end: windowEnd,
          strike_price: data.fills[0]?.strike_price || null,
          up_shares,
          down_shares,
          up_avg_price: up_shares > 0 ? up_cost / up_shares : null,
          down_avg_price: down_shares > 0 ? down_cost / down_shares : null,
          total_cost,
          result: null, // Would need market_history to determine
          pnl: null,
          fill_count: data.fills.length,
        });
      }

      return summaries.sort((a, b) => b.window_start - a.window_start);
    },
    refetchInterval: 30000,
  });

  return {
    bets: bets || [],
    loading: betsLoading,
    error: betsError?.message || null,
    refetch,
  };
}

export function useBetPriceHistory(asset: string, windowStart: number, windowEnd: number) {
  return useQuery({
    queryKey: ['bet-prices', asset, windowStart, windowEnd],
    queryFn: async () => {
      // Fetch chainlink prices for the time window
      const startTs = Math.floor(windowStart / 1000) - 60; // 1 min before
      const endTs = Math.floor(windowEnd / 1000) + 60; // 1 min after

      const { data, error } = await supabase
        .from('chainlink_prices')
        .select('*')
        .eq('asset', asset)
        .gte('chainlink_timestamp', startTs)
        .lte('chainlink_timestamp', endTs)
        .order('chainlink_timestamp', { ascending: true });

      if (error) throw error;

      return (data || []).map(p => ({
        ts: p.chainlink_timestamp * 1000,
        price: p.price,
        asset: p.asset,
      }));
    },
    enabled: !!asset && !!windowStart,
  });
}
