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
  positions: BotPosition[];
}

export interface UseBotPositionsResult {
  positions: BotPosition[];
  groupedPositions: MarketPositionGroup[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  summary: {
    totalPositions: number;
    totalMarkets: number;
    totalInvested: number;
    totalValue: number;
    totalPnl: number;
    hedgedMarkets: number;
  };
}

export function useBotPositions(): UseBotPositionsResult {
  const [positions, setPositions] = useState<BotPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPositions = async () => {
    try {
      setError(null);
      const { data, error: fetchError } = await supabase
        .from('bot_positions')
        .select('*')
        .order('synced_at', { ascending: false });

      if (fetchError) {
        throw fetchError;
      }

      setPositions(data || []);
    } catch (e) {
      console.error('Error fetching bot positions:', e);
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPositions();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('bot_positions_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bot_positions' },
        () => {
          // Refetch on any change
          fetchPositions();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const groupedPositions = useMemo<MarketPositionGroup[]>(() => {
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
      
      // Check if hedged (both UP and DOWN positions)
      const isHedged = upShares > 0 && downShares > 0;

      return {
        market_slug: slug,
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
        positions: marketPositions,
      };
    }).sort((a, b) => Math.abs(b.totalInvested) - Math.abs(a.totalInvested));
  }, [positions]);

  const summary = useMemo(() => {
    const totalInvested = groupedPositions.reduce((sum, g) => sum + g.totalInvested, 0);
    const totalValue = groupedPositions.reduce((sum, g) => sum + g.totalValue, 0);
    const hedgedMarkets = groupedPositions.filter(g => g.isHedged).length;

    return {
      totalPositions: positions.length,
      totalMarkets: groupedPositions.length,
      totalInvested,
      totalValue,
      totalPnl: totalValue - totalInvested,
      hedgedMarkets,
    };
  }, [positions, groupedPositions]);

  return {
    positions,
    groupedPositions,
    loading,
    error,
    refetch: fetchPositions,
    summary,
  };
}
