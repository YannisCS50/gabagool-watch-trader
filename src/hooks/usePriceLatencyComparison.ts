import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PriceTick {
  source: 'binance' | 'chainlink';
  symbol: string;
  price: number;
  timestamp: number;
  receivedAt: number;
}

export interface LatencyMeasurement {
  binanceTimestamp: number;
  chainlinkTimestamp: number;
  latencyMs: number;
  priceDiff: number;
  measuredAt: number;
}

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';

const SYMBOL_MAP: Record<Asset, { binance: string; chainlink: string }> = {
  BTC: { binance: 'btcusdt', chainlink: 'btc/usd' },
  ETH: { binance: 'ethusdt', chainlink: 'eth/usd' },
  SOL: { binance: 'solusdt', chainlink: 'sol/usd' },
  XRP: { binance: 'xrpusdt', chainlink: 'xrp/usd' },
};

const MAX_TICKS = 1000;
const MAX_MEASUREMENTS = 500;
const POLL_INTERVAL_MS = 500; // Poll every 500ms

interface PriceLatencyState {
  selectedAsset: Asset;
  binancePrice: number | null;
  chainlinkPrice: number | null;
  binanceLastUpdate: number | null;
  chainlinkLastUpdate: number | null;
  binanceTicks: PriceTick[];
  chainlinkTicks: PriceTick[];
  latencyMeasurements: LatencyMeasurement[];
  sessionStart: number;
  totalBinanceTicks: number;
  totalChainlinkTicks: number;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  eventLog: Array<{ timestamp: number; source: 'binance' | 'chainlink'; symbol: string; price: number; latencyLead?: number }>;
  lastError: string | null;
}

