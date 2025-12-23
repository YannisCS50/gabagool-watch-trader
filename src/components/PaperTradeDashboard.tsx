import React from 'react';
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
} from 'lucide-react';
import { usePaperTrades, PaperTrade, PaperTradeResult } from '@/hooks/usePaperTrades';
import { formatDistanceToNow } from 'date-fns';

interface PaperTradeDashboardProps {
  compact?: boolean;
}

export const PaperTradeDashboard: React.FC<PaperTradeDashboardProps> = ({ compact = false }) => {
  const { trades, results, stats, isLoading, triggerBot, triggerSettle, refetch } = usePaperTrades();
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

  if (compact) {
    return (
      <Card className="border-purple-500/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-purple-400">
              <Bot className="w-4 h-4" />
              Paper Trade Bot
            </div>
            <Badge variant="outline" className="text-purple-400 border-purple-500/30">
              {trades.length} trades
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2 rounded-md bg-muted/30">
              <div className="text-xs text-muted-foreground">Invested</div>
              <div className="font-mono font-bold">${stats.totalInvested.toFixed(0)}</div>
            </div>
            <div className="p-2 rounded-md bg-muted/30">
              <div className="text-xs text-muted-foreground">P/L</div>
              <div className={`font-mono font-bold ${stats.totalProfitLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {stats.totalProfitLoss >= 0 ? '+' : ''}${stats.totalProfitLoss.toFixed(2)}
              </div>
            </div>
            <div className="p-2 rounded-md bg-muted/30">
              <div className="text-xs text-muted-foreground">Win Rate</div>
              <div className={`font-mono font-bold ${stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
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

  // Get open positions (trades without settled results)
  const settledSlugs = new Set(results.filter(r => r.settled_at).map(r => r.market_slug));
  const openMarkets = Object.keys(tradesByMarket).filter(slug => !settledSlugs.has(slug));

  return (
    <div className="space-y-4">
      {/* Header Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="border-purple-500/30">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Activity className="w-4 h-4" />
              <span className="text-sm">Total Trades</span>
            </div>
            <div className="text-2xl font-bold text-purple-400">{stats.totalTrades}</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <DollarSign className="w-4 h-4" />
              <span className="text-sm">Total Invested</span>
            </div>
            <div className="text-2xl font-bold">${stats.totalInvested.toFixed(2)}</div>
          </CardContent>
        </Card>

        <Card className={stats.totalProfitLoss >= 0 ? 'border-emerald-500/30' : 'border-red-500/30'}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              <span className="text-sm">Total P/L</span>
            </div>
            <div className={`text-2xl font-bold ${stats.totalProfitLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {stats.totalProfitLoss >= 0 ? '+' : ''}${stats.totalProfitLoss.toFixed(2)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Target className="w-4 h-4" />
              <span className="text-sm">Win Rate</span>
            </div>
            <div className={`text-2xl font-bold ${stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
              {stats.winRate.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {stats.winCount}W / {stats.lossCount}L / {stats.pendingCount}P
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 flex flex-col gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleTriggerBot}
              disabled={isTriggering}
              className="w-full"
            >
              {isTriggering ? (
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Run Bot
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleTriggerSettle}
              disabled={isTriggering}
              className="w-full"
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Settle
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Open Positions */}
      {openMarkets.length > 0 && (
        <Card className="border-yellow-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-yellow-400">
              <Clock className="w-5 h-5" />
              Open Positions ({openMarkets.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {openMarkets.slice(0, 10).map(slug => {
              const marketTrades = tradesByMarket[slug];
              const upTrades = marketTrades.filter(t => t.outcome === 'UP');
              const downTrades = marketTrades.filter(t => t.outcome === 'DOWN');
              const upShares = upTrades.reduce((s, t) => s + t.shares, 0);
              const downShares = downTrades.reduce((s, t) => s + t.shares, 0);
              const totalCost = marketTrades.reduce((s, t) => s + t.total, 0);
              const tradeType = marketTrades[0]?.trade_type || 'UNKNOWN';

              return (
                <div key={slug} className="p-3 rounded-lg bg-muted/30 border border-border/50">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={
                        marketTrades[0]?.asset === 'BTC' 
                          ? 'text-orange-400 border-orange-500/30' 
                          : 'text-blue-400 border-blue-500/30'
                      }>
                        {marketTrades[0]?.asset}
                      </Badge>
                      <span className="text-sm text-muted-foreground truncate max-w-[200px]">{slug}</span>
                    </div>
                    <Badge variant="outline" className="text-purple-400 border-purple-500/30">
                      {tradeType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-emerald-400 font-mono">↑{upShares.toFixed(1)}</span>
                    <span className="text-red-400 font-mono">↓{downShares.toFixed(1)}</span>
                    <span className="text-muted-foreground">Cost: ${totalCost.toFixed(2)}</span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Settled Results */}
      {results.filter(r => r.settled_at).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              Settled Results ({results.filter(r => r.settled_at).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {results.filter(r => r.settled_at).slice(0, 20).map(result => (
                <div 
                  key={result.id} 
                  className={`p-3 rounded-lg border ${
                    (result.profit_loss || 0) > 0 
                      ? 'bg-emerald-500/10 border-emerald-500/30' 
                      : 'bg-red-500/10 border-red-500/30'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={
                        result.asset === 'BTC' 
                          ? 'text-orange-400 border-orange-500/30' 
                          : 'text-blue-400 border-blue-500/30'
                      }>
                        {result.asset}
                      </Badge>
                      <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                        {result.market_slug}
                      </span>
                      <Badge className={
                        result.result === 'UP' 
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' 
                          : 'bg-red-500/20 text-red-400 border-red-500/30'
                      }>
                        {result.result}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-muted-foreground">
                        ${result.total_invested?.toFixed(2)} → ${result.payout?.toFixed(2)}
                      </span>
                      <span className={`font-bold font-mono ${
                        (result.profit_loss || 0) > 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}>
                        {(result.profit_loss || 0) > 0 ? '+' : ''}${result.profit_loss?.toFixed(2)}
                        <span className="text-xs ml-1">
                          ({result.profit_loss_percent?.toFixed(1)}%)
                        </span>
                      </span>
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
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-purple-400" />
            Recent Paper Trades
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {trades.slice(0, 30).map(trade => (
              <div key={trade.id} className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={
                    trade.asset === 'BTC' 
                      ? 'text-orange-400 border-orange-500/30' 
                      : 'text-blue-400 border-blue-500/30'
                  }>
                    {trade.asset}
                  </Badge>
                  {trade.outcome === 'UP' ? (
                    <TrendingUp className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-3 h-3 text-red-400" />
                  )}
                  <span className={trade.outcome === 'UP' ? 'text-emerald-400' : 'text-red-400'}>
                    {trade.outcome}
                  </span>
                  <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30">
                    {trade.trade_type}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="font-mono">{trade.shares.toFixed(2)} @ {(trade.price * 100).toFixed(1)}¢</span>
                  <span className="text-muted-foreground">${trade.total.toFixed(2)}</span>
                  <span className="text-muted-foreground">
                    {formatDistanceToNow(new Date(trade.created_at), { addSuffix: true })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
