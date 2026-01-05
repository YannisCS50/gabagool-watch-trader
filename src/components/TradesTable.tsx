import { useState, useMemo } from 'react';
import { Trade } from '@/types/trade';
import { Button } from './ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface TradesTableProps {
  trades: Trade[];
  pageSize?: number;
}

function TradeRow({ trade, index }: { trade: Trade; index: number }) {
  const formatTime = (date: Date) => {
    return format(date, 'HH:mm:ss');
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatShares = (shares: number) => {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(shares);
  };

  const formatPrice = (price: number) => {
    return `${(price * 100).toFixed(1)}¢`;
  };

  return (
    <tr
      className={cn(
        'border-b border-border/30 hover:bg-muted/20 transition-colors',
        index % 2 === 0 ? 'bg-transparent' : 'bg-muted/5'
      )}
    >
      <td className="py-2.5 px-4 text-xs font-mono text-muted-foreground">
        {formatTime(trade.timestamp)}
      </td>
      <td className="py-2.5 px-4 text-sm">
        <span className="truncate max-w-[200px] block" title={trade.market}>
          {trade.market.length > 35 ? `${trade.market.slice(0, 35)}...` : trade.market}
        </span>
      </td>
      <td className="py-2.5 px-4">
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
            trade.outcome === 'Yes'
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-red-500/20 text-red-400 border border-red-500/30'
          )}
        >
          {trade.outcome}
        </span>
      </td>
      <td className="py-2.5 px-4">
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
            trade.side === 'buy'
              ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
              : 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
          )}
        >
          {trade.side.toUpperCase()}
        </span>
      </td>
      <td className="py-2.5 px-4 text-right text-sm font-mono">
        {formatShares(trade.shares)}
      </td>
      <td className="py-2.5 px-4 text-right text-sm font-mono">
        {formatPrice(trade.price)}
      </td>
      <td className="py-2.5 px-4 text-right text-sm font-mono font-medium">
        {formatCurrency(trade.total)}
      </td>
    </tr>
  );
}

export function TradesTable({ trades, pageSize = 50 }: TradesTableProps) {
  const [currentPage, setCurrentPage] = useState(1);
  
  const totalPages = Math.ceil(trades.length / pageSize);
  
  const paginatedTrades = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return trades.slice(start, start + pageSize);
  }, [trades, currentPage, pageSize]);

  const goToPage = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Activity
          <span className="ml-2 text-xs font-normal text-muted-foreground/70">
            ({trades.length} trades)
          </span>
        </h2>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="h-7 w-7 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="h-7 w-7 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
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
            {paginatedTrades.map((trade, index) => (
              <TradeRow key={trade.id} trade={trade} index={index} />
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="px-4 py-3 border-t border-border/50 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Showing {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, trades.length)} of {trades.length}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(1)}
              disabled={currentPage === 1}
              className="h-7 text-xs"
            >
              First
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage === 1}
              className="h-7 text-xs"
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage === totalPages}
              className="h-7 text-xs"
            >
              Next
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(totalPages)}
              disabled={currentPage === totalPages}
              className="h-7 text-xs"
            >
              Last
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
