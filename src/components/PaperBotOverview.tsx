import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Bot,
  Cpu,
  TrendingUp,
  TrendingDown,
  Zap,
  Wallet,
  Target,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { usePaperTrades } from '@/hooks/usePaperTrades';

interface RealtimeBotStatus {
  isConnected: boolean;
  isEnabled: boolean;
  marketsCount: number;
  tokensCount: number;
  lastTrades: Array<{
    slug: string;
    outcome: string;
    price: number;
    shares: number;
    slippage: number | null;
    reasoning: string;
  }>;
  logs: string[];
}

interface PaperBotOverviewProps {
  botEnabled: boolean;
  toggleBot: () => void;
  botLoading: boolean;
  realtimeBotStatus: RealtimeBotStatus;
  getPrice: (slug: string, outcome: 'up' | 'down' | 'yes' | 'no') => number | null;
}

export const PaperBotOverview = ({
  botEnabled,
  toggleBot,
  botLoading,
  realtimeBotStatus,
  getPrice,
}: PaperBotOverviewProps) => {
  const { trades, results, stats } = usePaperTrades();

  // Calculate unrealized P&L
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
      unrealizedPLPercent: totalOpenInvested > 0 ? (totalUnrealizedPL / totalOpenInvested) * 100 : 0,
    };
  }, [trades, results, getPrice]);

  const totalPL = stats.totalProfitLoss + unrealizedStats.unrealizedPL;
  const portfolioValue = 1000 + totalPL;
  const totalPLPercent = (totalPL / 1000) * 100;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="p-2 rounded-lg bg-primary/10">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            Paper Trading Bot
            <div className="flex items-center gap-2">
              <Switch 
                checked={botEnabled} 
                onCheckedChange={toggleBot}
                disabled={botLoading}
              />
              <Badge variant={botEnabled ? "default" : "secondary"}>
                {botEnabled ? "Active" : "Off"}
              </Badge>
            </div>
          </CardTitle>
          <Link to="/paper-trading" className="text-sm text-primary hover:underline">
            Full Dashboard →
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Connection Status */}
        {botEnabled && (
          <div className="flex items-center gap-3 text-sm">
            <Badge variant="outline" className={realtimeBotStatus.isConnected ? "text-emerald-500 border-emerald-500/30" : ""}>
              <Cpu className="w-3 h-3 mr-1" />
              {realtimeBotStatus.isConnected ? "Connected" : "Connecting..."}
            </Badge>
            {realtimeBotStatus.isConnected && (
              <>
                <span className="text-muted-foreground">
                  {realtimeBotStatus.marketsCount} markets
                </span>
                <span className="text-muted-foreground">•</span>
                <span className="text-muted-foreground">
                  {realtimeBotStatus.tokensCount} tokens
                </span>
              </>
            )}
          </div>
        )}

        {/* Portfolio Stats Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {/* Portfolio Value */}
          <div className="p-3 rounded-lg bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Wallet className="w-3 h-3" />
              Portfolio
            </div>
            <div className="text-xl font-bold">${portfolioValue.toFixed(0)}</div>
            <div className={`text-xs flex items-center gap-0.5 ${totalPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {totalPL >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {totalPL >= 0 ? '+' : ''}{totalPLPercent.toFixed(2)}%
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
              R: ${stats.totalProfitLoss.toFixed(0)} / U: ${unrealizedStats.unrealizedPL.toFixed(0)}
            </div>
          </div>

          {/* Win Rate */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Target className="w-3 h-3" />
              Win Rate
            </div>
            <div className={`text-xl font-bold ${stats.winRate >= 50 ? 'text-emerald-500' : 'text-red-500'}`}>
              {stats.winRate.toFixed(0)}%
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
              ${unrealizedStats.openInvested.toFixed(0)} invested
            </div>
          </div>

          {/* Total Trades */}
          <div className="p-3 rounded-lg bg-muted/30 border border-border/50">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
              <Zap className="w-3 h-3" />
              Trades
            </div>
            <div className="text-xl font-bold">{stats.totalTrades}</div>
            <div className="text-xs text-muted-foreground">
              ${stats.totalInvested.toFixed(0)} total
            </div>
          </div>
        </div>

        {/* Recent Trades */}
        {realtimeBotStatus.lastTrades.length > 0 && (
          <div className="pt-3 border-t border-border/50">
            <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
              <Zap className="w-3 h-3" />
              Recent Trades
            </div>
            <div className="flex flex-wrap gap-1.5">
              {realtimeBotStatus.lastTrades.slice(0, 8).map((trade, i) => (
                <Badge 
                  key={i} 
                  variant="outline" 
                  className={`text-xs ${
                    trade.outcome === 'UP' 
                      ? 'text-emerald-500 border-emerald-500/30' 
                      : 'text-red-500 border-red-500/30'
                  }`}
                >
                  {trade.outcome === 'UP' ? <TrendingUp className="w-3 h-3 mr-1" /> : <TrendingDown className="w-3 h-3 mr-1" />}
                  {(trade.price * 100).toFixed(0)}¢ × {trade.shares.toFixed(0)}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
