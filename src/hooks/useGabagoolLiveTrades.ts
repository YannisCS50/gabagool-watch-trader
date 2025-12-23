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
  profitIfUpWins: number;
  profitIfDownWins: number;
  guaranteedPayout: number;
  guaranteedProfit: number;
  bestCasePayout: number;
  bestCaseProfit: number;
  combinedEntry: number;
  isArbitrage: boolean;
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

    // Separate BUY and SELL trades per outcome
    const upBuys = trades.filter(t => t.outcome === 'Up' && t.side.toUpperCase() === 'BUY');
    const upSells = trades.filter(t => t.outcome === 'Up' && t.side.toUpperCase() === 'SELL');
    const downBuys = trades.filter(t => t.outcome === 'Down' && t.side.toUpperCase() === 'BUY');
    const downSells = trades.filter(t => t.outcome === 'Down' && t.side.toUpperCase() === 'SELL');

    // Net shares (buys - sells)
    const upNetShares = upBuys.reduce((sum, t) => sum + t.shares, 0) - upSells.reduce((sum, t) => sum + t.shares, 0);
    const downNetShares = downBuys.reduce((sum, t) => sum + t.shares, 0) - downSells.reduce((sum, t) => sum + t.shares, 0);

    // Net cost (buys - sells proceeds)
    const upNetCost = upBuys.reduce((sum, t) => sum + t.total, 0) - upSells.reduce((sum, t) => sum + t.total, 0);
    const downNetCost = downBuys.reduce((sum, t) => sum + t.total, 0) - downSells.reduce((sum, t) => sum + t.total, 0);

    // Average prices
    const upAvgPrice = upNetShares > 0 ? upNetCost / upNetShares : 0;
    const downAvgPrice = downNetShares > 0 ? downNetCost / downNetShares : 0;

    const totalInvested = upNetCost + downNetCost;

    // Payouts (1 share = $1 payout if that side wins)
    const payoutIfUpWins = upNetShares;
    const payoutIfDownWins = downNetShares;

    // Profits per scenario
    const profitIfUpWins = payoutIfUpWins - totalInvested;
    const profitIfDownWins = payoutIfDownWins - totalInvested;

    // Guaranteed = worst case scenario
    const guaranteedPayout = Math.min(payoutIfUpWins, payoutIfDownWins);
    const guaranteedProfit = guaranteedPayout - totalInvested;

    // Best case = best scenario
    const bestCasePayout = Math.max(payoutIfUpWins, payoutIfDownWins);
    const bestCaseProfit = bestCasePayout - totalInvested;

    // Combined entry price (sum of avg prices for both sides)
    const combinedEntry = upAvgPrice + downAvgPrice;

    // True arbitrage = guaranteed profit > 0
    const isArbitrage = guaranteedProfit > 0;

    const isDualSide = upNetShares > 0 && downNetShares > 0;

    const sortedTrades = [...trades].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const lastTradeTime = sortedTrades.length > 0 ? sortedTrades[0].timestamp : null;

    return {
      up: { shares: upNetShares, invested: upNetCost, avgPrice: upAvgPrice },
      down: { shares: downNetShares, invested: downNetCost, avgPrice: downAvgPrice },
      totalInvested,
      payoutIfUpWins,
      payoutIfDownWins,
      profitIfUpWins,
      profitIfDownWins,
      guaranteedPayout,
      guaranteedProfit,
      bestCasePayout,
      bestCaseProfit,
      combinedEntry,
      isArbitrage,
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
