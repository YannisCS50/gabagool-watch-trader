import { Trade } from '@/types/trade';
import { TradeRow } from './TradeRow';

interface TradesTableProps {
  trades: Trade[];
}

export function TradesTable({ trades }: TradesTableProps) {
  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border/50">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Activity
        </h2>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border/50">
              <th className="py-3 px-4 text-left font-medium">Time</th>
              <th className="py-3 px-4 text-left font-medium">Market</th>
              <th className="py-3 px-4 text-left font-medium">Outcome</th>
              <th className="py-3 px-4 text-left font-medium">Side</th>
              <th className="py-3 px-4 text-right font-medium">Shares</th>
              <th className="py-3 px-4 text-right font-medium">Price</th>
              <th className="py-3 px-4 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade, index) => (
              <TradeRow key={trade.id} trade={trade} index={index} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
