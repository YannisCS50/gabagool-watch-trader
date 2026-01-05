import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Zap,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Target,
  RefreshCw,
  AlertTriangle,
  Clock,
  Activity,
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  ShieldAlert,
  Power,
} from 'lucide-react';
import { useLiveTrades, LiveTrade, LiveTradeResult } from '@/hooks/useLiveTrades';
import { formatDistanceToNow } from 'date-fns';
import { usePolymarketRealtime } from '@/hooks/usePolymarketRealtime';
import { useStrikePrices } from '@/hooks/useStrikePrices';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface LiveTradeDashboardProps {
  compact?: boolean;
}

export const LiveTradeDashboard: React.FC<LiveTradeDashboardProps> = ({ compact = false }) => {
  const { trades, results, stats, isLoading, refetch } = useLiveTrades();
  const { getPrice, pricesVersion } = usePolymarketRealtime();
  const { getStrikePrice } = useStrikePrices();
  const [isKilling, setIsKilling] = useState(false);

  const handleKillSwitch = async () => {
    if (!confirm('⚠️ KILL SWITCH: Dit stopt alle live trading activiteit. Weet je het zeker?')) {
      return;
    }
    
    setIsKilling(true);
    try {
      const { data, error } = await supabase.functions.invoke('live-trade-bot', {
        body: { action: 'kill' }
      });
      
      if (error) throw error;
      toast.success('Kill switch geactiveerd - trading gestopt');
    } catch (err) {
      console.error('Kill switch error:', err);
      toast.error('Kill switch gefaald');
    } finally {
      setIsKilling(false);
    }
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
      <Card className="border-red-500/30 bg-gradient-to-br from-red-500/5 to-transparent backdrop-blur">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-red-500" />
              <span className="font-medium text-sm">Live Bot</span>
            </div>
            <Badge variant="destructive" className="text-xs">
              REAL $
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
              <div className="text-xs text-muted-foreground">Trades</div>
              <div className="font-mono font-semibold">{stats.totalTrades}</div>
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
  }, {} as Record<string, LiveTrade[]>);

  const settledSlugs = new Set(results.filter(r => r.settled_at).map(r => r.market_slug));
  const openMarkets = Object.keys(tradesByMarket).filter(slug => !settledSlugs.has(slug));
  const totalPL = stats.totalProfitLoss + unrealizedStats.unrealizedPL;

  return (
    <div className="space-y-6">
      {/* Warning Banner */}
      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-center gap-4">
        <ShieldAlert className="w-8 h-8 text-red-500 flex-shrink-0" />
        <div className="flex-1">
          <div className="font-semibold text-red-500">Live Trading Mode</div>
          <div className="text-sm text-muted-foreground">
            Dit is ECHT geld. Trades worden uitgevoerd op Polymarket.
          </div>
        </div>
        <Button 
          variant="destructive" 
          onClick={handleKillSwitch}
          disabled={isKilling}
          className="flex-shrink-0"
        >
          {isKilling ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Power className="w-4 h-4 mr-2" />}
          Kill Switch
        </Button>
      </div>

      {/* Main Stats Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Portfolio Value */}
        <Card className="bg-gradient-to-br from-red-500/10 to-red-500/5 border-red-500/20">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <Wallet className="w-4 h-4 text-red-500" />
              </div>
              <span className="text-sm text-muted-foreground">Portfolio (Live)</span>
            </div>
            <div className="text-3xl font-bold mb-1">
              ${(stats.totalInvested - stats.totalProfitLoss + unrealizedStats.currentValue).toFixed(0)}
            </div>
            <div className={`text-sm flex items-center gap-1 ${totalPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {totalPL >= 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
              {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)} total
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

        {/* Profit Per Hour */}
        <Card className={stats.profitPerHour >= 0 ? 'border-emerald-500/20' : 'border-red-500/20'}>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className={`p-2 rounded-lg ${stats.profitPerHour >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                <Clock className="w-4 h-4" />
              </div>
              <span className="text-sm text-muted-foreground">Profit/Uur</span>
            </div>
            <div className={`text-3xl font-bold mb-1 ${stats.profitPerHour >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {stats.profitPerHour >= 0 ? '+' : ''}${stats.profitPerHour.toFixed(2)}
            </div>
            <div className="text-sm text-muted-foreground">
              {stats.tradingHours.toFixed(0)}u actief
            </div>
          </CardContent>
        </Card>

        {/* Invested */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-lg bg-muted">
                <DollarSign className="w-4 h-4 text-muted-foreground" />
              </div>
              <span className="text-sm text-muted-foreground">Total Invested</span>
            </div>
            <div className="text-3xl font-bold mb-1">
              ${stats.totalInvested.toFixed(0)}
            </div>
            <div className="text-sm text-muted-foreground">
              {stats.totalTrades} trades
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
                <Clock className="w-5 h-5 text-red-500" />
                Live Open Positions
                <Badge variant="destructive">{openMarkets.length}</Badge>
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
                    <th className="text-center pb-3 font-medium">Strike</th>
                    <th className="text-center pb-3 font-medium">Prices</th>
                    <th className="text-center pb-3 font-medium">Status</th>
                    <th className="text-center pb-3 font-medium">Position</th>
                    <th className="text-right pb-3 font-medium">Cost</th>
                    <th className="text-right pb-3 font-medium">Value</th>
                    <th className="text-right pb-3 font-medium">P/L</th>
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

                    const eventEndTime = marketTrades[0]?.event_end_time;
                    const now = new Date();
                    const marketEnded = eventEndTime ? new Date(eventEndTime) < now : false;
                    const marketStatus: 'OPEN' | 'PENDING' = marketEnded ? 'PENDING' : 'OPEN';

                    const totalShares = upShares + downShares;
                    const upPct = totalShares > 0 ? (upShares / totalShares) * 100 : 50;

                    const strikePrice = getStrikePrice(slug);

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
                        <td className="py-3 text-center">
                          {strikePrice ? (
                            <div className="font-mono text-xs">
                              ${asset === 'BTC' ? strikePrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : strikePrice.toFixed(2)}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-3 text-center">
                          {hasLivePrices ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <div className="flex items-center gap-1 text-xs">
                                <span className="text-emerald-500 font-mono">{(currentUpPrice! * 100).toFixed(0)}¢</span>
                                <span className="text-muted-foreground">/</span>
                                <span className="text-red-500 font-mono">{(currentDownPrice! * 100).toFixed(0)}¢</span>
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                Σ {((currentUpPrice! + currentDownPrice!) * 100).toFixed(0)}¢
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">-</span>
                          )}
                        </td>
                        <td className="py-3 text-center">
                          {marketStatus === 'OPEN' ? (
                            <Badge variant="outline" className="text-xs text-emerald-500 border-emerald-500/50 bg-emerald-500/10">
                              <Activity className="w-3 h-3 mr-1" />
                              OPEN
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs text-yellow-500 border-yellow-500/50 bg-yellow-500/10 animate-pulse">
                              <Clock className="w-3 h-3 mr-1" />
                              PENDING
                            </Badge>
                          )}
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
                        <td className="py-3 text-right font-mono text-sm">
                          ${totalCost.toFixed(2)}
                        </td>
                        <td className="py-3 text-right font-mono text-sm">
                          {hasLivePrices ? `$${currentValue.toFixed(2)}` : '-'}
                        </td>
                        <td className={`py-3 text-right font-mono text-sm font-medium ${
                          posUnrealizedPL >= 0 ? 'text-emerald-500' : 'text-red-500'
                        }`}>
                          {hasLivePrices ? (
                            <>
                              {posUnrealizedPL >= 0 ? '+' : ''}${posUnrealizedPL.toFixed(2)}
                            </>
                          ) : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Closed Positions */}
      {results.filter(r => r.settled_at).length > 0 && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <DollarSign className="w-5 h-5 text-muted-foreground" />
              Closed Positions
              <Badge variant="secondary">{results.filter(r => r.settled_at).length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border/50">
                    <th className="text-left pb-3 font-medium">Market</th>
                    <th className="text-center pb-3 font-medium">Result</th>
                    <th className="text-right pb-3 font-medium">Invested</th>
                    <th className="text-right pb-3 font-medium">Payout</th>
                    <th className="text-right pb-3 font-medium">P/L</th>
                    <th className="text-right pb-3 font-medium">ROI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {results.filter(r => r.settled_at).slice(0, 10).map(result => (
                    <tr key={result.id} className="hover:bg-muted/30 transition-colors">
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm ${
                            result.asset === 'BTC' ? 'bg-orange-500/10 text-orange-500' : 'bg-blue-500/10 text-blue-500'
                          }`}>
                            {result.asset === 'BTC' ? '₿' : 'Ξ'}
                          </div>
                          <div>
                            <div className="font-medium text-sm">{result.asset} 15m</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {result.market_slug.split('-').slice(-1)[0]}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 text-center">
                        <Badge 
                          variant={result.result === 'UP' ? 'default' : 'secondary'}
                          className={result.result === 'UP' ? 'bg-emerald-500' : 'bg-red-500'}
                        >
                          {result.result}
                        </Badge>
                      </td>
                      <td className="py-3 text-right font-mono text-sm">
                        ${(result.total_invested || 0).toFixed(2)}
                      </td>
                      <td className="py-3 text-right font-mono text-sm">
                        ${(result.payout || 0).toFixed(2)}
                      </td>
                      <td className={`py-3 text-right font-mono text-sm font-medium ${
                        (result.profit_loss || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                      }`}>
                        {(result.profit_loss || 0) >= 0 ? '+' : ''}${(result.profit_loss || 0).toFixed(2)}
                      </td>
                      <td className={`py-3 text-right font-mono text-sm ${
                        (result.profit_loss_percent || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                      }`}>
                        {(result.profit_loss_percent || 0) >= 0 ? '+' : ''}{(result.profit_loss_percent || 0).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Trades */}
      {trades.length > 0 && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="w-5 h-5 text-muted-foreground" />
              Recent Live Trades
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {trades.slice(0, 20).map(trade => (
                <div key={trade.id} className="flex items-center justify-between py-2 px-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-6 h-6 rounded flex items-center justify-center text-xs font-bold ${
                      trade.outcome === 'UP' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
                    }`}>
                      {trade.outcome === 'UP' ? '↑' : '↓'}
                    </div>
                    <div>
                      <div className="text-sm font-medium">{trade.asset} {trade.outcome}</div>
                      <div className="text-xs text-muted-foreground">
                        {trade.shares.toFixed(0)} shares @ ${trade.price.toFixed(3)}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-medium">${trade.total.toFixed(2)}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(trade.created_at), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {trades.length === 0 && !isLoading && (
        <Card className="border-dashed">
          <CardContent className="p-12 text-center">
            <Zap className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <h3 className="font-semibold text-lg mb-2">Geen Live Trades</h3>
            <p className="text-muted-foreground">
              Er zijn nog geen live trades geplaatst. Start de live trading bot om te beginnen.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
