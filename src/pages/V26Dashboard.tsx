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

interface StrikePrice {
  market_slug: string;
  asset: string;
  strike_price: number;
  close_price: number | null;
}

interface V26Bet {
  market_slug: string;
  asset: string;
  event_start_time: string;
  event_end_time: string;
  trades: V26Trade[];
  strike_price: number | null;
  close_price: number | null;
  delta: number | null;
  result: 'WIN' | 'LOSS' | 'PENDING' | 'NO_FILL';
  total_filled_shares: number;
  total_invested: number;
  pnl: number | null;
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

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;
type AssetFilter = typeof ASSETS[number];

export default function V26Dashboard() {
  const navigate = useNavigate();
  const [bets, setBets] = useState<V26Bet[]>([]);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('ALL');
  const [stats, setStats] = useState<{ total: number; filled: number; wins: number; losses: number; pending: number; totalPnl: number }>({
    total: 0, filled: 0, wins: 0, losses: 0, pending: 0, totalPnl: 0
  });
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);

    // Fetch trades
    const { data: tradesData } = await supabase
      .from('v26_trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    // Fetch strike prices
    const { data: strikesData } = await supabase
      .from('strike_prices')
      .select('market_slug, asset, strike_price, close_price')
      .order('created_at', { ascending: false })
      .limit(500);

    if (!tradesData) {
      setLoading(false);
      return;
    }

    // Create strike price lookup
    const strikeLookup = new Map<string, StrikePrice>();
    if (strikesData) {
      for (const s of strikesData) {
        const key = `${s.market_slug}`;
        if (!strikeLookup.has(key)) {
          strikeLookup.set(key, s as StrikePrice);
        }
      }
    }

    // Group trades by market_slug (bet)
    const betMap = new Map<string, V26Bet>();
    
    for (const trade of tradesData as V26Trade[]) {
      const key = trade.market_slug;
      
      if (!betMap.has(key)) {
        const strike = strikeLookup.get(key);
        const strikePrice = strike?.strike_price ?? null;
        const closePrice = strike?.close_price ?? null;
        const delta = (strikePrice !== null && closePrice !== null) 
          ? closePrice - strikePrice 
          : null;
        
        betMap.set(key, {
          market_slug: trade.market_slug,
          asset: trade.asset,
          event_start_time: trade.event_start_time,
          event_end_time: trade.event_end_time,
          trades: [],
          strike_price: strikePrice,
          close_price: closePrice,
          delta,
          result: 'PENDING',
          total_filled_shares: 0,
          total_invested: 0,
          pnl: null,
        });
      }
      
      const bet = betMap.get(key)!;
      bet.trades.push(trade);
      bet.total_filled_shares += trade.filled_shares ?? 0;
      bet.total_invested += (trade.filled_shares ?? 0) * (trade.avg_fill_price ?? trade.price);
    }

    // Calculate results for each bet
    const betsArray: V26Bet[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalPending = 0;
    let totalFilled = 0;
    let totalPnl = 0;

    for (const bet of betMap.values()) {
      // Determine result based on delta
      if (bet.total_filled_shares === 0) {
        bet.result = 'NO_FILL';
      } else if (bet.delta === null) {
        // Market not settled yet
        const isEnded = new Date(bet.event_end_time) < new Date();
        bet.result = isEnded ? 'PENDING' : 'PENDING';
        totalPending++;
        totalFilled++;
      } else {
        // We bought DOWN, so:
        // - delta < 0 (price went down) → DOWN wins → WIN
        // - delta > 0 (price went up) → UP wins → LOSS
        // - delta = 0 → depends on exact rules, treat as LOSS for safety
        if (bet.delta < 0) {
          bet.result = 'WIN';
          // WIN: we get $1 per share
          bet.pnl = bet.total_filled_shares * 1 - bet.total_invested;
          totalWins++;
          totalPnl += bet.pnl;
        } else {
          bet.result = 'LOSS';
          // LOSS: we get $0 per share
          bet.pnl = 0 - bet.total_invested;
          totalLosses++;
          totalPnl += bet.pnl;
        }
        totalFilled++;
      }
      
      betsArray.push(bet);
    }

    // Sort by event time descending
    betsArray.sort((a, b) => new Date(b.event_start_time).getTime() - new Date(a.event_start_time).getTime());

    setBets(betsArray);
    setStats({
      total: betsArray.length,
      filled: totalFilled,
      wins: totalWins,
      losses: totalLosses,
      pending: totalPending,
      totalPnl,
    });
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

  const getResultBadge = (bet: V26Bet) => {
    switch (bet.result) {
      case 'WIN':
        return (
          <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
            ✓ WIN {bet.pnl !== null && `+$${bet.pnl.toFixed(2)}`}
          </Badge>
        );
      case 'LOSS':
        return (
          <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
            ✗ LOSS {bet.pnl !== null && `-$${Math.abs(bet.pnl).toFixed(2)}`}
          </Badge>
        );
      case 'NO_FILL':
        return <Badge variant="outline" className="text-muted-foreground">No Fill</Badge>;
      case 'PENDING':
      default:
        const isEnded = new Date(bet.event_end_time) < new Date();
        if (isEnded) {
          return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">⏳ Awaiting Oracle</Badge>;
        }
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">🔴 Live</Badge>;
    }
  };

  const winRate = stats.wins + stats.losses > 0 
    ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1) 
    : '0';

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
                Total Bets
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
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
              <div className="text-2xl font-bold">{stats.filled}</div>
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
              <div className="text-2xl font-bold text-green-500">{stats.wins}</div>
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
              <div className="text-2xl font-bold text-red-500">{stats.losses}</div>
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
              <div className="text-2xl font-bold">{winRate}%</div>
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
              <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${stats.totalPnl.toFixed(2)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Bets Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Bets</CardTitle>
                <CardDescription>Per market - shares, price, delta, result</CardDescription>
              </div>
              <div className="flex gap-1">
                {ASSETS.map((asset) => (
                  <Button
                    key={asset}
                    variant={assetFilter === asset ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setAssetFilter(asset)}
                  >
                    {asset}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {bets.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No V26 bets yet</p>
                <p className="text-sm">Bets will appear here when the strategy starts running</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bet</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bets
                      .filter((bet) => assetFilter === 'ALL' || bet.asset === assetFilter)
                      .map((bet) => {
                        const filledTrade = bet.trades.find(t => t.filled_shares > 0);
                        const avgPrice = filledTrade?.avg_fill_price ?? filledTrade?.price ?? 0.48;
                        const isEnded = new Date(bet.event_end_time) < new Date();
                        const hasOrder = bet.trades.some(t => t.order_id);
                        
                        // Status logic
                        let status: 'placed' | 'open' | 'closed' = 'placed';
                        if (bet.total_filled_shares > 0 && !isEnded) {
                          status = 'open';
                        } else if (isEnded) {
                          status = 'closed';
                        } else if (hasOrder) {
                          status = 'placed';
                        }

                        // Bet title: "BTC DOWN 16:15"
                        const betTitle = `${bet.asset} DOWN ${format(new Date(bet.event_start_time), 'HH:mm')}`;

                        const getStatusBadge = () => {
                          switch (status) {
                            case 'placed':
                              return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Placed</Badge>;
                            case 'open':
                              return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">🔴 Open</Badge>;
                            case 'closed':
                              return <Badge variant="outline">Closed</Badge>;
                          }
                        };

                        const getResultDisplay = () => {
                          // Not closed yet
                          if (status !== 'closed') {
                            return <span className="text-muted-foreground">-</span>;
                          }
                          // Closed but no fill
                          if (bet.total_filled_shares === 0) {
                            return <Badge variant="outline" className="text-muted-foreground">No Fill</Badge>;
                          }
                          // Filled and closed - MUST have result
                          // If delta is available, use it
                          if (bet.delta !== null) {
                            if (bet.delta < 0) {
                              return (
                                <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
                                  ✓ Win {bet.pnl !== null && `+$${bet.pnl.toFixed(2)}`}
                                </Badge>
                              );
                            } else {
                              return (
                                <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
                                  ✗ Loss {bet.pnl !== null && `-$${Math.abs(bet.pnl).toFixed(2)}`}
                                </Badge>
                              );
                            }
                          }
                          // Filled, closed, but no oracle data yet
                          return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">⏳ Oracle</Badge>;
                        };

                        return (
                          <TableRow key={bet.market_slug}>
                            <TableCell>
                              <div className="font-medium">{betTitle}</div>
                              <div className="text-xs text-muted-foreground">
                                {format(new Date(bet.event_start_time), 'MMM d, yyyy')}
                              </div>
                            </TableCell>
                            <TableCell>
                              {bet.total_filled_shares > 0 ? (
                                <span className="font-medium">{bet.total_filled_shares}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono">
                              ${avgPrice.toFixed(2)}
                            </TableCell>
                            <TableCell className="font-mono font-medium">
                              ${bet.total_invested.toFixed(2)}
                            </TableCell>
                            <TableCell>
                              {bet.delta !== null ? (
                                <span className={`font-mono ${bet.delta < 0 ? 'text-green-500' : 'text-red-500'}`}>
                                  {bet.delta >= 0 ? '+' : ''}{bet.delta.toFixed(2)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell>{getStatusBadge()}</TableCell>
                            <TableCell>{getResultDisplay()}</TableCell>
                          </TableRow>
                        );
                      })}
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
