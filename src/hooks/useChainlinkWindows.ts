import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface V29Tick {
  id: string;
  ts: number;
  asset: string;
  market_slug: string;
  strike_price: number;
  chainlink_price: number;
  binance_price: number;
  binance_delta: number;
  up_best_bid: number | null;
  down_best_bid: number | null;
  signal_direction: string | null;
  order_placed: boolean;
  fill_price: number | null;
  fill_size: number | null;
  created_at: string;
}

export interface WindowSummary {
  market_slug: string;
  asset: string;
  window_start: number;
  window_end: number;
  strike_price: number;
  tick_count: number;
  first_tick_ts: number;
  last_tick_ts: number;
  open_price: number;
  close_price: number;
  high_price: number;
  low_price: number;
  price_change: number;
  price_change_pct: number;
  signals_up: number;
  signals_down: number;
  orders_placed: number;
  fills: number;
}

export function useChainlinkWindows(asset?: string) {
  return useQuery({
    queryKey: ['chainlink-windows', asset],
    queryFn: async () => {
      let query = supabase
        .from('v29_ticks')
        .select('*')
        .order('ts', { ascending: false })
        .limit(2000);

      if (asset && asset !== 'all') {
        query = query.eq('asset', asset);
      }

      const { data, error } = await query;
      if (error) throw error;

      // Group by market_slug
      const windowMap = new Map<string, V29Tick[]>();
      for (const tick of data || []) {
        const existing = windowMap.get(tick.market_slug);
        if (existing) {
          existing.push(tick);
        } else {
          windowMap.set(tick.market_slug, [tick]);
        }
      }

      // Calculate summary for each window
      const summaries: WindowSummary[] = [];
      for (const [market_slug, ticks] of windowMap) {
        // Sort by ts ascending for OHLC
        const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
        
        // Parse window from market_slug (e.g., "btc-updown-15m-1768563000")
        const parts = market_slug.split('-');
        const windowStartSec = parseInt(parts[parts.length - 1]);
        const windowStart = windowStartSec * 1000;
        const windowEnd = windowStart + 15 * 60 * 1000;

        const prices = sorted.map(t => t.chainlink_price).filter(p => p != null);
        
        summaries.push({
          market_slug,
          asset: sorted[0].asset,
          window_start: windowStart,
          window_end: windowEnd,
          strike_price: sorted[0].strike_price,
          tick_count: sorted.length,
          first_tick_ts: sorted[0].ts,
          last_tick_ts: sorted[sorted.length - 1].ts,
          open_price: prices[0] || 0,
          close_price: prices[prices.length - 1] || 0,
          high_price: Math.max(...prices),
          low_price: Math.min(...prices),
          price_change: (prices[prices.length - 1] || 0) - (prices[0] || 0),
          price_change_pct: prices[0] ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : 0,
          signals_up: sorted.filter(t => t.signal_direction === 'up').length,
          signals_down: sorted.filter(t => t.signal_direction === 'down').length,
          orders_placed: sorted.filter(t => t.order_placed).length,
          fills: sorted.filter(t => t.fill_price != null).length,
        });
      }

      return summaries.sort((a, b) => b.window_start - a.window_start);
    },
    refetchInterval: 10000,
  });
}

export function useWindowTicks(marketSlug: string) {
  return useQuery({
    queryKey: ['window-ticks', marketSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v29_ticks')
        .select('*')
        .eq('market_slug', marketSlug)
        .order('ts', { ascending: true });

      if (error) throw error;
      return data as V29Tick[];
    },
    enabled: !!marketSlug,
  });
}
