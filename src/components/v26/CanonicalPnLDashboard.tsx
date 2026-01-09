import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, RefreshCw, DollarSign, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useBotWallet } from '@/hooks/useSubgraphData';
import { 
  useCanonicalPnlSummary, 
  useCanonicalMarketPnl, 
  useCanonicalReducer,
  MarketPnl 
} from '@/hooks/useCanonicalPnl';
import { MarketLifecycleBadge } from './MarketLifecycleBadge';

function PnLCard({ 
  label, 
  value, 
  isPositive,
  icon: Icon
}: { 
  label: string; 
  value: number | null; 
  isPositive?: boolean;
  icon?: typeof TrendingUp;
}) {
  if (value === null) {
    return (
      <div className="text-center p-4 bg-muted/30 rounded-lg">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className="text-xl font-mono text-muted-foreground">—</div>
      </div>
    );
  }

  const positive = isPositive ?? value >= 0;
  const IconComponent = Icon || (positive ? TrendingUp : TrendingDown);

  return (
    <div className="text-center p-4 bg-muted/30 rounded-lg">
      <div className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
        <IconComponent className="h-3 w-3" />
        {label}
      </div>
      <div className={`text-2xl font-bold font-mono ${positive ? 'text-green-500' : 'text-red-500'}`}>
        {positive ? '+' : ''}{value.toFixed(2)}
        <span className="text-sm ml-1 text-muted-foreground">USD</span>
      </div>
    </div>
  );
}

function MarketRow({ market }: { market: MarketPnl }) {
  const pnl = market.realized_pnl || 0;
  const isPositive = pnl >= 0;

  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm truncate max-w-[200px]">
          {market.market_slug || market.market_id.slice(0, 12) + '...'}
        </span>
        <MarketLifecycleBadge
          bought={market.has_buy}
          sold={market.has_sell}
          claimed={market.is_claimed}
          lost={market.is_lost}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-mono text-sm ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
          {isPositive ? '+' : ''}${pnl.toFixed(2)}
        </span>
        <Badge 
          variant="outline" 
          className={`text-xs ${
            market.confidence === 'HIGH' ? 'border-green-500/30 text-green-500' :
            market.confidence === 'MEDIUM' ? 'border-yellow-500/30 text-yellow-500' :
            'border-red-500/30 text-red-500'
          }`}
        >
          {market.confidence}
        </Badge>
      </div>
    </div>
  );
}

