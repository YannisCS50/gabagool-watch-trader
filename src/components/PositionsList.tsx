import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { MarketPosition } from '@/types/trade';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

interface PositionsListProps {
  positions: MarketPosition[];
  pageSize?: number;
}

type OutcomeBucket = 'positive' | 'negative' | 'neutral';

function normalizeOutcome(outcome: string): { bucket: OutcomeBucket; order: number } {
  const o = (outcome || '').trim().toLowerCase();
  if (o === 'yes' || o === 'up') return { bucket: 'positive', order: 0 };
  if (o === 'no' || o === 'down') return { bucket: 'negative', order: 1 };
  return { bucket: 'neutral', order: 2 };
}

function outcomeStyles(outcome: string) {
  const { bucket } = normalizeOutcome(outcome);

  if (bucket === 'positive') {
    return {
      pill: 'bg-success/20 text-success',
      card: 'bg-success/5 border-success/20',
    };
  }

  if (bucket === 'negative') {
    return {
      pill: 'bg-destructive/20 text-destructive',
      card: 'bg-destructive/5 border-destructive/20',
    };
  }

  return {
    pill: 'bg-muted text-muted-foreground',
    card: 'bg-muted/20 border-border/50',
  };
}

interface MarketGroup {
  key: string;
  marketSlug: string;
  market: string;
  positions: MarketPosition[];
  totalPnl: number;
  totalShares: number;
}

export function PositionsList({ positions, pageSize = 10 }: PositionsListProps) {
  const [currentPage, setCurrentPage] = useState(1);

  const marketGroups = useMemo<MarketGroup[]>(() => {
    const groups = new Map<
      string,
      {
        key: string;
        marketSlug: string;
        market: string;
        byOutcome: Map<string, MarketPosition>;
        totalPnl: number;
        totalShares: number;
      }
    >();

    for (const pos of positions) {
      const key = pos.marketSlug || pos.market;

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          marketSlug: pos.marketSlug,
          market: pos.market,
          byOutcome: new Map(),
          totalPnl: 0,
          totalShares: 0,
        });
      }

      const group = groups.get(key)!;

      // If we ever get duplicates per outcome, keep the latest one.
      group.byOutcome.set(pos.outcome, pos);

      group.totalPnl += pos.pnl;
      group.totalShares += pos.shares;
    }

    return Array.from(groups.values())
      .map((g) => {
        const sortedPositions = Array.from(g.byOutcome.values()).sort((a, b) => {
          const ao = normalizeOutcome(a.outcome);
          const bo = normalizeOutcome(b.outcome);
          if (ao.order !== bo.order) return ao.order - bo.order;
          return a.outcome.localeCompare(b.outcome);
        });

        return {
          key: g.key,
          marketSlug: g.marketSlug,
          market: g.market,
          positions: sortedPositions,
          totalPnl: g.totalPnl,
          totalShares: g.totalShares,
        } satisfies MarketGroup;
      })
      .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  }, [positions]);

  const totalPages = Math.max(1, Math.ceil(marketGroups.length / pageSize));

  const paginatedGroups = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return marketGroups.slice(start, start + pageSize);
  }, [marketGroups, currentPage, pageSize]);

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
    <section aria-label="Active positions" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Active Positions
          <span className="ml-2 text-xs font-normal text-muted-foreground/70">
            ({positions.length} positions, {marketGroups.length} markets)
          </span>
        </h2>

        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{currentPage}/{totalPages}</span>
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
        {paginatedGroups.map((group, index) => (
          <MarketGroupCard key={group.key} group={group} index={index} />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="text-center text-xs text-muted-foreground">
          Showing {(currentPage - 1) * pageSize + 1} - {Math.min(currentPage * pageSize, marketGroups.length)} of {marketGroups.length}
        </div>
      )}
    </section>
  );
}

function MarketGroupCard({ group, index }: { group: MarketGroup; index: number }) {
  const isProfit = group.totalPnl >= 0;
  const cols = group.positions.length > 1 ? 'grid-cols-2' : 'grid-cols-1';

  return (
    <article
      className="glass rounded-lg p-4 animate-fade-in"
      style={{ animationDelay: `${index * 50}ms` }}
      aria-label={`Market positions: ${group.market}`}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <h3 className="font-medium text-sm flex-1 min-w-0 truncate">{group.market}</h3>
        <div className="text-right">
          <div
            className={cn(
              'text-lg font-mono font-semibold',
              isProfit ? 'text-success' : 'text-destructive'
            )}
          >
            {isProfit ? '+' : ''}${group.totalPnl.toFixed(0)}
          </div>
          <div className="text-xs text-muted-foreground font-mono">combined P&amp;L</div>
        </div>
      </div>

      <div className={cn('grid gap-2', cols)}>
        {group.positions.slice(0, 2).map((pos) => (
          <PositionMini key={`${group.key}:${pos.outcome}`} position={pos} />
        ))}
      </div>

      {group.positions.length > 2 && (
        <div className="mt-2 text-xs text-muted-foreground font-mono">
          +{group.positions.length - 2} more outcomes
        </div>
      )}
    </article>
  );
}

function PositionMini({ position }: { position: MarketPosition }) {
  const isProfit = position.pnl >= 0;
  const s = outcomeStyles(position.outcome);

  return (
    <div className={cn('rounded-md p-2 border', s.card)}>
      <div className="flex items-center justify-between mb-1">
        <span className={cn('text-xs font-mono font-medium px-1.5 py-0.5 rounded', s.pill)}>
          {position.outcome}
        </span>
        <span
          className={cn(
            'text-xs font-mono font-semibold',
            isProfit ? 'text-success' : 'text-destructive'
          )}
        >
          {isProfit ? '+' : ''}{position.pnlPercent.toFixed(1)}%
        </span>
      </div>
      <div className="text-xs text-muted-foreground font-mono space-y-0.5">
        <div>{position.shares.toLocaleString()} shares</div>
        <div>
          Avg: ${position.avgPrice.toFixed(3)}  {position.currentPrice.toFixed(3) ? `→ $${position.currentPrice.toFixed(3)}` : ''}
        </div>
      </div>
    </div>
  );
}
