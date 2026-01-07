import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, TrendingDown, Clock, DollarSign, Target, Activity, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

interface V26Trade {
  id: string;
  created_at: string;
  asset: string;
  market_id: string;
  market_slug: string;
  event_start_time: string;
  event_end_time: string;
  order_id: string | null;
  side: string;
  price: number;
  shares: number;
  notional: number;
  status: string;
  filled_shares: number;
  avg_fill_price: number | null;
  fill_time_ms: number | null;
  result: string | null;
  pnl: number | null;
  settled_at: string | null;
  run_id: string | null;
  error_message: string | null;
}

interface V26Stats {
  total_trades: number;
  filled_trades: number;
  settled_trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  total_pnl: number;
  total_invested: number;
  last_trade_at: string | null;
}

export default function V26Dashboard() {
  const navigate = useNavigate();
  const [trades, setTrades] = useState<V26Trade[]>([]);
  const [stats, setStats] = useState<V26Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    
    // Fetch stats
    const { data: statsData } = await supabase
      .from('v26_stats')
      .select('*')
      .single();
    
    if (statsData) {
      setStats(statsData as V26Stats);
    }

    // Fetch recent trades
    const { data: tradesData } = await supabase
      .from('v26_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (tradesData) {
      setTrades(tradesData as V26Trade[]);
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('v26_trades_realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'v26_trades',
        },
        () => {
          fetchData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'filled':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">Filled</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Pending</Badge>;
      case 'placed':
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">Placed</Badge>;
      case 'cancelled':
        return <Badge className="bg-muted text-muted-foreground">Cancelled</Badge>;
      case 'expired':
        return <Badge className="bg-muted text-muted-foreground">Expired</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getResultBadge = (result: string | null, pnl: number | null) => {
    if (!result) {
      return <Badge variant="outline" className="text-muted-foreground">Pending</Badge>;
    }
    
    const isWin = result === 'DOWN';
    const pnlFormatted = pnl !== null ? `$${pnl.toFixed(2)}` : '';
    
    return (
      <Badge className={isWin 
        ? "bg-green-500/10 text-green-500 border-green-500/20" 
        : "bg-red-500/10 text-red-500 border-red-500/20"
      }>
        {isWin ? '✓ WIN' : '✗ LOSS'} {pnlFormatted}
      </Badge>
    );
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold">V26 Loveable Strategy</h1>
              <p className="text-muted-foreground">Pre-Market DOWN Trader @ $0.48</p>
            </div>
          </div>
          <Button onClick={fetchData} variant="outline" disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Strategy Info */}
        <Card className="bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Side:</span>
                <span className="ml-2 font-medium">DOWN</span>
              </div>
              <div>
                <span className="text-muted-foreground">Price:</span>
                <span className="ml-2 font-medium">$0.48</span>
              </div>
              <div>
                <span className="text-muted-foreground">Shares:</span>
                <span className="ml-2 font-medium">10 per trade</span>
              </div>
              <div>
                <span className="text-muted-foreground">Assets:</span>
                <span className="ml-2 font-medium">BTC, ETH, SOL, XRP</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Activity className="h-3 w-3" />
                Total Trades
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.total_trades ?? 0}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Target className="h-3 w-3" />
                Filled
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.filled_trades ?? 0}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                Wins
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{stats?.wins ?? 0}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <TrendingDown className="h-3 w-3" />
                Losses
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{stats?.losses ?? 0}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Target className="h-3 w-3" />
                Win Rate
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats?.win_rate_pct?.toFixed(1) ?? '0'}%
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <DollarSign className="h-3 w-3" />
                Total P&L
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${(stats?.total_pnl ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${(stats?.total_pnl ?? 0).toFixed(2)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Trades Table */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Trades</CardTitle>
            <CardDescription>
              Last 100 V26 trades
            </CardDescription>
          </CardHeader>
          <CardContent>
            {trades.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No V26 trades yet</p>
                <p className="text-sm">Trades will appear here when the strategy starts running</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Market</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Fill</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell className="whitespace-nowrap">
                          {format(new Date(trade.created_at), 'MMM d HH:mm')}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{trade.asset}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                          {trade.market_slug}
                        </TableCell>
                        <TableCell>${trade.price.toFixed(2)}</TableCell>
                        <TableCell>{trade.shares}</TableCell>
                        <TableCell>{getStatusBadge(trade.status)}</TableCell>
                        <TableCell>
                          {trade.filled_shares > 0 ? (
                            <span className="text-green-500">
                              {trade.filled_shares} @ ${trade.avg_fill_price?.toFixed(3) ?? trade.price.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>{getResultBadge(trade.result, trade.pnl)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
