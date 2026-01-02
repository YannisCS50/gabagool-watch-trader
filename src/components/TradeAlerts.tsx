import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Trophy, TrendingDown, TrendingUp, Skull } from 'lucide-react';
import { useLiveTrades } from '@/hooks/useLiveTrades';

interface TradeAlert {
  type: 'bad_hedge' | 'big_win' | 'big_loss';
  marketSlug: string;
  asset: string;
  upShares: number;
  downShares: number;
  hedgeRatio: number; // 0-100, where 50 is perfect
  profitLoss?: number;
  profitLossPercent?: number;
  message: string;
  severity: 'warning' | 'danger' | 'success';
}

export function TradeAlerts() {
  const { trades, results } = useLiveTrades();

  const alerts = useMemo(() => {
    const alertList: TradeAlert[] = [];

    // Group trades by market_slug to analyze hedging
    const tradesByMarket = trades.reduce((acc, trade) => {
      if (!acc[trade.market_slug]) {
        acc[trade.market_slug] = { up: 0, down: 0, upCost: 0, downCost: 0, asset: trade.asset };
      }
      if (trade.outcome?.toLowerCase() === 'up' || trade.outcome?.toLowerCase() === 'yes') {
        acc[trade.market_slug].up += trade.shares;
        acc[trade.market_slug].upCost += trade.total;
      } else {
        acc[trade.market_slug].down += trade.shares;
        acc[trade.market_slug].downCost += trade.total;
      }
      return acc;
    }, {} as Record<string, { up: number; down: number; upCost: number; downCost: number; asset: string }>);

    // Analyze each market for bad hedges (only open positions)
    // Bad hedge = pair cost > $1.00 per share (losing money on the hedge)
    Object.entries(tradesByMarket).forEach(([slug, data]) => {
      if (data.up === 0 || data.down === 0) return; // Need both sides for a hedge

      // Check if this market is already settled
      const isSettled = results.some(r => r.market_slug === slug && r.settled_at);
      if (isSettled) return;

      // Calculate pair cost: cost per hedged share pair
      const minShares = Math.min(data.up, data.down);
      const upAvgPrice = data.upCost / data.up;
      const downAvgPrice = data.downCost / data.down;
      const pairCost = upAvgPrice + downAvgPrice;

      // Bad hedge: pair cost > $1.00 means we're losing money on the hedge
      if (pairCost > 1.0 && minShares >= 10) {
        const lockedLoss = (pairCost - 1.0) * minShares;
        
        alertList.push({
          type: 'bad_hedge',
          marketSlug: slug,
          asset: data.asset,
          upShares: data.up,
          downShares: data.down,
          hedgeRatio: pairCost,
          message: `Pair cost $${pairCost.toFixed(3)} (-$${lockedLoss.toFixed(2)} verlies)`,
          severity: pairCost > 1.05 ? 'danger' : 'warning',
        });
      }
    });

    // Find biggest winners and losers from settled results
    const settledResults = results.filter(r => r.settled_at && r.profit_loss !== null);
    
    // Sort by profit/loss
    const sorted = [...settledResults].sort((a, b) => 
      (b.profit_loss || 0) - (a.profit_loss || 0)
    );

    // Top 3 winners
    sorted.slice(0, 3).forEach(result => {
      if ((result.profit_loss || 0) > 0) {
        alertList.push({
          type: 'big_win',
          marketSlug: result.market_slug,
          asset: result.asset,
          upShares: result.up_shares || 0,
          downShares: result.down_shares || 0,
          hedgeRatio: 50,
          profitLoss: result.profit_loss || 0,
          profitLossPercent: result.profit_loss_percent || 0,
          message: `+$${(result.profit_loss || 0).toFixed(2)} (${(result.profit_loss_percent || 0).toFixed(1)}%)`,
          severity: 'success',
        });
      }
    });

    // Bottom 3 losers (worst losses)
    sorted.slice(-3).reverse().forEach(result => {
      if ((result.profit_loss || 0) < -0.5) {
        alertList.push({
          type: 'big_loss',
          marketSlug: result.market_slug,
          asset: result.asset,
          upShares: result.up_shares || 0,
          downShares: result.down_shares || 0,
          hedgeRatio: 50,
          profitLoss: result.profit_loss || 0,
          profitLossPercent: result.profit_loss_percent || 0,
          message: `$${(result.profit_loss || 0).toFixed(2)} (${(result.profit_loss_percent || 0).toFixed(1)}%)`,
          severity: 'danger',
        });
      }
    });

    // Sort: bad hedges first (by severity), then losses, then wins
    return alertList.sort((a, b) => {
      const priority = { bad_hedge: 0, big_loss: 1, big_win: 2 };
      const severityPriority = { danger: 0, warning: 1, success: 2 };
      
      if (priority[a.type] !== priority[b.type]) {
        return priority[a.type] - priority[b.type];
      }
      return severityPriority[a.severity] - severityPriority[b.severity];
    });
  }, [trades, results]);

  const formatMarketSlug = (slug: string) => {
    // Extract readable part from slug
    const match = slug.match(/(\d+)-(\d+)/);
    if (match) {
      const timestamp = parseInt(match[1]);
      const date = new Date(timestamp * 1000);
      return date.toLocaleDateString('nl-NL', { 
        day: 'numeric', 
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    return slug.slice(0, 20) + '...';
  };

  const getIcon = (type: TradeAlert['type']) => {
    switch (type) {
      case 'bad_hedge':
        return <AlertTriangle className="w-4 h-4" />;
      case 'big_win':
        return <Trophy className="w-4 h-4" />;
      case 'big_loss':
        return <Skull className="w-4 h-4" />;
    }
  };

  const getColor = (severity: TradeAlert['severity']) => {
    switch (severity) {
      case 'danger':
        return 'bg-red-500/10 border-red-500/30 text-red-500';
      case 'warning':
        return 'bg-yellow-500/10 border-yellow-500/30 text-yellow-500';
      case 'success':
        return 'bg-green-500/10 border-green-500/30 text-green-500';
    }
  };

  const getBadgeVariant = (type: TradeAlert['type']) => {
    switch (type) {
      case 'bad_hedge':
        return 'destructive';
      case 'big_win':
        return 'default';
      case 'big_loss':
        return 'destructive';
    }
  };

  const getTypeLabel = (type: TradeAlert['type']) => {
    switch (type) {
      case 'bad_hedge':
        return 'BAD HEDGE';
      case 'big_win':
        return 'TOP WIN';
      case 'big_loss':
        return 'LOSS';
    }
  };

  if (alerts.length === 0) {
    return null;
  }

  const badHedges = alerts.filter(a => a.type === 'bad_hedge');
  const bigWins = alerts.filter(a => a.type === 'big_win');
  const bigLosses = alerts.filter(a => a.type === 'big_loss');

  return (
    <Card className="border-2 border-yellow-500/30 bg-yellow-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-500" />
          Trade Alerts
          <Badge variant="outline" className="ml-2">
            {alerts.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Bad Hedges - Most Important */}
        {badHedges.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-red-500 uppercase tracking-wide flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Slechte Hedges (Open)
            </div>
            <div className="space-y-2">
              {badHedges.map((alert, i) => (
                <div
                  key={`${alert.marketSlug}-${i}`}
                  className={`flex items-center justify-between p-3 rounded-lg border ${getColor(alert.severity)}`}
                >
                  <div className="flex items-center gap-3">
                    {getIcon(alert.type)}
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {alert.asset}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatMarketSlug(alert.marketSlug)}
                        </span>
                      </div>
                      <div className="text-sm font-medium mt-1">
                        {alert.message}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">
                      UP: {alert.upShares.toFixed(0)} | DOWN: {alert.downShares.toFixed(0)}
                    </div>
                    <Badge variant={getBadgeVariant(alert.type)} className="mt-1">
                      {getTypeLabel(alert.type)}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Big Losses */}
        {bigLosses.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-red-400 uppercase tracking-wide flex items-center gap-1">
              <TrendingDown className="w-3 h-3" />
              Grootste Verliezen
            </div>
            <div className="grid gap-2">
              {bigLosses.map((alert, i) => (
                <div
                  key={`${alert.marketSlug}-${i}`}
                  className="flex items-center justify-between p-2 rounded-lg bg-red-500/10 border border-red-500/20"
                >
                  <div className="flex items-center gap-2">
                    <Skull className="w-4 h-4 text-red-500" />
                    <Badge variant="outline" className="text-xs">
                      {alert.asset}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatMarketSlug(alert.marketSlug)}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-red-500">
                    {alert.message}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Big Wins */}
        {bigWins.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-green-500 uppercase tracking-wide flex items-center gap-1">
              <TrendingUp className="w-3 h-3" />
              Grootste Winnaars
            </div>
            <div className="grid gap-2">
              {bigWins.map((alert, i) => (
                <div
                  key={`${alert.marketSlug}-${i}`}
                  className="flex items-center justify-between p-2 rounded-lg bg-green-500/10 border border-green-500/20"
                >
                  <div className="flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-green-500" />
                    <Badge variant="outline" className="text-xs">
                      {alert.asset}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatMarketSlug(alert.marketSlug)}
                    </span>
                  </div>
                  <div className="text-sm font-bold text-green-500">
                    {alert.message}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
