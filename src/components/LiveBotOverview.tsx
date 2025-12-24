import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Bot,
  Zap,
  Wallet,
  Target,
  Activity,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  AlertTriangle,
  DollarSign,
  RefreshCw,
  Power,
} from 'lucide-react';
import { useLiveBotSettings } from '@/hooks/useLiveBotSettings';
import { useLiveTrades } from '@/hooks/useLiveTrades';
import { usePolymarketRealtime } from '@/hooks/usePolymarketRealtime';

interface LiveBotOverviewProps {
  getPrice: (slug: string, outcome: 'up' | 'down' | 'yes' | 'no') => number | null;
}

export const LiveBotOverview = ({ getPrice }: LiveBotOverviewProps) => {
  const [isEnabled, setIsEnabled] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  
  const { 
    isReady, 
    isLoading, 
    balance, 
    walletAddress, 
    limits, 
    error,
    refetch,
    killSwitch,
  } = useLiveBotSettings();
  
  const { trades, results, isLoading: tradesLoading } = useLiveTrades();

  // Calculate stats from live trades
  const stats = useMemo(() => {
    const settled = results.filter(r => r.settled_at);
    const totalPL = settled.reduce((sum, r) => sum + (r.profit_loss || 0), 0);
    const wins = settled.filter(r => (r.profit_loss || 0) > 0).length;
    const losses = settled.filter(r => (r.profit_loss || 0) < 0).length;
    const totalInvested = settled.reduce((sum, r) => sum + (r.total_invested || 0), 0);
    
    return {
      totalPL,
      winRate: settled.length > 0 ? (wins / settled.length) * 100 : 0,
      winCount: wins,
      lossCount: losses,
      settledCount: settled.length,
      totalInvested,
    };
  }, [results]);

  // Calculate unrealized P&L for open positions
  const unrealizedStats = useMemo(() => {
    const settledSlugs = new Set(results.filter(r => r.settled_at).map(r => r.market_slug));
    const openTrades = trades.filter(t => !settledSlugs.has(t.market_slug));
    
    let totalUnrealizedPL = 0;
    let totalCurrentValue = 0;
    let totalOpenInvested = 0;
    let openPositionCount = 0;
    
    const byMarket = openTrades.reduce((acc, trade) => {
      if (!acc[trade.market_slug]) {
        acc[trade.market_slug] = { upShares: 0, upCost: 0, downShares: 0, downCost: 0 };
        openPositionCount++;
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
      openPositions: openPositionCount,
    };
  }, [trades, results, getPrice]);

  const totalPL = stats.totalPL + unrealizedStats.unrealizedPL;

  const handleToggle = async () => {
    if (isToggling) return;
    setIsToggling(true);
    try {
      if (isEnabled) {
        // Turn off → kill switch
        await killSwitch();
        setIsEnabled(false);
      } else {
        // Turn on → just enable (no backend call needed, bot is ready if isReady)
        setIsEnabled(true);
      }
      await refetch();
    } catch (err) {
      console.error('Toggle error:', err);
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <Card className="border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <Zap className="w-4 h-4 text-amber-500" />
            </div>
            Live Trading Bot
            <div className="flex items-center gap-2">
              <Switch 
                checked={isEnabled && isReady} 
                onCheckedChange={handleToggle}
                disabled={isLoading || isToggling || !isReady}
              />
              <Badge variant={isEnabled && isReady ? "default" : "secondary"} className={isEnabled && isReady ? "bg-amber-500" : ""}>
                {isLoading ? "Loading..." : isEnabled && isReady ? "Active" : isReady ? "Ready" : "Offline"}
              </Badge>
            </div>
            {limits && (
              <Badge variant="outline" className="text-xs">
                Max ${limits.maxOrderSize}/order
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={refetch} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Link to="/live-trading" className="text-sm text-amber-500 hover:underline">
              Dashboard →
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error State */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
            <AlertTriangle className="w-4 h-4" />
            {error}
          </div>
        )}

        {/* Balance & Wallet Info */}
        {isReady && (
          <div className="flex items-center gap-3 text-sm">
            <Badge variant="outline" className="text-amber-500 border-amber-500/30">
              <Wallet className="w-3 h-3 mr-1" />
              ${balance?.toFixed(2) || '0.00'} USDC
            </Badge>
            {walletAddress && (
              <span className="text-xs text-muted-foreground font-mono">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </span>
            )}
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Balance */}
          <div className="p-3 rounded-lg bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <DollarSign className="w-3 h-3" />
              Balance
            </div>
            <div className="text-xl font-bold text-amber-500">
              ${balance?.toFixed(2) || '—'}
            </div>
            <div className="text-xs text-muted-foreground">
              Polymarket
            </div>
          </div>

          {/* Total P/L */}
          <div className={`p-3 rounded-lg border ${totalPL >= 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              {totalPL >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              Total P/L
            </div>
            <div className={`text-xl font-bold ${totalPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">
              R: ${stats.totalPL.toFixed(0)} / U: ${unrealizedStats.unrealizedPL.toFixed(0)}
            </div>
          </div>

          {/* Win Rate */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Target className="w-3 h-3" />
              Win Rate
            </div>
            <div className={`text-xl font-bold ${stats.winRate >= 50 ? 'text-emerald-500' : stats.settledCount > 0 ? 'text-red-500' : ''}`}>
              {stats.settledCount > 0 ? `${stats.winRate.toFixed(0)}%` : '—'}
            </div>
            <div className="text-xs text-muted-foreground">
              {stats.winCount}W / {stats.lossCount}L
            </div>
          </div>

          {/* Open Positions */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Activity className="w-3 h-3" />
              Open
            </div>
            <div className="text-xl font-bold">{unrealizedStats.openPositions}</div>
            <div className="text-xs text-muted-foreground">
              ${unrealizedStats.openInvested.toFixed(2)} invested
            </div>
          </div>

          {/* Total Trades */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Zap className="w-3 h-3" />
              Trades
            </div>
            <div className="text-xl font-bold">{trades.length}</div>
            <div className="text-xs text-muted-foreground">
              ${stats.totalInvested.toFixed(2)} total
            </div>
          </div>
        </div>

        {/* Safety Limits Info */}
        {limits && (
          <div className="pt-3 border-t border-border/50">
            <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" />
              Safety Limits (20x smaller than paper)
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-xs">
                Max ${limits.maxOrderSize}/order
              </Badge>
              <Badge variant="outline" className="text-xs">
                Max ${limits.maxPositionSize}/market
              </Badge>
              <Badge variant="outline" className="text-xs">
                Max ${limits.maxDailyLoss}/day loss
              </Badge>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
