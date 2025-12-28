import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Zap, TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { useLiveTrades } from '@/hooks/useLiveTrades';

interface LiveBotTradesSummaryProps {
  marketSlug: string;
  upClobPrice: number;
  downClobPrice: number;
}

export const LiveBotTradesSummary = ({
  marketSlug,
  upClobPrice,
  downClobPrice,
}: LiveBotTradesSummaryProps) => {
  const { trades, results } = useLiveTrades();

  const marketData = useMemo(() => {
    const marketTrades = trades.filter(t => t.market_slug === marketSlug);
    const marketResult = results.find(r => r.market_slug === marketSlug);
    
    if (marketTrades.length === 0) return null;

    const upTrades = marketTrades.filter(t => t.outcome === 'UP');
    const downTrades = marketTrades.filter(t => t.outcome === 'DOWN');
    
    const upShares = upTrades.reduce((sum, t) => sum + t.shares, 0);
    const downShares = downTrades.reduce((sum, t) => sum + t.shares, 0);
    const upCost = upTrades.reduce((sum, t) => sum + t.total, 0);
    const downCost = downTrades.reduce((sum, t) => sum + t.total, 0);
    const upAvg = upShares > 0 ? upCost / upShares : 0;
    const downAvg = downShares > 0 ? downCost / downShares : 0;
    
    const totalInvested = upCost + downCost;
    const currentValue = (upShares * upClobPrice) + (downShares * downClobPrice);
    const unrealizedPL = currentValue - totalInvested;
    
    // Combined cost analysis
    const combinedAvg = upAvg + downAvg;
    const isArbitrage = upShares > 0 && downShares > 0;
    const guaranteedProfit = isArbitrage ? Math.min(upShares, downShares) * (1 - combinedAvg) : 0;
    
    return {
      upShares,
      downShares,
      upCost,
      downCost,
      upAvg,
      downAvg,
      totalInvested,
      currentValue,
      unrealizedPL,
      isArbitrage,
      combinedAvg,
      guaranteedProfit,
      trades: marketTrades,
      result: marketResult,
      isSettled: !!marketResult?.settled_at,
    };
  }, [trades, results, marketSlug, upClobPrice, downClobPrice]);

  if (!marketData) return null;

  const {
    upShares,
    downShares,
    upAvg,
    downAvg,
    totalInvested,
    unrealizedPL,
    isArbitrage,
    combinedAvg,
    guaranteedProfit,
    trades: marketTrades,
    result,
    isSettled,
  } = marketData;

  return (
    <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="w-3 h-3 text-amber-500" />
          <span className="text-xs font-medium text-amber-500">Live Bot</span>
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            {marketTrades.length} trades
          </Badge>
        </div>
        {isSettled && result && (
          <Badge 
            variant="outline" 
            className={`text-[10px] ${
              (result.profit_loss || 0) >= 0 
                ? 'text-emerald-500 border-emerald-500/30' 
                : 'text-red-500 border-red-500/30'
            }`}
          >
            {(result.profit_loss || 0) >= 0 ? '+' : ''}${(result.profit_loss || 0).toFixed(2)}
          </Badge>
        )}
        {!isSettled && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="w-3 h-3" />
            Open
          </div>
        )}
      </div>

      {/* Position Summary */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {upShares > 0 && (
          <div className="flex items-center justify-between p-1.5 rounded bg-emerald-500/10">
            <span className="text-emerald-500">UP</span>
            <span className="font-mono">
              {upShares.toFixed(0)} @ {(upAvg * 100).toFixed(0)}¢
            </span>
          </div>
        )}
        {downShares > 0 && (
          <div className="flex items-center justify-between p-1.5 rounded bg-red-500/10">
            <span className="text-red-500">DOWN</span>
            <span className="font-mono">
              {downShares.toFixed(0)} @ {(downAvg * 100).toFixed(0)}¢
            </span>
          </div>
        )}
      </div>

      {/* Stats Row */}
      <div className="flex items-center justify-between text-[10px] pt-1 border-t border-amber-500/10">
        <div className="text-muted-foreground">
          Invested: <span className="font-mono">${totalInvested.toFixed(2)}</span>
        </div>
        
        {isArbitrage && (
          <div className="flex items-center gap-1 text-emerald-500">
            <span>Combined:</span>
            <span className="font-mono font-medium">{(combinedAvg * 100).toFixed(0)}¢</span>
            {guaranteedProfit > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 text-emerald-500 border-emerald-500/30">
                +${guaranteedProfit.toFixed(2)} locked
              </Badge>
            )}
          </div>
        )}
        
        {!isSettled && (
          <div className={`flex items-center gap-1 ${unrealizedPL >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
            {unrealizedPL >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            <span className="font-mono">{unrealizedPL >= 0 ? '+' : ''}${unrealizedPL.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
};
