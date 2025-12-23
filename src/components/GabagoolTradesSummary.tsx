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
}

export const GabagoolTradesSummary = memo(({ 
  marketSlug, 
  upClobPrice, 
  downClobPrice 
}: GabagoolTradesSummaryProps) => {
  const { summary, isLoading, tradesCount } = useGabagoolLiveTrades(marketSlug);
  const [isOpen, setIsOpen] = useState(false);

  if (isLoading || !summary) return null;

  const { up, down, totalInvested, payoutIfUpWins, payoutIfDownWins, edge, isDualSide, trades, lastTradeTime } = summary;

  // Calculate live edge vs CLOB price
  const upEdgeVsClob = up.avgPrice > 0 && upClobPrice > 0 
    ? ((upClobPrice - up.avgPrice) / up.avgPrice) * 100 
    : 0;
  const downEdgeVsClob = down.avgPrice > 0 && downClobPrice > 0 
    ? ((downClobPrice - down.avgPrice) / down.avgPrice) * 100 
    : 0;

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

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
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-muted-foreground" />
            <span className="text-muted-foreground">Invested:</span>
            <span className="font-mono font-bold">${totalInvested.toFixed(2)}</span>
          </div>
          <div className={`font-mono font-bold ${edge >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {edge >= 0 ? '+' : ''}{edge.toFixed(1)}% edge
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground mt-1">
          <span>If UP wins: ${payoutIfUpWins.toFixed(2)}</span>
          <span>If DOWN wins: ${payoutIfDownWins.toFixed(2)}</span>
        </div>
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
