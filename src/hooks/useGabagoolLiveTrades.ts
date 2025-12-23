import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface Trade {
  id: string;
  timestamp: Date;
  side: 'BUY' | 'SELL';
  outcome: 'Up' | 'Down';
  shares: number;
  price: number;
  total: number;
}

interface Position {
  shares: number;
  invested: number;
  avgPrice: number;
}

interface TradeSummary {
  up: Position;
  down: Position;
  totalInvested: number;
  payoutIfUpWins: number;
  payoutIfDownWins: number;
  guaranteedPayout: number;
  bestCasePayout: number;
  edge: number;
  isDualSide: boolean;
  trades: Trade[];
  lastTradeTime: Date | null;
}

export function useGabagoolLiveTrades(marketSlug: string | null) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch initial trades
  useEffect(() => {
    if (!marketSlug) {
      setTrades([]);
      setIsLoading(false);
      return;
    }

    const fetchTrades = async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('trader_username', 'gabagool22')
        .eq('market_slug', marketSlug)
        .order('timestamp', { ascending: false });

      if (error) {
        console.error('Error fetching trades:', error);
        setIsLoading(false);
        return;
      }

      const mappedTrades: Trade[] = (data || []).map(t => ({
        id: t.id,
        timestamp: new Date(t.timestamp),
        side: t.side as 'BUY' | 'SELL',
        outcome: t.outcome as 'Up' | 'Down',
        shares: Number(t.shares),
        price: Number(t.price),
        total: Number(t.total),
      }));

      setTrades(mappedTrades);
      setIsLoading(false);
    };

    fetchTrades();
  }, [marketSlug]);

  // Realtime subscription
  useEffect(() => {
    if (!marketSlug) return;

    const channel = supabase
      .channel(`gabagool-trades-${marketSlug}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'trades',
          filter: `trader_username=eq.gabagool22`,
        },
        (payload) => {
          const newTrade = payload.new as any;
          // Only add if it matches our market
          if (newTrade.market_slug === marketSlug) {
            const trade: Trade = {
              id: newTrade.id,
              timestamp: new Date(newTrade.timestamp),
              side: newTrade.side as 'BUY' | 'SELL',
              outcome: newTrade.outcome as 'Up' | 'Down',
              shares: Number(newTrade.shares),
              price: Number(newTrade.price),
              total: Number(newTrade.total),
            };
            setTrades(prev => [trade, ...prev]);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [marketSlug]);

  // Calculate summary
  const summary: TradeSummary | null = useMemo(() => {
    if (trades.length === 0) return null;

    const upTrades = trades.filter(t => t.outcome === 'Up' && t.side.toUpperCase() === 'BUY');
    const downTrades = trades.filter(t => t.outcome === 'Down' && t.side.toUpperCase() === 'BUY');

    const upShares = upTrades.reduce((sum, t) => sum + t.shares, 0);
    const upInvested = upTrades.reduce((sum, t) => sum + t.total, 0);
    const upAvgPrice = upShares > 0 ? upInvested / upShares : 0;

    const downShares = downTrades.reduce((sum, t) => sum + t.shares, 0);
    const downInvested = downTrades.reduce((sum, t) => sum + t.total, 0);
    const downAvgPrice = downShares > 0 ? downInvested / downShares : 0;

    const totalInvested = upInvested + downInvested;
    const payoutIfUpWins = upShares * 1.00;
    const payoutIfDownWins = downShares * 1.00;
    const guaranteedPayout = Math.min(payoutIfUpWins, payoutIfDownWins);
    const bestCasePayout = Math.max(payoutIfUpWins, payoutIfDownWins);
    
    // Edge = (guaranteed - invested) / invested * 100
    const edge = totalInvested > 0 
      ? ((guaranteedPayout - totalInvested) / totalInvested) * 100 
      : 0;

    const isDualSide = upShares > 0 && downShares > 0;

    const sortedTrades = [...trades].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const lastTradeTime = sortedTrades.length > 0 ? sortedTrades[0].timestamp : null;

    return {
      up: { shares: upShares, invested: upInvested, avgPrice: upAvgPrice },
      down: { shares: downShares, invested: downInvested, avgPrice: downAvgPrice },
      totalInvested,
      payoutIfUpWins,
      payoutIfDownWins,
      guaranteedPayout,
      bestCasePayout,
      edge,
      isDualSide,
      trades: sortedTrades,
      lastTradeTime,
    };
  }, [trades]);

  return {
    summary,
    isLoading,
    tradesCount: trades.length,
  };
}
