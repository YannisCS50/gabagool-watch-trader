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

const SYMBOL_MAP: Record<Asset, { binance: string; chainlink: string }> = {
  BTC: { binance: 'btcusdt', chainlink: 'btc/usd' },
  ETH: { binance: 'ethusdt', chainlink: 'eth/usd' },
  SOL: { binance: 'solusdt', chainlink: 'sol/usd' },
  XRP: { binance: 'xrpusdt', chainlink: 'xrp/usd' },
};

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/';
const MAX_TICKS = 1000;
const MAX_MEASUREMENTS = 500;

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
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const lastBinanceTickRef = useRef<Map<string, PriceTick>>(new Map());

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
    }));
    lastBinanceTickRef.current.clear();
  }, []);

  const handleBinanceTick = useCallback((payload: { symbol: string; timestamp: number; value: number }, receivedAt: number) => {
    const tick: PriceTick = {
      source: 'binance',
      symbol: payload.symbol,
      price: payload.value,
      timestamp: payload.timestamp,
      receivedAt,
    };

    lastBinanceTickRef.current.set(payload.symbol, tick);

    setState(prev => {
      const binanceSymbol = SYMBOL_MAP[prev.selectedAsset].binance;
      const isCurrentAsset = payload.symbol === binanceSymbol;

      const newBinanceTicks = [...prev.binanceTicks, tick].slice(-MAX_TICKS);
      const newEventLog = isCurrentAsset 
        ? [{ timestamp: receivedAt, source: 'binance' as const, symbol: payload.symbol, price: payload.value }, ...prev.eventLog].slice(0, 100)
        : prev.eventLog;

      return {
        ...prev,
        binanceTicks: newBinanceTicks,
        totalBinanceTicks: prev.totalBinanceTicks + 1,
        binancePrice: isCurrentAsset ? payload.value : prev.binancePrice,
        binanceLastUpdate: isCurrentAsset ? payload.timestamp : prev.binanceLastUpdate,
        eventLog: newEventLog,
      };
    });
  }, []);

  const handleChainlinkTick = useCallback((payload: { symbol: string; timestamp: number; value: number }, receivedAt: number) => {
    const tick: PriceTick = {
      source: 'chainlink',
      symbol: payload.symbol,
      price: payload.value,
      timestamp: payload.timestamp,
      receivedAt,
    };

    setState(prev => {
      const chainlinkSymbol = SYMBOL_MAP[prev.selectedAsset].chainlink;
      const binanceSymbol = SYMBOL_MAP[prev.selectedAsset].binance;
      const isCurrentAsset = payload.symbol === chainlinkSymbol;

      // Find matching Binance tick for latency calculation
      const matchingBinanceTick = lastBinanceTickRef.current.get(binanceSymbol);
      let newMeasurement: LatencyMeasurement | null = null;
      let latencyLead: number | undefined;

      if (matchingBinanceTick && isCurrentAsset) {
        const latencyMs = payload.timestamp - matchingBinanceTick.timestamp;
        latencyLead = latencyMs;
        newMeasurement = {
          binanceTimestamp: matchingBinanceTick.timestamp,
          chainlinkTimestamp: payload.timestamp,
          latencyMs,
          priceDiff: Math.abs(payload.value - matchingBinanceTick.price),
          measuredAt: receivedAt,
        };
      }

      const newChainlinkTicks = [...prev.chainlinkTicks, tick].slice(-MAX_TICKS);
      const newMeasurements = newMeasurement 
        ? [...prev.latencyMeasurements, newMeasurement].slice(-MAX_MEASUREMENTS)
        : prev.latencyMeasurements;

      const newEventLog = isCurrentAsset 
        ? [{ timestamp: receivedAt, source: 'chainlink' as const, symbol: payload.symbol, price: payload.value, latencyLead }, ...prev.eventLog].slice(0, 100)
        : prev.eventLog;

      return {
        ...prev,
        chainlinkTicks: newChainlinkTicks,
        totalChainlinkTicks: prev.totalChainlinkTicks + 1,
        chainlinkPrice: isCurrentAsset ? payload.value : prev.chainlinkPrice,
        chainlinkLastUpdate: isCurrentAsset ? payload.timestamp : prev.chainlinkLastUpdate,
        latencyMeasurements: newMeasurements,
        eventLog: newEventLog,
      };
    });
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setState(prev => ({ ...prev, connectionStatus: 'connecting' }));

    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setState(prev => ({ ...prev, connectionStatus: 'connected' }));
        
        // Subscribe to both feeds
        ws.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices",
              type: "update",
              filters: "btcusdt,ethusdt,solusdt,xrpusdt"
            },
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              filters: ""
            }
          ]
        }));
      };

      ws.onmessage = (event) => {
        const receivedAt = Date.now();
        try {
          const data = JSON.parse(event.data);
          
          if (data.topic === 'crypto_prices' && data.payload) {
            handleBinanceTick(data.payload, receivedAt);
          } else if (data.topic === 'crypto_prices_chainlink' && data.payload) {
            handleChainlinkTick(data.payload, receivedAt);
          }
        } catch (e) {
          console.error('Failed to parse WS message:', e);
        }
      };

      ws.onerror = () => {
        setState(prev => ({ ...prev, connectionStatus: 'error' }));
      };

      ws.onclose = () => {
        setState(prev => ({ ...prev, connectionStatus: 'disconnected' }));
        wsRef.current = null;
        
        // Auto-reconnect after 3 seconds
        reconnectTimeoutRef.current = window.setTimeout(() => {
          connect();
        }, 3000);
      };
    } catch (e) {
      console.error('WebSocket connection error:', e);
      setState(prev => ({ ...prev, connectionStatus: 'error' }));
    }
  }, [handleBinanceTick, handleChainlinkTick]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setState(prev => ({ ...prev, connectionStatus: 'disconnected' }));
  }, []);

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

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