export function CanonicalPnLDashboard() {
  const { data: wallet, isLoading: walletLoading } = useBotWallet();
  const { data: summary, isLoading: summaryLoading } = useCanonicalPnlSummary(wallet ?? undefined);
  const { data: markets, isLoading: marketsLoading } = useCanonicalMarketPnl(wallet ?? undefined);
  const reducer = useCanonicalReducer();

  const isLoading = walletLoading || summaryLoading;

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Canonical PnL (Database)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!wallet) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Canonical PnL (Database)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            No wallet configured
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sort markets by absolute PnL
  const sortedMarkets = [...(markets || [])]
    .sort((a, b) => Math.abs(b.realized_pnl || 0) - Math.abs(a.realized_pnl || 0))
    .slice(0, 10);

  // Compute totals from markets if summary not available
  const totalRealized = summary?.total_realized_pnl ?? 
    (markets || []).reduce((sum, m) => sum + (m.realized_pnl || 0), 0);
  
  const settledCount = summary?.settled_markets ?? 
    (markets || []).filter(m => m.state === 'SETTLED').length;
  
  const claimedCount = summary?.claimed_markets ?? 
    (markets || []).filter(m => m.is_claimed).length;
  
  const lostCount = summary?.lost_markets ?? 
    (markets || []).filter(m => m.is_lost).length;

  const totalMarkets = summary?.total_markets ?? (markets || []).length;

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Canonical PnL (Database)
              {totalRealized !== 0 && (
                <Badge 
                  variant="outline" 
                  className={totalRealized >= 0 ? 'border-green-500/30 text-green-500' : 'border-red-500/30 text-red-500'}
                >
                  {totalRealized >= 0 ? '+' : ''}{totalRealized.toFixed(2)} USD
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {totalMarkets} markets • {settledCount} settled • {claimedCount} claimed • {lostCount} lost
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => reducer.mutate()}
            disabled={reducer.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${reducer.isPending ? 'animate-spin' : ''}`} />
            {reducer.isPending ? 'Syncing...' : 'Run Reducer'}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* PnL Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <PnLCard 
            label="Realized PnL" 
            value={totalRealized}
            icon={DollarSign}
          />
          <PnLCard 
            label="Total Cost" 
            value={summary?.total_cost ?? (markets || []).reduce((s, m) => s + (m.total_cost || 0), 0)}
            isPositive={false}
          />
          <PnLCard 
            label="Total Payout" 
            value={summary?.total_payout ?? (markets || []).reduce((s, m) => s + (m.total_payout || 0), 0)}
            isPositive={true}
          />
        </div>

        {/* Lifecycle Stats */}
        <div className="grid grid-cols-4 gap-2 mb-6">
          <div className="text-center p-2 bg-blue-500/10 rounded border border-blue-500/20">
            <div className="text-xl font-bold text-blue-400">{summary?.markets_bought ?? totalMarkets}</div>
            <div className="text-xs text-muted-foreground">Bought</div>
          </div>
          <div className="text-center p-2 bg-purple-500/10 rounded border border-purple-500/20">
            <div className="text-xl font-bold text-purple-400">{summary?.markets_sold ?? 0}</div>
            <div className="text-xs text-muted-foreground">Sold</div>
          </div>
          <div className="text-center p-2 bg-green-500/10 rounded border border-green-500/20">
            <div className="text-xl font-bold text-green-400">{claimedCount}</div>
            <div className="text-xs text-muted-foreground">Claimed</div>
          </div>
          <div className="text-center p-2 bg-red-500/10 rounded border border-red-500/20">
            <div className="text-xl font-bold text-red-400">{lostCount}</div>
            <div className="text-xs text-muted-foreground">Lost</div>
          </div>
        </div>

        {/* No Data Warning */}
        {(!markets || markets.length === 0) && (
          <div className="text-center py-6 border border-yellow-500/30 rounded-lg bg-yellow-500/5">
            <AlertTriangle className="h-8 w-8 mx-auto text-yellow-500/50 mb-2" />
            <div className="text-sm text-muted-foreground">
              No market data in canonical tables yet.
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Click "Run Reducer" to populate from Polymarket activity.
            </div>
          </div>
        )}

        {/* Top Markets */}
        {sortedMarkets.length > 0 && (
          <div className="border-t border-border/50 pt-4">
            <div className="text-sm font-medium mb-3 flex items-center gap-2">
              Top Markets by PnL
              <Badge variant="secondary" className="text-xs">
                Sum: ${sortedMarkets.reduce((s, m) => s + (m.realized_pnl || 0), 0).toFixed(2)}
              </Badge>
            </div>
            <div className="space-y-1">
              {sortedMarkets.map(market => (
                <MarketRow key={market.id} market={market} />
              ))}
            </div>
          </div>
        )}

        {/* Verification */}
        {markets && markets.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Sum of market PnL:</span>
              <span className="font-mono">
                ${(markets || []).reduce((s, m) => s + (m.realized_pnl || 0), 0).toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Dashboard Total PnL:</span>
              <span className="font-mono">${totalRealized.toFixed(2)}</span>
            </div>
            {Math.abs((markets || []).reduce((s, m) => s + (m.realized_pnl || 0), 0) - totalRealized) < 0.01 ? (
              <div className="flex items-center gap-1 text-xs text-green-500 mt-1">
                <CheckCircle2 className="h-3 w-3" />
                Totals reconcile exactly
              </div>
            ) : (
              <div className="flex items-center gap-1 text-xs text-yellow-500 mt-1">
                <AlertTriangle className="h-3 w-3" />
                Totals differ - run reducer to sync
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
