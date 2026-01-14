import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Bell, CheckCircle, Activity } from 'lucide-react';
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

// A 50ms bucket containing multiple ticks
interface TickBucket {
  bucketTs: number; // Start of 50ms window
  ticks: V29Tick[];
  hasAlert: boolean;
  hasFill: boolean;
  // Aggregated values (last tick in bucket)
  lastBinancePrice: number | null;
  totalDelta: number;
  alertDirection: string | null;
  fillPrice: number | null;
  signalToFillMs: number | null;
}

interface V29TickTableProps {
  assetFilter?: string;
  maxRows?: number;
}

const BUCKET_MS = 50;

export function V29TickTable({ assetFilter = 'ALL', maxRows = 1000 }: V29TickTableProps) {
  const [ticks, setTicks] = useState<V29Tick[]>([]);
  const [loading, setLoading] = useState(true);

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

  // Group ticks into 50ms buckets
  const buckets = useMemo((): TickBucket[] => {
    const bucketMap = new Map<string, TickBucket>();
    
    for (const tick of ticks) {
      // Round down to nearest 50ms
      const bucketTs = Math.floor(tick.ts / BUCKET_MS) * BUCKET_MS;
      const key = `${tick.asset}-${bucketTs}`;
      
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          bucketTs,
          ticks: [],
          hasAlert: false,
          hasFill: false,
          lastBinancePrice: null,
          totalDelta: 0,
          alertDirection: null,
          fillPrice: null,
          signalToFillMs: null,
        });
      }
      
      const bucket = bucketMap.get(key)!;
      bucket.ticks.push(tick);
      
      if (tick.binance_price !== null) {
        bucket.lastBinancePrice = tick.binance_price;
      }
      if (tick.binance_delta !== null) {
        bucket.totalDelta += tick.binance_delta;
      }
      if (tick.alert_triggered) {
        bucket.hasAlert = true;
        bucket.alertDirection = tick.signal_direction;
      }
      if (tick.fill_price !== null) {
        bucket.hasFill = true;
        bucket.fillPrice = tick.fill_price;
        bucket.signalToFillMs = tick.signal_to_fill_ms;
      }
    }
    
    // Sort by timestamp descending (newest first)
    return Array.from(bucketMap.values()).sort((a, b) => b.bucketTs - a.bucketTs);
  }, [ticks]);

  const formatPrice = (price: number | null, decimals = 2) => {
    if (price === null) return '-';
    return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatCents = (price: number | null) => {
    if (price === null) return '-';
    return `${(price * 100).toFixed(1)}¢`;
  };

  const formatDelta = (delta: number | null) => {
    if (delta === null || delta === 0) return '-';
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
    
    return { alerts, fills, total: ticks.length, buckets: buckets.length, avgSignalToFill };
  }, [ticks, buckets]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Tick Log (50ms buckets)
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">{stats.total} ticks → {stats.buckets} buckets</Badge>
            <Badge variant="secondary" className="text-xs">
              <Bell className="h-3 w-3 mr-1" />{stats.alerts}
            </Badge>
            <Badge className="bg-green-500/20 text-green-400 text-xs">
              <CheckCircle className="h-3 w-3 mr-1" />{stats.fills}
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
                <TableHead className="w-[100px]">Tijd (50ms)</TableHead>
                <TableHead className="w-[45px]">Asset</TableHead>
                <TableHead className="text-right">Binance</TableHead>
                <TableHead className="text-right">Δ (sum)</TableHead>
                <TableHead className="text-center">Alert</TableHead>
                <TableHead className="text-center">Fill</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right"># ticks</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.map((bucket) => {
                const firstTick = bucket.ticks[0];
                return (
                  <TableRow 
                    key={`${firstTick.asset}-${bucket.bucketTs}`} 
                    className={`text-xs hover:bg-muted/50 ${
                      bucket.hasAlert ? 'bg-yellow-500/10 border-l-2 border-yellow-500' :
                      bucket.hasFill ? 'bg-green-500/10 border-l-2 border-green-500' : ''
                    }`}
                  >
                    <TableCell className="font-mono text-[10px]">
                      {format(new Date(bucket.bucketTs), 'HH:mm:ss.SSS')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{firstTick.asset}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatPrice(bucket.lastBinancePrice)}
                    </TableCell>
                    <TableCell className={`text-right font-mono ${
                      bucket.totalDelta > 0 ? 'text-green-500' : bucket.totalDelta < 0 ? 'text-red-500' : ''
                    }`}>
                      {formatDelta(bucket.totalDelta)}
                    </TableCell>
                    <TableCell className="text-center">
                      {bucket.hasAlert ? (
                        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px]">
                          <Bell className="h-2.5 w-2.5 mr-0.5" />{bucket.alertDirection || 'Y'}
                        </Badge>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-center">
                      {bucket.hasFill ? (
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px]">
                          {formatCents(bucket.fillPrice)}
                        </Badge>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {bucket.signalToFillMs !== null ? (
                        <span className={
                          bucket.signalToFillMs < 100 ? 'text-green-500' : 
                          bucket.signalToFillMs < 500 ? 'text-yellow-500' : 'text-red-500'
                        }>
                          {bucket.signalToFillMs}ms
                        </span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {bucket.ticks.length}
                    </TableCell>
                  </TableRow>
                );
              })}
              {buckets.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    Geen tick data. Start de V29 runner.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}