import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { 
  BotEvent, 
  Order, 
  Fill, 
  InventorySnapshot,
  computeHealthMetrics,
  HealthMetrics
} from '@/lib/botHealthMetrics';

export type TimeRange = '15m' | '1h' | '6h' | '24h';

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

interface UseBotHealthDataOptions {
  timeRange: TimeRange;
  assetFilter?: string;
  marketIdFilter?: string;
}

export function useBotHealthData(options: UseBotHealthDataOptions) {
  const { timeRange, assetFilter, marketIdFilter } = options;
  const timeRangeMs = TIME_RANGE_MS[timeRange];
  const startTime = Date.now() - timeRangeMs;

  // Fetch bot events
  const eventsQuery = useQuery({
    queryKey: ['bot-health-events', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<BotEvent[]> => {
      let query = supabase
        .from('bot_events')
        .select('*')
        .gte('ts', startTime)
        .order('ts', { ascending: true });
      
      if (assetFilter) {
        query = query.eq('asset', assetFilter);
      }
      if (marketIdFilter) {
        query = query.ilike('market_id', `%${marketIdFilter}%`);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(e => ({
        ...e,
        data: e.data as Record<string, unknown> | null,
      }));
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  // Fetch orders
  const ordersQuery = useQuery({
    queryKey: ['bot-health-orders', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<Order[]> => {
      let query = supabase
        .from('orders')
        .select('*')
        .gte('created_ts', startTime)
        .order('created_ts', { ascending: true });
      
      if (assetFilter) {
        query = query.eq('asset', assetFilter);
      }
      if (marketIdFilter) {
        query = query.ilike('market_id', `%${marketIdFilter}%`);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 30000,
  });

  // Fetch fills
  const fillsQuery = useQuery({
    queryKey: ['bot-health-fills', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<Fill[]> => {
      let query = supabase
        .from('fill_logs')
        .select('*')
        .gte('ts', startTime)
        .order('ts', { ascending: true });
      
      if (assetFilter) {
        query = query.eq('asset', assetFilter);
      }
      if (marketIdFilter) {
        query = query.ilike('market_id', `%${marketIdFilter}%`);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(f => ({
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

  // Fetch inventory snapshots
  const snapshotsQuery = useQuery({
    queryKey: ['bot-health-snapshots', timeRange, assetFilter, marketIdFilter],
    queryFn: async (): Promise<InventorySnapshot[]> => {
      let query = supabase
        .from('inventory_snapshots')
        .select('*')
        .gte('ts', startTime)
        .order('ts', { ascending: true });
      
      if (assetFilter) {
        query = query.eq('asset', assetFilter);
      }
      if (marketIdFilter) {
        query = query.ilike('market_id', `%${marketIdFilter}%`);
      }
      
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 30000,
  });

  // Compute metrics
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

  const isLoading = eventsQuery.isLoading || ordersQuery.isLoading || 
                    fillsQuery.isLoading || snapshotsQuery.isLoading;
  
  const error = eventsQuery.error || ordersQuery.error || 
                fillsQuery.error || snapshotsQuery.error;

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