export function usePriceLatencyComparison() {
  const [state, setState] = useState<PriceLatencyState>({
    selectedAsset: 'BTC',
    binancePrice: null,
    chainlinkPrice: null,
    binanceLastUpdate: null,
    chainlinkLastUpdate: null,
    binanceTicks: [],
    chainlinkTicks: [],
    latencyMeasurements: [],
    sessionStart: Date.now(),
    totalBinanceTicks: 0,
    totalChainlinkTicks: 0,
    connectionStatus: 'disconnected',
    eventLog: [],
    lastError: null,
  });

  const pollIntervalRef = useRef<number | null>(null);
  const isPollingRef = useRef(false);
  const lastBinancePriceRef = useRef<Map<string, { price: number; timestamp: number }>>(new Map());

  const setSelectedAsset = useCallback((asset: Asset) => {
    setState(prev => ({ ...prev, selectedAsset: asset }));
  }, []);

  const clearEventLog = useCallback(() => {
    setState(prev => ({ ...prev, eventLog: [] }));
  }, []);

  const resetSession = useCallback(() => {
    setState(prev => ({
      ...prev,
      binanceTicks: [],
      chainlinkTicks: [],
      latencyMeasurements: [],
      sessionStart: Date.now(),
      totalBinanceTicks: 0,
      totalChainlinkTicks: 0,
      eventLog: [],
      binancePrice: null,
      chainlinkPrice: null,
      binanceLastUpdate: null,
      chainlinkLastUpdate: null,
    }));
    lastBinancePriceRef.current.clear();
  }, []);

  // Fetch prices from the edge function
  const fetchPrices = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const receivedAt = Date.now();

      // Call the price-feeds edge function for Binance + Chainlink prices
      const { data, error } = await supabase.functions.invoke('price-feeds', {
        body: { assets: ['BTC', 'ETH', 'SOL', 'XRP'] }
      });

      if (error) throw error;

      if (data?.prices) {
        setState(prev => {
          const updates: Partial<PriceLatencyState> = {};
          let newBinanceTicks = [...prev.binanceTicks];
          let newChainlinkTicks = [...prev.chainlinkTicks];
          let newMeasurements = [...prev.latencyMeasurements];
          let newEventLog = [...prev.eventLog];
          let totalBinance = prev.totalBinanceTicks;
          let totalChainlink = prev.totalChainlinkTicks;

          for (const [asset, priceData] of Object.entries(data.prices as Record<string, { binance?: number; chainlink?: number; binance_ts?: number; chainlink_ts?: number }>)) {
            const binanceSymbol = SYMBOL_MAP[asset as Asset]?.binance;
            const chainlinkSymbol = SYMBOL_MAP[asset as Asset]?.chainlink;
            const isCurrentAsset = asset === prev.selectedAsset;

            // Handle Binance price
            if (priceData.binance && binanceSymbol) {
              const ts = priceData.binance_ts || receivedAt;
              const lastPrice = lastBinancePriceRef.current.get(asset);
              
              // Only add if price changed
              if (!lastPrice || lastPrice.price !== priceData.binance) {
                const tick: PriceTick = {
                  source: 'binance',
                  symbol: binanceSymbol,
                  price: priceData.binance,
                  timestamp: ts,
                  receivedAt,
                };
                newBinanceTicks = [...newBinanceTicks, tick].slice(-MAX_TICKS);
                totalBinance++;
                lastBinancePriceRef.current.set(asset, { price: priceData.binance, timestamp: ts });

                if (isCurrentAsset) {
                  updates.binancePrice = priceData.binance;
                  updates.binanceLastUpdate = ts;
                  newEventLog = [
                    { timestamp: receivedAt, source: 'binance' as const, symbol: binanceSymbol, price: priceData.binance },
                    ...newEventLog
                  ].slice(0, 100);
                }
              }
            }

            // Handle Chainlink price
            if (priceData.chainlink && chainlinkSymbol) {
              const ts = priceData.chainlink_ts || receivedAt;
              const tick: PriceTick = {
                source: 'chainlink',
                symbol: chainlinkSymbol,
                price: priceData.chainlink,
                timestamp: ts,
                receivedAt,
              };
              
              // Check if different from last
              const lastChainlink = newChainlinkTicks.find(t => t.symbol === chainlinkSymbol);
              if (!lastChainlink || lastChainlink.price !== priceData.chainlink) {
                newChainlinkTicks = [...newChainlinkTicks, tick].slice(-MAX_TICKS);
                totalChainlink++;

                // Calculate latency if we have matching Binance
                const lastBinance = lastBinancePriceRef.current.get(asset);
                let latencyLead: number | undefined;
                if (lastBinance && isCurrentAsset) {
                  const latencyMs = ts - lastBinance.timestamp;
                  latencyLead = latencyMs;
                  newMeasurements = [...newMeasurements, {
                    binanceTimestamp: lastBinance.timestamp,
                    chainlinkTimestamp: ts,
                    latencyMs,
                    priceDiff: Math.abs(priceData.chainlink - lastBinance.price),
                    measuredAt: receivedAt,
                  }].slice(-MAX_MEASUREMENTS);
                }

                if (isCurrentAsset) {
                  updates.chainlinkPrice = priceData.chainlink;
                  updates.chainlinkLastUpdate = ts;
                  newEventLog = [
                    { timestamp: receivedAt, source: 'chainlink' as const, symbol: chainlinkSymbol, price: priceData.chainlink, latencyLead },
                    ...newEventLog
                  ].slice(0, 100);
                }
              }
            }
          }

          return {
            ...prev,
            ...updates,
            binanceTicks: newBinanceTicks,
            chainlinkTicks: newChainlinkTicks,
            latencyMeasurements: newMeasurements,
            eventLog: newEventLog,
            totalBinanceTicks: totalBinance,
            totalChainlinkTicks: totalChainlink,
            connectionStatus: 'connected',
            lastError: null,
          };
        });
      }
    } catch (err) {
      console.error('Failed to fetch prices:', err);
      setState(prev => ({
        ...prev,
        connectionStatus: 'error',
        lastError: err instanceof Error ? err.message : 'Failed to fetch prices',
      }));
    } finally {
      isPollingRef.current = false;
    }
  }, []);

  const connect = useCallback(() => {
    if (pollIntervalRef.current) return;

    setState(prev => ({ ...prev, connectionStatus: 'connecting' }));

    // Initial fetch
    fetchPrices();

    // Start polling
    pollIntervalRef.current = window.setInterval(() => {
      fetchPrices();
    }, POLL_INTERVAL_MS);
  }, [fetchPrices]);

  const disconnect = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setState(prev => ({ ...prev, connectionStatus: 'disconnected' }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // Calculate derived statistics
  const stats = {
    currentLatency: state.latencyMeasurements.length > 0 
      ? state.latencyMeasurements[state.latencyMeasurements.length - 1].latencyMs 
      : null,
    avgLatency: state.latencyMeasurements.length > 0
      ? state.latencyMeasurements.reduce((sum, m) => sum + m.latencyMs, 0) / state.latencyMeasurements.length
      : null,
    minLatency: state.latencyMeasurements.length > 0
      ? Math.min(...state.latencyMeasurements.map(m => m.latencyMs))
      : null,
    maxLatency: state.latencyMeasurements.length > 0
      ? Math.max(...state.latencyMeasurements.map(m => m.latencyMs))
      : null,
    priceDiff: state.binancePrice && state.chainlinkPrice 
      ? Math.abs(state.binancePrice - state.chainlinkPrice)
      : null,
    priceDiffPercent: state.binancePrice && state.chainlinkPrice
      ? (Math.abs(state.binancePrice - state.chainlinkPrice) / state.binancePrice) * 100
      : null,
    binanceLeadPct: state.latencyMeasurements.length > 0
      ? (state.latencyMeasurements.filter(m => m.latencyMs > 0).length / state.latencyMeasurements.length) * 100
      : null,
    sessionDuration: Date.now() - state.sessionStart,
    binanceUpdatesPerSec: state.totalBinanceTicks / ((Date.now() - state.sessionStart) / 1000) || 0,
    chainlinkUpdatesPerSec: state.totalChainlinkTicks / ((Date.now() - state.sessionStart) / 1000) || 0,
  };

  // Get chart data (last 60 seconds of ticks for current asset)
  const getChartData = useCallback(() => {
    const now = Date.now();
    const sixtySecondsAgo = now - 60000;
    const binanceSymbol = SYMBOL_MAP[state.selectedAsset].binance;
    const chainlinkSymbol = SYMBOL_MAP[state.selectedAsset].chainlink;

    const binanceData = state.binanceTicks
      .filter(t => t.symbol === binanceSymbol && t.receivedAt >= sixtySecondsAgo)
      .map(t => ({ time: t.receivedAt, price: t.price, source: 'binance' }));

    const chainlinkData = state.chainlinkTicks
      .filter(t => t.symbol === chainlinkSymbol && t.receivedAt >= sixtySecondsAgo)
      .map(t => ({ time: t.receivedAt, price: t.price, source: 'chainlink' }));

    return { binanceData, chainlinkData };
  }, [state.binanceTicks, state.chainlinkTicks, state.selectedAsset]);

  // Get latency histogram data
  const getLatencyHistogram = useCallback(() => {
    const bins = [0, 50, 100, 150, 200, 250, 300];
    const histogram = bins.map((min, i) => {
      const max = bins[i + 1] ?? Infinity;
      const count = state.latencyMeasurements.filter(m => m.latencyMs >= min && m.latencyMs < max).length;
      return { range: `${min}-${max === Infinity ? '+' : max}ms`, count };
    });
    return histogram;
  }, [state.latencyMeasurements]);

  return {
    ...state,
    stats,
    setSelectedAsset,
    clearEventLog,
    resetSession,
    connect,
    disconnect,
    getChartData,
    getLatencyHistogram,
  };
}
