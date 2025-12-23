import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PaperTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  combined_price: number | null;
  arbitrage_edge: number | null;
  crypto_price: number | null;
  open_price: number | null;
  price_delta: number | null;
  price_delta_percent: number | null;
  remaining_seconds: number | null;
  trade_type: string | null;
  reasoning: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
  created_at: string;
}

export interface PaperTradeResult {
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

export interface PaperTradeStats {
  totalTrades: number;
  totalInvested: number;
  totalPayout: number;
  totalProfitLoss: number;
  winCount: number;
  lossCount: number;
  pendingCount: number;
  winRate: number;
}

export interface UsePaperTradesResult {
  trades: PaperTrade[];
  results: PaperTradeResult[];
  stats: PaperTradeStats;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  triggerBot: () => Promise<void>;
  triggerSettle: () => Promise<void>;
}

export function usePaperTrades(): UsePaperTradesResult {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [results, setResults] = useState<PaperTradeResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);

      // Fetch recent trades
      const { data: tradesData, error: tradesError } = await supabase
        .from('paper_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (tradesError) throw tradesError;

      // Fetch results
      const { data: resultsData, error: resultsError } = await supabase
        .from('paper_trade_results')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (resultsError) throw resultsError;

      setTrades(tradesData || []);
      setResults(resultsData || []);
    } catch (err) {
      console.error('Error fetching paper trades:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Calculate stats from both trades AND results
  // Total invested includes open positions (from trades) + settled positions (from results)
  const openTradesInvested = trades.reduce((sum, t) => {
    // Only count trades that don't have a settled result
    const hasResult = results.some(r => r.market_slug === t.market_slug && r.settled_at);
    return hasResult ? sum : sum + t.total;
  }, 0);
  
  const settledInvested = results.reduce((sum, r) => sum + (r.total_invested || 0), 0);
  
  const stats: PaperTradeStats = {
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

  // Subscribe to realtime updates
  useEffect(() => {
    const tradesChannel = supabase
      .channel('paper-trades-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trades' },
        () => fetchData()
      )
      .subscribe();

    const resultsChannel = supabase
      .channel('paper-results-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'paper_trade_results' },
        () => fetchData()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(tradesChannel);
      supabase.removeChannel(resultsChannel);
    };
  }, [fetchData]);

  const triggerBot = useCallback(async () => {
    try {
      const { error } = await supabase.functions.invoke('paper-trade-bot');
      if (error) throw error;
      await fetchData();
    } catch (err) {
      console.error('Error triggering paper trade bot:', err);
      setError(err instanceof Error ? err.message : 'Failed to trigger bot');
    }
  }, [fetchData]);

  const triggerSettle = useCallback(async () => {
    try {
      const { error } = await supabase.functions.invoke('settle-paper-trades');
      if (error) throw error;
      await fetchData();
    } catch (err) {
      console.error('Error triggering settle:', err);
      setError(err instanceof Error ? err.message : 'Failed to settle trades');
    }
  }, [fetchData]);

  return {
    trades,
    results,
    stats,
    isLoading,
    error,
    refetch: fetchData,
    triggerBot,
    triggerSettle,
  };
}

// Helper hook to get paper trades for a specific market
export function usePaperTradesByMarket(marketSlug: string) {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [result, setResult] = useState<PaperTradeResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [tradesRes, resultRes] = await Promise.all([
          supabase
            .from('paper_trades')
            .select('*')
            .eq('market_slug', marketSlug)
            .order('created_at', { ascending: false }),
          supabase
            .from('paper_trade_results')
            .select('*')
            .eq('market_slug', marketSlug)
            .maybeSingle(),
        ]);

        setTrades(tradesRes.data || []);
        setResult(resultRes.data);
      } catch (err) {
        console.error('Error fetching paper trades for market:', err);
      } finally {
        setIsLoading(false);
      }
    }

    if (marketSlug) {
      fetchData();
    }
  }, [marketSlug]);

  // Summary stats
  const summary = {
    upShares: trades.filter(t => t.outcome === 'UP').reduce((sum, t) => sum + t.shares, 0),
    upCost: trades.filter(t => t.outcome === 'UP').reduce((sum, t) => sum + t.total, 0),
    downShares: trades.filter(t => t.outcome === 'DOWN').reduce((sum, t) => sum + t.shares, 0),
    downCost: trades.filter(t => t.outcome === 'DOWN').reduce((sum, t) => sum + t.total, 0),
    totalInvested: trades.reduce((sum, t) => sum + t.total, 0),
  };

  return {
    trades,
    result,
    summary,
    isLoading,
  };
}
