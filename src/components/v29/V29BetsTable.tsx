/**
 * V29 Bets Table - Shows P&L per 15-min betting window
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { format } from 'date-fns';

interface Bet {
  id: string;
  run_id: string | null;
  asset: string;
  market_slug: string | null;
  strike_price: number | null;
  window_start: string;
  window_end: string;
  up_shares: number | null;
  up_avg_price: number | null;
  up_cost: number | null;
  down_shares: number | null;
  down_avg_price: number | null;
  down_cost: number | null;
  buy_count: number | null;
  sell_count: number | null;
  total_cost: number | null;
  total_revenue: number | null;
  realized_pnl: number | null;
  unrealized_pnl: number | null;
  status: string;
  result: string | null;
  settled_outcome: string | null;
  payout: number | null;
  created_at: string;
}

export function V29BetsTable() {
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchBets() {
      const { data, error } = await supabase
        .from('v29_bets')
        .select('*')
        .order('window_start', { ascending: false })
        .limit(50);

      if (!error && data) {
        setBets(data as Bet[]);
      }
      setLoading(false);
    }

    fetchBets();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('v29_bets_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'v29_bets' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setBets(prev => [payload.new as Bet, ...prev].slice(0, 50));
          } else if (payload.eventType === 'UPDATE') {
            setBets(prev => prev.map(b => b.id === payload.new.id ? payload.new as Bet : b));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const getStatusBadge = (status: string, result: string | null) => {
    if (status === 'active') {
      return <Badge variant="outline" className="bg-blue-500/10 text-blue-500">Active</Badge>;
    }
    if (status === 'settled') {
      if (result === 'win') return <Badge className="bg-green-500">Win</Badge>;
      if (result === 'loss') return <Badge className="bg-red-500">Loss</Badge>;
      return <Badge variant="outline">Settled</Badge>;
    }
    return <Badge variant="outline">{status}</Badge>;
  };

  const formatPnL = (pnl: number | null) => {
    if (pnl === null || pnl === undefined) return '-';
    const formatted = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const color = pnl >= 0 ? 'text-green-500' : 'text-red-500';
    return <span className={color}>{formatted}</span>;
  };

  // Calculate summary stats
  const totalPnL = bets.reduce((sum, b) => sum + (b.realized_pnl || 0), 0);
  const activeBets = bets.filter(b => b.status === 'active').length;
  const wins = bets.filter(b => b.result === 'win').length;
  const losses = bets.filter(b => b.result === 'loss').length;
  const winRate = wins + losses > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '-';

  if (loading) {
    return <div className="text-muted-foreground">Loading bets...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Bets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeBets}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{winRate}%</div>
            <div className="text-xs text-muted-foreground">{wins}W / {losses}L</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Bets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{bets.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Bets Table */}
      <Card>
        <CardHeader>
          <CardTitle>Bet History (15-min windows)</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Strike</TableHead>
                <TableHead>Positions</TableHead>
                <TableHead>Trades</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Revenue</TableHead>
                <TableHead>P&L</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No bets yet
                  </TableCell>
                </TableRow>
              ) : (
                bets.map((bet) => (
                  <TableRow key={bet.id}>
                    <TableCell className="text-xs">
                      {format(new Date(bet.window_start), 'HH:mm')} - {format(new Date(bet.window_end), 'HH:mm')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{bet.asset}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${bet.strike_price?.toLocaleString() || '-'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {(bet.up_shares || 0) > 0 && (
                        <div className="text-green-500">↑ {(bet.up_shares || 0).toFixed(1)} @ {((bet.up_avg_price || 0) * 100).toFixed(0)}¢</div>
                      )}
                      {(bet.down_shares || 0) > 0 && (
                        <div className="text-red-500">↓ {(bet.down_shares || 0).toFixed(1)} @ {((bet.down_avg_price || 0) * 100).toFixed(0)}¢</div>
                      )}
                      {(bet.up_shares || 0) === 0 && (bet.down_shares || 0) === 0 && '-'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {bet.buy_count || 0}B / {bet.sell_count || 0}S
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${(bet.total_cost || 0).toFixed(2)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      ${(bet.total_revenue || 0).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {formatPnL(bet.realized_pnl)}
                      {bet.status === 'active' && bet.unrealized_pnl !== null && bet.unrealized_pnl !== 0 && (
                        <div className="text-xs text-muted-foreground">
                          ({formatPnL(bet.unrealized_pnl)} unreal)
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(bet.status, bet.result)}
                      {bet.settled_outcome && (
                        <div className="text-xs text-muted-foreground mt-1">
                          → {bet.settled_outcome}
                        </div>
                      )}
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
