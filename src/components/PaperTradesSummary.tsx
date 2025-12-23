import React from 'react';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Bot, Clock, DollarSign } from 'lucide-react';
import { usePaperTradesByMarket } from '@/hooks/usePaperTrades';

interface PaperTradesSummaryProps {
  marketSlug: string;
  compact?: boolean;
  actualResult?: 'UP' | 'DOWN' | null;
}

export const PaperTradesSummary = React.memo(function PaperTradesSummary({
  marketSlug,
  compact = false,
  actualResult,
}: PaperTradesSummaryProps) {
  const { trades, result, summary, isLoading } = usePaperTradesByMarket(marketSlug);

  if (isLoading || trades.length === 0) {
    return null;
  }

  const upAvgPrice = summary.upShares > 0 ? summary.upCost / summary.upShares : 0;
  const downAvgPrice = summary.downShares > 0 ? summary.downCost / summary.downShares : 0;

  // Calculate P/L based on result
  let payout = 0;
  let profitLoss = 0;
  const finalResult = actualResult || (result?.result as 'UP' | 'DOWN' | null);

  if (finalResult === 'UP') {
    payout = summary.upShares;
    profitLoss = payout - summary.totalInvested;
  } else if (finalResult === 'DOWN') {
    payout = summary.downShares;
    profitLoss = payout - summary.totalInvested;
  }

  const profitLossPercent = summary.totalInvested > 0 
    ? (profitLoss / summary.totalInvested) * 100 
    : 0;

  const tradeType = trades[0]?.trade_type || 'UNKNOWN';

  if (compact) {
    return (
      <div className="mt-2 p-2 rounded-md bg-purple-500/10 border border-purple-500/20">
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-purple-400">
            <Bot className="w-3 h-3" />
            <span className="font-medium">Paper Bot</span>
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-purple-400 border-purple-500/30">
              {tradeType}
            </Badge>
          </div>
          
          <div className="flex items-center gap-3">
            {summary.upShares > 0 && (
              <span className="text-emerald-400 font-mono">
                ↑{summary.upShares.toFixed(1)} @{(upAvgPrice * 100).toFixed(0)}¢
              </span>
            )}
            {summary.downShares > 0 && (
              <span className="text-red-400 font-mono">
                ↓{summary.downShares.toFixed(1)} @{(downAvgPrice * 100).toFixed(0)}¢
              </span>
            )}
            
            {finalResult && (
              <span className={`font-bold ${profitLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(2)}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-purple-400" />
          <span className="font-medium text-sm text-purple-400">Paper Trade Bot</span>
          <Badge variant="outline" className="text-xs text-purple-400 border-purple-500/30">
            {tradeType}
          </Badge>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          {trades.length} trades
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20">
          <div className="flex items-center gap-1 text-emerald-400 text-xs mb-1">
            <TrendingUp className="w-3 h-3" />
            UP Position
          </div>
          <div className="text-sm font-mono text-emerald-400">
            {summary.upShares.toFixed(2)} shares
          </div>
          <div className="text-xs text-muted-foreground">
            Avg: {(upAvgPrice * 100).toFixed(1)}¢ | Cost: ${summary.upCost.toFixed(2)}
          </div>
        </div>

        <div className="p-2 rounded-md bg-red-500/10 border border-red-500/20">
          <div className="flex items-center gap-1 text-red-400 text-xs mb-1">
            <TrendingDown className="w-3 h-3" />
            DOWN Position
          </div>
          <div className="text-sm font-mono text-red-400">
            {summary.downShares.toFixed(2)} shares
          </div>
          <div className="text-xs text-muted-foreground">
            Avg: {(downAvgPrice * 100).toFixed(1)}¢ | Cost: ${summary.downCost.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between p-2 rounded-md bg-muted/30">
        <div className="flex items-center gap-1 text-sm">
          <DollarSign className="w-4 h-4 text-muted-foreground" />
          <span>Total Invested:</span>
          <span className="font-mono font-bold">${summary.totalInvested.toFixed(2)}</span>
        </div>

        {finalResult && (
          <div className={`flex items-center gap-1 font-bold ${profitLoss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            <span>P/L:</span>
            <span className="font-mono">
              {profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(2)} ({profitLossPercent.toFixed(1)}%)
            </span>
          </div>
        )}

        {!finalResult && (
          <Badge variant="outline" className="text-yellow-400 border-yellow-500/30">
            Pending
          </Badge>
        )}
      </div>
    </div>
  );
});
