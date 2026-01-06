import { useMemo } from 'react';
import { useBotPositions } from '@/hooks/useBotPositions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Shield, AlertTriangle, TrendingUp, TrendingDown, Clock, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';
import { nl } from 'date-fns/locale';

export interface PortfolioPosition {
  title?: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  initialValue: number;
  cashPnl?: number;
  percentPnl?: number;
  redeemable?: boolean;
  endDate?: string;
}

type PositionGroup = {
  market_slug: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upValue: number;
  downValue: number;
  upAvgPrice: number;
  downAvgPrice: number;
  totalInvested: number;
  totalValue: number;
  pnl: number;
  pnlPercent: number;
  isHedged: boolean;
  eventEndTime: string | null;
  positions: Array<{ synced_at?: string }>; // only present for DB-synced positions
};

function formatShares(shares: number) {
  return Number.isInteger(shares) ? shares.toFixed(0) : shares.toFixed(1);
}

function formatMarketSlug(slug: string, asset?: string): string {
  const parts = slug.split('-');
  if (parts.length >= 3 && parts[1] === 'updown' && parts[2] === '15m') {
    const displayAsset = asset || parts[0].toUpperCase();
    const timestamp = parseInt(parts[3] || '0', 10);
    if (timestamp > 0) {
      const date = new Date(timestamp * 1000);
      const time = format(date, 'HH:mm', { locale: nl });
      return `${displayAsset} 15m ${time}`;
    }
    return `${displayAsset} 15m`;
  }
  return slug.replace(/-/g, ' ').slice(0, 30);
}

