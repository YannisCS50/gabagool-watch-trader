import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  TrendingUp,
  TrendingDown,
  Target,
  DollarSign,
  BarChart3,
  PieChart,
  Calendar,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Award,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useLiveTrades, LiveTrade, LiveTradeResult } from '@/hooks/useLiveTrades';
import { format, formatDistanceToNow, differenceInMinutes, parseISO } from 'date-fns';

interface BetStats {
  market_slug: string;
  asset: string;
  trades: LiveTrade[];
  result?: LiveTradeResult;
  upShares: number;
  upCost: number;
  upAvgPrice: number;
  downShares: number;
  downCost: number;
  downAvgPrice: number;
  totalInvested: number;
  isHedged: boolean;
  lockedProfit: number;
  payout: number | null;
  profitLoss: number | null;
  profitLossPercent: number | null;
  isSettled: boolean;
  eventEndTime: string | null;
  firstTradeTime: string;
  lastTradeTime: string;
  tradeCount: number;
  outcome: string | null;
  // NEW: Paired/Unpaired exposure metrics (essential for paired-arbitrage evaluation)
  pairedShares: number;
  unpairedShares: number;
  unpairedNotional: number;
  unpairedSide: 'UP' | 'DOWN' | null;
}

type BetFilter = 'all' | 'running' | 'closed' | 'wins' | 'losses' | 'unpaired';

