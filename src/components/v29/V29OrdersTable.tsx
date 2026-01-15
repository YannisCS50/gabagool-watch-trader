/**
 * V29 Orders Table - Shows individual orders with P&L
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';

interface Order {
  id: string;
  run_id: string | null;
  asset: string;
  market_id: string;
  side: string;
  direction: string;
  shares: number;
  price: number;
  cost: number | null;
  status: string;
  fill_price: number | null;
  fill_shares: number | null;
  fill_cost: number | null;
  pnl: number | null;
  order_id: string | null;
  created_at: string;
  filled_at: string | null;
}

interface Props {
  assetFilter?: string;
  limit?: number;
}

export function V29OrdersTable({ assetFilter, limit = 50 }: Props) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchOrders() {
      let query = supabase
        .from('v29_orders')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (assetFilter && assetFilter !== 'all') {
        query = query.eq('asset', assetFilter);
      }

      const { data, error } = await query;

      if (!error && data) {
        setOrders(data as Order[]);
      }
      setLoading(false);
    }

    fetchOrders();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('v29_orders_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'v29_orders' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newOrder = payload.new as Order;
            if (!assetFilter || assetFilter === 'all' || newOrder.asset === assetFilter) {
              setOrders(prev => [newOrder, ...prev].slice(0, limit));
            }
          } else if (payload.eventType === 'UPDATE') {
            setOrders(prev => prev.map(o => o.id === payload.new.id ? payload.new as Order : o));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [assetFilter, limit]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'filled':
        return <Badge className="bg-green-500">Filled</Badge>;
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500">Pending</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'cancelled':
        return <Badge variant="outline">Cancelled</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getSideBadge = (side: string, direction: string) => {
    const color = side === 'BUY' ? 'bg-blue-500' : 'bg-orange-500';
    const arrow = direction === 'UP' ? '↑' : '↓';
    return <Badge className={color}>{side} {arrow}</Badge>;
  };

  const formatPnL = (pnl: number | null) => {
    if (pnl === null || pnl === undefined) return '-';
    const formatted = pnl >= 0 ? `+$${pnl.toFixed(3)}` : `-$${Math.abs(pnl).toFixed(3)}`;
    const color = pnl >= 0 ? 'text-green-500' : 'text-red-500';
    return <span className={color}>{formatted}</span>;
  };

  // Summary stats
  const buyOrders = orders.filter(o => o.side === 'BUY');
  const sellOrders = orders.filter(o => o.side === 'SELL');
  const filledOrders = orders.filter(o => o.status === 'filled');
  const totalPnL = sellOrders.reduce((sum, o) => sum + (o.pnl || 0), 0);

  if (loading) {
    return <div className="text-muted-foreground">Loading orders...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Buys</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-500">{buyOrders.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sells</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-500">{sellOrders.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Fill Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {orders.length > 0 ? ((filledOrders.length / orders.length) * 100).toFixed(0) : 0}%
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sell P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Orders</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Shares</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Fill</TableHead>
                <TableHead>P&L</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    No orders yet
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="text-xs font-mono">
                      {format(new Date(order.created_at), 'HH:mm:ss')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{order.asset}</Badge>
                    </TableCell>
                    <TableCell>
                      {getSideBadge(order.side, order.direction)}
                    </TableCell>
                    <TableCell className="font-mono">
                      {order.shares.toFixed(2)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {(order.price * 100).toFixed(1)}¢
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {order.fill_price ? `${(order.fill_price * 100).toFixed(1)}¢` : '-'}
                      {order.fill_shares && order.fill_shares !== order.shares && (
                        <span className="text-muted-foreground ml-1">({order.fill_shares})</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {order.side === 'SELL' ? formatPnL(order.pnl) : '-'}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(order.status)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
