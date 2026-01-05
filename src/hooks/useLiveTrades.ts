import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useCurrentWallet } from './useCurrentWallet';

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
  wallet_address: string | null;
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
  profitPerHour: number;
  tradingHours: number;
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
  const { walletAddress, isLoading: walletLoading } = useCurrentWallet();

  const fetchData = useCallback(async () => {
    if (walletLoading) return;
    
    try {
      setError(null);

      // Build query - ONLY include filled trades (not pending/cancelled)
      let tradesQuery = supabase
        .from('live_trades')
        .select('*')
        .eq('status', 'filled')
        .order('created_at', { ascending: false });
      
      let resultsQuery = supabase
        .from('live_trade_results')
        .select('*')
        .order('created_at', { ascending: false });

      // Filter by wallet address if available
      if (walletAddress) {
        tradesQuery = tradesQuery.or(`wallet_address.eq.${walletAddress},wallet_address.is.null`);
        resultsQuery = resultsQuery.or(`wallet_address.eq.${walletAddress},wallet_address.is.null`);
      }

      const { data: tradesData, error: tradesError } = await tradesQuery;
      if (tradesError) throw tradesError;

      const { data: resultsData, error: resultsError } = await resultsQuery;
      if (resultsError) throw resultsError;

      setTrades(tradesData || []);
      setResults(resultsData || []);
    } catch (err) {
      console.error('Error fetching live trades:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress, walletLoading]);

  // Calculate stats
  const openTradesInvested = trades.reduce((sum, t) => {
    const hasResult = results.some(r => r.market_slug === t.market_slug && r.settled_at);
    return hasResult ? sum : sum + t.total;
  }, 0);
  
  const settledInvested = results.reduce((sum, r) => sum + (r.total_invested || 0), 0);
  const totalProfitLoss = results.reduce((sum, r) => sum + (r.profit_loss || 0), 0);
  
  // Calculate trading hours from first trade to last settled result
  const settledResults = results.filter(r => r.settled_at);
  const allDates = [
    ...trades.map(t => new Date(t.created_at).getTime()),
    ...settledResults.map(r => new Date(r.settled_at!).getTime())
  ].filter(d => !isNaN(d));
  
  let tradingHours = 0;
  if (allDates.length >= 2) {
    const minDate = Math.min(...allDates);
    const maxDate = Math.max(...allDates);
    tradingHours = (maxDate - minDate) / (1000 * 60 * 60);
  }
  
  const profitPerHour = tradingHours > 0 ? totalProfitLoss / tradingHours : 0;
  
  const stats: LiveTradeStats = {
    totalTrades: trades.length,
    totalInvested: openTradesInvested + settledInvested,
    totalPayout: results.reduce((sum, r) => sum + (r.payout || 0), 0),
    totalProfitLoss,
    winCount: results.filter(r => (r.profit_loss || 0) > 0 && r.settled_at).length,
    lossCount: results.filter(r => r.settled_at && (r.profit_loss || 0) <= 0).length,
    pendingCount: results.filter(r => !r.settled_at).length,
    winRate: 0,
    profitPerHour,
    tradingHours,
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
          // Only add if filled
          if (newTrade.status === 'filled') {
            setTrades(prev => [newTrade, ...prev]);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'live_trades' },
        (payload) => {
          const updated = payload.new as LiveTrade;
          // Handle status changes: add if became filled, remove if no longer filled
          setTrades(prev => {
            const exists = prev.some(t => t.id === updated.id);
            if (updated.status === 'filled') {
              if (exists) {
                return prev.map(t => t.id === updated.id ? updated : t);
              } else {
                return [updated, ...prev];
              }
            } else {
              // Remove if status changed away from filled
              return prev.filter(t => t.id !== updated.id);
            }
          });
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
          setResults(prev => [newResult, ...prev]);
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
