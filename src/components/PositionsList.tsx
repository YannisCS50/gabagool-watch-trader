import { useState, useMemo } from 'react';
import { MarketPosition } from '@/types/trade';
import { PositionCard } from './PositionCard';
import { Button } from './ui/button';
import { ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PositionsListProps {
  positions: MarketPosition[];
  pageSize?: number;
}

interface MarketPair {
  marketSlug: string;
  market: string;
  yesPosition: MarketPosition | null;
  noPosition: MarketPosition | null;
  totalPnl: number;
  totalShares: number;
}

export function PositionsList({ positions, pageSize = 10 }: PositionsListProps) {
  const [currentPage, setCurrentPage] = useState(1);

  // Group positions by market (Yes/No pairs)
  const marketPairs = useMemo(() => {
    const pairs = new Map<string, MarketPair>();
    
    positions.forEach(pos => {
      const key = pos.marketSlug || pos.market;
      if (!pairs.has(key)) {
        pairs.set(key, {
          marketSlug: pos.marketSlug,
          market: pos.market,
          yesPosition: null,
          noPosition: null,
          totalPnl: 0,
          totalShares: 0,
        });
      }
      
      const pair = pairs.get(key)!;
      if (pos.outcome === 'Yes') {
        pair.yesPosition = pos;
      } else {
        pair.noPosition = pos;
      }
      pair.totalPnl += pos.pnl;
      pair.totalShares += pos.shares;
    });
    
    // Sort by total PnL (absolute value, descending)
    return Array.from(pairs.values()).sort((a, b) => 
      Math.abs(b.totalPnl) - Math.abs(a.totalPnl)
    );
  }, [positions]);

  // Separate into paired and unpaired positions
  const { pairedMarkets, unpairedPositions } = useMemo(() => {
    const paired: MarketPair[] = [];
    const unpaired: MarketPosition[] = [];
    
    marketPairs.forEach(pair => {
      if (pair.yesPosition && pair.noPosition) {
        paired.push(pair);
      } else {
        if (pair.yesPosition) unpaired.push(pair.yesPosition);
        if (pair.noPosition) unpaired.push(pair.noPosition);
      }
    });
    
    return { pairedMarkets: paired, unpairedPositions: unpaired };
  }, [marketPairs]);

  // Combine for pagination: paired first, then unpaired
  const allItems = useMemo(() => {
    const items: Array<{ type: 'pair'; data: MarketPair } | { type: 'single'; data: MarketPosition }> = [];
    pairedMarkets.forEach(pair => items.push({ type: 'pair', data: pair }));
    unpairedPositions.forEach(pos => items.push({ type: 'single', data: pos }));
    return items;
  }, [pairedMarkets, unpairedPositions]);

  const totalPages = Math.ceil(allItems.length / pageSize);
  
  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return allItems.slice(start, start + pageSize);
  }, [allItems, currentPage, pageSize]);

  const goToPage = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  if (positions.length === 0) {
    return (
      <div className="glass rounded-lg p-6 text-center">
        <AlertCircle className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">No open positions</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Active Positions
          <span className="ml-2 text-xs font-normal text-muted-foreground/70">
            ({positions.length} positions, {marketPairs.length} markets)
          </span>
        </h2>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">
              {currentPage}/{totalPages}
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

      <div className="space-y-3">
        {paginatedItems.map((item, index) => {
          if (item.type === 'pair') {
            return (
              <MarketPairCard 
                key={item.data.marketSlug} 
                pair={item.data} 
                index={index} 
              />
            );
          } else {
            return (
              <PositionCard 
                key={item.data.marketSlug + item.data.outcome} 
                position={item.data} 
                index={index} 
              />
            );
          }
        })}
      </div>

      {totalPages > 1 && (
        <div className="text-center text-xs text-muted-foreground">
          Showing {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, allItems.length)} of {allItems.length}
        </div>
      )}
    </div>
  );
}

function MarketPairCard({ pair, index }: { pair: MarketPair; index: number }) {
  const isProfit = pair.totalPnl >= 0;
  const pnlPercent = pair.yesPosition && pair.noPosition 
    ? ((pair.yesPosition.pnlPercent * pair.yesPosition.shares + pair.noPosition.pnlPercent * pair.noPosition.shares) / pair.totalShares)
    : 0;

  return (
    <div 
      className="glass rounded-lg p-4 animate-fade-in"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Market Header */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <h3 className="font-medium text-sm flex-1 min-w-0 truncate">{pair.market}</h3>
        <div className="text-right">
          <div className={cn(
            "text-lg font-mono font-semibold",
            isProfit ? "text-success" : "text-destructive"
          )}>
            {isProfit ? '+' : ''}${pair.totalPnl.toFixed(0)}
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            combined P&L
          </div>
        </div>
      </div>

      {/* Yes/No Pair */}
      <div className="grid grid-cols-2 gap-2">
        {pair.yesPosition && (
          <PositionMini position={pair.yesPosition} />
        )}
        {pair.noPosition && (
          <PositionMini position={pair.noPosition} />
        )}
      </div>
    </div>
  );
}

function PositionMini({ position }: { position: MarketPosition }) {
  const isProfit = position.pnl >= 0;

  return (
    <div className={cn(
      "rounded-md p-2 border",
      position.outcome === 'Yes' 
        ? "bg-success/5 border-success/20" 
        : "bg-destructive/5 border-destructive/20"
    )}>
      <div className="flex items-center justify-between mb-1">
        <span className={cn(
          "text-xs font-mono font-medium px-1.5 py-0.5 rounded",
          position.outcome === 'Yes' 
            ? "bg-success/20 text-success" 
            : "bg-destructive/20 text-destructive"
        )}>
          {position.outcome}
        </span>
        <span className={cn(
          "text-xs font-mono font-semibold",
          isProfit ? "text-success" : "text-destructive"
        )}>
          {isProfit ? '+' : ''}{position.pnlPercent.toFixed(1)}%
        </span>
      </div>
      <div className="text-xs text-muted-foreground font-mono space-y-0.5">
        <div>{position.shares.toLocaleString()} shares</div>
        <div>Avg: ${position.avgPrice.toFixed(3)} → ${position.currentPrice.toFixed(3)}</div>
      </div>
    </div>
  );
}
