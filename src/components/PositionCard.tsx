import { MarketPosition } from '@/types/trade';
import { cn } from '@/lib/utils';

interface PositionCardProps {
  position: MarketPosition;
  index: number;
}

export function PositionCard({ position, index }: PositionCardProps) {
  const isProfit = position.pnl >= 0;

  return (
    <div 
      className="glass rounded-lg p-4 animate-fade-in"
      style={{ animationDelay: `${index * 100}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-sm truncate">{position.market}</h3>
          <div className="flex items-center gap-2 mt-2">
            <span className={cn(
              "inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium",
              position.outcome === 'Yes' 
                ? "bg-success/20 text-success" 
                : "bg-destructive/20 text-destructive"
            )}>
              {position.outcome}
            </span>
            <span className="text-xs text-muted-foreground font-mono">
              {position.shares.toLocaleString()} shares
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className={cn(
            "text-lg font-mono font-semibold",
            isProfit ? "text-success" : "text-destructive"
          )}>
            {isProfit ? '+' : ''}{position.pnlPercent.toFixed(1)}%
          </div>
          <div className={cn(
            "text-sm font-mono",
            isProfit ? "text-success/80" : "text-destructive/80"
          )}>
            {isProfit ? '+' : ''}${position.pnl.toFixed(0)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs font-mono text-muted-foreground">
        <span>Avg: ${position.avgPrice.toFixed(2)}</span>
        <span>Current: ${position.currentPrice.toFixed(2)}</span>
      </div>
      <div className="mt-2 h-1 bg-muted rounded-full overflow-hidden">
        <div 
          className={cn(
            "h-full rounded-full transition-all",
            isProfit ? "bg-success" : "bg-destructive"
          )}
          style={{ width: `${Math.min(Math.abs(position.pnlPercent) * 2, 100)}%` }}
        />
      </div>
    </div>
  );
}
