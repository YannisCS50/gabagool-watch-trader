import { Trade } from '@/types/trade';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

interface TradeRowProps {
  trade: Trade;
  index: number;
}

export function TradeRow({ trade, index }: TradeRowProps) {
  const isBuy = trade.side === 'buy';
  
  return (
    <tr 
      className="border-b border-border/50 hover:bg-accent/30 transition-colors animate-fade-in"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <td className="py-3 px-4">
        <div className="font-mono text-xs text-muted-foreground">
          {format(trade.timestamp, 'MMM dd')}
        </div>
        <div className="font-mono text-xs text-muted-foreground/60">
          {format(trade.timestamp, 'HH:mm')}
        </div>
      </td>
      <td className="py-3 px-4">
        <div className="max-w-xs truncate font-medium text-sm">
          {trade.market}
        </div>
      </td>
      <td className="py-3 px-4">
        <span className={cn(
          "inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium",
          trade.outcome === 'Yes' 
            ? "bg-success/20 text-success" 
            : "bg-destructive/20 text-destructive"
        )}>
          {trade.outcome}
        </span>
      </td>
      <td className="py-3 px-4">
        <span className={cn(
          "inline-flex items-center gap-1 text-xs font-mono font-medium uppercase",
          isBuy ? "text-success" : "text-destructive"
        )}>
          {isBuy ? '▲' : '▼'} {trade.side}
        </span>
      </td>
      <td className="py-3 px-4 font-mono text-sm text-right">
        {trade.shares.toLocaleString()}
      </td>
      <td className="py-3 px-4 font-mono text-sm text-right">
        ${trade.price.toFixed(2)}
      </td>
      <td className="py-3 px-4 font-mono text-sm text-right font-medium">
        ${trade.total.toLocaleString()}
      </td>
    </tr>
  );
}