function PositionGroupRow({ group }: { group: PositionGroup }) {
  const now = new Date();
  const isExpired = group.eventEndTime ? new Date(group.eventEndTime) < now : false;

  return (
    <div
      className={cn(
        'glass rounded-lg p-3 space-y-2',
        isExpired && 'opacity-60'
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {group.isHedged ? (
            <Shield className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <span className="font-medium text-sm">{formatMarketSlug(group.market_slug, group.asset)}</span>
          {group.isHedged && (
            <Badge
              variant="outline"
              className="text-xs bg-success/10 text-success border-success/20"
            >
              Hedged
            </Badge>
          )}
          {isExpired && (
            <Badge
              variant="outline"
              className="text-xs bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
            >
              Pending
            </Badge>
          )}
        </div>
        {group.eventEndTime && !isExpired && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {format(new Date(group.eventEndTime), 'HH:mm', { locale: nl })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1">
          <TrendingUp className="h-3 w-3 text-success" />
          <span className="text-muted-foreground">UP:</span>
          <span className="font-mono">{formatShares(group.upShares)}</span>
          <span className="text-muted-foreground">@ {(group.upAvgPrice * 100).toFixed(0)}¢</span>
        </div>
        <div className="flex items-center gap-1">
          <TrendingDown className="h-3 w-3 text-destructive" />
          <span className="text-muted-foreground">DOWN:</span>
          <span className="font-mono">{formatShares(group.downShares)}</span>
          <span className="text-muted-foreground">@ {(group.downAvgPrice * 100).toFixed(0)}¢</span>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Cost: ${group.totalInvested.toFixed(2)}</span>
        <span>Paired: {formatShares(Math.min(group.upShares, group.downShares))}</span>
        {group.isHedged && (
          <span className="text-success">
            Est. P/L: ${(Math.min(group.upShares, group.downShares) - group.totalInvested).toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

function extractEventEndTimeFromSlug(slug: string): string | null {
  const parts = slug.split('-');
  if (parts.length >= 4 && parts[1] === 'updown' && parts[2] === '15m') {
    const timestamp = parseInt(parts[3], 10);
    if (timestamp > 0) {
      // Add 15 minutes (900 seconds) to get end time
      return new Date((timestamp + 900) * 1000).toISOString();
    }
  }
  return null;
}

function buildGroupsFromPortfolioPositions(portfolioPositions: PortfolioPosition[]): PositionGroup[] {
  const groups = new Map<string, PortfolioPosition[]>();

  for (const pos of portfolioPositions) {
    if (!pos.slug) continue;
    if (!groups.has(pos.slug)) groups.set(pos.slug, []);
    groups.get(pos.slug)!.push(pos);
  }

  return Array.from(groups.entries())
    .map(([slug, positions]) => {
      let upShares = 0,
        downShares = 0;
      let upCost = 0,
        downCost = 0;
      let upValue = 0,
        downValue = 0;
      let upAvgPriceW = 0,
        downAvgPriceW = 0;
      let upQty = 0,
        downQty = 0;

      let eventEndTime: string | null = null;

      for (const p of positions) {
        if (!eventEndTime && p.endDate) eventEndTime = p.endDate;

        const o = (p.outcome || '').toLowerCase();
        const isUp = o === 'up' || o === 'yes';

        if (isUp) {
          upShares += p.size;
          upCost += p.initialValue || 0;
          upValue += p.currentValue || 0;
          upAvgPriceW += (p.avgPrice || 0) * (p.size || 0);
          upQty += p.size || 0;
        } else {
          downShares += p.size;
          downCost += p.initialValue || 0;
          downValue += p.currentValue || 0;
          downAvgPriceW += (p.avgPrice || 0) * (p.size || 0);
          downQty += p.size || 0;
        }
      }

      const upAvgPrice = upQty > 0 ? upAvgPriceW / upQty : 0;
      const downAvgPrice = downQty > 0 ? downAvgPriceW / downQty : 0;

      const totalInvested = upCost + downCost;
      const totalValue = upValue + downValue;
      const pnl = totalValue - totalInvested;
      const pnlPercent = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;
      const isHedged = upShares > 0 && downShares > 0;

      if (!eventEndTime) eventEndTime = extractEventEndTimeFromSlug(slug);

      return {
        market_slug: slug,
        asset: slug.split('-')[0]?.toUpperCase() || '—',
        upShares,
        downShares,
        upCost,
        downCost,
        upValue,
        downValue,
        upAvgPrice,
        downAvgPrice,
        totalInvested,
        totalValue,
        pnl,
        pnlPercent,
        isHedged,
        eventEndTime,
        positions: [],
      } satisfies PositionGroup;
    })
    .sort((a, b) => {
      if (a.eventEndTime && b.eventEndTime) {
        return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
      }
      return Math.abs(b.totalInvested) - Math.abs(a.totalInvested);
    });
}

export function BotPositionsCard({
  portfolioPositions,
  portfolioLoading,
  onRefresh,
}: {
  portfolioPositions?: PortfolioPosition[];
  portfolioLoading?: boolean;
  onRefresh?: () => void;
}) {
  const usePortfolio = (portfolioPositions?.length ?? 0) > 0;

  const {
    groupedPositions: dbGrouped,
    loading: dbLoading,
    error,
    refetch,
    summary: dbSummary,
    dataSource,
  } = useBotPositions({ enabled: !usePortfolio });

  const portfolioGrouped = useMemo(() => {
    if (!usePortfolio) return [] as PositionGroup[];
    return buildGroupsFromPortfolioPositions(portfolioPositions || []);
  }, [usePortfolio, portfolioPositions]);

  const groupedPositions: PositionGroup[] = usePortfolio ? portfolioGrouped : (dbGrouped as unknown as PositionGroup[]);
  const summary = useMemo(() => {
    if (!usePortfolio) return dbSummary;

    const totalInvested = portfolioGrouped.reduce((sum, g) => sum + g.totalInvested, 0);
    const totalValue = portfolioGrouped.reduce((sum, g) => sum + g.totalValue, 0);
    const hedgedMarkets = portfolioGrouped.filter(g => g.isHedged).length;

    // Positions count = sum of legs, not markets.
    const totalPositions = (portfolioPositions || []).length;

    return {
      totalPositions,
      totalMarkets: portfolioGrouped.length,
      totalInvested,
      totalValue,
      totalPnl: totalValue - totalInvested,
      hedgedMarkets,
    };
  }, [usePortfolio, dbSummary, portfolioGrouped, portfolioPositions]);

  const loading = usePortfolio ? false : dbLoading; // Don't show loading for portfolio since parent handles it

  const lastSyncTime = !usePortfolio && groupedPositions.length > 0 && groupedPositions[0].positions.length > 0
    ? groupedPositions[0].positions[0]?.synced_at
    : null;

  // Separate active (currently running) and pending/expired positions
  const now = new Date();

  const activePositions = groupedPositions.filter(g => {
    if (!g.eventEndTime) return false;
    const endTime = new Date(g.eventEndTime);
    // Start time is 15 min (900 sec) before end time
    const startTime = new Date(endTime.getTime() - 15 * 60 * 1000);
    return now >= startTime && now < endTime;
  });

  const pendingPositions = groupedPositions.filter(g => {
    if (!g.eventEndTime) return true;
    const endTime = new Date(g.eventEndTime);
    return now >= endTime;
  });

  const futurePositions = groupedPositions.filter(g => {
    if (!g.eventEndTime) return false;
    const endTime = new Date(g.eventEndTime);
    const startTime = new Date(endTime.getTime() - 15 * 60 * 1000);
    return now < startTime;
  });

  const handleRefresh = () => {
    if (onRefresh) return onRefresh();
    return refetch();
  };

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          🤖 Open Positions
          {usePortfolio ? (
            <Badge variant="outline" className="text-xs">
              <Database className="h-3 w-3 mr-1" />
              Polymarket
            </Badge>
          ) : dataSource === 'live_trades' ? (
            <Badge variant="outline" className="text-xs">
              <Database className="h-3 w-3 mr-1" />
              live_trades
            </Badge>
          ) : null}
          {lastSyncTime && !usePortfolio && dataSource === 'bot_positions' && (
            <span className="text-xs font-normal text-muted-foreground">
              synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
            </span>
          )}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && !usePortfolio && <div className="text-destructive text-sm">{error}</div>}

        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <div className="glass rounded-md p-2">
            <div className="text-lg font-mono font-bold">{summary.totalMarkets}</div>
            <div className="text-xs text-muted-foreground">Markets</div>
          </div>
          <div className="glass rounded-md p-2">
            <div className="text-lg font-mono font-bold">${summary.totalInvested.toFixed(0)}</div>
            <div className="text-xs text-muted-foreground">Invested</div>
          </div>
          <div className="glass rounded-md p-2">
            <div className="text-lg font-mono font-bold">{summary.hedgedMarkets}</div>
            <div className="text-xs text-muted-foreground">Hedged</div>
          </div>
          <div className="glass rounded-md p-2">
            <div className="text-lg font-mono font-bold">{summary.totalPositions}</div>
            <div className="text-xs text-muted-foreground">Positions</div>
          </div>
        </div>

        {/* Position List */}
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading positions...
          </div>
        ) : groupedPositions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No open positions found.</div>
        ) : (
          <div className="space-y-4">
            {activePositions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  LIVE ({activePositions.length})
                </div>
                <div className="space-y-2">
                  {activePositions.map(group => (
                    <PositionGroupRow key={group.market_slug} group={group} />
                  ))}
                </div>
              </div>
            )}

            {futurePositions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                  <Clock className="h-3 w-3 text-blue-400" />
                  Upcoming ({futurePositions.length})
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {futurePositions.slice(0, 3).map(group => (
                    <PositionGroupRow key={group.market_slug} group={group} />
                  ))}
                  {futurePositions.length > 3 && (
                    <div className="text-xs text-center text-muted-foreground">
                      +{futurePositions.length - 3} more upcoming...
                    </div>
                  )}
                </div>
              </div>
            )}

            {pendingPositions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                  <Clock className="h-3 w-3 text-yellow-500" />
                  Pending Settlement ({pendingPositions.length})
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {pendingPositions.slice(0, 5).map(group => (
                    <PositionGroupRow key={group.market_slug} group={group} />
                  ))}
                  {pendingPositions.length > 5 && (
                    <div className="text-xs text-center text-muted-foreground">
                      +{pendingPositions.length - 5} more pending...
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

