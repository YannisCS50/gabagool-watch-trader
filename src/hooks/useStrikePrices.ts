import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface StrikePrice {
  market_slug: string;
  strike_price: number;
  asset: string;
  event_start_time: string;
}

export function useStrikePrices() {
  const [strikePrices, setStrikePrices] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);

  const fetchStrikePrices = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('strike_prices')
        .select('market_slug, strike_price')
        .order('event_start_time', { ascending: false })
        .limit(100);

      if (error) throw error;

      const priceMap: Record<string, number> = {};
      for (const row of data || []) {
        priceMap[row.market_slug] = row.strike_price;
      }
      setStrikePrices(priceMap);
    } catch (err) {
      console.error('Error fetching strike prices:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrikePrices();
  }, [fetchStrikePrices]);

  const getStrikePrice = useCallback((marketSlug: string): number | null => {
    return strikePrices[marketSlug] ?? null;
  }, [strikePrices]);

  return {
    strikePrices,
    getStrikePrice,
    isLoading,
    refetch: fetchStrikePrices,
  };
}
