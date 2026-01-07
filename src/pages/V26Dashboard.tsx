import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, RefreshCw, TrendingUp, TrendingDown, DollarSign, Target, Percent,
  Clock, Zap, BarChart3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ExternalLink
} from 'lucide-react';
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
}

interface StrikePrice {
  market_slug: string;
  strike_price: number;
  close_price: number | null;
}

interface TradeLog {
  id: string;
  market: string;
  asset: string;
  time: string;
  shares: number;
  pricePerShare: number;
  total: number;
  orderType: 'LIMIT';
  result: 'WIN' | 'LOSS' | 'LIVE' | 'PENDING' | 'NOT_BOUGHT';
  pnl: number | null;
  fillTimeMs: number | null;
  strikePrice: number | null;
  closePrice: number | null;
  delta: number | null;
  status: string;
  eventEndTime: string;
  createdAt: string;
}

interface AssetStats {
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  invested: number;
}

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;
const PAGE_SIZE = 20;

export default function V26Dashboard() {
  const navigate = useNavigate();
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [stats, setStats] = useState({
    totalBets: 0,
    filledBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    live: 0,
    winRate: 0,
    totalInvested: 0,
    totalPnl: 0,
  });
  const [assetStats, setAssetStats] = useState<Record<string, AssetStats>>({});
  const [fillTimeStats, setFillTimeStats] = useState({
    avgMs: 0,
    bestMs: Infinity,
    worstMs: 0,
    count: 0,
  });

  const fetchData = async () => {
    setLoading(true);

    const tradesRes = await supabase
      .from('v26_trades')
      .select('*')
      .order('event_start_time', { ascending: false })
      .limit(500);

    const tradesData = tradesRes.data as V26Trade[] | null;

    if (!tradesData) {
      setLoading(false);
      return;
    }

    const marketSlugs = Array.from(new Set(tradesData.map((t) => t.market_slug))).filter(Boolean);

    const strikesRes = marketSlugs.length
      ? await supabase
          .from('strike_prices')
          .select('market_slug, strike_price, close_price')
          .in('market_slug', marketSlugs)
      : { data: [] as StrikePrice[] };

    const strikesData = strikesRes.data as StrikePrice[] | null;

    const strikeLookup = new Map<string, StrikePrice>();
    if (strikesData) {
      for (const s of strikesData) {
        strikeLookup.set(s.market_slug, s);
      }
    }

    const logs: TradeLog[] = [];
    let totalWins = 0;
    let totalLosses = 0;
    let totalPending = 0;
    let totalLive = 0;
    let totalFilled = 0;
    let totalInvested = 0;
    let totalPnl = 0;

    // Per-asset stats
    const perAsset: Record<string, AssetStats> = {
      BTC: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0 },
      ETH: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0 },
      SOL: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0 },
      XRP: { wins: 0, losses: 0, winRate: 0, pnl: 0, invested: 0 },
    };

    // Fill time tracking
    const fillTimes: number[] = [];

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
      const fillTimeMs = trade.fill_time_ms;

      // Track fill times
      if (fillTimeMs !== null && fillTimeMs > 0) {
        fillTimes.push(fillTimeMs);
      }

      const tradeResult = trade.result;
      const tradePnl = trade.pnl;

      let result: TradeLog['result'];
      
      if (!isFilled) {
        result = 'NOT_BOUGHT';
      } else if (!isEnded) {
        result = 'LIVE';
        totalLive++;
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].invested += cost;
      } else if (tradeResult === 'DOWN') {
        result = 'WIN';
        totalWins++;
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].wins++;
        perAsset[trade.asset].invested += cost;
      } else if (tradeResult === 'UP') {
        result = 'LOSS';
        totalLosses++;
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].losses++;
        perAsset[trade.asset].invested += cost;
      } else if (delta !== null) {
        if (delta < 0) {
          result = 'WIN';
          totalWins++;
          perAsset[trade.asset].wins++;
        } else {
          result = 'LOSS';
          totalLosses++;
          perAsset[trade.asset].losses++;
        }
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].invested += cost;
      } else {
        result = 'PENDING';
        totalPending++;
        totalFilled++;
        totalInvested += cost;
        perAsset[trade.asset].invested += cost;
      }

      let pnl: number | null = null;
      
      if (tradePnl !== null) {
        pnl = tradePnl;
        totalPnl += pnl;
        perAsset[trade.asset].pnl += pnl;
      } else if (isFilled && result === 'LOSS') {
        pnl = -cost;
        totalPnl += pnl;
        perAsset[trade.asset].pnl += pnl;
      }

      const startTime = new Date(trade.event_start_time);

      logs.push({
        id: trade.id,
        market: trade.market_slug,
        asset: trade.asset,
        time: format(startTime, 'dd-MM HH:mm'),
        shares: filledShares,
        pricePerShare: avgPrice,
        total: cost,
        orderType: 'LIMIT',
        result,
        pnl,
        fillTimeMs,
        strikePrice,
        closePrice,
        delta,
        status: trade.status,
        eventEndTime: trade.event_end_time,
        createdAt: trade.created_at,
      });
    }

    // Calculate win rates per asset
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const a = perAsset[asset];
      a.winRate = a.wins + a.losses > 0 ? (a.wins / (a.wins + a.losses)) * 100 : 0;
    }

    const winRate = totalWins + totalLosses > 0 
      ? (totalWins / (totalWins + totalLosses)) * 100 
      : 0;

    // Calculate fill time stats
    const fillTimeStatsCalc = {
      avgMs: fillTimes.length > 0 ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length : 0,
      bestMs: fillTimes.length > 0 ? Math.min(...fillTimes) : 0,
      worstMs: fillTimes.length > 0 ? Math.max(...fillTimes) : 0,
      count: fillTimes.length,
    };

    setTrades(logs);
    setAssetStats(perAsset);
    setFillTimeStats(fillTimeStatsCalc);
    setStats({
      totalBets: logs.length,
      filledBets: totalFilled,
      wins: totalWins,
      losses: totalLosses,
      pending: totalPending,
      live: totalLive,
      winRate,
      totalInvested,
      totalPnl,
    });
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    
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

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [assetFilter]);

  const filtered = useMemo(() => 
    assetFilter === 'ALL' 
      ? trades 
      : trades.filter(t => t.asset === assetFilter),
    [trades, assetFilter]
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginatedTrades = useMemo(() => 
    filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  const getResultBadge = (log: TradeLog) => {
    switch (log.result) {
      case 'NOT_BOUGHT':
        return <Badge variant="outline" className="text-muted-foreground text-xs">❌ Niet gekocht</Badge>;
      case 'LIVE':
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 text-xs">🔴 Live</Badge>;
      case 'PENDING':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 text-xs">⏳ Oracle</Badge>;
      case 'WIN':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20 text-xs">✓ WIN</Badge>;
      case 'LOSS':
        return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 text-xs">✗ LOSS</Badge>;
    }
  };

  const formatFillTime = (ms: number | null) => {
    if (ms === null || ms === 0) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getBestAsset = () => {
    let best = { asset: '-', winRate: 0 };
    for (const [asset, stats] of Object.entries(assetStats)) {
      if (stats.wins + stats.losses >= 3 && stats.winRate > best.winRate) {
        best = { asset, winRate: stats.winRate };
      }
    }
    return best;
  };

  const getWorstAsset = () => {
    let worst = { asset: '-', winRate: 100 };
    for (const [asset, stats] of Object.entries(assetStats)) {
      if (stats.wins + stats.losses >= 3 && stats.winRate < worst.winRate) {
        worst = { asset, winRate: stats.winRate };
      }
    }
    return worst.asset === '-' ? { asset: '-', winRate: 0 } : worst;
  };

  const bestAsset = getBestAsset();
  const worstAsset = getWorstAsset();

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl md:text-3xl font-bold">V26 Trade Log</h1>
              <div className="flex items-center gap-2">
                <span className="text-sm">🐍</span>
                <p className="text-sm text-muted-foreground">DOWN @ $0.48 LIMIT orders</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              asChild
            >
              <a 
                href="https://polymarket.com/profile?tab=portfolio" 
                target="_blank" 
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Polymarket
              </a>
            </Button>
            <Button onClick={fetchData} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Main KPIs - Row 1 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-gradient-to-br from-card to-muted/30">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Target className="h-3 w-3" /> Filled
              </div>
              <div className="text-2xl font-bold">{stats.filledBets}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {stats.live > 0 && <span className="text-blue-500">{stats.live} live</span>}
                {stats.live > 0 && stats.pending > 0 && ' · '}
                {stats.pending > 0 && <span className="text-yellow-500">{stats.pending} pending</span>}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-green-500/5 to-green-500/10 border-green-500/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-green-500/70 text-xs mb-1">
                <TrendingUp className="h-3 w-3" /> Wins
              </div>
              <div className="text-2xl font-bold text-green-500">{stats.wins}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-red-500/5 to-red-500/10 border-red-500/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-red-500/70 text-xs mb-1">
                <TrendingDown className="h-3 w-3" /> Losses
              </div>
              <div className="text-2xl font-bold text-red-500">{stats.losses}</div>
            </CardContent>
          </Card>

          <Card className="bg-gradient-to-br from-card to-muted/30">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Percent className="h-3 w-3" /> Win Rate
              </div>
              <div className="text-2xl font-bold">{stats.winRate.toFixed(1)}%</div>
            </CardContent>
          </Card>

          <Card className={`bg-gradient-to-br ${stats.totalPnl >= 0 ? 'from-green-500/5 to-green-500/10 border-green-500/20' : 'from-red-500/5 to-red-500/10 border-red-500/20'}`}>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <DollarSign className="h-3 w-3" /> Net P&L
              </div>
              <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${stats.totalPnl.toFixed(2)}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Secondary KPIs - Row 2 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Zap className="h-3 w-3" /> Avg Fill Time
              </div>
              <div className="text-xl font-bold font-mono">
                {formatFillTime(fillTimeStats.avgMs)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Best: {formatFillTime(fillTimeStats.bestMs)} · Worst: {formatFillTime(fillTimeStats.worstMs)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <BarChart3 className="h-3 w-3" /> Best Asset
              </div>
              <div className="text-xl font-bold text-green-500">
                {bestAsset.asset}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {bestAsset.winRate.toFixed(0)}% win rate
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <BarChart3 className="h-3 w-3" /> Worst Asset
              </div>
              <div className="text-xl font-bold text-red-500">
                {worstAsset.asset}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {worstAsset.winRate.toFixed(0)}% win rate
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Clock className="h-3 w-3" /> Invested
              </div>
              <div className="text-xl font-bold font-mono">
                ${stats.totalInvested.toFixed(0)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                ~${(stats.totalInvested / Math.max(stats.filledBets, 1)).toFixed(2)} avg
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Asset Performance Cards */}
        <div className="grid grid-cols-4 gap-2">
          {['BTC', 'ETH', 'SOL', 'XRP'].map((asset) => {
            const s = assetStats[asset] || { wins: 0, losses: 0, winRate: 0, pnl: 0 };
            const total = s.wins + s.losses;
            return (
              <Card key={asset} className="overflow-hidden">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold text-sm">{asset}</span>
                    <span className={`text-xs font-mono ${s.pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {s.pnl >= 0 ? '+' : ''}{s.pnl.toFixed(0)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 transition-all"
                        style={{ width: `${total > 0 ? (s.wins / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">
                      {s.wins}/{total}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Filter + Pagination Info */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {ASSETS.map((asset) => (
              <Button
                key={asset}
                variant={assetFilter === asset ? 'default' : 'outline'}
                size="sm"
                onClick={() => setAssetFilter(asset)}
                className="text-xs px-3"
              >
                {asset}
              </Button>
            ))}
          </div>
          <div className="text-sm text-muted-foreground">
            {filtered.length} trades · Pagina {currentPage} van {Math.max(totalPages, 1)}
          </div>
        </div>

        {/* Trade Log Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border/50">
                    <TableHead className="text-xs font-medium">Markt</TableHead>
                    <TableHead className="text-xs font-medium">Event</TableHead>
                    <TableHead className="text-xs font-medium text-right">Shares</TableHead>
                    <TableHead className="text-xs font-medium text-right">Prijs</TableHead>
                    <TableHead className="text-xs font-medium text-right">Cost</TableHead>
                    <TableHead className="text-xs font-medium">Fill Time</TableHead>
                    <TableHead className="text-xs font-medium">Result</TableHead>
                    <TableHead className="text-xs font-medium text-right">P&L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedTrades.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                        Geen trades gevonden
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedTrades.map((log) => (
                      <TableRow 
                        key={log.id} 
                        className={`border-b border-border/30 ${log.result === 'NOT_BOUGHT' ? 'opacity-40' : ''} hover:bg-muted/30 transition-colors`}
                      >
                        <TableCell className="py-2">
                          <div className="font-medium text-sm">{log.market}</div>
                        </TableCell>
                        <TableCell className="py-2 text-muted-foreground text-sm">{log.time}</TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.shares > 0 ? log.shares : '-'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.shares > 0 ? `$${log.pricePerShare.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm">
                          {log.total > 0 ? `$${log.total.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="py-2">
                          {log.fillTimeMs !== null && log.fillTimeMs > 0 ? (
                            <Badge 
                              variant="outline" 
                              className={`text-xs ${
                                log.fillTimeMs < 2000 
                                  ? 'text-green-500 border-green-500/30' 
                                  : log.fillTimeMs < 5000 
                                    ? 'text-yellow-500 border-yellow-500/30' 
                                    : 'text-red-500 border-red-500/30'
                              }`}
                            >
                              {formatFillTime(log.fillTimeMs)}
                            </Badge>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="py-2">{getResultBadge(log)}</TableCell>
                        <TableCell className="py-2 text-right font-mono text-sm font-bold">
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

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border/50">
                <div className="text-sm text-muted-foreground">
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                  >
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  
                  {/* Page numbers */}
                  <div className="flex items-center gap-1 mx-2">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? 'default' : 'outline'}
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setCurrentPage(pageNum)}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>

                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
