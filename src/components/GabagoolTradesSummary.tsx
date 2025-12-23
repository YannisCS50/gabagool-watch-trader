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
} from 'lucide-react';
import { useGabagoolLiveTrades } from '@/hooks/useGabagoolLiveTrades';
import { formatDistanceToNow } from 'date-fns';

interface GabagoolTradesSummaryProps {
  marketSlug: string;
  upClobPrice: number;
  downClobPrice: number;
  compact?: boolean;
  actualResult?: 'UP' | 'DOWN' | null;
}

export const GabagoolTradesSummary = memo(({ 
  marketSlug, 
  upClobPrice, 
  downClobPrice,
  compact = false,
  actualResult = null,
}: GabagoolTradesSummaryProps) => {
  const { summary, isLoading, tradesCount } = useGabagoolLiveTrades(marketSlug);
  const [isOpen, setIsOpen] = useState(false);

  if (isLoading || !summary) return null;
  if (compact && summary.totalInvested === 0) return null;

  const { 
    up, down, totalInvested, 
    profitIfUpWins, profitIfDownWins, 
    guaranteedProfit, bestCaseProfit,
    combinedEntry, isArbitrage, isDualSide, 
    trades, lastTradeTime 
  } = summary;

  // Calculate live edge vs CLOB price
  const upEdgeVsClob = up.avgPrice > 0 && upClobPrice > 0 
    ? ((upClobPrice - up.avgPrice) / up.avgPrice) * 100 
    : 0;
  const downEdgeVsClob = down.avgPrice > 0 && downClobPrice > 0 
    ? ((downClobPrice - down.avgPrice) / down.avgPrice) * 100 
    : 0;
    
  const guaranteedProfitPercent = totalInvested > 0 ? (guaranteedProfit / totalInvested) * 100 : 0;
  const profitIfUpPercent = totalInvested > 0 ? (profitIfUpWins / totalInvested) * 100 : 0;
  const profitIfDownPercent = totalInvested > 0 ? (profitIfDownWins / totalInvested) * 100 : 0;

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Determine actual P/L if result is known
  const actualPnL = actualResult === 'UP' ? profitIfUpWins : actualResult === 'DOWN' ? profitIfDownWins : null;
  const actualPnLPercent = actualResult === 'UP' ? profitIfUpPercent : actualResult === 'DOWN' ? profitIfDownPercent : null;

  // Compact version for expired markets
  if (compact) {
    return (
      <div className="mt-2 p-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm">🎰</span>
          <span className="text-xs font-medium text-muted-foreground">Gabagool22</span>
        </div>
        
        <div className="grid grid-cols-2 gap-2 text-xs mb-2">
          <div className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            <span className="text-muted-foreground">UP:</span>
            <span className="font-mono text-emerald-400">{up.shares.toFixed(0)}</span>
          </div>
          <div className="flex items-center gap-1">
            <TrendingDown className="w-3 h-3 text-red-400" />
            <span className="text-muted-foreground">DOWN:</span>
            <span className="font-mono text-red-400">{down.shares.toFixed(0)}</span>
          </div>
        </div>
        
        {actualResult && actualPnL !== null && (
          <div className="flex items-center justify-between text-xs pt-2 border-t border-purple-500/20">
            <span className={actualResult === 'UP' ? 'text-emerald-400' : 'text-red-400'}>
              Won: {actualResult}
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
    <div className="mt-3 p-3 rounded-lg bg-gradient-to-br from-purple-500/10 to-pink-500/10 border border-purple-500/30">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎰</span>
          <span className="font-semibold text-sm">Gabagool22</span>
          <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs animate-pulse">
            LIVE
          </Badge>
          {isDualSide && (
            <Badge variant="outline" className="text-purple-400 border-purple-500/30 text-xs flex items-center gap-1">
              <Shuffle className="w-3 h-3" />
              Dual-Side
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
          <div className="text-lg font-bold text-emerald-400">{up.shares.toFixed(1)}</div>
          <div className="text-xs text-muted-foreground">
            @{(up.avgPrice * 100).toFixed(1)}¢ • ${up.invested.toFixed(2)}
          </div>
          {upEdgeVsClob !== 0 && (
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
          <div className="text-lg font-bold text-red-400">{down.shares.toFixed(1)}</div>
          <div className="text-xs text-muted-foreground">
            @{(down.avgPrice * 100).toFixed(1)}¢ • ${down.invested.toFixed(2)}
          </div>
          {downEdgeVsClob !== 0 && (
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
              <div className="flex items-center justify-between">
                <span className="font-medium text-emerald-400">✅ Guaranteed: +${guaranteedProfit.toFixed(2)} (+{guaranteedProfitPercent.toFixed(1)}%)</span>
                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-mono">
                  {combinedEntry.toFixed(2)}
                </Badge>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-amber-400 font-medium">⚠️ Hedge niet perfect</span>
                  </div>
                  <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 font-mono text-sm">
                    {combinedEntry.toFixed(2)}
                  </Badge>
                </div>
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
          <span className="text-muted-foreground">{tradesCount} trades</span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {trades.map((trade) => (
              <div 
                key={trade.id} 
                className={`flex items-center justify-between p-2 rounded text-xs ${
                  trade.outcome === 'Up' ? 'bg-emerald-500/5' : 'bg-red-500/5'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground font-mono">
                    {formatTime(trade.timestamp)}
                  </span>
                  <Badge 
                    variant="outline" 
                    className={`text-xs px-1 py-0 ${
                      trade.outcome === 'Up' 
                        ? 'text-emerald-400 border-emerald-500/30' 
                        : 'text-red-400 border-red-500/30'
                    }`}
                  >
                    {trade.side} {trade.outcome.toUpperCase()}
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

GabagoolTradesSummary.displayName = 'GabagoolTradesSummary';
