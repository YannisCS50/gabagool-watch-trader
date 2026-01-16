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
  is_completed: boolean;
}

export function useChainlinkWindows(asset?: string, onlyCompleted: boolean = true) {
  return useQuery({
    queryKey: ['chainlink-windows', asset, onlyCompleted],
    queryFn: () => fetchWindowsSummaries(asset, onlyCompleted),
    refetchInterval: 30000,
  });
}

// Fetch all windows with summaries
async function fetchWindowsSummaries(asset?: string, onlyCompleted: boolean = true): Promise<WindowSummary[]> {
  // Get distinct market_slugs first
  let query = supabase
    .from('v29_ticks')
    .select('market_slug, asset, strike_price, ts, chainlink_price, signal_direction, order_placed, fill_price')
    .order('ts', { ascending: true });

  if (asset && asset !== 'all') {
    query = query.eq('asset', asset);
  }

  const { data: allTicks, error } = await query;
  if (error) throw error;

  // Group by market_slug
  const windowMap = new Map<string, typeof allTicks>();
  for (const tick of allTicks || []) {
    const existing = windowMap.get(tick.market_slug);
    if (existing) {
      existing.push(tick);
    } else {
      windowMap.set(tick.market_slug, [tick]);
    }
  }

  const now = Date.now();
  const summaries: WindowSummary[] = [];

  for (const [market_slug, ticks] of windowMap) {
    // Parse window from market_slug
    const parts = market_slug.split('-');
    const windowStartSec = parseInt(parts[parts.length - 1]);
    const windowStart = windowStartSec * 1000;
    const windowEnd = windowStart + 15 * 60 * 1000;
    const isCompleted = now >= windowEnd;

    if (onlyCompleted && !isCompleted) continue;

    const prices = ticks.map(t => t.chainlink_price).filter((p): p is number => p != null);
    if (prices.length === 0) continue;

    const sorted = [...ticks].sort((a, b) => a.ts - b.ts);

    summaries.push({
      market_slug,
      asset: sorted[0].asset,
      window_start: windowStart,
      window_end: windowEnd,
      strike_price: sorted[0].strike_price,
      tick_count: sorted.length,
      first_tick_ts: sorted[0].ts,
      last_tick_ts: sorted[sorted.length - 1].ts,
      open_price: prices[0],
      close_price: prices[prices.length - 1],
      high_price: Math.max(...prices),
      low_price: Math.min(...prices),
      price_change: prices[prices.length - 1] - prices[0],
      price_change_pct: ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100,
      signals_up: sorted.filter(t => t.signal_direction === 'up').length,
      signals_down: sorted.filter(t => t.signal_direction === 'down').length,
      orders_placed: sorted.filter(t => t.order_placed).length,
      fills: sorted.filter(t => t.fill_price != null).length,
      is_completed: isCompleted,
    });
  }

  return summaries.sort((a, b) => b.window_start - a.window_start);
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
