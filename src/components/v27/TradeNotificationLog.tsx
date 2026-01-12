import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { TrendingUp, TrendingDown, Bell, Trash2, Download } from 'lucide-react';
import type { PaperSignal } from '@/hooks/usePaperTraderData';

interface TradeNotification {
  id: string;
  timestamp: number;
  type: 'new' | 'filled' | 'sold' | 'failed' | 'update';
  asset: string;
  direction: string;
  price: number | null;
  pnl: number | null;
  exitType: string | null;
  message: string;
  signal: PaperSignal;
}

export function TradeNotificationLog() {
  const [notifications, setNotifications] = useState<TradeNotification[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const channel = supabase
      .channel('trade-notification-log')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'paper_signals',
        },
        (payload) => {
          const signal = payload.new as PaperSignal;
          const dirEmoji = signal.direction === 'UP' ? '🟢' : '🔴';
          const price = signal.share_price ? `${(signal.share_price * 100).toFixed(1)}¢` : '—';
          const bcDelta = signal.binance_chainlink_delta;
          const latencyMs = signal.binance_chainlink_latency_ms;
          const liveTag = signal.is_live ? '🔴 LIVE' : '📄 PAPER';
          
          addNotification({
            id: `${signal.id}-new`,
            timestamp: Date.now(),
            type: 'new',
            asset: signal.asset,
            direction: signal.direction,
            price: signal.share_price,
            pnl: null,
            exitType: null,
            message: `${liveTag} ${dirEmoji} NEW ${signal.asset} ${signal.direction} @ ${price} | B-CL Δ$${bcDelta?.toFixed(0) ?? '?'} (~${latencyMs ?? '?'}ms)`,
            signal,
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'paper_signals',
        },
        (payload) => {
          const signal = payload.new as PaperSignal;
          
          // Different notification based on status
          if (signal.status === 'filled' && payload.old.status !== 'filled') {
            const triggerPrice = signal.share_price ? `${(signal.share_price * 100).toFixed(1)}¢` : '—';
            const entryPrice = signal.entry_price ? `${(signal.entry_price * 100).toFixed(1)}¢` : '—';
            const bcDelta = signal.binance_chainlink_delta;
            const latencyMs = signal.binance_chainlink_latency_ms;
            const liveTag = signal.is_live ? '🔴' : '📄';
            
            addNotification({
              id: `${signal.id}-filled`,
              timestamp: Date.now(),
              type: 'filled',
              asset: signal.asset,
              direction: signal.direction,
              price: signal.entry_price,
              pnl: null,
              exitType: null,
              message: `${liveTag} 📦 FILLED ${signal.asset} ${signal.direction} | B-CL Δ$${bcDelta?.toFixed(0) ?? '?'} (~${latencyMs ?? '?'}ms) | Trigger@${triggerPrice} → Entry@${entryPrice}`,
              signal,
            });
          } else if (signal.status === 'sold') {
            const pnlEmoji = (signal.net_pnl ?? 0) >= 0 ? '✅' : '❌';
            const pnlStr = signal.net_pnl !== null 
              ? (signal.net_pnl >= 0 ? `+$${signal.net_pnl.toFixed(2)}` : `-$${Math.abs(signal.net_pnl).toFixed(2)}`)
              : '—';
            
            addNotification({
              id: `${signal.id}-sold`,
              timestamp: Date.now(),
              type: 'sold',
              asset: signal.asset,
              direction: signal.direction,
              price: signal.exit_price,
              pnl: signal.net_pnl,
              exitType: signal.exit_type,
              message: `${pnlEmoji} SOLD ${signal.asset} @ ${signal.exit_price ? (signal.exit_price * 100).toFixed(1) : '—'}¢ | PnL: ${pnlStr} | Exit: ${signal.exit_type?.toUpperCase() ?? '—'}`,
              signal,
            });
          } else if (signal.status === 'failed') {
            addNotification({
              id: `${signal.id}-failed`,
              timestamp: Date.now(),
              type: 'failed',
              asset: signal.asset,
              direction: signal.direction,
              price: signal.share_price,
              pnl: null,
              exitType: null,
              message: `⚠️ FAILED ${signal.asset} ${signal.direction} | ${signal.notes ?? 'Unknown reason'}`,
              signal,
            });
          }
        }
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
  
  const addNotification = (notification: TradeNotification) => {
    setNotifications(prev => {
      const updated = [notification, ...prev].slice(0, 100); // Keep max 100
      return updated;
    });
  };
  
  const clearNotifications = () => {
    setNotifications([]);
  };
  
  const downloadLog = () => {
    const content = notifications.map(n => 
      `[${new Date(n.timestamp).toISOString()}] ${n.message}`
    ).join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-notifications-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const getTypeColor = (type: TradeNotification['type']) => {
    switch (type) {
      case 'new': return 'bg-blue-500/20 text-blue-400';
      case 'filled': return 'bg-purple-500/20 text-purple-400';
      case 'sold': return 'bg-green-500/20 text-green-400';
      case 'failed': return 'bg-red-500/20 text-red-400';
      default: return 'bg-gray-500/20 text-gray-400';
    }
  };
  
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-center">
          <CardTitle className="text-lg flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Trade Notifications
            {notifications.length > 0 && (
              <Badge variant="secondary">{notifications.length}</Badge>
            )}
          </CardTitle>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={downloadLog} disabled={notifications.length === 0}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={clearNotifications} disabled={notifications.length === 0}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[300px]" ref={scrollRef}>
          {notifications.length === 0 ? (
            <div className="text-muted-foreground text-sm text-center p-8 border border-dashed rounded">
              No trade notifications yet. Trades will appear here in real-time.
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.map((n) => (
                <div 
                  key={n.id} 
                  className="p-3 bg-card border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {n.direction === 'UP' ? (
                        <TrendingUp className="h-4 w-4 text-green-400" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-400" />
                      )}
                      <Badge className={getTypeColor(n.type)}>
                        {n.type.toUpperCase()}
                      </Badge>
                      <span className="font-mono font-bold">{n.asset}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(n.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-mono">
                    {n.message}
                  </div>
                  {n.pnl !== null && (
                    <div className={`mt-1 text-lg font-bold ${n.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {n.pnl >= 0 ? '+' : ''}${n.pnl.toFixed(2)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
