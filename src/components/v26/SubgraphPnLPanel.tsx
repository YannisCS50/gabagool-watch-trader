import { TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSubgraphPnlSummary, useSubgraphMarketPnl, useBotWallet, Confidence } from '@/hooks/useSubgraphData';
import { Skeleton } from '@/components/ui/skeleton';

const confidenceConfig: Record<Confidence, { color: string; icon: typeof CheckCircle2; label: string }> = {
  HIGH: { color: 'text-green-500 border-green-500/30', icon: CheckCircle2, label: 'High Confidence' },
  MEDIUM: { color: 'text-yellow-500 border-yellow-500/30', icon: AlertTriangle, label: 'Medium - Some data incomplete' },
  LOW: { color: 'text-red-500 border-red-500/30', icon: HelpCircle, label: 'Low - Missing critical data' },
};

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const config = confidenceConfig[confidence];
  const Icon = config.icon;
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={`text-xs ${config.color}`}>
            <Icon className="h-3 w-3 mr-1" />
            {confidence}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p>{config.label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PnLValue({ value, confidence, label }: { value: number | null; confidence: Confidence; label: string }) {
  if (value === null) {
    return (
      <div className="text-center">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className="text-lg font-mono text-muted-foreground">—</div>
        <ConfidenceBadge confidence="LOW" />
      </div>
    );
  }

  const isPositive = value >= 0;
  
  return (
    <div className="text-center">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
        {isPositive ? '+' : ''}{value.toFixed(2)}
        <span className="text-sm ml-1">USD</span>
      </div>
      <ConfidenceBadge confidence={confidence} />
    </div>
  );
}

export function SubgraphPnLPanel() {
  const { data: wallet } = useBotWallet();
  const { data: summary, isLoading: summaryLoading } = useSubgraphPnlSummary(wallet ?? undefined);
  const { data: marketPnl, isLoading: marketsLoading } = useSubgraphMarketPnl(wallet ?? undefined);

  if (summaryLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Subgraph PnL (Canonical)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Subgraph PnL (Canonical)</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            No PnL data available yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 space-y-2">
            <AlertTriangle className="h-8 w-8 mx-auto text-yellow-500/50" />
            <div className="text-sm text-muted-foreground">
              PnL will be computed after fills are synced from the Polymarket Data API.
            </div>
            <div className="text-xs text-muted-foreground">
              Use the "Sync Now" button in the Health Panel above to trigger a sync.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const openMarkets = marketPnl?.filter(m => !m.is_settled) ?? [];
  const settledMarkets = marketPnl?.filter(m => m.is_settled) ?? [];

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              Subgraph PnL (Canonical)
              <ConfidenceBadge confidence={summary.overall_confidence} />
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {summary.total_fills} fills across {summary.total_markets} markets 
              ({summary.settled_markets} settled, {summary.open_markets} open)
            </CardDescription>
          </div>
          {summary.total_fees_unknown_count > 0 && (
            <Badge variant="outline" className="text-yellow-500 border-yellow-500/30">
              <AlertTriangle className="h-3 w-3 mr-1" />
              {summary.total_fees_unknown_count} unknown fees
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-6 py-4">
          <PnLValue 
            value={summary.total_realized_pnl} 
            confidence={summary.realized_confidence}
            label="Realized PnL"
          />
          <PnLValue 
            value={summary.total_unrealized_pnl} 
            confidence={summary.unrealized_confidence}
            label="Unrealized PnL"
          />
          <PnLValue 
            value={summary.total_pnl} 
            confidence={summary.overall_confidence}
            label="Total PnL"
          />
        </div>

        {/* Fee Summary */}
        <div className="border-t border-border/50 pt-4 mt-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Known Fees</span>
            <span className="font-mono">${summary.total_fees_known.toFixed(2)}</span>
          </div>
          {summary.drift_count > 0 && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-yellow-500">Position Drifts</span>
              <Badge variant="outline" className="text-yellow-500 border-yellow-500/30">
                {summary.drift_count} markets
              </Badge>
            </div>
          )}
        </div>

        {/* Market Breakdown (Top 5) */}
        {marketPnl && marketPnl.length > 0 && (
          <div className="border-t border-border/50 pt-4 mt-4">
            <div className="text-sm font-medium mb-3">Top Markets by PnL</div>
            <div className="space-y-2">
              {marketPnl
                .slice()
                .sort((a, b) => Math.abs(b.realized_pnl_usd ?? 0) - Math.abs(a.realized_pnl_usd ?? 0))
                .slice(0, 5)
                .map((market) => (
                  <div key={market.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground truncate max-w-[200px]">
                        {market.market_slug || market.market_id.slice(0, 12) + '...'}
                      </span>
                      {market.is_settled && (
                        <Badge variant="outline" className="text-xs">Settled</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`font-mono ${(market.realized_pnl_usd ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {(market.realized_pnl_usd ?? 0) >= 0 ? '+' : ''}
                        ${(market.realized_pnl_usd ?? 0).toFixed(2)}
                      </span>
                      <ConfidenceBadge confidence={market.confidence} />
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
