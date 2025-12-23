import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Bot,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  RefreshCw,
  Play,
  CheckCircle2,
  Clock,
  Zap,
  Activity,
  Wallet,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { usePaperTrades, PaperTrade, PaperTradeResult } from '@/hooks/usePaperTrades';
import { formatDistanceToNow } from 'date-fns';
import { usePolymarketRealtime } from '@/hooks/usePolymarketRealtime';

interface PaperTradeDashboardProps {
  compact?: boolean;
}

export const PaperTradeDashboard: React.FC<PaperTradeDashboardProps> = ({ compact = false }) => {
  const { trades, results, stats, isLoading, triggerBot, triggerSettle, refetch } = usePaperTrades();
  const { getPrice, pricesVersion } = usePolymarketRealtime();
  const [isTriggering, setIsTriggering] = React.useState(false);

  const handleTriggerBot = async () => {
    setIsTriggering(true);
    await triggerBot();
    setIsTriggering(false);
  };

  const handleTriggerSettle = async () => {
    setIsTriggering(true);
    await triggerSettle();
    setIsTriggering(false);
  };

  // Calculate unrealized P&L for open positions
  const unrealizedStats = useMemo(() => {
    const settledSlugs = new Set(results.filter(r => r.settled_at).map(r => r.market_slug));
    const openTrades = trades.filter(t => !settledSlugs.has(t.market_slug));
    
    let totalUnrealizedPL = 0;
    let totalCurrentValue = 0;
    let totalOpenInvested = 0;
    
    const byMarket = openTrades.reduce((acc, trade) => {
      if (!acc[trade.market_slug]) {
        acc[trade.market_slug] = { upShares: 0, upCost: 0, downShares: 0, downCost: 0 };
      }
      if (trade.outcome === 'UP') {
        acc[trade.market_slug].upShares += trade.shares;
        acc[trade.market_slug].upCost += trade.total;
      } else {
        acc[trade.market_slug].downShares += trade.shares;
        acc[trade.market_slug].downCost += trade.total;
      }
      return acc;
    }, {} as Record<string, { upShares: number; upCost: number; downShares: number; downCost: number }>);
    
    for (const [slug, pos] of Object.entries(byMarket)) {
      const upPrice = getPrice(slug, 'up');
      const downPrice = getPrice(slug, 'down');
      const invested = pos.upCost + pos.downCost;
      totalOpenInvested += invested;
      
      if (upPrice !== null && downPrice !== null) {
        const upValue = pos.upShares * upPrice;
        const downValue = pos.downShares * downPrice;
        totalCurrentValue += upValue + downValue;
        totalUnrealizedPL += (upValue + downValue) - invested;
      }
    }
    
    return {
      unrealizedPL: totalUnrealizedPL,
      currentValue: totalCurrentValue,
      openInvested: totalOpenInvested,
      unrealizedPLPercent: totalOpenInvested > 0 ? (totalUnrealizedPL / totalOpenInvested) * 100 : 0,
    };
  }, [trades, results, getPrice, pricesVersion]);

  if (compact) {
    return (
      <Card className="border-border/50 bg-card/50 backdrop-blur">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              <span className="font-medium text-sm">Paper Bot</span>
            </div>
            <Badge variant="secondary" className="text-xs">
              {trades.length} trades
            </Badge>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Invested</div>
              <div className="font-mono font-semibold">${stats.totalInvested.toFixed(0)}</div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">P/L</div>
              <div className={`font-mono font-semibold ${stats.totalProfitLoss >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {stats.totalProfitLoss >= 0 ? '+' : ''}${stats.totalProfitLoss.toFixed(2)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Win Rate</div>
              <div className={`font-mono font-semibold ${stats.winRate >= 50 ? 'text-emerald-500' : 'text-red-500'}`}>
                {stats.winRate.toFixed(0)}%
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Group trades by market
  const tradesByMarket = trades.reduce((acc, trade) => {
    if (!acc[trade.market_slug]) {
      acc[trade.market_slug] = [];
    }
    acc[trade.market_slug].push(trade);
    return acc;
  }, {} as Record<string, PaperTrade[]>);

  const settledSlugs = new Set(results.filter(r => r.settled_at).map(r => r.market_slug));
  const openMarkets = Object.keys(tradesByMarket).filter(slug => !settledSlugs.has(slug));
  const totalPL = stats.totalProfitLoss + unrealizedStats.unrealizedPL;
  const budgetRemaining = 1000 - stats.totalInvested + stats.totalProfitLoss;

  return (
    <div className="space-y-6">
      {/* Main Stats Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Portfolio Value */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Wallet className="w-4 h-4 text-primary" />
              </div>
              <span className="text-sm text-muted-foreground">Portfolio</span>
            </div>
            <div className="text-3xl font-bold mb-1">
              ${(budgetRemaining + unrealizedStats.currentValue).toFixed(0)}
            </div>
            <div className={`text-sm flex items-center gap-1 ${totalPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {totalPL >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
              {totalPL >= 0 ? '+' : ''}{((totalPL / 1000) * 100).toFixed(2)}% all time
            </div>
          </CardContent>
        </Card>

        {/* Total P/L */}
        <Card className={totalPL >= 0 ? 'border-emerald-500/20' : 'border-red-500/20'}>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className={`p-2 rounded-lg ${totalPL >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                {totalPL >= 0 ? <TrendingUp className="w-4 h-4 text-emerald-500" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
              </div>
              <span className="text-sm text-muted-foreground">Total P/L</span>
            </div>
            <div className={`text-3xl font-bold mb-1 ${totalPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}
            </div>
            <div className="text-sm text-muted-foreground flex gap-3">
              <span>Realized: ${stats.totalProfitLoss.toFixed(2)}</span>
              <span>Open: ${unrealizedStats.unrealizedPL.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Win Rate */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-lg bg-muted">
                <Target className="w-4 h-4 text-muted-foreground" />
              </div>
              <span className="text-sm text-muted-foreground">Performance</span>
            </div>
            <div className={`text-3xl font-bold mb-1 ${stats.winRate >= 50 ? 'text-emerald-500' : 'text-red-500'}`}>
              {stats.winRate.toFixed(0)}%
            </div>
            <div className="text-sm text-muted-foreground">
              {stats.winCount}W / {stats.lossCount}L / {stats.pendingCount} pending
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <Card>
          <CardContent className="p-5 flex flex-col justify-center gap-2">
            <Button 
              onClick={handleTriggerBot}
              disabled={isTriggering}
              className="w-full"
              size="sm"
            >
              {isTriggering ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Run Bot
            </Button>
            <Button 
              variant="outline"
              onClick={handleTriggerSettle}
              disabled={isTriggering}
              className="w-full"
              size="sm"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Settle Markets
            </Button>
            <div className="text-xs text-center text-muted-foreground mt-1">
              {stats.totalTrades} trades • ${stats.totalInvested.toFixed(0)} invested
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Open Positions */}
      {openMarkets.length > 0 && (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="w-5 h-5 text-primary" />
                Open Positions
                <Badge variant="secondary">{openMarkets.length}</Badge>
              </CardTitle>
              {unrealizedStats.openInvested > 0 && (
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
                  unrealizedStats.unrealizedPL >= 0 
                    ? 'bg-emerald-500/10 text-emerald-500' 
                    : 'bg-red-500/10 text-red-500'
                }`}>
                  <Activity className="w-3.5 h-3.5" />
                  {unrealizedStats.unrealizedPL >= 0 ? '+' : ''}${unrealizedStats.unrealizedPL.toFixed(2)} unrealized
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border/50">
                    <th className="text-left pb-3 font-medium">Market</th>
                    <th className="text-center pb-3 font-medium">Position</th>
                    <th className="text-center pb-3 font-medium">Hedge</th>
                    <th className="text-right pb-3 font-medium">Cost</th>
                    <th className="text-right pb-3 font-medium">Value</th>
                    <th className="text-right pb-3 font-medium">P/L</th>
                    <th className="text-right pb-3 font-medium">If UP</th>
                    <th className="text-right pb-3 font-medium">If DOWN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {openMarkets.slice(0, 15).map(slug => {
                    const marketTrades = tradesByMarket[slug];
                    const upTrades = marketTrades.filter(t => t.outcome === 'UP');
                    const downTrades = marketTrades.filter(t => t.outcome === 'DOWN');
                    const upShares = upTrades.reduce((s, t) => s + t.shares, 0);
                    const downShares = downTrades.reduce((s, t) => s + t.shares, 0);
                    const upCost = upTrades.reduce((s, t) => s + t.total, 0);
                    const downCost = downTrades.reduce((s, t) => s + t.total, 0);
                    const totalCost = upCost + downCost;
                    const asset = marketTrades[0]?.asset || 'BTC';

                    const currentUpPrice = getPrice(slug, 'up');
                    const currentDownPrice = getPrice(slug, 'down');
                    const hasLivePrices = currentUpPrice !== null && currentDownPrice !== null;
                    
                    let currentValue = 0;
                    let posUnrealizedPL = 0;
                    if (hasLivePrices) {
                      currentValue = upShares * (currentUpPrice || 0) + downShares * (currentDownPrice || 0);
                      posUnrealizedPL = currentValue - totalCost;
                    }

                                    const profitIfUpWins = upShares - totalCost;
                                    const profitIfDownWins = downShares - totalCost;
                                    const totalShares = upShares + downShares;
                                    const upPct = totalShares > 0 ? (upShares / totalShares) * 100 : 50;
                                    
                                    // Hedge number: total shares per dollar invested
                                    const hedgeNumber = totalCost > 0 ? totalShares / totalCost : 0;

                    return (
                      <tr key={slug} className="group hover:bg-muted/30 transition-colors">
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${
                              asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                            }`}>
                              {asset === 'BTC' ? '₿' : 'Ξ'}
                            </div>
                            <div>
                              <div className="font-medium text-sm">{asset} 15m</div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {slug.split('-').slice(-1)[0]}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3">
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="text-emerald-500">{upShares.toFixed(0)}↑</span>
                              <span className="text-muted-foreground">/</span>
                              <span className="text-red-500">{downShares.toFixed(0)}↓</span>
                            </div>
                            <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden flex">
                              <div className="bg-emerald-500 transition-all" style={{ width: `${upPct}%` }} />
                              <div className="bg-red-500 transition-all" style={{ width: `${100 - upPct}%` }} />
                            </div>
                                          </div>
                                        </td>
                                        <td className="py-3 text-center">
                                          <span className={`font-mono text-sm font-medium ${
                                            hedgeNumber >= 1.02 ? 'text-emerald-500' : 
                                            hedgeNumber <= 0.98 ? 'text-red-500' : 
                                            'text-yellow-500'
                                          }`}>
                                            {hedgeNumber.toFixed(2)}
                                          </span>
                                        </td>
                                        <td className="py-3 text-right font-mono text-sm">
                          ${totalCost.toFixed(2)}
                        </td>
                        <td className="py-3 text-right font-mono text-sm">
                          {hasLivePrices ? `$${currentValue.toFixed(2)}` : '—'}
                        </td>
                        <td className="py-3 text-right">
                          {hasLivePrices ? (
                            <span className={`font-mono text-sm font-medium ${posUnrealizedPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                              {posUnrealizedPL >= 0 ? '+' : ''}{posUnrealizedPL.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          <span className={`font-mono text-sm ${profitIfUpWins >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                            {profitIfUpWins >= 0 ? '+' : ''}{profitIfUpWins.toFixed(0)}
                          </span>
                        </td>
                        <td className="py-3 text-right">
                          <span className={`font-mono text-sm ${profitIfDownWins >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                            {profitIfDownWins >= 0 ? '+' : ''}{profitIfDownWins.toFixed(0)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {openMarkets.length > 15 && (
              <div className="text-center text-sm text-muted-foreground mt-4">
                +{openMarkets.length - 15} more positions
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Settled Results & Recent Trades in two columns */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Settled Results */}
        {results.filter(r => r.settled_at).length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                Settled Results
                <Badge variant="secondary">{results.filter(r => r.settled_at).length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {results.filter(r => r.settled_at).slice(0, 15).map(result => (
                  <div 
                    key={result.id} 
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      (result.profit_loss || 0) > 0 
                        ? 'bg-emerald-500/5 border border-emerald-500/10' 
                        : 'bg-red-500/5 border border-red-500/10'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded flex items-center justify-center text-xs font-bold ${
                        result.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                      }`}>
                        {result.asset === 'BTC' ? '₿' : 'Ξ'}
                      </div>
                      <div>
                        <Badge variant="outline" className={`text-xs ${
                          result.result === 'UP' 
                            ? 'text-emerald-500 border-emerald-500/30' 
                            : 'text-red-500 border-red-500/30'
                        }`}>
                          {result.result} won
                        </Badge>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={`font-mono font-medium ${(result.profit_loss || 0) > 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {(result.profit_loss || 0) > 0 ? '+' : ''}${result.profit_loss?.toFixed(2)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ${result.total_invested?.toFixed(0)} → ${result.payout?.toFixed(0)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent Trades */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Zap className="w-5 h-5 text-primary" />
              Recent Trades
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-2">
              {trades.slice(0, 20).map(trade => (
                <div key={trade.id} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${
                      trade.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                    }`}>
                      {trade.asset === 'BTC' ? '₿' : 'Ξ'}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {trade.outcome === 'UP' ? (
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span className={`text-sm font-medium ${trade.outcome === 'UP' ? 'text-emerald-500' : 'text-red-500'}`}>
                        {trade.outcome}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <span className="font-mono">
                      {trade.shares.toFixed(0)} @ {(trade.price * 100).toFixed(0)}¢
                    </span>
                    <span className="text-muted-foreground w-16 text-right">
                      ${trade.total.toFixed(2)}
                    </span>
                    <span className="text-muted-foreground w-20 text-right">
                      {formatDistanceToNow(new Date(trade.created_at), { addSuffix: true }).replace('about ', '')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
