import { useBotPositions, MarketPositionGroup } from '@/hooks/useBotPositions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Shield, AlertTriangle, TrendingUp, TrendingDown, Clock, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDistanceToNow, format } from 'date-fns';
import { nl } from 'date-fns/locale';

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

function PositionGroupRow({ group }: { group: MarketPositionGroup }) {
  const now = new Date();
  const isExpired = group.eventEndTime ? new Date(group.eventEndTime) < now : false;
  
  return (
    <div className={cn(
      "glass rounded-lg p-3 space-y-2",
      isExpired && "opacity-60"
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {group.isHedged ? (
            <Shield className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <span className="font-medium text-sm">{formatMarketSlug(group.market_slug, group.asset)}</span>
          {group.isHedged && (
            <Badge variant="outline" className="text-xs bg-success/10 text-success border-success/20">
              Hedged
            </Badge>
          )}
          {isExpired && (
            <Badge variant="outline" className="text-xs bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
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
          <span className="font-mono">{group.upShares.toFixed(0)}</span>
          <span className="text-muted-foreground">@ {(group.upAvgPrice * 100).toFixed(0)}¢</span>
        </div>
        <div className="flex items-center gap-1">
          <TrendingDown className="h-3 w-3 text-destructive" />
          <span className="text-muted-foreground">DOWN:</span>
          <span className="font-mono">{group.downShares.toFixed(0)}</span>
          <span className="text-muted-foreground">@ {(group.downAvgPrice * 100).toFixed(0)}¢</span>
        </div>
      </div>
      
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Cost: ${group.totalInvested.toFixed(2)}</span>
        <span>Paired: {Math.min(group.upShares, group.downShares).toFixed(0)}</span>
        {group.isHedged && (
          <span className="text-success">
            Est. P/L: ${(Math.min(group.upShares, group.downShares) - group.totalInvested).toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

export function BotPositionsCard() {
  const { groupedPositions, loading, error, refetch, summary, dataSource } = useBotPositions();
  
  const lastSyncTime = groupedPositions.length > 0 && groupedPositions[0].positions.length > 0
    ? groupedPositions[0].positions[0]?.synced_at 
    : null;

  // Separate open and expired positions
  const now = new Date();
  const openPositions = groupedPositions.filter(g => 
    !g.eventEndTime || new Date(g.eventEndTime) > now
  );
  const pendingPositions = groupedPositions.filter(g => 
    g.eventEndTime && new Date(g.eventEndTime) <= now
  );

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          🤖 Open Positions
          {dataSource === 'live_trades' && (
            <Badge variant="outline" className="text-xs">
              <Database className="h-3 w-3 mr-1" />
              live_trades
            </Badge>
          )}
          {lastSyncTime && dataSource === 'bot_positions' && (
            <span className="text-xs font-normal text-muted-foreground">
              synced {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
            </span>
          )}
        </CardTitle>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={refetch}
          disabled={loading}
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="text-destructive text-sm">{error}</div>
        )}
        
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
            <div className="text-xs text-muted-foreground">Trades</div>
          </div>
        </div>

        {/* Position List */}
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading positions...
          </div>
        ) : groupedPositions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No open positions found.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Open positions */}
            {openPositions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  Active ({openPositions.length})
                </div>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {openPositions.map((group) => (
                    <PositionGroupRow key={group.market_slug} group={group} />
                  ))}
                </div>
              </div>
            )}

            {/* Pending settlement positions */}
            {pendingPositions.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-muted-foreground flex items-center gap-2">
                  <Clock className="h-3 w-3 text-yellow-500" />
                  Pending Settlement ({pendingPositions.length})
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {pendingPositions.slice(0, 5).map((group) => (
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
