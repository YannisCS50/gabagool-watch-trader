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

const SYMBOL_MAP: Record<Asset, { binance: string; binanceWs: string; chainlink: string }> = {
  BTC: { binance: 'btcusdt', binanceWs: 'btcusdt@trade', chainlink: 'btc/usd' },
  ETH: { binance: 'ethusdt', binanceWs: 'ethusdt@trade', chainlink: 'eth/usd' },
  SOL: { binance: 'solusdt', binanceWs: 'solusdt@trade', chainlink: 'sol/usd' },
  XRP: { binance: 'xrpusdt', binanceWs: 'xrpusdt@trade', chainlink: 'xrp/usd' },
};

const MAX_TICKS = 2000;
const MAX_MEASUREMENTS = 1000;
const CHAINLINK_POLL_MS = 500; // Chainlink updates ~1/sec on-chain

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
  binanceWsStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
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
    binanceWsStatus: 'disconnected',
  });

  const binanceWsRef = useRef<WebSocket | null>(null);
  const chainlinkPollRef = useRef<number | null>(null);
  const lastBinancePriceRef = useRef<Map<string, { price: number; timestamp: number }>>(new Map());
  const lastChainlinkPriceRef = useRef<Map<string, { price: number; timestamp: number }>>(new Map());

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
    lastChainlinkPriceRef.current.clear();
  }, []);

  // Handle Binance WebSocket message
  const handleBinanceMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      const receivedAt = Date.now();
      
      // Trade stream format: { e: "trade", s: "BTCUSDT", p: "12345.67", T: 1234567890123 }
      if (data.e === 'trade') {
        const symbol = data.s.toLowerCase();
        const price = parseFloat(data.p);
        const tradeTime = data.T; // Exchange timestamp in ms
        
        // Find which asset this is
        const asset = Object.entries(SYMBOL_MAP).find(([_, v]) => v.binance === symbol)?.[0] as Asset | undefined;
        if (!asset) return;

        const tick: PriceTick = {
          source: 'binance',
          symbol,
          price,
          timestamp: tradeTime,
          receivedAt,
        };

        lastBinancePriceRef.current.set(asset, { price, timestamp: tradeTime });

        setState(prev => {
          const isCurrentAsset = asset === prev.selectedAsset;
          const newBinanceTicks = [...prev.binanceTicks, tick].slice(-MAX_TICKS);
          
          let newMeasurements = prev.latencyMeasurements;
          let latencyLead: number | undefined;
          
          // Calculate latency against last Chainlink price for this asset
          const lastChainlink = lastChainlinkPriceRef.current.get(asset);
          if (lastChainlink && isCurrentAsset) {
            // Binance timestamp vs Chainlink timestamp
            const latencyMs = tradeTime - lastChainlink.timestamp;
            latencyLead = -latencyMs; // Negative means Binance is ahead
            newMeasurements = [...prev.latencyMeasurements, {
              binanceTimestamp: tradeTime,
              chainlinkTimestamp: lastChainlink.timestamp,
              latencyMs: latencyMs,
              priceDiff: Math.abs(price - lastChainlink.price),
              measuredAt: receivedAt,
            }].slice(-MAX_MEASUREMENTS);
          }

          const newEventLog = isCurrentAsset 
            ? [{ timestamp: receivedAt, source: 'binance' as const, symbol, price, latencyLead }, ...prev.eventLog].slice(0, 200)
            : prev.eventLog;

          return {
            ...prev,
            binancePrice: isCurrentAsset ? price : prev.binancePrice,
            binanceLastUpdate: isCurrentAsset ? tradeTime : prev.binanceLastUpdate,
            binanceTicks: newBinanceTicks,
            latencyMeasurements: newMeasurements,
            eventLog: newEventLog,
            totalBinanceTicks: prev.totalBinanceTicks + 1,
          };
        });
      }
    } catch (err) {
      console.error('Binance WS parse error:', err);
    }
  }, []);

  // Fetch Chainlink prices via edge function
  const fetchChainlinkPrices = useCallback(async () => {
    try {
      const receivedAt = Date.now();
      const { data, error } = await supabase.functions.invoke('price-feeds', {
        body: { assets: ['BTC', 'ETH', 'SOL', 'XRP'], chainlinkOnly: true }
      });

      if (error) throw error;

      if (data?.prices) {
        setState(prev => {
          let newChainlinkTicks = [...prev.chainlinkTicks];
          let newMeasurements = [...prev.latencyMeasurements];
          let newEventLog = [...prev.eventLog];
          let totalChainlink = prev.totalChainlinkTicks;
          let updates: Partial<PriceLatencyState> = {};

          for (const [asset, priceData] of Object.entries(data.prices as Record<string, { chainlink?: number; chainlink_ts?: number }>)) {
            if (!priceData.chainlink) continue;
            
            const chainlinkSymbol = SYMBOL_MAP[asset as Asset]?.chainlink;
            if (!chainlinkSymbol) continue;
            
            const ts = priceData.chainlink_ts || receivedAt;
            const price = priceData.chainlink;
            const isCurrentAsset = asset === prev.selectedAsset;

            // Check if price changed
            const lastPrice = lastChainlinkPriceRef.current.get(asset);
            if (lastPrice && lastPrice.price === price && Math.abs(lastPrice.timestamp - ts) < 100) {
              continue; // Skip duplicate
            }

            lastChainlinkPriceRef.current.set(asset, { price, timestamp: ts });

            const tick: PriceTick = {
              source: 'chainlink',
              symbol: chainlinkSymbol,
              price,
              timestamp: ts,
              receivedAt,
            };
            newChainlinkTicks = [...newChainlinkTicks, tick].slice(-MAX_TICKS);
            totalChainlink++;

            // Calculate latency vs Binance
            const lastBinance = lastBinancePriceRef.current.get(asset);
            let latencyLead: number | undefined;
            if (lastBinance && isCurrentAsset) {
              const latencyMs = ts - lastBinance.timestamp;
              latencyLead = latencyMs;
              newMeasurements = [...newMeasurements, {
                binanceTimestamp: lastBinance.timestamp,
                chainlinkTimestamp: ts,
                latencyMs,
                priceDiff: Math.abs(price - lastBinance.price),
                measuredAt: receivedAt,
              }].slice(-MAX_MEASUREMENTS);
            }

            if (isCurrentAsset) {
              updates.chainlinkPrice = price;
              updates.chainlinkLastUpdate = ts;
              newEventLog = [
                { timestamp: receivedAt, source: 'chainlink' as const, symbol: chainlinkSymbol, price, latencyLead },
                ...newEventLog
              ].slice(0, 200);
            }
          }

          return {
            ...prev,
            ...updates,
            chainlinkTicks: newChainlinkTicks,
            latencyMeasurements: newMeasurements,
            eventLog: newEventLog,
            totalChainlinkTicks: totalChainlink,
          };
        });
      }
    } catch (err) {
      console.error('Chainlink fetch error:', err);
    }
  }, []);

  const connect = useCallback(() => {
    // Already connected
    if (binanceWsRef.current?.readyState === WebSocket.OPEN) return;

    setState(prev => ({ ...prev, connectionStatus: 'connecting', binanceWsStatus: 'connecting' }));

    // Connect to Binance WebSocket for all assets
    const streams = Object.values(SYMBOL_MAP).map(s => s.binanceWs).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    const ws = new WebSocket(wsUrl);
    binanceWsRef.current = ws;

    ws.onopen = () => {
      console.log('Binance WebSocket connected');
      setState(prev => ({ 
        ...prev, 
        connectionStatus: 'connected', 
        binanceWsStatus: 'connected',
        lastError: null 
      }));
    };

    ws.onmessage = (event) => {
      try {
        const wrapper = JSON.parse(event.data);
        // Combined stream format: { stream: "btcusdt@trade", data: {...} }
        if (wrapper.data) {
          handleBinanceMessage({ data: JSON.stringify(wrapper.data) } as MessageEvent);
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('Binance WebSocket error:', error);
      setState(prev => ({ 
        ...prev, 
        connectionStatus: 'error', 
        binanceWsStatus: 'error',
        lastError: 'WebSocket connection failed' 
      }));
    };

    ws.onclose = () => {
      console.log('Binance WebSocket closed');
      setState(prev => ({ 
        ...prev, 
        connectionStatus: prev.connectionStatus === 'error' ? 'error' : 'disconnected',
        binanceWsStatus: 'disconnected' 
      }));
    };

    // Start Chainlink polling
    fetchChainlinkPrices();
    chainlinkPollRef.current = window.setInterval(fetchChainlinkPrices, CHAINLINK_POLL_MS);

  }, [handleBinanceMessage, fetchChainlinkPrices]);

  const disconnect = useCallback(() => {
    if (binanceWsRef.current) {
      binanceWsRef.current.close();
      binanceWsRef.current = null;
    }
    if (chainlinkPollRef.current) {
      clearInterval(chainlinkPollRef.current);
      chainlinkPollRef.current = null;
    }
    setState(prev => ({ 
      ...prev, 
      connectionStatus: 'disconnected',
      binanceWsStatus: 'disconnected' 
    }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (binanceWsRef.current) {
        binanceWsRef.current.close();
      }
      if (chainlinkPollRef.current) {
        clearInterval(chainlinkPollRef.current);
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
    const bins = [-500, -200, -100, -50, 0, 50, 100, 200, 500];
    const histogram = bins.map((min, i) => {
      const max = bins[i + 1] ?? Infinity;
      const count = state.latencyMeasurements.filter(m => m.latencyMs >= min && m.latencyMs < max).length;
      const label = max === Infinity ? `>${min}ms` : min < 0 ? `${min} to ${max}ms` : `${min}-${max}ms`;
      return { range: label, count, isNegative: min < 0 };
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
