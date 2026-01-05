import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLiveBotSettings } from './useLiveBotSettings';

interface RealtimeLiveTrade {
  market: string;
  outcome: string;
  price: number;
  shares: number;
  orderId?: string;
}

interface RealtimeRedemption {
  market: string;
  result: string;
  payout: number;
  profitLoss: number;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface RealtimeLiveBotStatus {
  isConnected: boolean;
  connectionState: ConnectionState;
  lastError: string | null;
  lastMessageAt: number | null;
  isEnabled: boolean;
  marketsCount: number;
  positionsCount: number;
  lastTrades: RealtimeLiveTrade[];
  lastRedemptions: RealtimeRedemption[];
  logs: string[];
}

function getFunctionsWsUrl(path: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) return `wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/${path}`;
  const wsBase = base.replace(/^http/, 'ws');
  return `${wsBase}/functions/v1/${path}`;
}

export function useRealtimeLiveBot() {
  const { isEnabled, setEnabled } = useLiveBotSettings();

  const wsUrl = useMemo(() => getFunctionsWsUrl('live-trade-realtime'), []);

  const [status, setStatus] = useState<RealtimeLiveBotStatus>({
    isConnected: false,
    connectionState: 'disconnected',
    lastError: null,
    lastMessageAt: null,
    isEnabled: false,
    marketsCount: 0,
    positionsCount: 0,
    lastTrades: [],
    lastRedemptions: [],
    logs: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimers = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    clearTimers();

    // Close existing connection
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    setStatus((prev) => ({
      ...prev,
      connectionState: 'connecting',
      lastError: null,
    }));

    console.log('[LiveBot] Connecting to', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[LiveBot] WebSocket connected');
      setStatus((prev) => ({
        ...prev,
        isConnected: true,
        connectionState: 'connected',
        lastError: null,
        lastMessageAt: Date.now(),
      }));

      // Keep-alive ping
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      // Ask server to send current status immediately
      ws.send(JSON.stringify({ type: 'status' }));
    };

    ws.onmessage = (event) => {
      setStatus((prev) => ({ ...prev, lastMessageAt: Date.now() }));

      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'status':
            setStatus((prev) => ({
              ...prev,
              isEnabled: !!data.isEnabled,
              marketsCount: data.marketsCount || 0,
              positionsCount: data.positionsCount || 0,
            }));
            break;

          // Live bot emits `signal` when it queues an order
          case 'signal':
            setStatus((prev) => ({
              ...prev,
              lastTrades: [
                {
                  market: data.market,
                  outcome: data.outcome,
                  price: data.price,
                  shares: data.shares,
                  orderId: data.orderId,
                },
                ...prev.lastTrades,
              ].slice(0, 20),
            }));
            break;

          // Backwards-compatible (if server ever emits these)
          case 'trade':
            setStatus((prev) => ({
              ...prev,
              lastTrades: [
                {
                  market: data.market,
                  outcome: data.outcome,
                  price: data.price,
                  shares: data.shares,
                  orderId: data.orderId,
                },
                ...prev.lastTrades,
              ].slice(0, 20),
            }));
            break;

          case 'redemption':
            setStatus((prev) => ({
              ...prev,
              lastRedemptions: [
                {
                  market: data.market,
                  result: data.result,
                  payout: data.payout,
                  profitLoss: data.profitLoss,
                },
                ...prev.lastRedemptions,
              ].slice(0, 10),
            }));
            break;

          case 'log':
            setStatus((prev) => ({
              ...prev,
              logs: [data.message, ...prev.logs].slice(0, 100),
            }));
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      // Browser WebSocket error event is opaque; keep it user-friendly.
      setStatus((prev) => ({
        ...prev,
        isConnected: false,
        connectionState: 'error',
        lastError: 'WebSocket connection error',
      }));
    };

    ws.onclose = (event) => {
      console.log('[LiveBot] WebSocket disconnected', event.code, event.reason);
      setStatus((prev) => ({
        ...prev,
        isConnected: false,
        connectionState: 'disconnected',
      }));

      clearTimers();

      // Always reconnect (bot checks enabled state internally)
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };
  }, [clearTimers, wsUrl]);

  useEffect(() => {
    // Always connect - the bot checks enabled state internally
    connect();

    return () => {
      clearTimers();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
    };
  }, [connect, clearTimers]);

  const toggleEnabled = useCallback(async () => {
    await setEnabled(!isEnabled);
  }, [isEnabled, setEnabled]);

  return {
    ...status,
    // Expose persisted state as the source of truth for UI toggles
    isEnabled,
    toggleEnabled,
    setEnabled,
  };
}
