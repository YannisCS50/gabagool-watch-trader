import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Trade, TraderStats, MarketPosition } from '@/types/trade';
import { useToast } from '@/hooks/use-toast';

export function useTrades(username: string = 'gabagool22') {
  const { toast } = useToast();

  const tradesQuery = useQuery({
    queryKey: ['trades', username],
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
    staleTime: 4 * 60 * 1000, // Consider data fresh for 4 minutes
    queryFn: async () => {
      // Fetch ALL trades with pagination
      let allTrades: any[] = [];
      let offset = 0;
      const pageSize = 1000;
      
      while (true) {
        const { data, error } = await supabase
          .from('trades')
          .select('*')
          .eq('trader_username', username)
          .order('timestamp', { ascending: false })
          .range(offset, offset + pageSize - 1);

        if (error) throw error;
        if (!data || data.length === 0) break;
        
        allTrades = [...allTrades, ...data];
        if (data.length < pageSize) break;
        offset += pageSize;
      }

      return allTrades.map((t): Trade => ({
        id: t.id,
        timestamp: new Date(t.timestamp),
        market: t.market,
        marketSlug: t.market_slug || '',
        outcome: t.outcome as 'Yes' | 'No',
        side: t.side as 'buy' | 'sell',
        shares: Number(t.shares),
        price: Number(t.price),
        total: Number(t.total),
        status: t.status as 'filled' | 'pending' | 'cancelled',
      }));
    },
  });

  const statsQuery = useQuery({
    queryKey: ['trader-stats', username],
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
    staleTime: 4 * 60 * 1000, // Consider data fresh for 4 minutes
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trader_stats')
        .select('*')
        .eq('trader_username', username)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') throw error;

      if (!data) {
        return {
          totalTrades: 0,
          totalVolume: 0,
          winRate: 0,
          avgTradeSize: 0,
          activeSince: new Date(),
          lastActive: new Date(),
        } as TraderStats;
      }

      return {
        totalTrades: data.total_trades || 0,
        totalVolume: Number(data.total_volume) || 0,
        winRate: Number(data.win_rate) || 0,
        avgTradeSize: Number(data.avg_trade_size) || 0,
        activeSince: new Date(data.active_since || Date.now()),
        lastActive: new Date(data.last_active || Date.now()),
      } as TraderStats;
    },
  });

  const positionsQuery = useQuery({
    queryKey: ['positions', username],
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
    staleTime: 4 * 60 * 1000, // Consider data fresh for 4 minutes
    queryFn: async () => {
      const { data, error } = await supabase
        .from('positions')
        .select('*')
        .eq('trader_username', username)
        .order('updated_at', { ascending: false });

      if (error) throw error;

      return (data || []).map((p): MarketPosition => ({
        market: p.market,
        marketSlug: p.market_slug || '',
        outcome: p.outcome as 'Yes' | 'No',
        shares: Number(p.shares),
        avgPrice: Number(p.avg_price),
        currentPrice: Number(p.current_price) || Number(p.avg_price),
        pnl: Number(p.pnl) || 0,
        pnlPercent: Number(p.pnl_percent) || 0,
      }));
    },
  });

  const scrapeMutation = useMutation({
    mutationFn: async () => {
      const response = await supabase.functions.invoke('scrape-polymarket', {
        body: { username },
      });

      if (response.error) throw response.error;
      return response.data;
    },
    onSuccess: (data) => {
      toast({
        title: 'Scrape Complete',
        description: `Found ${data.tradesFound} trades`,
      });
      // Refetch queries after successful scrape
      tradesQuery.refetch();
      statsQuery.refetch();
      positionsQuery.refetch();
    },
    onError: (error) => {
      toast({
        title: 'Scrape Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return {
    trades: tradesQuery.data || [],
    stats: statsQuery.data,
    positions: positionsQuery.data || [],
    isLoading: tradesQuery.isLoading || statsQuery.isLoading,
    scrape: scrapeMutation.mutate,
    isScraping: scrapeMutation.isPending,
  };
}
