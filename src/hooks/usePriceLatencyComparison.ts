import { useState, useEffect, useCallback, useRef } from 'react';

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

// Polymarket RTDS asset mapping
const RTDS_ASSET_MAP: Record<string, Asset> = {
  'BTC': 'BTC',
  'ETH': 'ETH',
  'SOL': 'SOL',
  'XRP': 'XRP',
};

const MAX_TICKS = 2000;
const MAX_MEASUREMENTS = 1000;

// Polymarket RTDS WebSocket URL (public, no auth needed)
const RTDS_WS_URL = 'wss://ws-live-data.polymarket.com';

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
  chainlinkWsStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
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
    chainlinkWsStatus: 'disconnected',
  });

  const binanceWsRef = useRef<WebSocket | null>(null);
  const chainlinkWsRef = useRef<WebSocket | null>(null);
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
      
      if (data.e === 'trade') {
        const symbol = data.s.toLowerCase();
        const price = parseFloat(data.p);
        const tradeTime = data.T;
        
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
          
          const lastChainlink = lastChainlinkPriceRef.current.get(asset);
          if (lastChainlink && isCurrentAsset) {
            const latencyMs = tradeTime - lastChainlink.timestamp;
            latencyLead = -latencyMs;
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

  // Handle Polymarket RTDS message (contains oracle_price events with Chainlink data)
  const handleRtdsMessage = useCallback((event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      const receivedAt = Date.now();
      
      // RTDS sends oracle_price events with Chainlink prices
      // Format: { type: "oracle_price", asset: "BTC", price: 94523.12, timestamp: 1736569200000 }
      if (msg.type === 'oracle_price' || msg.event === 'oracle_price' || msg.oracle_price) {
        const data = msg.oracle_price || msg;
        const assetStr = (data.asset || data.symbol || '').toUpperCase();
        const asset = RTDS_ASSET_MAP[assetStr];
        
        if (!asset) return;
        
        const price = parseFloat(data.price);
        if (isNaN(price)) return;
        
        // Use the timestamp from RTDS or current time
        const timestamp = data.timestamp ? Number(data.timestamp) : receivedAt;
        
        const chainlinkSymbol = SYMBOL_MAP[asset].chainlink;
        
        const tick: PriceTick = {
          source: 'chainlink',
          symbol: chainlinkSymbol,
          price,
          timestamp,
          receivedAt,
        };

        lastChainlinkPriceRef.current.set(asset, { price, timestamp });
        
        console.log(`[RTDS] Chainlink ${asset}: $${price.toFixed(2)}`);

        setState(prev => {
          const isCurrentAsset = asset === prev.selectedAsset;
          const newChainlinkTicks = [...prev.chainlinkTicks, tick].slice(-MAX_TICKS);
          
          let newMeasurements = prev.latencyMeasurements;
          let latencyLead: number | undefined;
          
          const lastBinance = lastBinancePriceRef.current.get(asset);
          if (lastBinance && isCurrentAsset) {
            const latencyMs = timestamp - lastBinance.timestamp;
            latencyLead = latencyMs;
            newMeasurements = [...prev.latencyMeasurements, {
              binanceTimestamp: lastBinance.timestamp,
              chainlinkTimestamp: timestamp,
              latencyMs,
              priceDiff: Math.abs(price - lastBinance.price),
              measuredAt: receivedAt,
            }].slice(-MAX_MEASUREMENTS);
          }

          const newEventLog = isCurrentAsset 
            ? [{ timestamp: receivedAt, source: 'chainlink' as const, symbol: chainlinkSymbol, price, latencyLead }, ...prev.eventLog].slice(0, 200)
            : prev.eventLog;

          return {
            ...prev,
            chainlinkPrice: isCurrentAsset ? price : prev.chainlinkPrice,
            chainlinkLastUpdate: isCurrentAsset ? timestamp : prev.chainlinkLastUpdate,
            chainlinkTicks: newChainlinkTicks,
            latencyMeasurements: newMeasurements,
            eventLog: newEventLog,
            totalChainlinkTicks: prev.totalChainlinkTicks + 1,
          };
        });
      }
      
      // Also check for price updates in different formats RTDS might use
      if (msg.prices || msg.data?.prices) {
        const prices = msg.prices || msg.data.prices;
        for (const [key, value] of Object.entries(prices)) {
          const assetStr = key.toUpperCase();
          const asset = RTDS_ASSET_MAP[assetStr];
          if (!asset) continue;
          
          const price = typeof value === 'number' ? value : parseFloat(value as string);
          if (isNaN(price)) continue;
          
          const timestamp = receivedAt;
          const chainlinkSymbol = SYMBOL_MAP[asset].chainlink;
          
          lastChainlinkPriceRef.current.set(asset, { price, timestamp });
          
          setState(prev => {
            const isCurrentAsset = asset === prev.selectedAsset;
            const tick: PriceTick = {
              source: 'chainlink',
              symbol: chainlinkSymbol,
              price,
              timestamp,
              receivedAt,
            };
            
            return {
              ...prev,
              chainlinkPrice: isCurrentAsset ? price : prev.chainlinkPrice,
              chainlinkLastUpdate: isCurrentAsset ? timestamp : prev.chainlinkLastUpdate,
              chainlinkTicks: [...prev.chainlinkTicks, tick].slice(-MAX_TICKS),
              totalChainlinkTicks: prev.totalChainlinkTicks + 1,
            };
          });
        }
      }
    } catch (err) {
      // Non-JSON message or parse error - ignore
    }
  }, []);

  const connect = useCallback(async () => {
    if (binanceWsRef.current?.readyState === WebSocket.OPEN) return;

    setState(prev => ({ 
      ...prev, 
      connectionStatus: 'connecting', 
      binanceWsStatus: 'connecting',
      chainlinkWsStatus: 'connecting',
    }));

    // 1. Connect to Binance WebSocket for real-time CEX prices
    const streams = Object.values(SYMBOL_MAP).map(s => s.binanceWs).join('/');
    const binanceWsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
    
    const binanceWs = new WebSocket(binanceWsUrl);
    binanceWsRef.current = binanceWs;

    binanceWs.onopen = () => {
      console.log('Binance WebSocket connected');
      setState(prev => ({ ...prev, binanceWsStatus: 'connected' }));
    };

    binanceWs.onmessage = (event) => {
      try {
        const wrapper = JSON.parse(event.data);
        if (wrapper.data) {
          handleBinanceMessage({ data: JSON.stringify(wrapper.data) } as MessageEvent);
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    };

    binanceWs.onerror = (error) => {
      console.error('Binance WebSocket error:', error);
      setState(prev => ({ ...prev, binanceWsStatus: 'error' }));
    };

    binanceWs.onclose = () => {
      console.log('Binance WebSocket closed');
      setState(prev => ({ ...prev, binanceWsStatus: 'disconnected' }));
    };

    // 2. Connect to Polymarket RTDS for Chainlink oracle prices
    // This is the SAME data Polymarket uses for settlement - no API key needed!
    try {
      console.log('Connecting to Polymarket RTDS for Chainlink prices...');
      const chainlinkWs = new WebSocket(RTDS_WS_URL);
      chainlinkWsRef.current = chainlinkWs;

      chainlinkWs.onopen = () => {
        console.log('Polymarket RTDS WebSocket connected');
        setState(prev => ({ ...prev, chainlinkWsStatus: 'connected' }));
        
        // Subscribe to oracle price updates for all assets
        // RTDS subscription format
        const subscriptions = [
          { action: 'subscribe', channel: 'oracle', assets: ['BTC', 'ETH', 'SOL', 'XRP'] },
          { action: 'subscribe', channel: 'price', assets: ['BTC', 'ETH', 'SOL', 'XRP'] },
        ];
        
        for (const sub of subscriptions) {
          chainlinkWs.send(JSON.stringify(sub));
        }
        
        console.log('Subscribed to RTDS oracle channels');
      };

      chainlinkWs.onmessage = handleRtdsMessage;

      chainlinkWs.onerror = (error) => {
        console.error('RTDS WebSocket error:', error);
        setState(prev => ({ ...prev, chainlinkWsStatus: 'error' }));
      };

      chainlinkWs.onclose = () => {
        console.log('RTDS WebSocket closed');
        setState(prev => ({ ...prev, chainlinkWsStatus: 'disconnected' }));
      };

    } catch (err) {
      console.error('RTDS connection error:', err);
      setState(prev => ({ 
        ...prev, 
        chainlinkWsStatus: 'error',
        lastError: err instanceof Error ? err.message : 'RTDS connection failed',
      }));
    }

    // Update overall connection status
    setState(prev => ({
      ...prev,
      connectionStatus: 'connected',
      lastError: null,
    }));

  }, [handleBinanceMessage, handleRtdsMessage]);

  const disconnect = useCallback(() => {
    if (binanceWsRef.current) {
      binanceWsRef.current.close();
      binanceWsRef.current = null;
    }
    if (chainlinkWsRef.current) {
      chainlinkWsRef.current.close();
      chainlinkWsRef.current = null;
    }
    setState(prev => ({ 
      ...prev, 
      connectionStatus: 'disconnected',
      binanceWsStatus: 'disconnected',
      chainlinkWsStatus: 'disconnected',
    }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (binanceWsRef.current) {
        binanceWsRef.current.close();
      }
      if (chainlinkWsRef.current) {
        chainlinkWsRef.current.close();
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