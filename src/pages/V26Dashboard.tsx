import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, TrendingUp, TrendingDown, DollarSign, Target, Percent } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';

// Polymarket fee structure
const MAKER_REBATE = 0.005; // 0.5% rebate for makers
const TAKER_FEE = 0.01;     // 1% fee for takers

interface V26Trade {
  id: string;
  created_at: string;
  asset: string;
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
  result: string | null;
  pnl: number | null;
}

interface StrikePrice {
  market_slug: string;
  strike_price: number;
  close_price: number | null;
}

interface TradeLog {
  id: string;
  market: string;           // e.g. "BTC DOWN 17:45"
  asset: string;
  time: string;             // event start time formatted
  shares: number;           // filled shares
  pricePerShare: number;    // avg fill price
  total: number;            // shares * price
  orderType: 'LIMIT';       // V26 always uses limit orders
  result: 'WIN' | 'LOSS' | 'LIVE' | 'PENDING' | 'NOT_BOUGHT';
  fee: number;              // estimated fee (negative = rebate)
  pnl: number | null;       // net profit/loss after fees
  // Raw data for display
  strikePrice: number | null;
  closePrice: number | null;
  delta: number | null;
  status: string;
  eventEndTime: string;
}

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;

export default function V26Dashboard() {
  const navigate = useNavigate();
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalBets: 0,
    filledBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    winRate: 0,
    totalInvested: 0,
    totalFees: 0,
    totalPnl: 0,
    grossPnl: 0,
  });

  const fetchData = async () => {
    setLoading(true);

    const [tradesRes, strikesRes] = await Promise.all([
      supabase
        .from('v26_trades')
        .select('*')
        .order('event_start_time', { ascending: false })
        .limit(200),
      supabase
        .from('strike_prices')
        .select('market_slug, strike_price, close_price')
        .limit(500),
    ]);

    const tradesData = tradesRes.data as V26Trade[] | null;
    const strikesData = strikesRes.data as StrikePrice[] | null;

    if (!tradesData) {
      setLoading(false);
      return;
    }

    // Create strike price lookup
    const strikeLookup = new Map<string, StrikePrice>();
    if (strikesData) {
      for (const s of strikesData) {
        strikeLookup.set(s.market_slug, s);
      }
    }

    // Process trades into simple log entries
    const logs: TradeLog[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalPending = 0;
    let totalFilled = 0;
    let totalInvested = 0;
    let totalFees = 0;
    let totalPnl = 0;
    let grossPnl = 0;

    // Group by market_slug to avoid duplicates
    const seen = new Set<string>();

    for (const trade of tradesData) {
      if (seen.has(trade.market_slug)) continue;
      seen.add(trade.market_slug);

      const strike = strikeLookup.get(trade.market_slug);
      const strikePrice = strike?.strike_price ?? null;
      const closePrice = strike?.close_price ?? null;
      const delta = strikePrice !== null && closePrice !== null 
        ? closePrice - strikePrice 
        : null;

      const now = new Date();
      const eventEnd = new Date(trade.event_end_time);
      const isEnded = eventEnd < now;
      const isFilled = trade.status === 'filled' || trade.filled_shares > 0;
      const filledShares = trade.filled_shares || 0;
      const avgPrice = trade.avg_fill_price ?? trade.price;
      const cost = filledShares * avgPrice;

      // Use trade.result from database if available (runner already calculated)
      const tradeResult = trade.result; // 'UP', 'DOWN', or null
      const tradePnl = trade.pnl; // already calculated by runner

      // Determine display result
      let result: TradeLog['result'];
      
      if (!isFilled) {
        result = 'NOT_BOUGHT';
      } else if (!isEnded) {
        result = 'LIVE';
        totalFilled++;
        totalInvested += cost;
      } else if (tradeResult === 'DOWN') {
        // DOWN = we win (we bet on DOWN)
        result = 'WIN';
        totalWins++;
        totalFilled++;
        totalInvested += cost;
      } else if (tradeResult === 'UP') {
        // UP = we lose
        result = 'LOSS';
        totalLosses++;
        totalFilled++;
        totalInvested += cost;
      } else if (delta !== null) {
        // Fallback: calculate from delta if runner hasn't set result yet
        if (delta < 0) {
          result = 'WIN';
          totalWins++;
        } else {
          result = 'LOSS';
          totalLosses++;
        }
        totalFilled++;
        totalInvested += cost;
      } else {
        result = 'PENDING';
        totalPending++;
        totalFilled++;
        totalInvested += cost;
      }

      // Calculate fees (assume maker for limit orders)
      const fee = isFilled ? -(cost * MAKER_REBATE) : 0; // negative = rebate
      totalFees += fee;

      // Use runner's P&L if available, otherwise calculate
      let pnl: number | null = null;
      let gross: number | null = null;
      
      if (tradePnl !== null) {
        // Use runner's calculated P&L
        gross = tradePnl;
        pnl = tradePnl - fee; // add rebate
        grossPnl += gross;
        totalPnl += pnl;
      } else if (isFilled && result === 'LOSS') {
        // LOSS: we lose our cost, but still got rebate on entry
        gross = -cost;
        pnl = gross - fee; // -cost - (-rebate) = -cost + rebate
        grossPnl += gross;
        totalPnl += pnl;
      }

      // Format market name
      const startTime = new Date(trade.event_start_time);
      const timeStr = format(startTime, 'HH:mm');
      const market = `${trade.asset} DOWN ${timeStr}`;

      logs.push({
        id: trade.id,
        market,
        asset: trade.asset,
        time: format(startTime, 'dd-MM HH:mm'),
        shares: filledShares,
        pricePerShare: avgPrice,
        total: cost,
        orderType: 'LIMIT',
        result,
        fee,
        pnl,
        strikePrice,
        closePrice,
        delta,
        status: trade.status,
        eventEndTime: trade.event_end_time,
      });
    }

    const winRate = totalWins + totalLosses > 0 
      ? (totalWins / (totalWins + totalLosses)) * 100 
      : 0;

    setTrades(logs);
    setStats({
      totalBets: logs.length,
      filledBets: totalFilled,
      wins: totalWins,
      losses: totalLosses,
      pending: totalPending,
      winRate,
      totalInvested,
      totalFees,
      totalPnl,
      grossPnl,
    });
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000); // 5 min refresh
    
    const channel = supabase
      .channel('v26_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'v26_trades' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'strike_prices' }, fetchData)
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  const getResultBadge = (log: TradeLog) => {
    switch (log.result) {
      case 'NOT_BOUGHT':
        return <Badge variant="outline" className="text-muted-foreground">❌ Niet gekocht</Badge>;
      case 'LIVE':
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">🔴 Live</Badge>;
      case 'PENDING':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">⏳ Wachten oracle</Badge>;
      case 'WIN':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">✓ WIN</Badge>;
      case 'LOSS':
        return <Badge className="bg-red-500/10 text-red-500 border-red-500/20">✗ LOSS</Badge>;
    }
  };

  const filtered = assetFilter === 'ALL' 
    ? trades 
    : trades.filter(t => t.asset === assetFilter);

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
              <h1 className="text-3xl font-bold">V26 Trade Log</h1>
              <p className="text-muted-foreground">DOWN @ $0.48 LIMIT orders</p>
            </div>
          </div>
          <Button onClick={fetchData} variant="outline" disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Target className="h-3 w-3" /> Gevuld
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.filledBets}</div>
              <div className="text-xs text-muted-foreground">{stats.pending} wachten</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Wins
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{stats.wins}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <TrendingDown className="h-3 w-3" /> Losses
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-500">{stats.losses}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Percent className="h-3 w-3" /> Win Rate
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.winRate.toFixed(1)}%</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <DollarSign className="h-3 w-3" /> Netto P&L
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${stats.totalPnl.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">
                Fees: ${stats.totalFees.toFixed(2)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filter */}
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

        {/* Trade Log Table */}
        <Card>
          <CardHeader>
            <CardTitle>Trade Log</CardTitle>
            <CardDescription>Alle trades met volledige data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Markt</TableHead>
                    <TableHead>Tijd</TableHead>
                    <TableHead className="text-right">Shares</TableHead>
                    <TableHead className="text-right">Prijs/Share</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Order Type</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead className="text-right">Fee</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                        Geen trades gevonden
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((log) => (
                      <TableRow key={log.id} className={log.result === 'NOT_BOUGHT' ? 'opacity-50' : ''}>
                        <TableCell className="font-medium">{log.market}</TableCell>
                        <TableCell className="text-muted-foreground">{log.time}</TableCell>
                        <TableCell className="text-right font-mono">
                          {log.shares > 0 ? log.shares : '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {log.shares > 0 ? `$${log.pricePerShare.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {log.total > 0 ? `$${log.total.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{log.orderType}</Badge>
                        </TableCell>
                        <TableCell>{getResultBadge(log)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {log.fee !== 0 ? (
                            <span className={log.fee < 0 ? 'text-green-500' : 'text-red-500'}>
                              {log.fee < 0 ? '+' : '-'}${Math.abs(log.fee).toFixed(3)}
                            </span>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {log.pnl !== null ? (
                            <span className={log.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                              {log.pnl >= 0 ? '+' : ''}${log.pnl.toFixed(2)}
                            </span>
                          ) : '-'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Summary Box */}
        <Card className="bg-muted/50">
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Totaal geïnvesteerd:</span>
                <span className="ml-2 font-bold">${stats.totalInvested.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Bruto P&L:</span>
                <span className={`ml-2 font-bold ${stats.grossPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  ${stats.grossPnl.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Fees (rebate):</span>
                <span className="ml-2 font-bold text-green-500">${Math.abs(stats.totalFees).toFixed(2)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Netto P&L:</span>
                <span className={`ml-2 font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  ${stats.totalPnl.toFixed(2)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
