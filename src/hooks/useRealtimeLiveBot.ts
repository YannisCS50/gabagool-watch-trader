import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

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
  const [isEnabled, setIsEnabledState] = useState(false);
  
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
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectDelay = 30000; // Max 30s between reconnects

  // Fetch enabled state from database
  useEffect(() => {
    const fetchEnabled = async () => {
      try {
        const { data } = await supabase
          .from('live_bot_settings')
          .select('is_enabled')
          .single();
        setIsEnabledState(data?.is_enabled ?? false);
      } catch {
        // Ignore errors
      }
    };
    fetchEnabled();
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      await supabase
        .from('live_bot_settings')
        .upsert({ 
          id: '00000000-0000-0000-0000-000000000001',
          is_enabled: enabled,
          updated_at: new Date().toISOString()
        });
      setIsEnabledState(enabled);
    } catch (err) {
      console.error('Error setting enabled state:', err);
    }
  }, []);

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
      reconnectAttemptsRef.current = 0; // Reset on successful connect
      setStatus((prev) => ({
        ...prev,
        isConnected: true,
        connectionState: 'connected',
        lastError: null,
        lastMessageAt: Date.now(),
      }));

      // Keep-alive ping every 15s (more aggressive)
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
          } catch (e) {
            console.warn('[LiveBot] Ping failed, reconnecting...', e);
            ws.close();
          }
        }
      }, 15000);

      // Ask server to send current status immediately
      try {
        ws.send(JSON.stringify({ type: 'status' }));
      } catch {}
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

          case 'signal':
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

      // Don't reconnect if bot is explicitly disabled
      if (event.reason?.includes('Bot disabled') || event.reason?.includes('DISABLED')) {
        console.log('[LiveBot] Bot is disabled, not reconnecting');
        return;
      }

      // Exponential backoff with max delay
      reconnectAttemptsRef.current++;
      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), maxReconnectDelay);
      console.log(`[LiveBot] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttemptsRef.current})`);
      
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };
  }, [clearTimers, wsUrl, maxReconnectDelay]);

  useEffect(() => {
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
    isEnabled,
    toggleEnabled,
    setEnabled,
  };
}
