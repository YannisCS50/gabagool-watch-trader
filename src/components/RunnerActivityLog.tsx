import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Activity,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Zap,
  Server,
  TrendingUp,
  Trash2
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUsdcFromBaseUnits } from '@/lib/utils';
import { format } from 'date-fns';

interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'heartbeat' | 'trade_attempt' | 'trade_success' | 'trade_error' | 'connection' | 'market_update';
  message: string;
  details?: string;
  status: 'success' | 'error' | 'warning' | 'info';
}

export function RunnerActivityLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      // Fetch recent heartbeats
      const { data: heartbeats } = await supabase
        .from('runner_heartbeats')
        .select('*')
        .order('last_heartbeat', { ascending: false })
        .limit(10);

      // Fetch recent live trades
      const { data: trades } = await supabase
        .from('live_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      // Fetch pending orders
      const { data: orders } = await supabase
        .from('order_queue')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

      const newLogs: LogEntry[] = [];

      // Add heartbeat logs
      heartbeats?.forEach((hb) => {
        newLogs.push({
          id: `hb-${hb.id}`,
          timestamp: new Date(hb.last_heartbeat),
          type: 'heartbeat',
          message: `Runner ${hb.runner_id.substring(0, 20)}... heartbeat`,
          details: `Status: ${hb.status} | Markets: ${hb.markets_count} | Trades: ${hb.trades_count} | Balance: ${formatUsdcFromBaseUnits(hb.balance)}`,
          status: hb.status === 'active' ? 'success' : hb.status === 'offline' ? 'error' : 'warning'
        });
      });

      // Add trade logs
      trades?.forEach((trade) => {
        const hasOrderId = trade.order_id && trade.order_id !== 'null' && trade.order_id !== '';
        const isError = trade.status === 'failed' || !hasOrderId;
        
        newLogs.push({
          id: `trade-${trade.id}`,
          timestamp: new Date(trade.created_at!),
          type: isError ? 'trade_error' : trade.status === 'filled' ? 'trade_success' : 'trade_attempt',
          message: `${trade.asset} ${trade.outcome} @ $${Number(trade.price).toFixed(3)}`,
          details: hasOrderId 
            ? `Order ID: ${trade.order_id?.substring(0, 16)}... | Shares: ${trade.shares} | Total: $${Number(trade.total).toFixed(2)}`
            : `Status: ${trade.status} | NO ORDER ID - Trade not placed on Polymarket`,
          status: isError ? 'error' : trade.status === 'filled' ? 'success' : 'warning'
        });
      });

      // Add order queue logs
      orders?.forEach((order) => {
        const isError = order.status === 'failed';
        const isPending = order.status === 'pending';
        
        newLogs.push({
          id: `order-${order.id}`,
          timestamp: new Date(order.created_at),
          type: isError ? 'trade_error' : 'trade_attempt',
          message: `Order queued: ${order.asset} ${order.outcome}`,
          details: `Status: ${order.status}${order.error_message ? ` | Error: ${order.error_message}` : ''} | Price: $${Number(order.price).toFixed(3)}`,
          status: isError ? 'error' : isPending ? 'warning' : 'info'
        });
      });

      // Sort by timestamp descending
      newLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      
      setLogs(newLogs.slice(0, 50));
    } catch (err) {
      console.error('Error fetching logs:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
    
    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 5000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel('runner-activity-logs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runner_heartbeats' }, () => fetchLogs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_trades' }, () => fetchLogs())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_queue' }, () => fetchLogs())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getIcon = (type: LogEntry['type'], status: LogEntry['status']) => {
    if (status === 'error') return <XCircle className="w-4 h-4 text-red-500" />;
    if (status === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    
    switch (type) {
      case 'heartbeat':
        return <Server className="w-4 h-4 text-blue-500" />;
      case 'trade_success':
        return <CheckCircle className="w-4 h-4 text-emerald-500" />;
      case 'trade_attempt':
        return <TrendingUp className="w-4 h-4 text-primary" />;
      case 'connection':
        return <Zap className="w-4 h-4 text-amber-500" />;
      default:
        return <Activity className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: LogEntry['status']) => {
    switch (status) {
      case 'success':
        return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">OK</Badge>;
      case 'error':
        return <Badge variant="destructive">ERROR</Badge>;
      case 'warning':
        return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20">WARN</Badge>;
      default:
        return <Badge variant="secondary">INFO</Badge>;
    }
  };

  const errorCount = logs.filter(l => l.status === 'error').length;
  const successCount = logs.filter(l => l.status === 'success').length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Runner Activity Log
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-emerald-500">
              {successCount} OK
            </Badge>
            {errorCount > 0 && (
              <Badge variant="destructive">
                {errorCount} Errors
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? 'text-emerald-500' : ''}
            >
              <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4" ref={scrollRef}>
          {logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Activity className="w-8 h-8 mb-2 opacity-50" />
              <p>No activity logs yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className={`p-3 rounded-lg border ${
                    log.status === 'error' 
                      ? 'border-red-500/30 bg-red-500/5' 
                      : log.status === 'warning'
                      ? 'border-amber-500/30 bg-amber-500/5'
                      : log.status === 'success'
                      ? 'border-emerald-500/20 bg-emerald-500/5'
                      : 'border-border bg-muted/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      {getIcon(log.type, log.status)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{log.message}</span>
                          {getStatusBadge(log.status)}
                        </div>
                        {log.details && (
                          <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                            {log.details}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                      <Clock className="w-3 h-3" />
                      {format(log.timestamp, 'HH:mm:ss')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
