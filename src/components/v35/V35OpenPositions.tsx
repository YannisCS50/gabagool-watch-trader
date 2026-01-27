import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  TrendingUp, 
  TrendingDown, 
  Scale, 
  Clock,
  DollarSign
} from 'lucide-react';

interface MarketPosition {
  market_slug: string;
  up_qty: number;
  down_qty: number;
  up_cost: number;
  down_cost: number;
  paired: number;
  unpaired: number;
  combined_cost: number;
  locked_profit: number;
  fill_count: number;
  last_fill: string;
}

export function V35OpenPositions() {
  // Aggregate positions from fills
  const { data: positions, isLoading } = useQuery({
    queryKey: ['v35-open-positions'],
    queryFn: async () => {
      // Get aggregated fills per market and side
      const { data: fills, error } = await supabase
        .from('v35_fills')
        .select('market_slug, fill_type, price, size, created_at')
        .order('created_at', { ascending: false });

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
            down_qty: 0,
            up_cost: 0,
            down_cost: 0,
            paired: 0,
            unpaired: 0,
            combined_cost: 0,
            locked_profit: 0,
            fill_count: 0,
            last_fill: fill.created_at,
          });
        }

        const pos = marketMap.get(slug)!;
        pos.fill_count++;
        
        // Determine side from fill_type
        const isUp = fill.fill_type?.includes('UP');
        const isDown = fill.fill_type?.includes('DOWN');
        
        if (isUp) {
          pos.up_qty += Number(fill.size) || 0;
          pos.up_cost += (Number(fill.price) || 0) * (Number(fill.size) || 0);
        } else if (isDown) {
          pos.down_qty += Number(fill.size) || 0;
          pos.down_cost += (Number(fill.price) || 0) * (Number(fill.size) || 0);
        } else {
          // Fallback: try to split evenly or use a heuristic
          // For now, add to down since most fills alternate
          pos.down_qty += Number(fill.size) || 0;
          pos.down_cost += (Number(fill.price) || 0) * (Number(fill.size) || 0);
        }
      }

      // Calculate derived metrics
      for (const pos of marketMap.values()) {
        pos.paired = Math.min(pos.up_qty, pos.down_qty);
        pos.unpaired = Math.abs(pos.up_qty - pos.down_qty);
        
        const avgUp = pos.up_qty > 0 ? pos.up_cost / pos.up_qty : 0;
        const avgDown = pos.down_qty > 0 ? pos.down_cost / pos.down_qty : 0;
        
        pos.combined_cost = (pos.up_qty > 0 && pos.down_qty > 0) ? avgUp + avgDown : 0;
        pos.locked_profit = (pos.combined_cost > 0 && pos.combined_cost < 1.0)
          ? pos.paired * (1.0 - pos.combined_cost)
          : 0;
      }

      // Sort by most recent activity
      return Array.from(marketMap.values())
        .sort((a, b) => new Date(b.last_fill).getTime() - new Date(a.last_fill).getTime());
    },
    refetchInterval: 10000, // Refresh every 10s
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
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
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
          <CardDescription>Active market positions</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No open positions</p>
            <p className="text-xs">Positions will appear when fills are recorded</p>
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
          {positions.length} active market{positions.length !== 1 ? 's' : ''} • 
          Total Locked: ${positions.reduce((sum, p) => sum + p.locked_profit, 0).toFixed(2)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {positions.map((pos) => {
            const asset = pos.market_slug.split('-')[0].toUpperCase();
            const skew = pos.up_qty - pos.down_qty;
            const skewDirection = skew > 0 ? 'UP' : skew < 0 ? 'DOWN' : 'BALANCED';
            
            return (
              <div 
                key={pos.market_slug} 
                className="p-4 rounded-lg border border-border/50 bg-card/50 space-y-3"
              >
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono">
                      {asset}
                    </Badge>
                    <span className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {pos.market_slug.slice(-20)}
                    </span>
                  </div>
                  <Badge 
                    variant={pos.locked_profit > 0 ? "default" : "secondary"}
                    className={pos.locked_profit > 0 ? "bg-primary" : ""}
                  >
                    <DollarSign className="h-3 w-3 mr-1" />
                    {pos.locked_profit > 0 ? '+' : ''}${pos.locked_profit.toFixed(2)}
                  </Badge>
                </div>

                {/* Quantities */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    <div>
                      <p className="text-sm font-medium">{pos.up_qty.toFixed(1)} UP</p>
                      <p className="text-xs text-muted-foreground">
                        Avg: ${pos.up_qty > 0 ? (pos.up_cost / pos.up_qty).toFixed(3) : '0.000'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-destructive" />
                    <div>
                      <p className="text-sm font-medium">{pos.down_qty.toFixed(1)} DOWN</p>
                      <p className="text-xs text-muted-foreground">
                        Avg: ${pos.down_qty > 0 ? (pos.down_cost / pos.down_qty).toFixed(3) : '0.000'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Metrics */}
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-4">
                    <span>
                      <span className="text-muted-foreground">Paired:</span>{' '}
                      <span className="font-medium">{pos.paired.toFixed(1)}</span>
                    </span>
                    <span>
                      <span className="text-muted-foreground">Unpaired:</span>{' '}
                      <span className={`font-medium ${pos.unpaired > 50 ? 'text-warning' : ''}`}>
                        {pos.unpaired.toFixed(1)}
                      </span>
                    </span>
                    <span>
                      <span className="text-muted-foreground">CPP:</span>{' '}
                      <span className={`font-medium ${pos.combined_cost < 1 ? 'text-primary' : 'text-destructive'}`}>
                        ${pos.combined_cost.toFixed(3)}
                      </span>
                    </span>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {pos.fill_count} fills
                  </Badge>
                </div>

                {/* Skew indicator */}
                {pos.unpaired > 10 && (
                  <div className="text-xs text-muted-foreground">
                    ⚠️ Skewed {skewDirection} by {Math.abs(skew).toFixed(1)} shares
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
