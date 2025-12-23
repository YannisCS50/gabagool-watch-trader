import { memo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { 
  TrendingUp, 
  TrendingDown, 
  ChevronDown, 
  Shuffle,
  DollarSign,
  Clock,
  Bot,
  Zap,
} from 'lucide-react';
import { usePaperTradesByMarket } from '@/hooks/usePaperTrades';
import { formatDistanceToNow } from 'date-fns';

interface PaperBotTradesSummaryProps {
  marketSlug: string;
  upClobPrice: number;
  downClobPrice: number;
  compact?: boolean;
  actualResult?: 'UP' | 'DOWN' | null;
}

export const PaperBotTradesSummary = memo(({ 
  marketSlug, 
  upClobPrice, 
  downClobPrice,
  compact = false,
  actualResult = null,
}: PaperBotTradesSummaryProps) => {
  const { trades, result, summary, isLoading } = usePaperTradesByMarket(marketSlug);
  const [isOpen, setIsOpen] = useState(false);

  if (isLoading || trades.length === 0) return null;

  const { upShares, upCost, downShares, downCost, totalInvested } = summary;
  
  const upAvgPrice = upCost > 0 && upShares > 0 ? upCost / upShares : 0;
  const downAvgPrice = downCost > 0 && downShares > 0 ? downCost / downShares : 0;
  
  const isDualSide = upShares > 0 && downShares > 0;
  const combinedEntry = upAvgPrice + downAvgPrice;
  const isArbitrage = isDualSide && combinedEntry < 1;

  // Calculate profit scenarios
  const profitIfUpWins = upShares - totalInvested;
  const profitIfDownWins = downShares - totalInvested;
  const guaranteedProfit = Math.min(profitIfUpWins, profitIfDownWins);
  const bestCaseProfit = Math.max(profitIfUpWins, profitIfDownWins);
  
  // Calculate live edge vs CLOB price
  const upEdgeVsClob = upAvgPrice > 0 && upClobPrice > 0 
    ? ((upClobPrice - upAvgPrice) / upAvgPrice) * 100 
    : 0;
  const downEdgeVsClob = downAvgPrice > 0 && downClobPrice > 0 
    ? ((downClobPrice - downAvgPrice) / downAvgPrice) * 100 
    : 0;
    
  const guaranteedProfitPercent = totalInvested > 0 ? (guaranteedProfit / totalInvested) * 100 : 0;
  const profitIfUpPercent = totalInvested > 0 ? (profitIfUpWins / totalInvested) * 100 : 0;
  const profitIfDownPercent = totalInvested > 0 ? (profitIfDownWins / totalInvested) * 100 : 0;

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Get last trade time
  const lastTradeTime = trades.length > 0 ? new Date(trades[0].created_at) : null;

  // Determine actual P/L from result or calculate from actualResult prop
  const actualPnL = result?.profit_loss ?? (actualResult === 'UP' ? profitIfUpWins : actualResult === 'DOWN' ? profitIfDownWins : null);
  const actualPnLPercent = result?.profit_loss_percent ?? (actualResult === 'UP' ? profitIfUpPercent : actualResult === 'DOWN' ? profitIfDownPercent : null);

  // Get trade types
  const tradeTypes = [...new Set(trades.map(t => t.trade_type).filter(Boolean))];

  // Compact version for expired markets
  if (compact) {
    return (
      <div className="mt-2 p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
        <div className="flex items-center gap-2 mb-2">
          <Bot className="w-3 h-3 text-purple-400" />
          <span className="text-xs font-medium text-muted-foreground">Paper Bot</span>
          {tradeTypes.length > 0 && (
            <Badge variant="outline" className="text-purple-400 border-purple-500/30 text-[10px] px-1 py-0">
              {tradeTypes[0]}
            </Badge>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-2 text-xs mb-2">
          <div className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            <span className="text-muted-foreground">UP:</span>
            <span className="font-mono text-emerald-400">{upShares.toFixed(0)}</span>
          </div>
          <div className="flex items-center gap-1">
            <TrendingDown className="w-3 h-3 text-red-400" />
            <span className="text-muted-foreground">DOWN:</span>
            <span className="font-mono text-red-400">{downShares.toFixed(0)}</span>
          </div>
        </div>
        
        {(actualResult || result?.result) && actualPnL !== null && (
          <div className="flex items-center justify-between text-xs pt-2 border-t border-purple-500/20">
            <span className={(result?.result || actualResult) === 'UP' ? 'text-emerald-400' : 'text-red-400'}>
              Won: {result?.result || actualResult}
            </span>
            <span className={`font-mono font-bold ${actualPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {actualPnL >= 0 ? '+' : ''}${actualPnL.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-purple-400" />
          <span className="font-semibold text-sm text-purple-400">Paper Bot</span>
          <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-xs animate-pulse">
            LIVE
          </Badge>
          {isDualSide && (
            <Badge variant="outline" className="text-purple-400 border-purple-500/30 text-xs flex items-center gap-1">
              <Shuffle className="w-3 h-3" />
              Dual-Side
            </Badge>
          )}
          {tradeTypes.length > 0 && (
            <Badge variant="outline" className="text-blue-400 border-blue-500/30 text-xs flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {tradeTypes.join(' + ')}
            </Badge>
          )}
        </div>
        {lastTradeTime && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {formatDistanceToNow(lastTradeTime, { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Positions */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Up Position */}
        <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <div className="flex items-center gap-1 text-emerald-400 mb-1">
            <TrendingUp className="w-3 h-3" />
            <span className="text-xs font-medium">UP</span>
          </div>
          <div className="text-lg font-bold text-emerald-400">{upShares.toFixed(1)}</div>
          <div className="text-xs text-muted-foreground">
            @{(upAvgPrice * 100).toFixed(1)}¢ • ${upCost.toFixed(2)}
          </div>
          {upEdgeVsClob !== 0 && upShares > 0 && (
            <div className={`text-xs mt-1 ${upEdgeVsClob > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {upEdgeVsClob > 0 ? '+' : ''}{upEdgeVsClob.toFixed(1)}% vs CLOB
            </div>
          )}
        </div>

        {/* Down Position */}
        <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
          <div className="flex items-center gap-1 text-red-400 mb-1">
            <TrendingDown className="w-3 h-3" />
            <span className="text-xs font-medium">DOWN</span>
          </div>
          <div className="text-lg font-bold text-red-400">{downShares.toFixed(1)}</div>
          <div className="text-xs text-muted-foreground">
            @{(downAvgPrice * 100).toFixed(1)}¢ • ${downCost.toFixed(2)}
          </div>
          {downEdgeVsClob !== 0 && downShares > 0 && (
            <div className={`text-xs mt-1 ${downEdgeVsClob > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {downEdgeVsClob > 0 ? '+' : ''}{downEdgeVsClob.toFixed(1)}% vs CLOB
            </div>
          )}
        </div>
      </div>

      {/* P/L Summary */}
      <div className="p-2 rounded-lg bg-muted/30 border border-border/50 mb-3">
        <div className="flex items-center justify-between text-sm mb-2">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-muted-foreground" />
            <span className="text-muted-foreground">Invested:</span>
            <span className="font-mono font-bold">${totalInvested.toFixed(2)}</span>
          </div>
          {isDualSide && (
            <div className="text-xs text-muted-foreground">
              Combined: {(combinedEntry * 100).toFixed(0)}¢ 
              <span className={combinedEntry < 1 ? 'text-emerald-400' : 'text-red-400'}>
                {combinedEntry < 1 ? ' ✓' : ' ✗'}
              </span>
            </div>
          )}
        </div>
        
        {/* Scenario's */}
        <div className="space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">If UP wins:</span>
            <span className={`font-mono font-medium ${profitIfUpWins >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {profitIfUpWins >= 0 ? '+' : ''}${profitIfUpWins.toFixed(2)} ({profitIfUpPercent >= 0 ? '+' : ''}{profitIfUpPercent.toFixed(1)}%)
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">If DOWN wins:</span>
            <span className={`font-mono font-medium ${profitIfDownWins >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {profitIfDownWins >= 0 ? '+' : ''}${profitIfDownWins.toFixed(2)} ({profitIfDownPercent >= 0 ? '+' : ''}{profitIfDownPercent.toFixed(1)}%)
            </span>
          </div>
        </div>
        
        {/* Hedge analysis */}
        {isDualSide && (
          <div className="mt-2 pt-2 border-t border-border/50 text-sm">
            {isArbitrage ? (
              <span className="font-medium text-emerald-400">✅ Guaranteed win: +${guaranteedProfit.toFixed(2)} (+{guaranteedProfitPercent.toFixed(1)}%)</span>
            ) : (
              <div className="space-y-1">
                <div className="text-amber-400 font-medium mb-1">⚠️ Hedge niet perfect</div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className={`p-2 rounded ${profitIfUpWins >= profitIfDownWins ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                    <div className="text-muted-foreground mb-0.5">Best case:</div>
                    <div className={`font-mono font-bold ${bestCaseProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {bestCaseProfit >= 0 ? '+' : ''}${bestCaseProfit.toFixed(2)}
                    </div>
                    <div className="text-muted-foreground text-[10px]">
                      {profitIfUpWins >= profitIfDownWins ? 'UP wint' : 'DOWN wint'}
                    </div>
                  </div>
                  <div className={`p-2 rounded ${profitIfUpWins < profitIfDownWins ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                    <div className="text-muted-foreground mb-0.5">Worst case:</div>
                    <div className={`font-mono font-bold ${guaranteedProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {guaranteedProfit >= 0 ? '+' : ''}${guaranteedProfit.toFixed(2)}
                    </div>
                    <div className="text-muted-foreground text-[10px]">
                      {profitIfUpWins < profitIfDownWins ? 'UP wint' : 'DOWN wint'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Trades Accordion */}
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full flex items-center justify-between p-2 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors text-sm">
          <span className="text-muted-foreground">{trades.length} trades</span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {trades.map((trade) => (
              <div 
                key={trade.id} 
                className={`flex items-center justify-between p-2 rounded text-xs ${
                  trade.outcome === 'UP' ? 'bg-emerald-500/5' : 'bg-red-500/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono">
                    {formatTime(trade.created_at)}
                  </span>
                  <Badge 
                    variant="outline" 
                    className={`text-xs px-1 py-0 ${
                      trade.outcome === 'UP' 
                        ? 'text-emerald-400 border-emerald-500/30' 
                        : 'text-red-400 border-red-500/30'
                    }`}
                  >
                    {trade.trade_type} {trade.outcome}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{trade.shares.toFixed(2)} shares</span>
                  <span>@{(trade.price * 100).toFixed(1)}¢</span>
                  <span className="font-mono font-medium text-foreground">${trade.total.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});

PaperBotTradesSummary.displayName = 'PaperBotTradesSummary';
