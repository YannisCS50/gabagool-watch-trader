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

// Not used anymore - using v26_trades directly

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
  // From v26_trades (filled data)
  filled_shares: number;
  avg_fill_price: number | null;
  notional: number;
  status: string;
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

    // Fetch trades and strike prices in parallel
    const [tradesRes, strikesRes] = await Promise.all([
      supabase
        .from('v26_trades')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('strike_prices')
        .select('market_slug, asset, strike_price, close_price')
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    const tradesData = tradesRes.data;
    const strikesData = strikesRes.data;

    if (!tradesData) {
      setLoading(false);
      return;
    }

    // Create strike price lookup
    const strikeLookup = new Map<string, StrikePrice>();
    if (strikesData) {
      for (const s of strikesData) {
        if (!strikeLookup.has(s.market_slug)) {
          strikeLookup.set(s.market_slug, s as StrikePrice);
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
          // From v26_trades
          filled_shares: trade.filled_shares ?? 0,
          avg_fill_price: trade.avg_fill_price,
          notional: trade.notional ?? 0,
          status: trade.status,
        });
      }
      
      const bet = betMap.get(key)!;
      bet.trades.push(trade);
      // Sum up filled shares if multiple trades
      if (trade.filled_shares && trade.filled_shares > 0) {
        bet.filled_shares = Math.max(bet.filled_shares, trade.filled_shares);
        bet.avg_fill_price = trade.avg_fill_price;
        bet.notional = Math.max(bet.notional, trade.notional ?? 0);
        bet.status = trade.status;
      }
    }

    // Calculate results for each bet
    const betsArray: V26Bet[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalPending = 0;
    let totalFilled = 0;
    let totalPnl = 0;

    for (const bet of betMap.values()) {
      const isEnded = new Date(bet.event_end_time) < new Date();
      const hasFill = bet.filled_shares > 0 || bet.status === 'filled';
      
      if (!hasFill) {
        bet.result = 'NO_FILL';
      } else if (!isEnded) {
        bet.result = 'PENDING';
        totalPending++;
        totalFilled++;
      } else if (bet.delta !== null) {
        // Calculate cost from avg_fill_price * filled_shares or notional
        const cost = bet.notional > 0 ? bet.notional : (bet.avg_fill_price ?? 0.48) * bet.filled_shares;
        
        if (bet.delta < 0) {
          // DOWN wins: payout = shares * $1
          bet.result = 'WIN';
          const pnl = bet.filled_shares - cost;
          totalPnl += pnl;
          totalWins++;
        } else {
          // UP wins: loss = cost
          bet.result = 'LOSS';
          totalPnl -= cost;
          totalLosses++;
        }
        totalFilled++;
      } else {
        // Ended but no oracle data yet
        bet.result = 'PENDING';
        totalPending++;
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
    const cost = bet.notional > 0 ? bet.notional : (bet.avg_fill_price ?? 0.48) * bet.filled_shares;
    const pnl = bet.delta !== null 
      ? (bet.delta < 0 ? bet.filled_shares - cost : -cost)
      : null;
    
    switch (bet.result) {
      case 'WIN':
        return (
          <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
            ✓ WIN {pnl !== null && `+$${pnl.toFixed(2)}`}
          </Badge>
        );
      case 'LOSS':
        return (
          <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
            ✗ LOSS {pnl !== null && `-$${Math.abs(pnl).toFixed(2)}`}
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
                      <TableHead>Gekocht?</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Resultaat</TableHead>
                      <TableHead>P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bets
                      .filter((bet) => assetFilter === 'ALL' || bet.asset === assetFilter)
                      .map((bet) => {
                        const isEnded = new Date(bet.event_end_time) < new Date();
                        const hasFill = bet.filled_shares > 0 || bet.status === 'filled';

                        // Bet title: "BTC DOWN 16:15"
                        const betTitle = `${bet.asset} DOWN ${format(new Date(bet.event_start_time), 'HH:mm')}`;

                        // Determine outcome based on delta
                        const outcomeIsDown = bet.delta !== null && bet.delta < 0;

                        // Calculate cost and P&L
                        const cost = bet.notional > 0 ? bet.notional : (bet.avg_fill_price ?? 0.48) * bet.filled_shares;
                        
                        const calculatePnL = () => {
                          if (!isEnded || !hasFill) return null;
                          if (bet.delta === null) return null;
                          
                          if (outcomeIsDown) {
                            // DOWN wint: payout = shares x $1
                            return bet.filled_shares - cost;
                          } else {
                            // UP wint: verlies = cost
                            return -cost;
                          }
                        };

                        const pnl = calculatePnL();

                        return (
                          <TableRow key={bet.market_slug}>
                            <TableCell>
                              <div className="font-medium">{betTitle}</div>
                              <div className="text-xs text-muted-foreground">
                                {format(new Date(bet.event_start_time), 'MMM d, yyyy')}
                              </div>
                            </TableCell>
                            <TableCell>
                              {hasFill ? (
                                <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
                                  ✓ Ja
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">
                                  Nee
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="font-mono font-medium">
                              {hasFill ? bet.filled_shares : '-'}
                            </TableCell>
                            <TableCell className="font-mono">
                              {hasFill ? `$${cost.toFixed(2)}` : '-'}
                            </TableCell>
                            <TableCell>
                              {!isEnded ? (
                                <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
                                  🔴 Live
                                </Badge>
                              ) : bet.delta === null ? (
                                <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                                  ⏳ Wachten
                                </Badge>
                              ) : outcomeIsDown ? (
                                <Badge className="bg-green-500/10 text-green-500 border-green-500/20">
                                  ↓ DOWN
                                </Badge>
                              ) : (
                                <Badge className="bg-red-500/10 text-red-500 border-red-500/20">
                                  ↑ UP
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {!isEnded || !hasFill ? (
                                <span className="text-muted-foreground">-</span>
                              ) : pnl === null ? (
                                <span className="text-muted-foreground">⏳</span>
                              ) : pnl > 0 ? (
                                <div className="text-green-500 font-mono font-medium">
                                  +${pnl.toFixed(2)}
                                  <div className="text-xs text-muted-foreground">
                                    {bet.filled_shares} × $1
                                  </div>
                                </div>
                              ) : (
                                <div className="text-red-500 font-mono font-medium">
                                  -${Math.abs(pnl).toFixed(2)}
                                  <div className="text-xs text-muted-foreground">
                                    verlies: cost
                                  </div>
                                </div>
                              )}
                            </TableCell>
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
