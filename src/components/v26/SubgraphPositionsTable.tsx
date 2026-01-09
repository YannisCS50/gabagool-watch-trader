import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useSubgraphPositions, useBotWallet } from '@/hooks/useSubgraphData';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

export function SubgraphPositionsTable() {
  const { data: wallet } = useBotWallet();
  const { data: positions, isLoading } = useSubgraphPositions(wallet ?? undefined);

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Canonical Positions (Subgraph)</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48" />
        </CardContent>
      </Card>
    );
  }

  // Group positions by market
  const positionsByMarket = positions?.reduce((acc, pos) => {
    const key = pos.market_id ?? 'unknown';
    if (!acc[key]) acc[key] = [];
    acc[key].push(pos);
    return acc;
  }, {} as Record<string, typeof positions>);

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Canonical Positions (Subgraph)</CardTitle>
            <CardDescription className="text-xs mt-1">
              {positions?.length ?? 0} positions from Polymarket Positions subgraph
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-green-500 border-green-500/30">
            Source: Subgraph
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead className="text-xs">Market</TableHead>
                <TableHead className="text-xs">Token ID</TableHead>
                <TableHead className="text-xs">Outcome</TableHead>
                <TableHead className="text-xs text-right">Shares</TableHead>
                <TableHead className="text-xs text-right">Avg Cost</TableHead>
                <TableHead className="text-xs">Last Update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!positions || positions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <div className="space-y-2">
                      <div className="text-muted-foreground">No positions found</div>
                      <div className="text-xs text-muted-foreground">
                        This wallet may have no open positions, or sync hasn't run yet.
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                positions.map((pos) => (
                  <TableRow key={pos.id} className="hover:bg-muted/50 border-border/30">
                    <TableCell className="py-2 text-xs">
                      <span className="truncate max-w-[150px] block">
                        {pos.market_id?.slice(0, 12) ?? '—'}...
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-xs font-mono">
                      {pos.token_id.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="py-2">
                      {pos.outcome_side ? (
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${pos.outcome_side === 'UP' ? 'text-green-500 border-green-500/30' : 'text-red-500 border-red-500/30'}`}
                        >
                          {pos.outcome_side}
                        </Badge>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs">
                      {pos.shares.toFixed(2)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs">
                      {pos.avg_cost !== null ? `$${pos.avg_cost.toFixed(4)}` : '—'}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {format(new Date(pos.timestamp), 'MMM d, HH:mm')}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
