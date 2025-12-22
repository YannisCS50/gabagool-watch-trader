import { useState, useMemo } from 'react';
import { Trade } from '@/types/trade';
import { TradeRow } from './TradeRow';
import { Button } from './ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface TradesTableProps {
  trades: Trade[];
  pageSize?: number;
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