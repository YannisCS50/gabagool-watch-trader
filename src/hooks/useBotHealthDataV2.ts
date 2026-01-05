import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  BotEvent,
  Order,
  Fill,
  InventorySnapshot,
  computeHealthMetrics,
  HealthMetrics,
} from '@/lib/botHealthMetrics';

export type TimeRange = '15m' | '1h' | '6h' | '24h';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

const SNAPSHOT_MAX_ROWS: Record<TimeRange, number> = {
  // snapshot_logs is high-frequency; cap while still keeping charts meaningful
  '15m': 20000,
  '1h': 50000,
  '6h': 160000,
  '24h': 200000,
};

const SNAPSHOT_REFETCH_MS: Record<TimeRange, number> = {
  '15m': 30000,
  '1h': 30000,
  '6h': 60000,
  '24h': 120000,
};

interface UseBotHealthDataOptions {
  timeRange: TimeRange;
  assetFilter?: string;
  marketIdFilter?: string;
}

export function useBotHealthDataV2(options: UseBotHealthDataOptions) {
  const { timeRange, assetFilter, marketIdFilter } = options;
  const timeRangeMs = TIME_RANGE_MS[timeRange];
  const startTime = Date.now() - timeRangeMs;

  const eventsQuery = useQuery({
    queryKey: ['bot-health-events', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<BotEvent[]> => {
      let query = supabase
        .from('bot_events')
        .select('*')
        .gte('ts', startTime)
        .order('ts', { ascending: true });

      if (assetFilter) query = query.eq('asset', assetFilter);
      if (marketIdFilter) query = query.ilike('market_id', `%${marketIdFilter}%`);

      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map((e) => ({
        ...e,
        data: e.data as Record<string, unknown> | null,
      }));
    },
    refetchInterval: 30000,
  });

  const ordersQuery = useQuery({
    queryKey: ['bot-health-orders', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<Order[]> => {
      let query = supabase
        .from('orders')
        .select('*')
        .gte('created_ts', startTime)
        .order('created_ts', { ascending: true });

      if (assetFilter) query = query.eq('asset', assetFilter);
      if (marketIdFilter) query = query.ilike('market_id', `%${marketIdFilter}%`);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 30000,
  });

  const fillsQuery = useQuery({
    queryKey: ['bot-health-fills', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<Fill[]> => {
      let query = supabase
        .from('fill_logs')
        .select('*')
        .gte('ts', startTime)
        .order('ts', { ascending: true });

      if (assetFilter) query = query.eq('asset', assetFilter);
      if (marketIdFilter) query = query.ilike('market_id', `%${marketIdFilter}%`);

      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map((f) => ({
        id: f.id,
        ts: f.ts,
        asset: f.asset,
        market_id: f.market_id,
        side: f.side,
        intent: f.intent,
        fill_qty: f.fill_qty,
        fill_price: f.fill_price,
        fill_notional: f.fill_notional,
        order_id: f.order_id,
      }));
    },
    refetchInterval: 30000,
  });

  const snapshotsQuery = useQuery({
    queryKey: ['bot-health-snapshots', 'snapshot_logs', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<InventorySnapshot[]> => {
      const maxRows = SNAPSHOT_MAX_ROWS[timeRange];

      let query = supabase
        .from('snapshot_logs')
        .select('id, ts, asset, market_id, up_shares, down_shares, bot_state, pair_cost')
        .gte('ts', startTime)
        .order('ts', { ascending: true })
        .range(0, maxRows - 1);

      if (assetFilter) query = query.eq('asset', assetFilter);
      if (marketIdFilter) query = query.ilike('market_id', `%${marketIdFilter}%`);

      const { data, error } = await query;
      if (error) throw error;

      return (data || []).map((s) => ({
        id: s.id,
        ts: s.ts,
        asset: s.asset,
        market_id: s.market_id,
        up_shares: s.up_shares,
        down_shares: s.down_shares,
        state: s.bot_state,
        pair_cost: s.pair_cost,
        skew_allowed_reason: null,
      }));
    },
    refetchInterval: SNAPSHOT_REFETCH_MS[timeRange],
  });

  const metrics: HealthMetrics | null =
    eventsQuery.data && ordersQuery.data && fillsQuery.data && snapshotsQuery.data
      ? computeHealthMetrics(
          eventsQuery.data,
          ordersQuery.data,
          fillsQuery.data,
          snapshotsQuery.data,
          {},
          timeRangeMs
        )
      : null;

  const isLoading =
    eventsQuery.isLoading ||
    ordersQuery.isLoading ||
    fillsQuery.isLoading ||
    snapshotsQuery.isLoading;

  const error = eventsQuery.error || ordersQuery.error || fillsQuery.error || snapshotsQuery.error;

  return {
    metrics,
    isLoading,
    error,
    refetch: () => {
      eventsQuery.refetch();
      ordersQuery.refetch();
      fillsQuery.refetch();
      snapshotsQuery.refetch();
    },
    rawData: {
      events: eventsQuery.data || [],
      orders: ordersQuery.data || [],
      fills: fillsQuery.data || [],
      snapshots: snapshotsQuery.data || [],
    },
  };
}
