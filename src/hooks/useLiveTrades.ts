import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface LiveTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  order_id: string | null;
  status: string | null;
  created_at: string;
  event_start_time: string | null;
  event_end_time: string | null;
  reasoning: string | null;
  arbitrage_edge: number | null;
  avg_fill_price: number | null;
  estimated_slippage: number | null;
}

export interface LiveTradeResult {
  id: string;
  market_slug: string;
  asset: string;
  up_shares: number | null;
  up_cost: number | null;
  up_avg_price: number | null;
  down_shares: number | null;
  down_cost: number | null;
  down_avg_price: number | null;
  total_invested: number | null;
  result: string | null;
  payout: number | null;
  profit_loss: number | null;
  profit_loss_percent: number | null;
  event_end_time: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface LiveTradeStats {
  totalTrades: number;
  totalInvested: number;
  totalPayout: number;
  totalProfitLoss: number;
  winCount: number;
  lossCount: number;
  pendingCount: number;
  winRate: number;
}

export interface UseLiveTradesResult {
  trades: LiveTrade[];
  results: LiveTradeResult[];
  stats: LiveTradeStats;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useLiveTrades(): UseLiveTradesResult {
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [results, setResults] = useState<LiveTradeResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);

      // Fetch recent trades
      const { data: tradesData, error: tradesError } = await supabase
        .from('live_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (tradesError) throw tradesError;

      // Fetch results
      const { data: resultsData, error: resultsError } = await supabase
        .from('live_trade_results')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (resultsError) throw resultsError;

      setTrades(tradesData || []);
      setResults(resultsData || []);
    } catch (err) {
      console.error('Error fetching live trades:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Calculate stats
  const openTradesInvested = trades.reduce((sum, t) => {
    const hasResult = results.some(r => r.market_slug === t.market_slug && r.settled_at);
    return hasResult ? sum : sum + t.total;
  }, 0);
  
  const settledInvested = results.reduce((sum, r) => sum + (r.total_invested || 0), 0);
  
  const stats: LiveTradeStats = {
    totalTrades: trades.length,
    totalInvested: openTradesInvested + settledInvested,
    totalPayout: results.reduce((sum, r) => sum + (r.payout || 0), 0),
    totalProfitLoss: results.reduce((sum, r) => sum + (r.profit_loss || 0), 0),
    winCount: results.filter(r => (r.profit_loss || 0) > 0 && r.settled_at).length,
    lossCount: results.filter(r => r.settled_at && (r.profit_loss || 0) <= 0).length,
    pendingCount: results.filter(r => !r.settled_at).length,
    winRate: 0,
  };

  const settledCount = stats.winCount + stats.lossCount;
  stats.winRate = settledCount > 0 ? (stats.winCount / settledCount) * 100 : 0;

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to realtime updates with direct payload handling for faster updates
  useEffect(() => {
    const tradesChannel = supabase
      .channel('live-trades-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_trades' },
        (payload) => {
          const newTrade = payload.new as LiveTrade;
          setTrades(prev => [newTrade, ...prev.slice(0, 99)]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_trades' },
        (payload) => {
          const updated = payload.new as LiveTrade;
          setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
        }
      )
      .subscribe();

    const resultsChannel = supabase
      .channel('live-results-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_trade_results' },
        (payload) => {
          const newResult = payload.new as LiveTradeResult;
          setResults(prev => [newResult, ...prev.slice(0, 49)]);
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_trade_results' },
        (payload) => {
          const updated = payload.new as LiveTradeResult;
          setResults(prev => prev.map(r => r.id === updated.id ? updated : r));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(tradesChannel);
      supabase.removeChannel(resultsChannel);
    };
  }, []);

  return {
    trades,
    results,
    stats,
    isLoading,
    error,
    refetch: fetchData,
  };
}
