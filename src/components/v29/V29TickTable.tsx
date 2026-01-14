import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Bell, CheckCircle, Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

interface V29Tick {
  id: string;
  ts: number;
  created_at: string;
  run_id: string | null;
  asset: string;
  binance_price: number | null;
  chainlink_price: number | null;
  binance_delta: number | null;
  up_best_ask: number | null;
  up_best_bid: number | null;
  down_best_ask: number | null;
  down_best_bid: number | null;
  alert_triggered: boolean;
  signal_direction: string | null;
  order_placed: boolean;
  order_id: string | null;
  fill_price: number | null;
  fill_size: number | null;
  market_slug: string | null;
  strike_price: number | null;
  order_latency_ms: number | null;
  fill_latency_ms: number | null;
  signal_to_fill_ms: number | null;
  sign_latency_ms: number | null;
  post_latency_ms: number | null;
  used_cache: boolean | null;
}

interface AlertGroup {
  id: string;
  alertTick: V29Tick;
  beforeTicks: V29Tick[];
  afterTicks: V29Tick[];
  fillTick: V29Tick | null;
}

interface V29TickTableProps {
  assetFilter?: string;
  maxRows?: number;
}

export function V29TickTable({ assetFilter = 'ALL', maxRows = 1000 }: V29TickTableProps) {
  const [ticks, setTicks] = useState<V29Tick[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const fetchTicks = async () => {
    setLoading(ticks.length === 0);
    
    let query = supabase
      .from('v29_ticks')
      .select('*')
      .order('ts', { ascending: false })
      .limit(maxRows);
    
    if (assetFilter !== 'ALL') {
      query = query.eq('asset', assetFilter);
    }
    
    const { data, error } = await query;
    
    if (data && !error) {
      setTicks(data as V29Tick[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchTicks();
    const interval = setInterval(fetchTicks, 3000);
    return () => clearInterval(interval);
  }, [assetFilter, maxRows]);

  useEffect(() => {
    const channel = supabase
      .channel('v29-ticks-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v29_ticks' },
        (payload) => {
          const tick = payload.new as V29Tick;
          if (assetFilter === 'ALL' || tick.asset === assetFilter) {
            setTicks(prev => [tick, ...prev].slice(0, maxRows));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [assetFilter, maxRows]);

  // Group ticks around alerts: 5 before, alert, fill, 5 after
  const alertGroups = useMemo((): AlertGroup[] => {
    const groups: AlertGroup[] = [];
    const sortedTicks = [...ticks].sort((a, b) => a.ts - b.ts); // oldest first for context
    
    // Find all alerts WITH fills (alert_triggered=true AND fill_price IS NOT NULL)
    // These are the "complete" alert+fill records
    const alertsWithFills = sortedTicks.filter(t => t.alert_triggered && t.fill_price !== null);
    
    // Also find alerts without fills (blocked, skipped, etc.)
    const alertsWithoutFills = sortedTicks.filter(t => t.alert_triggered && t.fill_price === null);
    
    // Process alerts with fills first
    for (const alertTick of alertsWithFills) {
      const alertIdx = sortedTicks.indexOf(alertTick);
      const beforeTicks: V29Tick[] = [];
      const afterTicks: V29Tick[] = [];
      
      // Get 5 ticks before (same asset, not alert ticks)
      let beforeCount = 0;
      for (let i = alertIdx - 1; i >= 0 && beforeCount < 5; i--) {
        if (sortedTicks[i].asset === alertTick.asset && !sortedTicks[i].alert_triggered) {
          beforeTicks.unshift(sortedTicks[i]);
          beforeCount++;
        }
      }
      
      // Get 5 ticks after (same asset, not alert ticks)
      let afterCount = 0;
      for (let i = alertIdx + 1; i < sortedTicks.length && afterCount < 5; i++) {
        if (sortedTicks[i].asset === alertTick.asset && !sortedTicks[i].alert_triggered) {
          afterTicks.push(sortedTicks[i]);
          afterCount++;
        }
      }
      
      groups.push({
        id: alertTick.id,
        alertTick,
        beforeTicks,
        afterTicks,
        fillTick: alertTick, // The alert tick IS the fill tick (same record)
      });
    }
    
    // Process alerts without fills (blocked/skipped)
    for (const alertTick of alertsWithoutFills) {
      const alertIdx = sortedTicks.indexOf(alertTick);
      const beforeTicks: V29Tick[] = [];
      const afterTicks: V29Tick[] = [];
      
      // Get 5 ticks before
      let beforeCount = 0;
      for (let i = alertIdx - 1; i >= 0 && beforeCount < 5; i--) {
        if (sortedTicks[i].asset === alertTick.asset && !sortedTicks[i].alert_triggered) {
          beforeTicks.unshift(sortedTicks[i]);
          beforeCount++;
        }
      }
      
      // Get 5 ticks after
      let afterCount = 0;
      for (let i = alertIdx + 1; i < sortedTicks.length && afterCount < 5; i++) {
        if (sortedTicks[i].asset === alertTick.asset && !sortedTicks[i].alert_triggered) {
          afterTicks.push(sortedTicks[i]);
          afterCount++;
        }
      }
      
      groups.push({
        id: alertTick.id,
        alertTick,
        beforeTicks,
        afterTicks,
        fillTick: null, // No fill
      });
    }
    
    // Sort by timestamp descending (newest first)
    return groups.sort((a, b) => b.alertTick.ts - a.alertTick.ts);
  }, [ticks]);

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const formatPrice = (price: number | null, decimals = 2) => {
    if (price === null) return '-';
    return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatCents = (price: number | null) => {
    if (price === null) return '-';
    return `${(price * 100).toFixed(1)}¢`;
  };

  const formatDelta = (delta: number | null) => {
    if (delta === null) return '-';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}$${delta.toFixed(2)}`;
  };

  const stats = useMemo(() => {
    const alerts = ticks.filter(t => t.alert_triggered).length;
    const fills = ticks.filter(t => t.fill_price !== null).length;
    const fillsWithLatency = ticks.filter(t => t.signal_to_fill_ms !== null && t.signal_to_fill_ms > 0);
    const avgSignalToFill = fillsWithLatency.length > 0 
      ? fillsWithLatency.reduce((sum, t) => sum + (t.signal_to_fill_ms || 0), 0) / fillsWithLatency.length 
      : null;
    
    return { alerts, fills, total: ticks.length, avgSignalToFill };
  }, [ticks]);

  const TickRow = ({ tick, highlight }: { tick: V29Tick; highlight?: 'alert' | 'fill' | 'before' | 'after' }) => (
    <TableRow className={`text-xs hover:bg-muted/50 ${
      highlight === 'alert' ? 'bg-yellow-500/10 border-l-2 border-yellow-500' :
      highlight === 'fill' ? 'bg-green-500/10 border-l-2 border-green-500' :
      highlight === 'before' ? 'bg-muted/30' :
      highlight === 'after' ? 'bg-muted/20' : ''
    }`}>
      <TableCell className="font-mono text-[10px]">
        {format(new Date(tick.ts), 'HH:mm:ss.SSS')}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-[10px]">{tick.asset}</Badge>
      </TableCell>
      <TableCell className="text-right font-mono">{formatPrice(tick.binance_price)}</TableCell>
      <TableCell className="text-right font-mono text-muted-foreground">{formatPrice(tick.chainlink_price)}</TableCell>
      <TableCell className={`text-right font-mono ${
        tick.binance_delta !== null ? tick.binance_delta >= 0 ? 'text-green-500' : 'text-red-500' : ''
      }`}>
        {formatDelta(tick.binance_delta)}
      </TableCell>
      <TableCell className="text-center">
        {tick.alert_triggered ? (
          <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px]">
            <Bell className="h-2.5 w-2.5 mr-0.5" />{tick.signal_direction || 'Y'}
          </Badge>
        ) : '-'}
      </TableCell>
      <TableCell className="text-right font-mono">{formatCents(tick.up_best_ask)}</TableCell>
      <TableCell className="text-right font-mono">{formatCents(tick.down_best_ask)}</TableCell>
      <TableCell className="text-center">
        {tick.order_placed ? <CheckCircle className="h-3 w-3 text-blue-400 mx-auto" /> : '-'}
      </TableCell>
      <TableCell className="text-right font-mono">
        {tick.fill_price !== null ? (
          <span className="text-green-500">{formatCents(tick.fill_price)}</span>
        ) : '-'}
      </TableCell>
      <TableCell className="text-right font-mono">
        {tick.signal_to_fill_ms !== null ? (
          <span className={tick.signal_to_fill_ms < 100 ? 'text-green-500' : tick.signal_to_fill_ms < 500 ? 'text-yellow-500' : 'text-red-500'}>
            {tick.signal_to_fill_ms}ms
          </span>
        ) : tick.order_latency_ms !== null ? (
          <span className="text-muted-foreground">{tick.order_latency_ms}ms</span>
        ) : '-'}
      </TableCell>
    </TableRow>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Tick Log (per Alert)
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">{stats.total} ticks</Badge>
            <Badge variant="secondary" className="text-xs">
              <Bell className="h-3 w-3 mr-1" />{stats.alerts} alerts
            </Badge>
            <Badge className="bg-green-500/20 text-green-400 text-xs">
              <CheckCircle className="h-3 w-3 mr-1" />{stats.fills} fills
            </Badge>
            {stats.avgSignalToFill !== null && (
              <Badge variant="outline" className="text-xs bg-purple-500/10 text-purple-400 border-purple-500/30">
                ⚡ {stats.avgSignalToFill.toFixed(0)}ms avg
              </Badge>
            )}
            <Button variant="ghost" size="icon" onClick={fetchTicks} disabled={loading} className="h-7 w-7">
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[600px]">
          <Table>
            <TableHeader>
              <TableRow className="text-xs">
                <TableHead className="w-[90px]">Tijd</TableHead>
                <TableHead className="w-[45px]">Asset</TableHead>
                <TableHead className="text-right">Binance</TableHead>
                <TableHead className="text-right">Chainlink</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead className="text-center">Alert</TableHead>
                <TableHead className="text-right">Up Ask</TableHead>
                <TableHead className="text-right">Down Ask</TableHead>
                <TableHead className="text-center">Order</TableHead>
                <TableHead className="text-right">Fill</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alertGroups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    Geen alerts gevonden. {stats.total > 0 ? `${stats.total} ticks in database.` : 'Start de V29 runner.'}
                  </TableCell>
                </TableRow>
              ) : (
                alertGroups.map((group) => {
                  const isExpanded = expandedGroups.has(group.id);
                  return (
                    <tbody key={group.id}>
                      {/* Group header */}
                      <TableRow 
                        className="cursor-pointer hover:bg-muted/50 border-t-2 border-border"
                        onClick={() => toggleGroup(group.id)}
                      >
                        <TableCell colSpan={11} className="py-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                              <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
                                <Bell className="h-3 w-3 mr-1" />
                                {group.alertTick.asset} {group.alertTick.signal_direction}
                              </Badge>
                              <span className="font-mono text-xs">
                                {format(new Date(group.alertTick.ts), 'HH:mm:ss.SSS')}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                Binance ${formatPrice(group.alertTick.binance_price)} | Δ{formatDelta(group.alertTick.binance_delta)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {group.fillTick ? (
                                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                                  Filled @ {formatCents(group.fillTick.fill_price)}
                                  {group.fillTick.signal_to_fill_ms && ` (${group.fillTick.signal_to_fill_ms}ms)`}
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                  No fill
                                </Badge>
                              )}
                              <span className="text-xs text-muted-foreground">
                                {group.beforeTicks.length + 1 + (group.fillTick ? 1 : 0) + group.afterTicks.length} ticks
                              </span>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                      
                      {/* Expanded content */}
                      {isExpanded && (
                        <>
                          {/* Before ticks */}
                          {group.beforeTicks.map((tick) => (
                            <TickRow key={tick.id} tick={tick} highlight="before" />
                          ))}
                          {/* Alert + Fill tick (same record when filled) */}
                          <TickRow tick={group.alertTick} highlight={group.fillTick ? "fill" : "alert"} />
                          {/* After ticks */}
                          {group.afterTicks.map((tick) => (
                            <TickRow key={tick.id} tick={tick} highlight="after" />
                          ))}
                        </>
                      )}
                    </tbody>
                  );
                })
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
