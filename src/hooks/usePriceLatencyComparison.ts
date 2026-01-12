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

// Polymarket RTDS via our backend WebSocket proxy (avoids browser/network quirks)
const PROJECT_BASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const RTDS_PROXY_WS_URL = PROJECT_BASE_URL
  ? `${PROJECT_BASE_URL.replace(/^http/, 'ws')}/functions/v1/rtds-proxy`
  : null;

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

  // Handle RTDS proxy messages (crypto_prices_chainlink topic)
  const handleRtdsMessage = useCallback((event: MessageEvent) => {
    const receivedAt = Date.now();

    try {
      const msg = JSON.parse(event.data);

      // Proxy control messages
      if (msg?.type === 'proxy_error') {
        console.error('[RTDS] proxy_error:', msg?.error);
        setState(prev => ({ ...prev, chainlinkWsStatus: 'error', lastError: String(msg?.error || 'RTDS proxy error') }));
        return;
      }

      if (msg?.type === 'proxy_disconnected') {
        console.warn('[RTDS] proxy_disconnected:', msg?.code);
        setState(prev => ({ ...prev, chainlinkWsStatus: 'error', lastError: 'RTDS proxy disconnected' }));
        return;
      }

      // Chainlink crypto prices
      // Expected: { topic: "crypto_prices_chainlink", payload: { symbol: "btc/usd", value: 98765.43, timestamp?: ... } }
      if (msg?.topic === 'crypto_prices_chainlink' && msg?.payload) {
        const symbolRaw = String(msg.payload.symbol || msg.payload.asset || msg.payload.ticker || '').toLowerCase();
        const valueRaw =
          typeof msg.payload.value === 'number'
            ? msg.payload.value
            : typeof msg.payload.price === 'number'
              ? msg.payload.price
              : typeof msg.payload.p === 'number'
                ? msg.payload.p
                : null;

        if (valueRaw === null) return;

        let asset: Asset | null = null;
        if (symbolRaw.includes('btc')) asset = 'BTC';
        else if (symbolRaw.includes('eth')) asset = 'ETH';
        else if (symbolRaw.includes('sol')) asset = 'SOL';
        else if (symbolRaw.includes('xrp')) asset = 'XRP';

        if (!asset) return;

        const timestamp =
          typeof msg.payload.timestamp === 'number'
            ? msg.payload.timestamp
            : typeof msg.payload.ts === 'number'
              ? msg.payload.ts
              : typeof msg.payload.timestampMs === 'number'
                ? msg.payload.timestampMs
                : receivedAt;

        const chainlinkSymbol = SYMBOL_MAP[asset].chainlink;

        const tick: PriceTick = {
          source: 'chainlink',
          symbol: chainlinkSymbol,
          price: valueRaw,
          timestamp,
          receivedAt,
        };

        lastChainlinkPriceRef.current.set(asset, { price: valueRaw, timestamp });

        setState(prev => {
          const isCurrentAsset = asset === prev.selectedAsset;
          const newChainlinkTicks = [...prev.chainlinkTicks, tick].slice(-MAX_TICKS);

          let newMeasurements = prev.latencyMeasurements;
          let latencyLead: number | undefined;

          const lastBinance = lastBinancePriceRef.current.get(asset);
          if (lastBinance && isCurrentAsset) {
            const latencyMs = timestamp - lastBinance.timestamp;
            latencyLead = latencyMs;
            newMeasurements =
              [...prev.latencyMeasurements, {
                binanceTimestamp: lastBinance.timestamp,
                chainlinkTimestamp: timestamp,
                latencyMs,
                priceDiff: Math.abs(valueRaw - lastBinance.price),
                measuredAt: receivedAt,
              }].slice(-MAX_MEASUREMENTS);
          }

          const newEventLog = isCurrentAsset
            ? [{ timestamp: receivedAt, source: 'chainlink' as const, symbol: chainlinkSymbol, price: valueRaw, latencyLead }, ...prev.eventLog].slice(0, 200)
            : prev.eventLog;

          return {
            ...prev,
            chainlinkPrice: isCurrentAsset ? valueRaw : prev.chainlinkPrice,
            chainlinkLastUpdate: isCurrentAsset ? timestamp : prev.chainlinkLastUpdate,
            chainlinkTicks: newChainlinkTicks,
            latencyMeasurements: newMeasurements,
            eventLog: newEventLog,
            totalChainlinkTicks: prev.totalChainlinkTicks + 1,
          };
        });

        return;
      }

      // Some RTDS variants may broadcast a price map
      if (msg?.prices || msg?.data?.prices) {
        const prices = msg.prices || msg.data.prices;
        for (const [key, value] of Object.entries(prices)) {
          const assetStr = String(key).toUpperCase();
          const mapped = RTDS_ASSET_MAP[assetStr];
          if (!mapped) continue;

          const price = typeof value === 'number' ? value : parseFloat(value as string);
          if (isNaN(price)) continue;

          const chainlinkSymbol = SYMBOL_MAP[mapped].chainlink;
          const tick: PriceTick = {
            source: 'chainlink',
            symbol: chainlinkSymbol,
            price,
            timestamp: receivedAt,
            receivedAt,
          };

          lastChainlinkPriceRef.current.set(mapped, { price, timestamp: receivedAt });

          setState(prev => {
            const isCurrentAsset = mapped === prev.selectedAsset;
            return {
              ...prev,
              chainlinkPrice: isCurrentAsset ? price : prev.chainlinkPrice,
              chainlinkLastUpdate: isCurrentAsset ? receivedAt : prev.chainlinkLastUpdate,
              chainlinkTicks: [...prev.chainlinkTicks, tick].slice(-MAX_TICKS),
              totalChainlinkTicks: prev.totalChainlinkTicks + 1,
            };
          });
        }
      }
    } catch {
      // Non-JSON message (e.g. PONG) - ignore
    }
  }, []);

  const connect = useCallback(async () => {
    const isActive = (ws: WebSocket | null) =>
      ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;

    const binanceActive = isActive(binanceWsRef.current);
    const chainlinkActive = isActive(chainlinkWsRef.current);

    // If both streams are already up (or mid-connecting), nothing to do.
    if (binanceActive && chainlinkActive) return;

    setState(prev => ({
      ...prev,
      connectionStatus: 'connecting',
      binanceWsStatus: binanceActive ? prev.binanceWsStatus : 'connecting',
      chainlinkWsStatus: chainlinkActive ? prev.chainlinkWsStatus : 'connecting',
    }));

    // 1) Binance: real-time CEX prices
    if (!binanceActive) {
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
    }

    // 2) Chainlink: via RTDS backend proxy
    if (!chainlinkActive) {
      try {
        if (!RTDS_PROXY_WS_URL) {
          throw new Error('Missing backend base URL (VITE_SUPABASE_URL)');
        }

        console.log('Connecting to RTDS proxy for Chainlink prices...');
        const chainlinkWs = new WebSocket(RTDS_PROXY_WS_URL);
        chainlinkWsRef.current = chainlinkWs;

        chainlinkWs.onopen = () => {
          console.log('RTDS proxy WebSocket connected');
          setState(prev => ({ ...prev, chainlinkWsStatus: 'connected' }));
        };

        chainlinkWs.onmessage = (event) => {
          // Subscribe as soon as proxy confirms it connected upstream
          try {
            const msg = JSON.parse(event.data);
            if (msg?.type === 'proxy_connected') {
              chainlinkWs.send(
                JSON.stringify({
                  action: 'subscribe',
                  subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }],
                }),
              );
              return;
            }
          } catch {
            // ignore
          }

          handleRtdsMessage(event);
        };

        chainlinkWs.onerror = (error) => {
          console.error('RTDS proxy WebSocket error:', error);
          setState(prev => ({ ...prev, chainlinkWsStatus: 'error', lastError: 'RTDS proxy WebSocket error' }));
        };

        chainlinkWs.onclose = () => {
          console.log('RTDS proxy WebSocket closed');
          setState(prev => ({ ...prev, chainlinkWsStatus: 'disconnected' }));
        };
      } catch (err) {
        console.error('RTDS proxy connection error:', err);
        setState(prev => ({
          ...prev,
          chainlinkWsStatus: 'error',
          lastError: err instanceof Error ? err.message : 'RTDS proxy connection failed',
        }));
      }
    }

    // Mark overall connection as active (individual statuses will reflect actual state)
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

  // Get all live prices (for use by other components like LiveMarketMonitor)
  const getAllPrices = useCallback(() => {
    const prices: Record<Asset, { binance: number | null; chainlink: number | null; binanceTs: number | null; chainlinkTs: number | null }> = {
      BTC: { binance: null, chainlink: null, binanceTs: null, chainlinkTs: null },
      ETH: { binance: null, chainlink: null, binanceTs: null, chainlinkTs: null },
      SOL: { binance: null, chainlink: null, binanceTs: null, chainlinkTs: null },
      XRP: { binance: null, chainlink: null, binanceTs: null, chainlinkTs: null },
    };

    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP'] as Asset[]) {
      const binanceData = lastBinancePriceRef.current.get(asset);
      const chainlinkData = lastChainlinkPriceRef.current.get(asset);
      
      if (binanceData) {
        prices[asset].binance = binanceData.price;
        prices[asset].binanceTs = binanceData.timestamp;
      }
      if (chainlinkData) {
        prices[asset].chainlink = chainlinkData.price;
        prices[asset].chainlinkTs = chainlinkData.timestamp;
      }
    }

    return prices;
  }, []);

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
    getAllPrices,
  };
}