import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Download, Copy, RefreshCw, ArrowUpDown } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

interface TradeWithContext {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  avg_fill_price: number | null;
  arbitrage_edge: number | null;
  reasoning: string | null;
  created_at: string;
  event_start_time: string | null;
  event_end_time: string | null;
  status: string | null;
  strike_price: number | null;
  btc_open_price: number | null;
  result: string | null;
  payout: number | null;
  profit_loss: number | null;
}

type SortField = 'created_at' | 'total' | 'shares' | 'price' | 'profit_loss';
type SortDirection = 'asc' | 'desc';

export function TradeAnalysisTable() {
  const [trades, setTrades] = useState<TradeWithContext[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const { toast } = useToast();

  const fetchTrades = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('live_trades')
        .select(`
          id,
          market_slug,
          asset,
          outcome,
          shares,
          price,
          total,
          avg_fill_price,
          arbitrage_edge,
          reasoning,
          created_at,
          event_start_time,
          event_end_time,
          status
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Fetch strike prices and results separately
      const marketSlugs = [...new Set(data?.map(t => t.market_slug) || [])];
      
      const [strikesResult, resultsResult] = await Promise.all([
        supabase
          .from('strike_prices')
          .select('market_slug, strike_price, open_price')
          .in('market_slug', marketSlugs),
        supabase
          .from('live_trade_results')
          .select('market_slug, result, payout, profit_loss')
          .in('market_slug', marketSlugs)
      ]);

      const strikesMap = new Map(
        strikesResult.data?.map(s => [s.market_slug, s]) || []
      );
      const resultsMap = new Map(
        resultsResult.data?.map(r => [r.market_slug, r]) || []
      );

      const enrichedTrades: TradeWithContext[] = (data || []).map(trade => {
        const strike = strikesMap.get(trade.market_slug);
        const result = resultsMap.get(trade.market_slug);
        return {
          ...trade,
          strike_price: strike?.strike_price ?? null,
          btc_open_price: strike?.open_price ?? null,
          result: result?.result ?? null,
          payout: result?.payout ?? null,
          profit_loss: result?.profit_loss ?? null,
        };
      });

      setTrades(enrichedTrades);
    } catch (error) {
      console.error('Error fetching trades:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch trades',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTrades();
  }, []);

  const sortedTrades = useMemo(() => {
    return [...trades].sort((a, b) => {
      let aVal: number | string | null = null;
      let bVal: number | string | null = null;

      switch (sortField) {
        case 'created_at':
          aVal = new Date(a.created_at).getTime();
          bVal = new Date(b.created_at).getTime();
          break;
        case 'total':
          aVal = a.total;
          bVal = b.total;
          break;
        case 'shares':
          aVal = a.shares;
          bVal = b.shares;
          break;
        case 'price':
          aVal = a.avg_fill_price ?? a.price;
          bVal = b.avg_fill_price ?? b.price;
          break;
        case 'profit_loss':
          aVal = a.profit_loss ?? 0;
          bVal = b.profit_loss ?? 0;
          break;
      }

      if (aVal === null) return 1;
      if (bVal === null) return -1;

      const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [trades, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const exportData = useMemo(() => {
    return sortedTrades.map(trade => {
      const fillPrice = trade.avg_fill_price ?? trade.price;
      const strikePrice = trade.strike_price ?? 0;
      
      return {
        time: format(new Date(trade.created_at), 'yyyy-MM-dd HH:mm:ss'),
        market: trade.market_slug,
        asset: trade.asset,
        outcome: trade.outcome,
        shares: trade.shares,
        price: fillPrice,
        total_cost: trade.total,
        strike_price: strikePrice,
        btc_at_open: trade.btc_open_price,
        reasoning: trade.reasoning || '',
        status: trade.status,
        result: trade.result || 'pending',
        profit_loss: trade.profit_loss,
        event_start: trade.event_start_time ? format(new Date(trade.event_start_time), 'HH:mm:ss') : '',
        event_end: trade.event_end_time ? format(new Date(trade.event_end_time), 'HH:mm:ss') : '',
      };
    });
  }, [sortedTrades]);

  const handleExportCSV = () => {
    const headers = Object.keys(exportData[0] || {}).join(',');
    const rows = exportData.map(row => 
      Object.values(row).map(v => 
        typeof v === 'string' && v.includes(',') ? `"${v}"` : v
      ).join(',')
    );
    const csv = [headers, ...rows].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-export-${format(new Date(), 'yyyy-MM-dd-HHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({ title: 'Exported', description: `${exportData.length} trades exported to CSV` });
  };

  const handleExportJSON = () => {
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-export-${format(new Date(), 'yyyy-MM-dd-HHmm')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast({ title: 'Exported', description: `${exportData.length} trades exported to JSON` });
  };

  const handleCopyForChatGPT = () => {
    const text = exportData.map(t => 
      `${t.time} | ${t.outcome} ${t.shares}x @ ${(t.price * 100).toFixed(0)}¢ = $${t.total_cost.toFixed(2)} | Strike: $${t.strike_price?.toFixed(2)} | ${t.reasoning} | Result: ${t.result} P/L: ${t.profit_loss !== null ? `$${t.profit_loss.toFixed(2)}` : 'pending'}`
    ).join('\n');
    
    navigator.clipboard.writeText(text);
    toast({ title: 'Copied', description: 'Trade data copied to clipboard in ChatGPT-friendly format' });
  };

  const SortButton = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-2 -ml-2"
      onClick={() => handleSort(field)}
    >
      {children}
      <ArrowUpDown className="ml-1 h-3 w-3" />
    </Button>
  );

  // Group trades by market for summary
  const marketSummary = useMemo(() => {
    const summary = new Map<string, { 
      upShares: number; 
      downShares: number; 
      upCost: number; 
      downCost: number;
      result: string | null;
      profitLoss: number | null;
    }>();

    trades.forEach(trade => {
      const existing = summary.get(trade.market_slug) || {
        upShares: 0, downShares: 0, upCost: 0, downCost: 0, result: trade.result, profitLoss: trade.profit_loss
      };
      
      if (trade.outcome === 'UP') {
        existing.upShares += trade.shares;
        existing.upCost += trade.total;
      } else {
        existing.downShares += trade.shares;
        existing.downCost += trade.total;
      }
      existing.result = trade.result;
      existing.profitLoss = trade.profit_loss;
      
      summary.set(trade.market_slug, existing);
    });

    return summary;
  }, [trades]);

  const totalStats = useMemo(() => {
    let totalInvested = 0;
    let totalPL = 0;
    let wins = 0;
    let losses = 0;

    marketSummary.forEach(market => {
      totalInvested += market.upCost + market.downCost;
      if (market.profitLoss !== null) {
        totalPL += market.profitLoss;
        if (market.profitLoss > 0) wins++;
        else if (market.profitLoss < 0) losses++;
      }
    });

    return { totalInvested, totalPL, wins, losses, markets: marketSummary.size };
  }, [marketSummary]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Trade Analysis Export</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={fetchTrades} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopyForChatGPT}>
                <Copy className="h-4 w-4 mr-1" />
                Copy for ChatGPT
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV}>
                <Download className="h-4 w-4 mr-1" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportJSON}>
                <Download className="h-4 w-4 mr-1" />
                JSON
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-5 gap-4 mb-4 text-sm">
            <div className="bg-muted/50 p-3 rounded-lg">
              <div className="text-muted-foreground">Markets</div>
              <div className="text-xl font-bold">{totalStats.markets}</div>
            </div>
            <div className="bg-muted/50 p-3 rounded-lg">
              <div className="text-muted-foreground">Total Trades</div>
              <div className="text-xl font-bold">{trades.length}</div>
            </div>
            <div className="bg-muted/50 p-3 rounded-lg">
              <div className="text-muted-foreground">Total Invested</div>
              <div className="text-xl font-bold">${totalStats.totalInvested.toFixed(2)}</div>
            </div>
            <div className="bg-muted/50 p-3 rounded-lg">
              <div className="text-muted-foreground">Total P/L</div>
              <div className={`text-xl font-bold ${totalStats.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${totalStats.totalPL.toFixed(2)}
              </div>
            </div>
            <div className="bg-muted/50 p-3 rounded-lg">
              <div className="text-muted-foreground">Win/Loss</div>
              <div className="text-xl font-bold">
                <span className="text-green-500">{totalStats.wins}</span>
                {' / '}
                <span className="text-red-500">{totalStats.losses}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">
                    <SortButton field="created_at">Time</SortButton>
                  </TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">
                    <SortButton field="shares">Shares</SortButton>
                  </TableHead>
                  <TableHead className="text-right">
                    <SortButton field="price">Price</SortButton>
                  </TableHead>
                  <TableHead className="text-right">
                    <SortButton field="total">Cost</SortButton>
                  </TableHead>
                  <TableHead className="text-right">Strike</TableHead>
                  <TableHead>Reasoning</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">
                    <SortButton field="profit_loss">P/L</SortButton>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      Loading trades...
                    </TableCell>
                  </TableRow>
                ) : sortedTrades.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      No trades found
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedTrades.map((trade) => {
                    const fillPrice = trade.avg_fill_price ?? trade.price;
                    return (
                      <TableRow key={trade.id}>
                        <TableCell className="font-mono text-xs">
                          {format(new Date(trade.created_at), 'MM/dd HH:mm:ss')}
                        </TableCell>
                        <TableCell className="font-mono text-xs max-w-[120px] truncate" title={trade.market_slug}>
                          {trade.market_slug.split('-').slice(-1)[0]}
                        </TableCell>
                        <TableCell>
                          <Badge variant={trade.outcome === 'UP' ? 'default' : 'secondary'}>
                            {trade.outcome}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">{trade.shares}</TableCell>
                        <TableCell className="text-right font-mono">
                          {(fillPrice * 100).toFixed(0)}¢
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          ${trade.total.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {trade.strike_price ? `$${trade.strike_price.toFixed(0)}` : '-'}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground" title={trade.reasoning || ''}>
                          {trade.reasoning || '-'}
                        </TableCell>
                        <TableCell>
                          {trade.result ? (
                            <Badge variant={trade.result === 'UP' ? 'default' : trade.result === 'DOWN' ? 'secondary' : 'outline'}>
                              {trade.result}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">pending</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {trade.profit_loss !== null ? (
                            <span className={trade.profit_loss >= 0 ? 'text-green-500' : 'text-red-500'}>
                              ${trade.profit_loss.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
