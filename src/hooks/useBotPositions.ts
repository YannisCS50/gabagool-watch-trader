import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface BotPosition {
  id: string;
  wallet_address: string;
  market_slug: string;
  outcome: string;
  shares: number;
  avg_price: number;
  current_price: number | null;
  value: number | null;
  cost: number | null;
  pnl: number | null;
  pnl_percent: number | null;
  token_id: string | null;
  synced_at: string;
}

export interface MarketPositionGroup {
  market_slug: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upValue: number;
  downValue: number;
  upAvgPrice: number;
  downAvgPrice: number;
  totalInvested: number;
  totalValue: number;
  pnl: number;
  pnlPercent: number;
  isHedged: boolean;
  eventEndTime: string | null;
  positions: BotPosition[];
}

export interface UseBotPositionsResult {
  positions: BotPosition[];
  groupedPositions: MarketPositionGroup[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  dataSource: 'bot_positions' | 'live_trades';
  summary: {
    totalPositions: number;
    totalMarkets: number;
    totalInvested: number;
    totalValue: number;
    totalPnl: number;
    hedgedMarkets: number;
  };
}

interface LiveTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  wallet_address: string | null;
  event_end_time: string | null;
  created_at: string;
}

type UseBotPositionsOptions = {
  enabled?: boolean;
};

