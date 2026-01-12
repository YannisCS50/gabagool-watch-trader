import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Asset } from './usePriceLatencyComparison';

export interface MarketPrice {
  asset: Asset;
  upBestBid: number | null;
  upBestAsk: number | null;
  upMid: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  downMid: number | null;
  upTokenId: string;
  downTokenId: string;
  marketSlug: string;
  eventEndTime: string;
  strikePrice?: number;
  lastUpdated: number;
}

export interface PolymarketPricesState {
  prices: Record<Asset, MarketPrice | null>;
  loading: boolean;
  error: string | null;
  lastFetch: number | null;
}

const REFRESH_INTERVAL_MS = 2000; // Refresh every 2 seconds

export function usePolymarketPrices() {
  const [state, setState] = useState<PolymarketPricesState>({
    prices: { BTC: null, ETH: null, SOL: null, XRP: null },
    loading: false,
    error: null,
    lastFetch: null,
  });

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  const fetchPrices = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      setState(prev => ({ ...prev, loading: true, error: null }));

      // Step 1: Get active market tokens
      const { data: marketsData, error: marketsError } = await supabase.functions.invoke('get-market-tokens', {
        body: { 
          assets: ['BTC', 'ETH', 'SOL', 'XRP'],
          marketTypes: ['15min', '1hour'],
          limit: 4 // One per asset
        }
      });

      if (marketsError) {
        throw new Error(`Failed to fetch markets: ${marketsError.message}`);
      }

      const markets: any[] = marketsData?.markets || [];
      
      if (markets.length === 0) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: 'No active markets found',
          lastFetch: Date.now(),
        }));
        return;
      }

      // Collect all token IDs to fetch prices for
      const tokenIds: string[] = [];
      const tokenToMarket: Record<string, { market: any; side: 'up' | 'down' }> = {};

      for (const market of markets) {
        if (market.upTokenId) {
          tokenIds.push(market.upTokenId);
          tokenToMarket[market.upTokenId] = { market, side: 'up' };
        }
        if (market.downTokenId) {
          tokenIds.push(market.downTokenId);
          tokenToMarket[market.downTokenId] = { market, side: 'down' };
        }
      }

      if (tokenIds.length === 0) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: 'No token IDs found',
          lastFetch: Date.now(),
        }));
        return;
      }

      // Step 2: Fetch CLOB prices for all tokens
      const { data: pricesData, error: pricesError } = await supabase.functions.invoke('clob-prices', {
        body: { tokenIds }
      });

      if (pricesError) {
        throw new Error(`Failed to fetch prices: ${pricesError.message}`);
      }

      const pricesMap = pricesData?.prices || {};

      // Step 3: Build price records per asset
      const newPrices: Record<Asset, MarketPrice | null> = {
        BTC: null,
        ETH: null,
        SOL: null,
        XRP: null,
      };

      for (const market of markets) {
        const asset = market.asset as Asset;
        const upPrice = pricesMap[market.upTokenId];
        const downPrice = pricesMap[market.downTokenId];

        newPrices[asset] = {
          asset,
          upBestBid: upPrice?.bestBid ?? null,
          upBestAsk: upPrice?.bestAsk ?? null,
          upMid: upPrice?.mid ?? null,
          downBestBid: downPrice?.bestBid ?? null,
          downBestAsk: downPrice?.bestAsk ?? null,
          downMid: downPrice?.mid ?? null,
          upTokenId: market.upTokenId,
          downTokenId: market.downTokenId,
          marketSlug: market.slug,
          eventEndTime: market.eventEndTime,
          strikePrice: market.strikePrice,
          lastUpdated: Date.now(),
        };
      }

      if (isMountedRef.current) {
        setState({
          prices: newPrices,
          loading: false,
          error: null,
          lastFetch: Date.now(),
        });
      }
    } catch (err) {
      console.error('[usePolymarketPrices] Error:', err);
      if (isMountedRef.current) {
        setState(prev => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : 'Unknown error',
          lastFetch: Date.now(),
        }));
      }
    }
  }, []);

  // Start/stop polling
  const startPolling = useCallback(() => {
    if (intervalRef.current) return;
    
    fetchPrices(); // Initial fetch
    intervalRef.current = setInterval(fetchPrices, REFRESH_INTERVAL_MS);
  }, [fetchPrices]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Auto-start on mount
  useEffect(() => {
    isMountedRef.current = true;
    startPolling();

    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  // Helper to get share price for an asset and direction
  const getSharePrice = useCallback((asset: Asset, direction: 'UP' | 'DOWN'): number | null => {
    const marketPrice = state.prices[asset];
    if (!marketPrice) return null;

    if (direction === 'UP') {
      // For buying UP, we pay the ask; mid is a good estimate
      return marketPrice.upMid ?? marketPrice.upBestAsk ?? null;
    } else {
      // For buying DOWN, we pay the ask; mid is a good estimate
      return marketPrice.downMid ?? marketPrice.downBestAsk ?? null;
    }
  }, [state.prices]);

  // Get best bid/ask for selling
  const getSellPrice = useCallback((asset: Asset, direction: 'UP' | 'DOWN'): number | null => {
    const marketPrice = state.prices[asset];
    if (!marketPrice) return null;

    if (direction === 'UP') {
      return marketPrice.upBestBid ?? null;
    } else {
      return marketPrice.downBestBid ?? null;
    }
  }, [state.prices]);

  return {
    ...state,
    fetchPrices,
    startPolling,
    stopPolling,
    getSharePrice,
    getSellPrice,
  };
}
