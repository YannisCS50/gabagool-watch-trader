import { useState, useEffect, useCallback, useRef } from 'react';
import { usePaperBotSettings } from './usePaperBotSettings';

interface RealtimeTrade {
  slug: string;
  outcome: string;
  price: number;
  shares: number;
  slippage: number | null;
  reasoning: string;
}

interface RealtimeBotStatus {
  isConnected: boolean;
  isEnabled: boolean;
  marketsCount: number;
  tokensCount: number;
  lastTrades: RealtimeTrade[];
  logs: string[];
}

export function useRealtimePaperBot() {
  const { isEnabled } = usePaperBotSettings();
  const [status, setStatus] = useState<RealtimeBotStatus>({
    isConnected: false,
    isEnabled: false,
    marketsCount: 0,
    tokensCount: 0,
    lastTrades: [],
    logs: [],
  });
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (!isEnabled) {
      setStatus(prev => ({ ...prev, isEnabled: false, isConnected: false }));
      return;
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = `wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/paper-trade-realtime`;
    console.log('[RealtimeBot] Connecting to', wsUrl);
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[RealtimeBot] Connected');
      setStatus(prev => ({ ...prev, isConnected: true, isEnabled: true }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'enabled':
            setStatus(prev => ({ ...prev, isEnabled: true }));
            break;
            
          case 'disabled':
            setStatus(prev => ({ ...prev, isEnabled: false, isConnected: false }));
            break;
            
          case 'connected':
            setStatus(prev => ({
              ...prev,
              marketsCount: data.markets || 0,
              tokensCount: data.tokens || 0,
            }));
            break;
            
          case 'trade':
            setStatus(prev => ({
              ...prev,
              lastTrades: [...data.trades, ...prev.lastTrades].slice(0, 10),
            }));
            break;
            
          case 'log':
            setStatus(prev => ({
              ...prev,
              logs: [data.message, ...prev.logs].slice(0, 50),
            }));
            break;
            
          case 'disconnected':
            setStatus(prev => ({ ...prev, isConnected: false }));
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = (error) => {
      console.error('[RealtimeBot] WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('[RealtimeBot] Disconnected');
      setStatus(prev => ({ ...prev, isConnected: false }));
      
      // Reconnect after delay if still enabled
      if (isEnabled) {
        reconnectTimeoutRef.current = setTimeout(() => {
          connect();
        }, 5000);
      }
    };

    // Keep-alive ping
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    return () => {
      clearInterval(pingInterval);
    };
  }, [isEnabled]);

  useEffect(() => {
    if (isEnabled) {
      connect();
    } else {
      // Disconnect when disabled
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      setStatus(prev => ({ ...prev, isConnected: false, isEnabled: false }));
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [isEnabled, connect]);

  return status;
}
