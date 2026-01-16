import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TrendingUp, TrendingDown, Clock, DollarSign, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';

interface Position {
  market_slug: string;
  asset: string;
  direction: string;
  shares: number;
  avg_entry_price: number;
  total_cost: number;
  created_at: string;
}

interface MarketResult {
  slug: string;
  asset: string;
  result: string | null;
  event_end_time: string;
  strike_price: number | null;
  close_price: number | null;
}

interface BetPnL {
  market_slug: string;
  asset: string;
  event_end_time: string;
  up_shares: number;
  down_shares: number;
  up_cost: number;
  down_cost: number;
  total_cost: number;
  result: string | null;
  payout: number;
  pnl: number;
  status: 'running' | 'settled' | 'pending';
}

async function fetchBetPnLData(): Promise<BetPnL[]> {
  // Fetch positions
  const { data: positions, error: posError } = await supabase
    .from('v30_positions')
    .select('market_slug, asset, direction, shares, avg_entry_price, total_cost, created_at')
    .order('created_at', { ascending: false });

  if (posError) throw posError;

  // Fetch market results
  const { data: markets, error: mktError } = await supabase
    .from('market_history')
    .select('slug, asset, result, event_end_time, strike_price, close_price')
    .order('event_end_time', { ascending: false })
    .limit(200);

  if (mktError) throw mktError;

  // Create market lookup
  const marketLookup = new Map<string, MarketResult>();
  (markets || []).forEach((m: MarketResult) => {
    marketLookup.set(m.slug, m);
  });

  // Group positions by market
  const betMap = new Map<string, BetPnL>();

  (positions || []).forEach((pos: Position) => {
    const existing = betMap.get(pos.market_slug);
    const market = marketLookup.get(pos.market_slug);

    if (!existing) {
      const now = Date.now();
      const endTime = market?.event_end_time ? new Date(market.event_end_time).getTime() : 0;
      const status: 'running' | 'settled' | 'pending' = 
        market?.result && market.result !== 'UNKNOWN' ? 'settled' :
        endTime && endTime < now ? 'pending' : 'running';

      betMap.set(pos.market_slug, {
        market_slug: pos.market_slug,
        asset: pos.asset,
        event_end_time: market?.event_end_time || pos.created_at,
        up_shares: pos.direction === 'UP' ? pos.shares : 0,
        down_shares: pos.direction === 'DOWN' ? pos.shares : 0,
        up_cost: pos.direction === 'UP' ? pos.total_cost : 0,
        down_cost: pos.direction === 'DOWN' ? pos.total_cost : 0,
        total_cost: pos.total_cost,
        result: market?.result || null,
        payout: 0,
        pnl: 0,
        status,
      });
    } else {
      if (pos.direction === 'UP') {
        existing.up_shares += pos.shares;
        existing.up_cost += pos.total_cost;
      } else {
        existing.down_shares += pos.shares;
        existing.down_cost += pos.total_cost;
      }
      existing.total_cost += pos.total_cost;
    }
  });

  // Calculate payouts and PnL
  betMap.forEach((bet) => {
    if (bet.result === 'UP') {
      bet.payout = bet.up_shares;
      bet.pnl = bet.payout - bet.total_cost;
    } else if (bet.result === 'DOWN') {
      bet.payout = bet.down_shares;
      bet.pnl = bet.payout - bet.total_cost;
    } else {
      // Running or pending - estimate based on 50/50
      const pairedShares = Math.min(bet.up_shares, bet.down_shares);
      bet.payout = pairedShares; // Guaranteed payout from pairs
      bet.pnl = 0; // Unknown until settled
    }
  });

  return Array.from(betMap.values()).sort((a, b) => 
    new Date(b.event_end_time).getTime() - new Date(a.event_end_time).getTime()
  );
}

