import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Scale, 
  Clock,
  TrendingUp,
  TrendingDown
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface MarketPosition {
  market_slug: string;
  up_qty: number;
  up_avg: number;
  up_cost: number;
  down_qty: number;
  down_avg: number;
  down_cost: number;
  total_fills: number;
  last_fill: string;
  expiry_ts: number;
}

// Parse market slug to get expiry timestamp
function parseMarketExpiry(slug: string): number {
  const match = slug.match(/(\d{10})$/);
  return match ? parseInt(match[1], 10) * 1000 : 0;
}

// Format expiry time
function formatExpiry(ts: number): string {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
}

export function V35OpenPositions() {
  const { data: positions, isLoading } = useQuery({
    queryKey: ['v35-open-positions'],
    queryFn: async () => {
      // Get aggregated positions per market and side
      const { data: fills, error } = await supabase
        .from('v35_fills')
        .select('market_slug, side, price, size, created_at');

      if (error) throw error;
      if (!fills || fills.length === 0) return [];

      // Aggregate by market
      const marketMap = new Map<string, MarketPosition>();

      for (const fill of fills) {
        const slug = fill.market_slug;
        if (!marketMap.has(slug)) {
          marketMap.set(slug, {
            market_slug: slug,
            up_qty: 0,
            up_avg: 0,
            up_cost: 0,
            down_qty: 0,
            down_avg: 0,
            down_cost: 0,
            total_fills: 0,
            last_fill: fill.created_at,
            expiry_ts: parseMarketExpiry(slug),
          });
        }

        const pos = marketMap.get(slug)!;
        pos.total_fills++;
        
        const size = Number(fill.size) || 0;
        const price = Number(fill.price) || 0;
        const cost = size * price;

        if (fill.side === 'UP') {
          pos.up_qty += size;
          pos.up_cost += cost;
        } else if (fill.side === 'DOWN') {
          pos.down_qty += size;
          pos.down_cost += cost;
        }

        // Track most recent fill
        if (fill.created_at > pos.last_fill) {
          pos.last_fill = fill.created_at;
        }
      }

      // Calculate averages
      for (const pos of marketMap.values()) {
        pos.up_avg = pos.up_qty > 0 ? pos.up_cost / pos.up_qty : 0;
        pos.down_avg = pos.down_qty > 0 ? pos.down_cost / pos.down_qty : 0;
      }

      // Sort by expiry (most recent first)
      return Array.from(marketMap.values())
        .sort((a, b) => b.expiry_ts - a.expiry_ts);
    },
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Open Positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Open Positions
          </CardTitle>
          <CardDescription>Per-market position breakdown</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No open positions</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-5 w-5" />
          Open Positions
        </CardTitle>
        <CardDescription>
          {positions.length} market{positions.length !== 1 ? 's' : ''} with positions
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {positions.map((pos) => {
          const now = Date.now();
          const isExpired = pos.expiry_ts < now;
          const isLive = !isExpired;
          
          // Calculate current value (assuming 0.99 mid for UP when market is up)
          const upValue = pos.up_qty * 0.99; // Approx current value
          const downValue = pos.down_qty * 0.01; // Approx current value
          
          return (
            <div key={pos.market_slug} className="border rounded-lg overflow-hidden">
              {/* Market Header */}
              <div className="bg-muted/50 px-4 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium">BTC</span>
                  <span className="text-muted-foreground">
                    {formatExpiry(pos.expiry_ts - 15 * 60 * 1000)}-{formatExpiry(pos.expiry_ts)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {isLive ? (
                    <Badge variant="default" className="bg-primary">
                      <span className="mr-1 h-2 w-2 rounded-full bg-white animate-pulse inline-block" />
                      LIVE
                    </Badge>
                  ) : (
                    <Badge variant="secondary">EXPIRED</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {pos.total_fills} fills
                  </span>
                </div>
              </div>
              
              {/* Positions Table */}
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-24">OUTCOME</TableHead>
                    <TableHead className="text-right">QTY</TableHead>
                    <TableHead className="text-right">AVG</TableHead>
                    <TableHead className="text-right">COST</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pos.up_qty > 0 && (
                    <TableRow>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-primary" />
                          <span className="text-primary font-medium">Up</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {pos.up_qty.toFixed(0)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {(pos.up_avg * 100).toFixed(0)}¢
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        ${pos.up_cost.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  )}
                  {pos.down_qty > 0 && (
                    <TableRow>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <TrendingDown className="h-4 w-4 text-destructive" />
                          <span className="text-destructive font-medium">Down</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {pos.down_qty.toFixed(0)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {(pos.down_avg * 100).toFixed(0)}¢
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        ${pos.down_cost.toFixed(2)}
                      </TableCell>
                    </TableRow>
                  )}
                  {pos.up_qty === 0 && pos.down_qty === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No positions
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