export function useBotPositions(options: UseBotPositionsOptions = {}): UseBotPositionsResult {
  const enabled = options.enabled ?? true;

  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [liveTrades, setLiveTrades] = useState<LiveTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<'bot_positions' | 'live_trades'>('bot_positions');

  const fetchPositions = async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    try {
      setError(null);
      setLoading(true);

      // First try bot_positions
      const { data: botData, error: botError } = await supabase
        .from('bot_positions')
        .select('*')
        .order('synced_at', { ascending: false });

      if (botError) throw botError;

      if (botData && botData.length > 0) {
        setPositions(botData);
        setDataSource('bot_positions');
        setLoading(false);
        return;
      }

      // Fallback to live_trades for open positions
      // Get all filled trades, then filter to open markets
      const { data: tradesData, error: tradesError } = await supabase
        .from('live_trades')
        .select('id, market_slug, asset, outcome, shares, price, total, wallet_address, event_end_time, created_at')
        .eq('status', 'filled')
        .order('created_at', { ascending: false });

      if (tradesError) throw tradesError;

      // Get settled markets to filter them out
      const { data: settledData } = await supabase
        .from('live_trade_results')
        .select('market_slug')
        .not('settled_at', 'is', null);

      const settledSlugs = new Set((settledData || []).map(r => r.market_slug));

      // Filter to only open markets (not settled, event hasn't ended yet or ended recently)
      const now = new Date();
      const openTrades = (tradesData || []).filter(t => {
        if (settledSlugs.has(t.market_slug)) return false;
        // Include if event end time is in the future or within last hour
        if (t.event_end_time) {
          const endTime = new Date(t.event_end_time);
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
          return endTime > oneHourAgo;
        }
        return true;
      });

      setLiveTrades(openTrades);
      setDataSource('live_trades');
    } catch (e) {
      console.error('Error fetching bot positions:', e);
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    fetchPositions();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('bot_positions_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bot_positions' },
        () => fetchPositions()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'live_trades' },
        () => fetchPositions()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(fetchPositions, 30 * 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  // Helper to extract event end time from slug like "btc-updown-15m-1767731400"
  const extractEventEndTime = (slug: string): string | null => {
    const parts = slug.split('-');
    if (parts.length >= 4 && parts[1] === 'updown' && parts[2] === '15m') {
      const timestamp = parseInt(parts[3], 10);
      if (timestamp > 0) {
        // Add 15 minutes (900 seconds) to get end time
        return new Date((timestamp + 900) * 1000).toISOString();
      }
    }
    return null;
  };

  const groupedPositions = useMemo<MarketPositionGroup[]>(() => {
    // If using bot_positions
    if (dataSource === 'bot_positions' && positions.length > 0) {
      const groups = new Map<string, BotPosition[]>();

      for (const pos of positions) {
        const key = pos.market_slug;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(pos);
      }

      return Array.from(groups.entries()).map(([slug, marketPositions]) => {
        let upShares = 0, downShares = 0;
        let upCost = 0, downCost = 0;
        let upValue = 0, downValue = 0;
        let upAvgPrice = 0, downAvgPrice = 0;

        for (const p of marketPositions) {
          const outcome = p.outcome.toLowerCase();
          if (outcome === 'up' || outcome === 'yes') {
            upShares += p.shares;
            upCost += p.cost || 0;
            upValue += p.value || 0;
            upAvgPrice = p.avg_price;
          } else {
            downShares += p.shares;
            downCost += p.cost || 0;
            downValue += p.value || 0;
            downAvgPrice = p.avg_price;
          }
        }

        const totalInvested = upCost + downCost;
        const totalValue = upValue + downValue;
        const pnl = totalValue - totalInvested;
        const pnlPercent = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
        const isHedged = upShares > 0 && downShares > 0;
        const eventEndTime = extractEventEndTime(slug);

        return {
          market_slug: slug,
          asset: slug.split('-')[0].toUpperCase(),
          upShares,
          downShares,
          upCost,
          downCost,
          upValue,
          downValue,
          upAvgPrice,
          downAvgPrice,
          totalInvested,
          totalValue,
          pnl,
          pnlPercent,
          isHedged,
          eventEndTime,
          positions: marketPositions,
        };
      }).sort((a, b) => {
        // Sort by event end time (soonest first for active markets)
        if (a.eventEndTime && b.eventEndTime) {
          return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
        }
        return Math.abs(b.totalInvested) - Math.abs(a.totalInvested);
      });
    }

    // Fallback: build from live_trades
    const groups = new Map<string, LiveTrade[]>();
    for (const trade of liveTrades) {
      if (!groups.has(trade.market_slug)) {
        groups.set(trade.market_slug, []);
      }
      groups.get(trade.market_slug)!.push(trade);
    }

    return Array.from(groups.entries()).map(([slug, trades]) => {
      let upShares = 0, downShares = 0;
      let upCost = 0, downCost = 0;
      let upAvgPriceSum = 0, downAvgPriceSum = 0;
      let upCount = 0, downCount = 0;
      let eventEndTime: string | null = null;
      let asset = 'BTC';

      for (const t of trades) {
        asset = t.asset;
        if (!eventEndTime && t.event_end_time) {
          eventEndTime = t.event_end_time;
        }
        if (t.outcome === 'UP') {
          upShares += t.shares;
          upCost += t.total;
          upAvgPriceSum += t.price;
          upCount++;
        } else {
          downShares += t.shares;
          downCost += t.total;
          downAvgPriceSum += t.price;
          downCount++;
        }
      }

      const upAvgPrice = upCount > 0 ? upAvgPriceSum / upCount : 0;
      const downAvgPrice = downCount > 0 ? downAvgPriceSum / downCount : 0;
      const totalInvested = upCost + downCost;
      
      // Estimate value: min(upShares, downShares) will pay out 1
      const pairedShares = Math.min(upShares, downShares);
      const estimatedValue = pairedShares; // Paired shares guarantee $1 payout per share
      const pnl = estimatedValue - totalInvested;
      const pnlPercent = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
      const isHedged = upShares > 0 && downShares > 0;

      // Convert to BotPosition format for compatibility
      const fakePositions: BotPosition[] = trades.map(t => ({
        id: t.id,
        wallet_address: t.wallet_address || '',
        market_slug: t.market_slug,
        outcome: t.outcome,
        shares: t.shares,
        avg_price: t.price,
        current_price: null,
        value: t.total,
        cost: t.total,
        pnl: null,
        pnl_percent: null,
        token_id: null,
        synced_at: t.created_at,
      }));

      return {
        market_slug: slug,
        asset,
        upShares,
        downShares,
        upCost,
        downCost,
        upValue: upShares * 0.5, // Estimated
        downValue: downShares * 0.5, // Estimated
        upAvgPrice,
        downAvgPrice,
        totalInvested,
        totalValue: estimatedValue,
        pnl,
        pnlPercent,
        isHedged,
        eventEndTime,
        positions: fakePositions,
      };
    }).sort((a, b) => {
      // Sort by event end time (soonest first), then by invested
      if (a.eventEndTime && b.eventEndTime) {
        return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
      }
      return Math.abs(b.totalInvested) - Math.abs(a.totalInvested);
    });
  }, [positions, liveTrades, dataSource]);

  const summary = useMemo(() => {
    const totalInvested = groupedPositions.reduce((sum, g) => sum + g.totalInvested, 0);
    const totalValue = groupedPositions.reduce((sum, g) => sum + g.totalValue, 0);
    const hedgedMarkets = groupedPositions.filter(g => g.isHedged).length;

    return {
      totalPositions: dataSource === 'bot_positions' ? positions.length : liveTrades.length,
      totalMarkets: groupedPositions.length,
      totalInvested,
      totalValue,
      totalPnl: totalValue - totalInvested,
      hedgedMarkets,
    };
  }, [positions, liveTrades, groupedPositions, dataSource]);

  return {
    positions,
    groupedPositions,
    loading,
    error,
    refetch: fetchPositions,
    dataSource,
    summary,
  };
}
