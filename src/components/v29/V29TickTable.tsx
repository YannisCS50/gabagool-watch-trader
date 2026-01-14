import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Bell, ShoppingCart, CheckCircle, XCircle, Activity } from 'lucide-react';
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
}

interface V29TickTableProps {
  assetFilter?: string;
  maxRows?: number;
}

export function V29TickTable({ assetFilter = 'ALL', maxRows = 100 }: V29TickTableProps) {
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

  // Subscribe to realtime updates
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
    const orders = ticks.filter(t => t.order_placed).length;
    const fills = ticks.filter(t => t.fill_price !== null).length;
    return { alerts, orders, fills, total: ticks.length };
  }, [ticks]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Tick-by-Tick Log
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {stats.total} ticks
            </Badge>
            <Badge variant="secondary" className="text-xs">
              <Bell className="h-3 w-3 mr-1" />
              {stats.alerts}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              <ShoppingCart className="h-3 w-3 mr-1" />
              {stats.orders}
            </Badge>
            <Badge className="bg-green-500/20 text-green-400 text-xs">
              <CheckCircle className="h-3 w-3 mr-1" />
              {stats.fills}
            </Badge>
            <Button variant="ghost" size="icon" onClick={fetchTicks} disabled={loading} className="h-8 w-8">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[500px]">
          <Table>
            <TableHeader>
              <TableRow className="text-xs">
                <TableHead className="w-[100px]">Tijd</TableHead>
                <TableHead className="w-[50px]">Asset</TableHead>
                <TableHead className="text-right">Binance</TableHead>
                <TableHead className="text-right">Chainlink</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead className="text-center">Alert</TableHead>
                <TableHead className="text-right">Up Ask</TableHead>
                <TableHead className="text-right">Down Ask</TableHead>
                <TableHead className="text-center">Order</TableHead>
                <TableHead className="text-right">Fill</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ticks.map((tick) => (
                <TableRow key={tick.id} className="text-xs hover:bg-muted/50">
                  <TableCell className="font-mono">
                    {format(new Date(tick.ts), 'HH:mm:ss.SSS')}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {tick.asset}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPrice(tick.binance_price)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatPrice(tick.chainlink_price)}
                  </TableCell>
                  <TableCell className={`text-right font-mono ${
                    tick.binance_delta !== null 
                      ? tick.binance_delta >= 0 ? 'text-green-500' : 'text-red-500'
                      : ''
                  }`}>
                    {formatDelta(tick.binance_delta)}
                  </TableCell>
                  <TableCell className="text-center">
                    {tick.alert_triggered ? (
                      <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs">
                        <Bell className="h-3 w-3 mr-1" />
                        {tick.signal_direction || 'Y'}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCents(tick.up_best_ask)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCents(tick.down_best_ask)}
                  </TableCell>
                  <TableCell className="text-center">
                    {tick.order_placed ? (
                      <CheckCircle className="h-4 w-4 text-blue-400 mx-auto" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground/30 mx-auto" />
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {tick.fill_price !== null ? (
                      <span className="text-green-500">
                        {formatCents(tick.fill_price)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {ticks.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    Geen tick data beschikbaar. Start de V29 runner om data te loggen.
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
