import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface StrikePrice {
  market_slug: string;
  strike_price: number;
  asset: string;
  event_start_time: string;
}

const REFRESH_INTERVAL_MS = 30000; // 30 seconds

export function useStrikePrices() {
  const [strikePrices, setStrikePrices] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  const fetchStrikePrices = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('strike_prices')
        .select('market_slug, strike_price')
        .order('event_start_time', { ascending: false })
        .limit(100);

      if (error) throw error;
      if (!mountedRef.current) return;

      const priceMap: Record<string, number> = {};
      for (const row of data || []) {
        priceMap[row.market_slug] = row.strike_price;
      }
      setStrikePrices(priceMap);
      setLastUpdate(new Date());
    } catch (err) {
      console.error('[StrikePrices] Error fetching:', err);
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchStrikePrices();

    // Auto-refresh every 30 seconds to catch new markets
    const interval = setInterval(fetchStrikePrices, REFRESH_INTERVAL_MS);

    // Subscribe to realtime updates for new strike prices
    const channel = supabase
      .channel('strike_prices_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'strike_prices' },
        (payload) => {
          console.log('[StrikePrices] New strike price:', payload.new);
          if (mountedRef.current && payload.new) {
            const newRow = payload.new as { market_slug: string; strike_price: number };
            setStrikePrices(prev => ({
              ...prev,
              [newRow.market_slug]: newRow.strike_price
            }));
            setLastUpdate(new Date());
          }
        }
      )
      .subscribe();

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [fetchStrikePrices]);

  const getStrikePrice = useCallback((marketSlug: string): number | null => {
    return strikePrices[marketSlug] ?? null;
  }, [strikePrices]);

  return {
    strikePrices,
    getStrikePrice,
    isLoading,
    lastUpdate,
    refetch: fetchStrikePrices,
  };
}
