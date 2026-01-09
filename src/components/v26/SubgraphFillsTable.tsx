import { useState } from 'react';
import { ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useSubgraphFills, useBotWallet, SubgraphFill } from '@/hooks/useSubgraphData';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

export function SubgraphFillsTable() {
  const { data: wallet } = useBotWallet();
  const { data: fills, isLoading } = useSubgraphFills(wallet ?? undefined, 100);
  const [selectedFill, setSelectedFill] = useState<SubgraphFill | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Canonical Fills (Subgraph)</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64" />
        </CardContent>
      </Card>
    );
  }

  const displayedFills = showAll ? fills : fills?.slice(0, 20);

  return (
    <>
      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Canonical Fills (Subgraph)</CardTitle>
              <CardDescription className="text-xs mt-1">
                {fills?.length ?? 0} fills from Polymarket Activity subgraph
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
                  <TableHead className="text-xs">Time</TableHead>
                  <TableHead className="text-xs">Market</TableHead>
                  <TableHead className="text-xs">Side</TableHead>
                  <TableHead className="text-xs">Outcome</TableHead>
                  <TableHead className="text-xs text-right">Price</TableHead>
                  <TableHead className="text-xs text-right">Size</TableHead>
                  <TableHead className="text-xs text-right">Notional</TableHead>
                  <TableHead className="text-xs">Liquidity</TableHead>
                  <TableHead className="text-xs text-right">Fee</TableHead>
                  <TableHead className="text-xs"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!displayedFills || displayedFills.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8">
                      <div className="space-y-2">
                        <div className="text-muted-foreground">No fills ingested yet</div>
                        <div className="text-xs text-muted-foreground">
                          Check the Health Panel above for diagnostics. Common issues:
                        </div>
                        <ul className="text-xs text-muted-foreground list-disc list-inside">
                          <li>Wallet address not configured or incorrect format</li>
                          <li>Sync hasn't run yet (click "Sync Now")</li>
                          <li>Wallet has no trading activity on Polymarket</li>
                        </ul>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  displayedFills.map((fill) => (
                    <TableRow 
                      key={fill.id} 
                      className="hover:bg-muted/50 border-border/30 cursor-pointer"
                      onClick={() => setSelectedFill(fill)}
                    >
                      <TableCell className="py-2 text-xs text-muted-foreground">
                        {format(new Date(fill.timestamp), 'MMM d, HH:mm:ss')}
                      </TableCell>
                      <TableCell className="py-2 text-xs">
                        <span className="truncate max-w-[150px] block">
                          {fill.market_id?.slice(0, 12) ?? '—'}...
                        </span>
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${fill.side === 'BUY' ? 'text-green-500 border-green-500/30' : 'text-red-500 border-red-500/30'}`}
                        >
                          {fill.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2">
                        {fill.outcome_side ? (
                          <Badge 
                            variant="outline" 
                            className={`text-xs ${fill.outcome_side === 'UP' ? 'text-green-500 border-green-500/30' : 'text-red-500 border-red-500/30'}`}
                          >
                            {fill.outcome_side}
                          </Badge>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-xs">
                        ${fill.price.toFixed(2)}
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-xs">
                        {fill.size.toFixed(2)}
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-xs">
                        ${fill.notional.toFixed(2)}
                      </TableCell>
                      <TableCell className="py-2">
                        {fill.liquidity ? (
                          <Badge variant="outline" className="text-xs">
                            {fill.liquidity}
                          </Badge>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="py-2 text-right font-mono text-xs">
                        {fill.fee_known && fill.fee_usd !== null ? (
                          `$${fill.fee_usd.toFixed(2)}`
                        ) : (
                          <span className="text-yellow-500">?</span>
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        {fill.tx_hash && (
                          <a 
                            href={`https://polygonscan.com/tx/${fill.tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {fills && fills.length > 20 && (
            <div className="p-3 border-t border-border/50 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-2" />
                    Show Less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-2" />
                    Show All ({fills.length} fills)
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fill Detail Modal */}
      <Dialog open={!!selectedFill} onOpenChange={() => setSelectedFill(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Fill Details</DialogTitle>
            <DialogDescription>
              Raw data from Polymarket Activity subgraph
            </DialogDescription>
          </DialogHeader>
          {selectedFill && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Fill ID:</span>
                  <div className="font-mono text-xs break-all">{selectedFill.id}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Timestamp:</span>
                  <div>{format(new Date(selectedFill.timestamp), 'PPpp')}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Market ID:</span>
                  <div className="font-mono text-xs break-all">{selectedFill.market_id ?? '—'}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Token ID:</span>
                  <div className="font-mono text-xs break-all">{selectedFill.token_id ?? '—'}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">TX Hash:</span>
                  <div className="font-mono text-xs break-all">
                    {selectedFill.tx_hash ? (
                      <a 
                        href={`https://polygonscan.com/tx/${selectedFill.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {selectedFill.tx_hash}
                      </a>
                    ) : '—'}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Block Number:</span>
                  <div className="font-mono">{selectedFill.block_number ?? '—'}</div>
                </div>
              </div>
              <div className="border-t border-border/50 pt-4">
                <div className="text-sm font-medium mb-2">Trade Details</div>
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Side:</span>
                    <div>{selectedFill.side}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Price:</span>
                    <div className="font-mono">${selectedFill.price.toFixed(4)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Size:</span>
                    <div className="font-mono">{selectedFill.size.toFixed(4)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Notional:</span>
                    <div className="font-mono">${selectedFill.notional.toFixed(4)}</div>
                  </div>
                </div>
              </div>
              {selectedFill.fee_known && (
                <div className="border-t border-border/50 pt-4">
                  <div className="text-sm font-medium mb-2">Fee Information</div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Fee USD:</span>
                      <div className="font-mono">${selectedFill.fee_usd?.toFixed(4) ?? '—'}</div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Liquidity:</span>
                      <div>{selectedFill.liquidity ?? '—'}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
