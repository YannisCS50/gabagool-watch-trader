import { useState } from 'react';
import { Download, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useBotWallet } from '@/hooks/useSubgraphData';
import { format } from 'date-fns';

interface MarketLifecycle {
  id: string;
  market_id: string;
  market_slug: string | null;
  wallet: string;
  state: string;
  resolved_outcome: string | null;
  total_cost: number;
  total_payout: number;
  realized_pnl: number;
  has_buy: boolean;
  has_sell: boolean;
  has_redeem: boolean;
  is_claimed: boolean;
  is_lost: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export function MarketLifecycleTable() {
  const { data: wallet } = useBotWallet();
  const [showAll, setShowAll] = useState(false);

  const { data: markets, isLoading } = useQuery({
    queryKey: ['market-lifecycle', wallet],
    queryFn: async () => {
      if (!wallet) return [];
      const { data, error } = await supabase
        .from('market_lifecycle')
        .select('*')
        .eq('wallet', wallet.toLowerCase())
        .order('updated_at', { ascending: false });
      
      if (error) throw error;
      return data as MarketLifecycle[];
    },
    enabled: !!wallet,
  });

  const handleExportCSV = () => {
    if (!markets?.length) return;

    const headers = [
      'Market Slug',
      'Market ID',
      'State',
      'Resolved Outcome',
      'Total Cost',
      'Total Payout',
      'Realized PnL',
      'Has Buy',
      'Has Sell',
      'Has Redeem',
      'Is Claimed',
      'Is Lost',
      'Updated At'
    ];

    const rows = markets.map(m => [
      m.market_slug || '',
      m.market_id,
      m.state,
      m.resolved_outcome || '',
      m.total_cost.toFixed(4),
      m.total_payout.toFixed(4),
      m.realized_pnl.toFixed(4),
      m.has_buy ? 'Yes' : 'No',
      m.has_sell ? 'Yes' : 'No',
      m.has_redeem ? 'Yes' : 'No',
      m.is_claimed ? 'Yes' : 'No',
      m.is_lost ? 'Yes' : 'No',
      m.updated_at || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(r => r.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `market-lifecycle-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.csv`;
    link.click();
  };

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Market Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64" />
        </CardContent>
      </Card>
    );
  }

  const displayedMarkets = showAll ? markets : markets?.slice(0, 20);
  const settledCount = markets?.filter(m => m.state === 'SETTLED').length ?? 0;
  const openCount = markets?.filter(m => m.state === 'OPEN').length ?? 0;
  const totalPnl = markets?.reduce((sum, m) => sum + m.realized_pnl, 0) ?? 0;

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Market Lifecycle</CardTitle>
            <CardDescription className="text-xs mt-1">
              {markets?.length ?? 0} markets • {settledCount} settled • {openCount} open • 
              <span className={totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                {' '}${totalPnl.toFixed(2)} PnL
              </span>
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={!markets?.length}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto max-h-[500px]">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead className="text-xs">Market</TableHead>
                <TableHead className="text-xs">State</TableHead>
                <TableHead className="text-xs">Outcome</TableHead>
                <TableHead className="text-xs text-right">Cost</TableHead>
                <TableHead className="text-xs text-right">Payout</TableHead>
                <TableHead className="text-xs text-right">PnL</TableHead>
                <TableHead className="text-xs">Activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!displayedMarkets || displayedMarkets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    No market data available. Run the reducer first.
                  </TableCell>
                </TableRow>
              ) : (
                displayedMarkets.map((market) => (
                  <TableRow 
                    key={market.id} 
                    className="hover:bg-muted/50 border-border/30"
                  >
                    <TableCell className="py-2 text-xs">
                      <div className="flex items-center gap-1">
                        <span className="truncate max-w-[200px]">
                          {market.market_slug || market.market_id.slice(0, 16) + '...'}
                        </span>
                        <a
                          href={`https://polymarket.com/event/${market.market_slug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <Badge 
                        variant="outline" 
                        className={`text-xs ${
                          market.state === 'SETTLED' 
                            ? 'text-green-500 border-green-500/30' 
                            : 'text-yellow-500 border-yellow-500/30'
                        }`}
                      >
                        {market.state}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-2">
                      {market.resolved_outcome ? (
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${
                            market.resolved_outcome === 'UP' 
                              ? 'text-green-500 border-green-500/30' 
                              : 'text-red-500 border-red-500/30'
                          }`}
                        >
                          {market.resolved_outcome}
                        </Badge>
                      ) : market.is_lost ? (
                        <Badge variant="outline" className="text-xs text-red-500 border-red-500/30">
                          LOST
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs">
                      ${market.total_cost.toFixed(2)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono text-xs">
                      ${market.total_payout.toFixed(2)}
                    </TableCell>
                    <TableCell className={`py-2 text-right font-mono text-xs ${
                      market.realized_pnl >= 0 ? 'text-green-500' : 'text-red-500'
                    }`}>
                      {market.realized_pnl >= 0 ? '+' : ''}${market.realized_pnl.toFixed(2)}
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex gap-1">
                        {market.has_buy && (
                          <Badge variant="outline" className="text-xs px-1">B</Badge>
                        )}
                        {market.has_sell && (
                          <Badge variant="outline" className="text-xs px-1">S</Badge>
                        )}
                        {market.has_redeem && (
                          <Badge variant="outline" className="text-xs px-1 text-green-500 border-green-500/30">R</Badge>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {markets && markets.length > 20 && (
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
                  Show All ({markets.length} markets)
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
