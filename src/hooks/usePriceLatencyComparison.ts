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

  // Connection robustness
  const manualDisconnectRef = useRef(false);
  const reconnectRef = useRef({
    binance: { attempt: 0, timer: null as ReturnType<typeof setTimeout> | null },
    chainlink: { attempt: 0, timer: null as ReturnType<typeof setTimeout> | null },
  });
  const chainlinkClientPingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const deriveConnectionStatus = useCallback(
    (binanceWsStatus: PriceLatencyState['binanceWsStatus'], chainlinkWsStatus: PriceLatencyState['chainlinkWsStatus']): PriceLatencyState['connectionStatus'] => {
      if (binanceWsStatus === 'connected' && chainlinkWsStatus === 'connected') return 'connected';
      if (binanceWsStatus === 'connecting' || chainlinkWsStatus === 'connecting') return 'connecting';
      if (binanceWsStatus === 'error' || chainlinkWsStatus === 'error') return 'error';
      return 'disconnected';
    },
    [],
  );

  const setBinanceWsStatus = useCallback(
    (status: PriceLatencyState['binanceWsStatus'], lastError?: string | null) => {
      setState(prev => {
        const next = {
          ...prev,
          binanceWsStatus: status,
          lastError: lastError ?? prev.lastError,
        };
        return { ...next, connectionStatus: deriveConnectionStatus(next.binanceWsStatus, next.chainlinkWsStatus) };
      });
    },
    [deriveConnectionStatus],
  );

  const setChainlinkWsStatus = useCallback(
    (status: PriceLatencyState['chainlinkWsStatus'], lastError?: string | null) => {
      setState(prev => {
        const next = {
          ...prev,
          chainlinkWsStatus: status,
          lastError: lastError ?? prev.lastError,
        };
        return { ...next, connectionStatus: deriveConnectionStatus(next.binanceWsStatus, next.chainlinkWsStatus) };
      });
    },
    [deriveConnectionStatus],
  );

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

  const connect = useCallback(() => {
    manualDisconnectRef.current = false;

    const isActive = (ws: WebSocket | null) =>
      ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING;

    const scheduleReconnect = (key: 'binance' | 'chainlink', reason: string) => {
      if (manualDisconnectRef.current) return;

      const slot = reconnectRef.current[key];
      if (slot.timer) return;

      const base = 500; // ms
      const cap = 30_000;
      const delay = Math.min(cap, base * Math.pow(2, slot.attempt));
      const jitter = Math.floor(delay * 0.3 * Math.random());
      const wait = delay + jitter;

      slot.timer = setTimeout(() => {
        slot.timer = null;
        slot.attempt = Math.min(slot.attempt + 1, 10);
        connect();
      }, wait);

      console.warn(`[PriceLatency] ${key} reconnect scheduled in ${wait}ms (${reason})`);
    };

    const binanceActive = isActive(binanceWsRef.current);
    const chainlinkActive = isActive(chainlinkWsRef.current);

    if (!binanceActive) {
      setBinanceWsStatus('connecting', null);

      const streams = Object.values(SYMBOL_MAP).map(s => s.binanceWs).join('/');
      const binanceWsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;

      const ws = new WebSocket(binanceWsUrl);
      binanceWsRef.current = ws;

      ws.onopen = () => {
        reconnectRef.current.binance.attempt = 0;
        console.log('[PriceLatency] Binance WebSocket connected');
        setBinanceWsStatus('connected', null);
      };

      ws.onmessage = (event) => {
        try {
          const wrapper = JSON.parse(event.data);
          if (wrapper?.data) {
            handleBinanceMessage({ data: JSON.stringify(wrapper.data) } as MessageEvent);
          }
        } catch (err) {
          console.error('[PriceLatency] Binance WS message parse error:', err);
        }
      };

      ws.onerror = () => {
        setBinanceWsStatus('error', 'Binance WebSocket error');
      };

      ws.onclose = (event) => {
        console.warn('[PriceLatency] Binance WebSocket closed', event.code, event.reason);
        setBinanceWsStatus('disconnected');
        scheduleReconnect('binance', `close ${event.code}`);
      };
    }

    if (!chainlinkActive) {
      if (!RTDS_PROXY_WS_URL) {
        setChainlinkWsStatus('error', 'Missing backend base URL (VITE_SUPABASE_URL)');
        return;
      }

      setChainlinkWsStatus('connecting', null);

      // Clear client keepalive from any previous socket
      if (chainlinkClientPingRef.current) {
        clearInterval(chainlinkClientPingRef.current);
        chainlinkClientPingRef.current = null;
      }

      console.log('[PriceLatency] Connecting to RTDS proxy for Chainlink prices...');
      const ws = new WebSocket(RTDS_PROXY_WS_URL);
      chainlinkWsRef.current = ws;

      ws.onopen = () => {
        // We keep status as "connecting" until we receive proxy_connected.
        console.log('[PriceLatency] RTDS proxy socket open');

        // Client-side keepalive (helps against idle timeouts between browser  backend)
        chainlinkClientPingRef.current = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ action: 'ping' }));
            }
          } catch {
            // ignore
          }
        }, 25_000);
      };

      ws.onmessage = (event) => {
        // Subscribe as soon as proxy confirms it connected upstream
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'proxy_connected') {
            reconnectRef.current.chainlink.attempt = 0;
            setChainlinkWsStatus('connected', null);
            ws.send(
              JSON.stringify({
                action: 'subscribe',
                subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }],
              }),
            );
            return;
          }

          if (msg?.type === 'proxy_error') {
            setChainlinkWsStatus('error', String(msg?.error || 'RTDS proxy error'));
            try { ws.close(); } catch { /* ignore */ }
            return;
          }

          if (msg?.type === 'proxy_disconnected') {
            setChainlinkWsStatus('error', 'RTDS proxy disconnected');
            try { ws.close(); } catch { /* ignore */ }
            return;
          }
        } catch {
          // non-JSON - ignore
        }

        handleRtdsMessage(event);
      };

      ws.onerror = () => {
        setChainlinkWsStatus('error', 'RTDS proxy WebSocket error');
      };

      ws.onclose = (event) => {
        console.warn('[PriceLatency] RTDS proxy WebSocket closed', event.code, event.reason);
        if (chainlinkClientPingRef.current) {
          clearInterval(chainlinkClientPingRef.current);
          chainlinkClientPingRef.current = null;
        }
        setChainlinkWsStatus('disconnected');
        scheduleReconnect('chainlink', `close ${event.code}`);
      };
    }
  }, [handleBinanceMessage, handleRtdsMessage, setBinanceWsStatus, setChainlinkWsStatus]);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;

    // Clear reconnect timers
    for (const key of ['binance', 'chainlink'] as const) {
      const slot = reconnectRef.current[key];
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.attempt = 0;
    }

    if (chainlinkClientPingRef.current) {
      clearInterval(chainlinkClientPingRef.current);
      chainlinkClientPingRef.current = null;
    }

    if (binanceWsRef.current) {
      try { binanceWsRef.current.close(); } catch { /* ignore */ }
      binanceWsRef.current = null;
    }

    if (chainlinkWsRef.current) {
      try { chainlinkWsRef.current.close(); } catch { /* ignore */ }
      chainlinkWsRef.current = null;
    }

    setState(prev => ({
      ...prev,
      connectionStatus: 'disconnected',
      binanceWsStatus: 'disconnected',
      chainlinkWsStatus: 'disconnected',
      lastError: null,
    }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      manualDisconnectRef.current = true;

      for (const key of ['binance', 'chainlink'] as const) {
        const slot = reconnectRef.current[key];
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
      }

      if (chainlinkClientPingRef.current) {
        clearInterval(chainlinkClientPingRef.current);
        chainlinkClientPingRef.current = null;
      }

      if (binanceWsRef.current) {
        try { binanceWsRef.current.close(); } catch { /* ignore */ }
      }
      if (chainlinkWsRef.current) {
        try { chainlinkWsRef.current.close(); } catch { /* ignore */ }
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