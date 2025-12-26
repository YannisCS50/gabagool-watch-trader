import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  ListOrdered, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Loader2,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatDistanceToNow } from 'date-fns';

interface QueuedOrder {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  status: string;
  order_id: string | null;
  avg_fill_price: number | null;
  error_message: string | null;
  created_at: string;
  executed_at: string | null;
  reasoning: string | null;
}

export function OrderQueueStatus() {
  const [orders, setOrders] = useState<QueuedOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchOrders = async () => {
    setIsLoading(true);
    const { data, error } = await supabase
      .from('order_queue')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!error && data) {
      setOrders(data);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchOrders();

    // Set up realtime subscription
    const channel = supabase
      .channel('order_queue_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'order_queue'
        },
        (payload) => {
          console.log('Order queue update:', payload);
          
          if (payload.eventType === 'INSERT') {
            setOrders(prev => [payload.new as QueuedOrder, ...prev.slice(0, 19)]);
          } else if (payload.eventType === 'UPDATE') {
            setOrders(prev => prev.map(o => 
              o.id === (payload.new as QueuedOrder).id ? payload.new as QueuedOrder : o
            ));
          } else if (payload.eventType === 'DELETE') {
            setOrders(prev => prev.filter(o => o.id !== (payload.old as QueuedOrder).id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20"><Clock className="w-3 h-3 mr-1" /> Pending</Badge>;
      case 'processing':
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-500 border-blue-500/20"><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Processing</Badge>;
      case 'filled':
        return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20"><CheckCircle2 className="w-3 h-3 mr-1" /> Filled</Badge>;
      case 'failed':
        return <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20"><XCircle className="w-3 h-3 mr-1" /> Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const pendingCount = orders.filter(o => o.status === 'pending' || o.status === 'processing').length;
  const filledCount = orders.filter(o => o.status === 'filled').length;
  const failedCount = orders.filter(o => o.status === 'failed').length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ListOrdered className="w-5 h-5 text-primary" />
            Order Queue
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {pendingCount} pending
              </Badge>
            )}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchOrders} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            {filledCount} filled
          </span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-yellow-500" />
            {pendingCount} pending
          </span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            {failedCount} failed
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {orders.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <ListOrdered className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No orders in queue</p>
            <p className="text-xs mt-1">Orders from the edge function will appear here</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {orders.map((order) => (
              <div 
                key={order.id} 
                className={`p-3 rounded-lg border ${
                  order.status === 'pending' ? 'border-yellow-500/20 bg-yellow-500/5' :
                  order.status === 'processing' ? 'border-blue-500/20 bg-blue-500/5 animate-pulse' :
                  order.status === 'filled' ? 'border-emerald-500/20 bg-emerald-500/5' :
                  order.status === 'failed' ? 'border-red-500/20 bg-red-500/5' :
                  'border-border'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className={order.outcome === 'UP' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'}>
                        {order.asset} {order.outcome}
                      </Badge>
                      {getStatusBadge(order.status)}
                    </div>
                    <div className="text-sm font-mono">
                      {order.shares.toFixed(0)} shares @ {(order.price * 100).toFixed(0)}¢
                      {order.avg_fill_price && order.avg_fill_price !== order.price && (
                        <span className="text-muted-foreground ml-2">
                          (filled @ {(order.avg_fill_price * 100).toFixed(0)}¢)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {order.market_slug}
                    </div>
                    {order.error_message && (
                      <div className="text-xs text-red-400 mt-1 font-mono bg-red-500/10 p-1.5 rounded">
                        {order.error_message}
                      </div>
                    )}
                    {order.reasoning && (
                      <div className="text-xs text-muted-foreground mt-1 italic">
                        {order.reasoning}
                      </div>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0">
                    <div>{formatDistanceToNow(new Date(order.created_at), { addSuffix: true })}</div>
                    {order.executed_at && (
                      <div className="text-emerald-500">
                        Executed {formatDistanceToNow(new Date(order.executed_at), { addSuffix: true })}
                      </div>
                    )}
                    {order.order_id && (
                      <div className="font-mono text-[10px] opacity-50 mt-1">
                        {order.order_id.slice(0, 12)}...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
