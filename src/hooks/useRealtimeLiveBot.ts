import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveBotPersistence } from './useLiveBotPersistence';

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

interface RealtimeLiveBotStatus {
  isConnected: boolean;
  isEnabled: boolean;
  marketsCount: number;
  positionsCount: number;
  lastTrades: RealtimeLiveTrade[];
  lastRedemptions: RealtimeRedemption[];
  logs: string[];
}

export function useRealtimeLiveBot() {
  const { isEnabled, setEnabled } = useLiveBotPersistence();
  const [status, setStatus] = useState<RealtimeLiveBotStatus>({
    isConnected: false,
    isEnabled: false,
    marketsCount: 0,
    positionsCount: 0,
    lastTrades: [],
    lastRedemptions: [],
    logs: [],
  });
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = `wss://iuzpdjplasndyvbzhlzd.supabase.co/functions/v1/live-trade-realtime`;
    console.log('[LiveBot] Connecting to', wsUrl);
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[LiveBot] WebSocket connected');
      setStatus(prev => ({ ...prev, isConnected: true }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'status':
            setStatus(prev => ({
              ...prev,
              isEnabled: data.isEnabled,
              marketsCount: data.marketsCount || 0,
              positionsCount: data.positionsCount || 0,
            }));
            break;
            
          case 'trade':
            setStatus(prev => ({
              ...prev,
              lastTrades: [{
                market: data.market,
                outcome: data.outcome,
                price: data.price,
                shares: data.shares,
                orderId: data.orderId,
              }, ...prev.lastTrades].slice(0, 20),
            }));
            break;
            
          case 'redemption':
            setStatus(prev => ({
              ...prev,
              lastRedemptions: [{
                market: data.market,
                result: data.result,
                payout: data.payout,
                profitLoss: data.profitLoss,
              }, ...prev.lastRedemptions].slice(0, 10),
            }));
            break;
            
          case 'log':
            setStatus(prev => ({
              ...prev,
              logs: [data.message, ...prev.logs].slice(0, 100),
            }));
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = (error) => {
      console.error('[LiveBot] WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('[LiveBot] WebSocket disconnected');
      setStatus(prev => ({ ...prev, isConnected: false }));
      
      // Always reconnect (bot checks enabled state internally)
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
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
  }, []);

  useEffect(() => {
    // Always connect - the bot checks enabled state internally
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

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