export function V30BetPnLTable() {
  const [assetFilter, setAssetFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [expanded, setExpanded] = useState(false);

  const { data: bets = [], isLoading, error } = useQuery({
    queryKey: ['v30-bet-pnl'],
    queryFn: fetchBetPnLData,
    refetchInterval: 10000,
  });

  const filteredBets = useMemo(() => {
    return bets.filter((bet) => {
      if (assetFilter !== 'ALL' && bet.asset !== assetFilter) return false;
      if (statusFilter !== 'ALL' && bet.status !== statusFilter) return false;
      return true;
    });
  }, [bets, assetFilter, statusFilter]);

  const displayedBets = expanded ? filteredBets : filteredBets.slice(0, 10);

  const stats = useMemo(() => {
    const settled = filteredBets.filter(b => b.status === 'settled');
    const running = filteredBets.filter(b => b.status === 'running');
    const totalPnL = settled.reduce((sum, b) => sum + b.pnl, 0);
    const wins = settled.filter(b => b.pnl > 0).length;
    const losses = settled.filter(b => b.pnl < 0).length;
    const winRate = settled.length > 0 ? (wins / settled.length) * 100 : 0;
    const runningCost = running.reduce((sum, b) => sum + b.total_cost, 0);

    return { totalPnL, wins, losses, winRate, runningCount: running.length, runningCost };
  }, [filteredBets]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Bet P/L
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <DollarSign className="h-5 w-5" />
            Bet P/L - Error
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-destructive">{String(error)}</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Bet P/L
          </CardTitle>
          <div className="flex gap-2">
            <Select value={assetFilter} onValueChange={setAssetFilter}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All</SelectItem>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Status</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className={`text-xl font-bold ${stats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              ${stats.totalPnL.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">Realized P/L</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold text-green-500">{stats.wins}</div>
            <div className="text-xs text-muted-foreground">Wins</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold text-red-500">{stats.losses}</div>
            <div className="text-xs text-muted-foreground">Losses</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold">{stats.winRate.toFixed(1)}%</div>
            <div className="text-xs text-muted-foreground">Win Rate</div>
          </div>
          <div className="text-center p-3 bg-muted/50 rounded-lg">
            <div className="text-xl font-bold text-yellow-500">{stats.runningCount}</div>
            <div className="text-xs text-muted-foreground">${stats.runningCost.toFixed(0)} running</div>
          </div>
        </div>

        {/* Bets Table */}
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market</TableHead>
                <TableHead className="text-right">UP</TableHead>
                <TableHead className="text-right">DOWN</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-center">Result</TableHead>
                <TableHead className="text-right">P/L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedBets.map((bet) => (
                <TableRow key={bet.market_slug}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {bet.asset}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">
                        {bet.market_slug.split('-').pop()}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <TrendingUp className="h-3 w-3 text-green-500" />
                      <span className="text-sm">{bet.up_shares}</span>
                      <span className="text-xs text-muted-foreground">(${bet.up_cost.toFixed(1)})</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <TrendingDown className="h-3 w-3 text-red-500" />
                      <span className="text-sm">{bet.down_shares}</span>
                      <span className="text-xs text-muted-foreground">(${bet.down_cost.toFixed(1)})</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    ${bet.total_cost.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-center">
                    {bet.status === 'running' ? (
                      <Badge variant="outline" className="bg-yellow-500/10">
                        <Clock className="h-3 w-3 mr-1" />
                        Running
                      </Badge>
                    ) : bet.status === 'pending' ? (
                      <Badge variant="outline" className="bg-orange-500/10">
                        Pending
                      </Badge>
                    ) : bet.result === 'UP' ? (
                      <Badge className="bg-green-500">UP</Badge>
                    ) : bet.result === 'DOWN' ? (
                      <Badge className="bg-red-500">DOWN</Badge>
                    ) : (
                      <Badge variant="secondary">Unknown</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {bet.status === 'settled' ? (
                      <span className={`font-bold ${bet.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {bet.pnl >= 0 ? '+' : ''}${bet.pnl.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {filteredBets.length > 10 && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? (
                <>
                  <ChevronUp className="h-4 w-4 mr-1" />
                  Show Less
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 mr-1" />
                  Show All ({filteredBets.length})
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
