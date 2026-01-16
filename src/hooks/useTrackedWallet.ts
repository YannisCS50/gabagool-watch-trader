import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface TrackedTrade {
  id: string;
  wallet_address: string;
  trade_id: string;
  timestamp: string;
  side: string;
  asset: string | null;
  market_slug: string | null;
  outcome: string | null;
  size: number;
  price: number;
  fee: number | null;
  created_at: string;
}

export interface TrackedWalletStats {
  totalTrades: number;
  totalVolume: number;
  buyCount: number;
  sellCount: number;
  uniqueMarkets: number;
  avgTradeSize: number;
  lastTradeTime: string | null;
}

export function useTrackedWallet(walletAddress: string) {
  const [trades, setTrades] = useState<TrackedTrade[]>([]);
  const [stats, setStats] = useState<TrackedWalletStats>({
    totalTrades: 0,
    totalVolume: 0,
    buyCount: 0,
    sellCount: 0,
    uniqueMarkets: 0,
    avgTradeSize: 0,
    lastTradeTime: null,
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedWallet = walletAddress.toLowerCase();

  // Calculate stats from trades
  const calculateStats = useCallback((tradeList: TrackedTrade[]): TrackedWalletStats => {
    if (tradeList.length === 0) {
      return {
        totalTrades: 0,
        totalVolume: 0,
        buyCount: 0,
        sellCount: 0,
        uniqueMarkets: 0,
        avgTradeSize: 0,
        lastTradeTime: null,
      };
    }

    const totalVolume = tradeList.reduce((sum, t) => sum + t.size * t.price, 0);
    const buyCount = tradeList.filter(t => t.side === 'BUY').length;
    const sellCount = tradeList.filter(t => t.side === 'SELL').length;
    const uniqueMarkets = new Set(tradeList.map(t => t.market_slug)).size;
    
    return {
      totalTrades: tradeList.length,
      totalVolume,
      buyCount,
      sellCount,
      uniqueMarkets,
      avgTradeSize: totalVolume / tradeList.length,
      lastTradeTime: tradeList[0]?.timestamp || null,
    };
  }, []);

  // Fetch trades from database
  const fetchTrades = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('tracked_wallet_trades')
        .select('*')
        .eq('wallet_address', normalizedWallet)
        .order('timestamp', { ascending: false })
        .limit(500);

      if (fetchError) throw fetchError;

      const typedData = (data || []) as TrackedTrade[];
      setTrades(typedData);
      setStats(calculateStats(typedData));
    } catch (err) {
      console.error('[useTrackedWallet] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch trades');
    } finally {
      setLoading(false);
    }
  }, [normalizedWallet, calculateStats]);

  // Sync trades from Polymarket API
  const syncTrades = useCallback(async () => {
    setSyncing(true);
    setError(null);

    try {
      const { data, error: invokeError } = await supabase.functions.invoke('sync-tracked-wallet', {
        body: { wallet_address: normalizedWallet }
      });

      if (invokeError) throw invokeError;

      console.log('[useTrackedWallet] Sync result:', data);
      
      // Refetch after sync
      await fetchTrades();
    } catch (err) {
      console.error('[useTrackedWallet] Sync error:', err);
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [normalizedWallet, fetchTrades]);

  // Initial fetch
  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Realtime subscription
  useEffect(() => {
    const channel = supabase
      .channel(`tracked-wallet-${normalizedWallet}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'tracked_wallet_trades',
          filter: `wallet_address=eq.${normalizedWallet}`,
        },
        (payload) => {
          console.log('[useTrackedWallet] New trade:', payload.new);
          const newTrade = payload.new as TrackedTrade;
          setTrades((prev) => {
            const updated = [newTrade, ...prev].slice(0, 500);
            setStats(calculateStats(updated));
            return updated;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [normalizedWallet, calculateStats]);

  return {
    trades,
    stats,
    loading,
    syncing,
    error,
    syncTrades,
    refetch: fetchTrades,
  };
}
