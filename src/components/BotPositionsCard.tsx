import { useBotPositions, MarketPositionGroup } from '@/hooks/useBotPositions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Shield, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';

function formatMarketSlug(slug: string): string {
  // Convert "btc-updown-15m-1767091500" to "BTC 15m 11:45"
  const parts = slug.split('-');
  if (parts.length >= 3 && parts[1] === 'updown' && parts[2] === '15m') {
    const asset = parts[0].toUpperCase();
    const timestamp = parseInt(parts[3] || '0', 10);
    if (timestamp > 0) {
      const date = new Date(timestamp * 1000);
      const time = date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
      return `${asset} 15m ${time}`;
    }
    return `${asset} 15m`;
  }
  // Fallback: just show the slug nicely formatted
  return slug.replace(/-/g, ' ').slice(0, 30);
}

function PositionGroupRow({ group }: { group: MarketPositionGroup }) {
  const isProfit = group.pnl >= 0;
  
  return (
    <div className="glass rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {group.isHedged ? (
            <Shield className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )}
          <span className="font-medium text-sm">{formatMarketSlug(group.market_slug)}</span>
          {group.isHedged && (
            <Badge variant="outline" className="text-xs bg-success/10 text-success border-success/20">
              Hedged
            </Badge>
          )}
        </div>
        <div className={cn(
          'font-mono font-semibold',
          isProfit ? 'text-success' : 'text-destructive'
        )}>
          {isProfit ? '+' : ''}${group.pnl.toFixed(2)}
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex items-center gap-1">
          <TrendingUp className="h-3 w-3 text-success" />
          <span className="text-muted-foreground">UP:</span>
          <span className="font-mono">{group.upShares.toFixed(1)}</span>
          <span className="text-muted-foreground">@ ${group.upAvgPrice.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1">
          <TrendingDown className="h-3 w-3 text-destructive" />
          <span className="text-muted-foreground">DOWN:</span>
          <span className="font-mono">{group.downShares.toFixed(1)}</span>
          <span className="text-muted-foreground">@ ${group.downAvgPrice.toFixed(2)}</span>
        </div>
      </div>
      
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Invested: ${group.totalInvested.toFixed(2)}</span>
        <span>Value: ${group.totalValue.toFixed(2)}</span>
        <span className={isProfit ? 'text-success' : 'text-destructive'}>
          {group.pnlPercent.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

export function BotPositionsCard() {
  const { groupedPositions, loading, error, refetch, summary } = useBotPositions();
  
  const lastSyncTime = groupedPositions.length > 0 
    ? groupedPositions[0].positions[0]?.synced_at 
    : null;

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          🤖 Bot Positions (Polymarket Sync)
          {lastSyncTime && (
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
            <div className="text-lg font-mono font-bold">${summary.totalValue.toFixed(0)}</div>
            <div className="text-xs text-muted-foreground">Value</div>
          </div>
          <div className="glass rounded-md p-2">
            <div className={cn(
              'text-lg font-mono font-bold',
              summary.totalPnl >= 0 ? 'text-success' : 'text-destructive'
            )}>
              {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toFixed(0)}
            </div>
            <div className="text-xs text-muted-foreground">P/L</div>
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
            No synced positions yet. Runner will sync every 10s.
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {groupedPositions.map((group) => (
              <PositionGroupRow key={group.market_slug} group={group} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