export const LivePnLDashboard = () => {
  const { trades, results, stats, isLoading } = useLiveTrades();
  const [expandedBets, setExpandedBets] = useState<Set<string>>(new Set());
  const [activeFilter, setActiveFilter] = useState<BetFilter>('running');

  // Calculate detailed stats per bet
  const betStats = useMemo(() => {
    const betsMap = new Map<string, BetStats>();

    // Process trades
    trades.forEach((trade) => {
      if (!betsMap.has(trade.market_slug)) {
        betsMap.set(trade.market_slug, {
          market_slug: trade.market_slug,
          asset: trade.asset,
          trades: [],
          upShares: 0,
          upCost: 0,
          upAvgPrice: 0,
          downShares: 0,
          downCost: 0,
          downAvgPrice: 0,
          totalInvested: 0,
          isHedged: false,
          lockedProfit: 0,
          payout: null,
          profitLoss: null,
          profitLossPercent: null,
          isSettled: false,
          eventEndTime: trade.event_end_time,
          firstTradeTime: trade.created_at,
          lastTradeTime: trade.created_at,
          tradeCount: 0,
          outcome: null,
          // NEW: Paired/Unpaired exposure
          pairedShares: 0,
          unpairedShares: 0,
          unpairedNotional: 0,
          unpairedSide: null,
        });
      }

      const bet = betsMap.get(trade.market_slug)!;
      bet.trades.push(trade);
      bet.tradeCount++;
      
      if (new Date(trade.created_at) < new Date(bet.firstTradeTime)) {
        bet.firstTradeTime = trade.created_at;
      }
      if (new Date(trade.created_at) > new Date(bet.lastTradeTime)) {
        bet.lastTradeTime = trade.created_at;
      }

      if (trade.outcome === 'UP') {
        bet.upShares += trade.shares;
        bet.upCost += trade.total;
      } else {
        bet.downShares += trade.shares;
        bet.downCost += trade.total;
      }
    });

    // Calculate derived stats and merge results
    betsMap.forEach((bet, slug) => {
      bet.totalInvested = bet.upCost + bet.downCost;
      bet.upAvgPrice = bet.upShares > 0 ? bet.upCost / bet.upShares : 0;
      bet.downAvgPrice = bet.downShares > 0 ? bet.downCost / bet.downShares : 0;
      bet.isHedged = bet.upShares > 0 && bet.downShares > 0;

      // NEW: Calculate paired/unpaired exposure (PRIMARY RISK METRIC)
      bet.pairedShares = Math.min(bet.upShares, bet.downShares);
      bet.unpairedShares = Math.abs(bet.upShares - bet.downShares);
      if (bet.unpairedShares > 0) {
        bet.unpairedSide = bet.upShares > bet.downShares ? 'UP' : 'DOWN';
        // Unpaired notional = unpaired shares * avg cost of the excess side
        const unpairedAvgCost = bet.unpairedSide === 'UP' ? bet.upAvgPrice : bet.downAvgPrice;
        bet.unpairedNotional = bet.unpairedShares * unpairedAvgCost;
      }

      // Calculate locked profit for hedged bets
      if (bet.isHedged) {
        const minShares = Math.min(bet.upShares, bet.downShares);
        bet.lockedProfit = minShares - (bet.upAvgPrice + bet.downAvgPrice) * minShares;
      }

      // Find matching result
      const result = results.find((r) => r.market_slug === slug);
      if (result) {
        bet.result = result;
        bet.payout = result.payout;
        bet.profitLoss = result.profit_loss;
        bet.profitLossPercent = result.profit_loss_percent;
        bet.isSettled = !!result.settled_at;
        bet.outcome = result.result;
      }
    });

    // Also include results that don't have matching trades in our list
    // This ensures settled bets are shown even if the trades aren't in our current trades array
    results.forEach((result) => {
      if (!betsMap.has(result.market_slug)) {
        betsMap.set(result.market_slug, {
          market_slug: result.market_slug,
          asset: result.asset,
          trades: [],
          upShares: result.up_shares || 0,
          upCost: result.up_cost || 0,
          upAvgPrice: result.up_avg_price || 0,
          downShares: result.down_shares || 0,
          downCost: result.down_cost || 0,
          downAvgPrice: result.down_avg_price || 0,
          totalInvested: result.total_invested || 0,
          isHedged: (result.up_shares || 0) > 0 && (result.down_shares || 0) > 0,
          lockedProfit: 0,
          payout: result.payout,
          profitLoss: result.profit_loss,
          profitLossPercent: result.profit_loss_percent,
          isSettled: !!result.settled_at,
          eventEndTime: result.event_end_time,
          firstTradeTime: result.created_at,
          lastTradeTime: result.created_at,
          tradeCount: 0,
          outcome: result.result,
          result: result,
          pairedShares: Math.min(result.up_shares || 0, result.down_shares || 0),
          unpairedShares: Math.abs((result.up_shares || 0) - (result.down_shares || 0)),
          unpairedNotional: 0,
          unpairedSide: null,
        });
      }
    });

    // Sort by most recent first
    return Array.from(betsMap.values()).sort(
      (a, b) => new Date(b.lastTradeTime).getTime() - new Date(a.lastTradeTime).getTime()
    );
  }, [trades, results]);

  // Helper to check if a bet is actually running (market not yet ended)
  const isBetRunning = (bet: BetStats) => {
    if (!bet.eventEndTime) return !bet.isSettled;
    return new Date(bet.eventEndTime) > new Date();
  };

  // Summary statistics
  const summaryStats = useMemo(() => {
    const settledBets = betStats.filter((b) => b.isSettled);
    const runningBets = betStats.filter((b) => isBetRunning(b));
    const pendingSettlement = betStats.filter((b) => !b.isSettled && !isBetRunning(b));

    const wins = settledBets.filter((b) => (b.profitLoss || 0) > 0);
    const losses = settledBets.filter((b) => (b.profitLoss || 0) < 0);
    const breakEven = settledBets.filter((b) => (b.profitLoss || 0) === 0);

    const totalRealizedPL = settledBets.reduce((sum, b) => sum + (b.profitLoss || 0), 0);
    const totalOpenInvested = runningBets.reduce((sum, b) => sum + b.totalInvested, 0);
    const totalSettledInvested = settledBets.reduce((sum, b) => sum + b.totalInvested, 0);

    const avgWin = wins.length > 0 ? wins.reduce((sum, b) => sum + (b.profitLoss || 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, b) => sum + (b.profitLoss || 0), 0) / losses.length : 0;
    const largestWin = wins.length > 0 ? Math.max(...wins.map((b) => b.profitLoss || 0)) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses.map((b) => b.profitLoss || 0)) : 0;

    const hedgedBets = betStats.filter((b) => b.isHedged);
    const unhedgedBets = betStats.filter((b) => !b.isHedged);
    const totalLockedProfit = hedgedBets.reduce((sum, b) => sum + b.lockedProfit, 0);

    const btcBets = betStats.filter((b) => b.asset === 'BTC');
    const ethBets = betStats.filter((b) => b.asset === 'ETH');
    const solBets = betStats.filter((b) => b.asset === 'SOL');
    const xrpBets = betStats.filter((b) => b.asset === 'XRP');

    return {
      totalBets: betStats.length,
      settledBets: settledBets.length,
      runningBets: runningBets.length,
      pendingSettlement: pendingSettlement.length,
      wins: wins.length,
      losses: losses.length,
      breakEven: breakEven.length,
      winRate: settledBets.length > 0 ? (wins.length / settledBets.length) * 100 : 0,
      totalRealizedPL,
      totalOpenInvested,
      totalSettledInvested,
      totalInvested: totalOpenInvested + totalSettledInvested,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      profitFactor: Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0,
      hedgedBets: hedgedBets.length,
      unhedgedBets: unhedgedBets.length,
      totalLockedProfit,
      // NEW: Unpaired exposure metrics (PRIMARY RISK MEASURE)
      totalUnpairedNotional: runningBets.reduce((sum, b) => sum + b.unpairedNotional, 0),
      totalPairedShares: runningBets.reduce((sum, b) => sum + b.pairedShares, 0),
      totalUnpairedShares: runningBets.reduce((sum, b) => sum + b.unpairedShares, 0),
      betsWithUnpairedRisk: runningBets.filter(b => b.unpairedShares > 0).length,
      btcBets: btcBets.length,
      ethBets: ethBets.length,
      solBets: solBets.length,
      xrpBets: xrpBets.length,
      btcPL: btcBets.filter(b => b.isSettled).reduce((sum, b) => sum + (b.profitLoss || 0), 0),
      ethPL: ethBets.filter(b => b.isSettled).reduce((sum, b) => sum + (b.profitLoss || 0), 0),
      solPL: solBets.filter(b => b.isSettled).reduce((sum, b) => sum + (b.profitLoss || 0), 0),
      xrpPL: xrpBets.filter(b => b.isSettled).reduce((sum, b) => sum + (b.profitLoss || 0), 0),
    };
  }, [betStats]);

  // Filter bets based on active filter
  const filteredBets = useMemo(() => {
    switch (activeFilter) {
      case 'running':
        return betStats.filter((b) => isBetRunning(b));
      case 'closed':
        return betStats.filter((b) => b.isSettled);
      case 'wins':
        return betStats.filter((b) => b.isSettled && (b.profitLoss || 0) > 0);
      case 'losses':
        return betStats.filter((b) => b.isSettled && (b.profitLoss || 0) <= 0);
      case 'unpaired':
        return betStats.filter((b) => b.unpairedShares > 0);
      default:
        return betStats;
    }
  }, [betStats, activeFilter]);

  const toggleExpanded = (slug: string) => {
    const newExpanded = new Set(expandedBets);
    if (newExpanded.has(slug)) {
      newExpanded.delete(slug);
    } else {
      newExpanded.add(slug);
    }
    setExpandedBets(newExpanded);
  };

  const formatMarketSlug = (slug: string) => {
    // Parse market slug like "btc-updown-15m-1766870100"
    if (!slug) return 'Unknown';
    const parts = slug.split('-');
    if (parts.length >= 4) {
      const asset = parts[0].toUpperCase();
      const timestamp = parseInt(parts[parts.length - 1], 10);
      // Validate timestamp is a valid number
      if (!isNaN(timestamp) && timestamp > 0) {
        const date = new Date(timestamp * 1000);
        // Check if date is valid
        if (!isNaN(date.getTime())) {
          return `${asset} ${format(date, 'HH:mm')}`;
        }
      }
    }
    return slug;
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          Loading P/L data...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Header */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        {/* Total P/L */}
        <Card className={`col-span-2 ${summaryStats.totalRealizedPL >= 0 ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent' : 'border-red-500/30 bg-gradient-to-br from-red-500/10 to-transparent'}`}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              {summaryStats.totalRealizedPL >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              Realized P/L
            </div>
            <div className={`text-3xl font-bold font-mono ${summaryStats.totalRealizedPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {summaryStats.totalRealizedPL >= 0 ? '+' : ''}${summaryStats.totalRealizedPL.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              From {summaryStats.settledBets} settled bets
            </div>
          </CardContent>
        </Card>

        {/* Win Rate */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <Target className="w-4 h-4" />
              Win Rate
            </div>
            <div className={`text-2xl font-bold ${summaryStats.winRate >= 50 ? 'text-emerald-500' : summaryStats.settledBets > 0 ? 'text-red-500' : ''}`}>
              {summaryStats.settledBets > 0 ? `${summaryStats.winRate.toFixed(1)}%` : '—'}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {summaryStats.wins}W / {summaryStats.losses}L / {summaryStats.breakEven}BE
            </div>
          </CardContent>
        </Card>

        {/* Profit Factor */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <BarChart3 className="w-4 h-4" />
              Profit Factor
            </div>
            <div className={`text-2xl font-bold ${summaryStats.profitFactor >= 1 ? 'text-emerald-500' : summaryStats.settledBets > 0 ? 'text-red-500' : ''}`}>
              {summaryStats.profitFactor === Infinity ? '∞' : summaryStats.profitFactor.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Avg win / avg loss
            </div>
          </CardContent>
        </Card>

        {/* Open Positions */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <Clock className="w-4 h-4" />
              Running Bets
            </div>
            <div className="text-2xl font-bold">{summaryStats.runningBets}</div>
            <div className="text-xs text-muted-foreground mt-1">
              ${summaryStats.totalOpenInvested.toFixed(2)} invested
            </div>
          </CardContent>
        </Card>

        {/* Locked Profit */}
        <Card className={summaryStats.totalLockedProfit > 0 ? 'border-amber-500/30' : ''}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <Zap className="w-4 h-4" />
              Locked Profit
            </div>
            <div className={`text-2xl font-bold ${summaryStats.totalLockedProfit > 0 ? 'text-amber-500' : ''}`}>
              ${summaryStats.totalLockedProfit.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {summaryStats.hedgedBets} hedged bets
            </div>
          </CardContent>
        </Card>
      </div>

      {/* NEW: Unpaired Risk Card - PRIMARY RISK METRIC */}
      {summaryStats.totalUnpairedNotional > 0 && (
        <Card className="border-red-500/30 bg-gradient-to-br from-red-500/10 to-transparent">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  Unpaired Risk (Running Bets)
                </div>
                <div className="text-2xl font-bold text-red-500">
                  ${summaryStats.totalUnpairedNotional.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {summaryStats.betsWithUnpairedRisk} bets with unpaired exposure
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">Paired vs Unpaired</div>
                <div className="font-mono">
                  <span className="text-emerald-500">{summaryStats.totalPairedShares.toFixed(1)}</span>
                  {' / '}
                  <span className="text-red-500">{summaryStats.totalUnpairedShares.toFixed(1)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detailed Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-muted-foreground mb-2">Best Trade</div>
            <div className="text-xl font-bold text-emerald-500">
              +${summaryStats.largestWin.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-muted-foreground mb-2">Worst Trade</div>
            <div className="text-xl font-bold text-red-500">
              ${summaryStats.largestLoss.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-muted-foreground mb-2">Avg Win</div>
            <div className="text-xl font-bold text-emerald-500">
              +${summaryStats.avgWin.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-muted-foreground mb-2">Avg Loss</div>
            <div className="text-xl font-bold text-red-500">
              ${summaryStats.avgLoss.toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-Asset Breakdown */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <PieChart className="w-4 h-4" />
            Per-Asset Performance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex items-center justify-between p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-amber-500/20 text-amber-500 border-amber-500/30">BTC</Badge>
                <span className="text-sm">{summaryStats.btcBets} bets</span>
              </div>
              <span className={`font-mono font-bold ${summaryStats.btcPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {summaryStats.btcPL >= 0 ? '+' : ''}${summaryStats.btcPL.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-blue-500/20 text-blue-500 border-blue-500/30">ETH</Badge>
                <span className="text-sm">{summaryStats.ethBets} bets</span>
              </div>
              <span className={`font-mono font-bold ${summaryStats.ethPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {summaryStats.ethPL >= 0 ? '+' : ''}${summaryStats.ethPL.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-purple-500/20 text-purple-500 border-purple-500/30">SOL</Badge>
                <span className="text-sm">{summaryStats.solBets} bets</span>
              </div>
              <span className={`font-mono font-bold ${summaryStats.solPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {summaryStats.solPL >= 0 ? '+' : ''}${summaryStats.solPL.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-500/10 border border-slate-500/20">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="bg-slate-500/20 text-slate-400 border-slate-500/30">XRP</Badge>
                <span className="text-sm">{summaryStats.xrpBets} bets</span>
              </div>
              <span className={`font-mono font-bold ${summaryStats.xrpPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {summaryStats.xrpPL >= 0 ? '+' : ''}${summaryStats.xrpPL.toFixed(2)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bets List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Bets ({filteredBets.length})
            </div>
            <Tabs value={activeFilter} onValueChange={(v) => setActiveFilter(v as BetFilter)} className="w-auto">
              <TabsList className="h-8">
                <TabsTrigger value="all" className="text-xs px-3 h-6">All ({betStats.length})</TabsTrigger>
                <TabsTrigger value="running" className="text-xs px-3 h-6">Running ({summaryStats.runningBets})</TabsTrigger>
                <TabsTrigger value="closed" className="text-xs px-3 h-6">Closed ({summaryStats.settledBets})</TabsTrigger>
                <TabsTrigger value="wins" className="text-xs px-3 h-6 text-emerald-500">Wins ({summaryStats.wins})</TabsTrigger>
                <TabsTrigger value="losses" className="text-xs px-3 h-6 text-red-500">Losses ({summaryStats.losses})</TabsTrigger>
                {summaryStats.betsWithUnpairedRisk > 0 && (
                  <TabsTrigger value="unpaired" className="text-xs px-3 h-6 text-red-500">
                    ⚠ Unpaired ({summaryStats.betsWithUnpairedRisk})
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[500px]">
            <div className="space-y-2">
              {filteredBets.map((bet) => (
                <div
                  key={bet.market_slug}
                  className={`rounded-lg border transition-colors ${
                    bet.isSettled
                      ? (bet.profitLoss || 0) > 0
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : (bet.profitLoss || 0) < 0
                        ? 'border-red-500/30 bg-red-500/5'
                        : 'border-border/50 bg-muted/30'
                      : 'border-amber-500/30 bg-amber-500/5'
                  }`}
                >
                  {/* Main Row */}
                  <div
                    className="p-3 cursor-pointer"
                    onClick={() => toggleExpanded(bet.market_slug)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {/* Status Icon */}
                        {bet.isSettled ? (
                          (bet.profitLoss || 0) > 0 ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                          ) : (bet.profitLoss || 0) < 0 ? (
                            <XCircle className="w-5 h-5 text-red-500" />
                          ) : (
                            <MinusCircle className="w-5 h-5 text-muted-foreground" />
                          )
                        ) : (
                          <Clock className="w-5 h-5 text-amber-500" />
                        )}

                        <div>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={`text-xs ${
                                bet.asset === 'BTC'
                                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                                  : bet.asset === 'ETH'
                                  ? 'bg-blue-500/10 text-blue-500 border-blue-500/30'
                                  : bet.asset === 'SOL'
                                  ? 'bg-purple-500/10 text-purple-500 border-purple-500/30'
                                  : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                              }`}
                            >
                              {bet.asset}
                            </Badge>
                            <span className="font-medium">{formatMarketSlug(bet.market_slug)}</span>
                            {bet.isHedged && (
                              <Badge variant="outline" className="text-xs bg-primary/10 text-primary border-primary/30">
                                Hedged
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1">
                            <span>{bet.tradeCount} trades • ${bet.totalInvested.toFixed(2)} invested</span>
                            {bet.unpairedShares > 0 && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0 bg-red-500/10 text-red-500 border-red-500/30">
                                ⚠ {bet.unpairedShares.toFixed(1)} unpaired {bet.unpairedSide}
                              </Badge>
                            )}
                            {bet.eventEndTime && (
                              <span>• Ends {format(parseISO(bet.eventEndTime), 'HH:mm')}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        {/* P/L */}
                        <div className="text-right">
                          {bet.isSettled ? (
                            <>
                              <div className={`font-mono font-bold ${(bet.profitLoss || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                                {(bet.profitLoss || 0) >= 0 ? '+' : ''}${(bet.profitLoss || 0).toFixed(2)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {bet.profitLossPercent?.toFixed(1)}% ROI
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="font-mono text-amber-500">Pending</div>
                              {bet.lockedProfit > 0 && (
                                <div className="text-xs text-emerald-500">
                                  +${bet.lockedProfit.toFixed(2)} locked
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        {/* Expand Icon */}
                        {expandedBets.has(bet.market_slug) ? (
                          <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {expandedBets.has(bet.market_slug) && (
                    <div className="px-3 pb-3 border-t border-border/50 pt-3 space-y-3">
                      {/* Position Breakdown */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/20">
                          <div className="text-xs text-emerald-500 mb-1 flex items-center gap-1">
                            <ArrowUpRight className="w-3 h-3" />
                            UP Position
                          </div>
                          <div className="font-mono text-sm">
                            {bet.upShares.toFixed(1)} shares @ {(bet.upAvgPrice * 100).toFixed(1)}¢
                          </div>
                          <div className="text-xs text-muted-foreground">
                            ${bet.upCost.toFixed(2)} cost
                          </div>
                        </div>
                        <div className="p-2 rounded bg-red-500/10 border border-red-500/20">
                          <div className="text-xs text-red-500 mb-1 flex items-center gap-1">
                            <ArrowDownRight className="w-3 h-3" />
                            DOWN Position
                          </div>
                          <div className="font-mono text-sm">
                            {bet.downShares.toFixed(1)} shares @ {(bet.downAvgPrice * 100).toFixed(1)}¢
                          </div>
                          <div className="text-xs text-muted-foreground">
                            ${bet.downCost.toFixed(2)} cost
                          </div>
                        </div>
                      </div>

                      {/* Result if settled */}
                      {bet.isSettled && bet.result && (
                        <div className="p-2 rounded bg-muted/50 border border-border/50">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Outcome:</span>
                            <Badge variant={bet.outcome === 'UP' ? 'default' : 'secondary'}>
                              {bet.outcome}
                            </Badge>
                          </div>
                          <div className="flex items-center justify-between text-sm mt-1">
                            <span className="text-muted-foreground">Payout:</span>
                            <span className="font-mono">${(bet.payout || 0).toFixed(2)}</span>
                          </div>
                        </div>
                      )}

                      {/* Trade List */}
                      <div>
                        <div className="text-xs text-muted-foreground mb-2">Trade History</div>
                        <div className="space-y-1">
                          {bet.trades
                            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
                            .map((trade) => (
                              <div
                                key={trade.id}
                                className="flex items-center justify-between text-xs p-1.5 rounded bg-background/50"
                              >
                                <div className="flex items-center gap-2">
                                  <Badge
                                    variant="outline"
                                    className={`text-[10px] px-1.5 ${
                                      trade.outcome === 'UP'
                                        ? 'text-emerald-500 border-emerald-500/30'
                                        : 'text-red-500 border-red-500/30'
                                    }`}
                                  >
                                    {trade.outcome}
                                  </Badge>
                                  <span className="font-mono">
                                    {trade.shares} @ {(trade.price * 100).toFixed(0)}¢
                                  </span>
                                  <span className="text-muted-foreground">${trade.total.toFixed(2)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-muted-foreground">
                                    {format(parseISO(trade.created_at), 'HH:mm:ss')}
                                  </span>
                                  {trade.reasoning && (
                                    <span className="text-muted-foreground truncate max-w-[150px]" title={trade.reasoning}>
                                      {trade.reasoning}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {betStats.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No bets recorded yet
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
};
