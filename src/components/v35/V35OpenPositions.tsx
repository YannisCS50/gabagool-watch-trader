import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Scale, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface MarketPosition {
  market_slug: string;
  asset: string;
  polymarket_up_qty: number;
  polymarket_up_avg: number;
  polymarket_down_qty: number;
  polymarket_down_avg: number;
  fills_up_qty: number;
  fills_up_avg: number;
  fills_down_qty: number;
  fills_down_avg: number;
  up_qty_match: boolean;
  down_qty_match: boolean;
  paired: number;
  unpaired: number;
  combined_cost: number;
  locked_profit: number;
}

interface PositionsResponse {
  success: boolean;
  positions: MarketPosition[];
  summary: {
    total_markets: number;
    total_paired: number;
    total_unpaired: number;
    total_locked_profit: number;
    mismatched_markets: number;
  };
  polymarket_raw: number;
  fills_raw: number;
}

function parseMarketTime(slug: string): { start: string; end: string; isLive: boolean } | null {
  // Parse timestamp from slug like "eth-updown-15m-1769517000"
  const match = slug.match(/(\d{10})$/);
  if (!match) return null;
  
  const timestamp = parseInt(match[1]) * 1000;
  const startDate = new Date(timestamp);
  const endDate = new Date(timestamp + 15 * 60 * 1000); // +15 minutes
  const now = Date.now();
  
  const formatTime = (d: Date) => {
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
  };
  
  return {
    start: formatTime(startDate),
    end: formatTime(endDate),
    isLive: now >= timestamp && now < timestamp + 15 * 60 * 1000,
  };
}

export function V35OpenPositions() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<PositionsResponse>({
    queryKey: ['v35-polymarket-positions'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('v35-positions');
      if (error) throw error;
      return data as PositionsResponse;
    },
    refetchInterval: 10000, // Refresh every 10 seconds
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Live Positions (Polymarket)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Live Positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-destructive">
            Error loading positions: {String(error)}
          </div>
        </CardContent>
      </Card>
    );
  }

  const positions = data?.positions || [];
  const summary = data?.summary;

  // Filter only markets with actual positions
  const activePositions = positions.filter(p => 
    p.polymarket_up_qty > 0 || p.polymarket_down_qty > 0
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Scale className="h-5 w-5" />
              Live Positions (Polymarket)
            </CardTitle>
            <CardDescription>
              Real-time positions from Polymarket Data API
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {summary && summary.mismatched_markets > 0 && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {summary.mismatched_markets} Mismatched
              </Badge>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary Stats */}
        {summary && (
          <div className="grid grid-cols-4 gap-4 mb-6 p-4 bg-muted/50 rounded-lg">
            <div className="text-center">
              <div className="text-2xl font-bold">{summary.total_markets}</div>
              <div className="text-xs text-muted-foreground">Active Markets</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{summary.total_paired.toFixed(0)}</div>
              <div className="text-xs text-muted-foreground">Paired Shares</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{summary.total_unpaired.toFixed(0)}</div>
              <div className="text-xs text-muted-foreground">Unpaired</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                ${summary.total_locked_profit.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">Locked Profit</div>
            </div>
          </div>
        )}

        {/* Positions Table */}
        {activePositions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No active positions found
          </div>
        ) : (
          <div className="space-y-4">
            {activePositions.map((pos) => {
              const timeInfo = parseMarketTime(pos.market_slug);
              const hasMismatch = !pos.up_qty_match || !pos.down_qty_match;
              
              return (
                <div 
                  key={pos.market_slug} 
                  className={`p-4 border rounded-lg ${hasMismatch ? 'border-destructive/50 bg-destructive/5' : 'border-border'}`}
                >
                  {/* Market Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{pos.asset}</Badge>
                      {timeInfo && (
                        <span className="text-sm font-medium">
                          {timeInfo.start} - {timeInfo.end} UTC
                        </span>
                      )}
                      {timeInfo?.isLive && (
                        <Badge className="bg-primary animate-pulse">LIVE</Badge>
                      )}
                      {!timeInfo?.isLive && (
                        <Badge variant="secondary">EXPIRED</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {hasMismatch ? (
                        <Badge variant="destructive" className="flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Data Mismatch
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="flex items-center gap-1 text-primary border-primary/30">
                          <CheckCircle2 className="h-3 w-3" />
                          Synced
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Positions Grid - Polymarket Style */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* UP Position */}
                    <div className="p-3 bg-muted/30 rounded">
                      <div className="text-xs text-muted-foreground mb-1">UP (Yes)</div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <div className="font-bold">{pos.polymarket_up_qty.toFixed(2)}</div>
                          <div className="text-xs text-muted-foreground">QTY</div>
                        </div>
                        <div>
                          <div className="font-bold">{(pos.polymarket_up_avg * 100).toFixed(1)}¢</div>
                          <div className="text-xs text-muted-foreground">AVG</div>
                        </div>
                        <div>
                          <div className="font-bold">
                            ${(pos.polymarket_up_qty * pos.polymarket_up_avg).toFixed(2)}
                          </div>
                          <div className="text-xs text-muted-foreground">COST</div>
                        </div>
                      </div>
                    </div>

                    {/* DOWN Position */}
                    <div className="p-3 bg-muted/30 rounded">
                      <div className="text-xs text-muted-foreground mb-1">DOWN (No)</div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>
                          <div className="font-bold">{pos.polymarket_down_qty.toFixed(2)}</div>
                          <div className="text-xs text-muted-foreground">QTY</div>
                        </div>
                        <div>
                          <div className="font-bold">{(pos.polymarket_down_avg * 100).toFixed(1)}¢</div>
                          <div className="text-xs text-muted-foreground">AVG</div>
                        </div>
                        <div>
                          <div className="font-bold">
                            ${(pos.polymarket_down_qty * pos.polymarket_down_avg).toFixed(2)}
                          </div>
                          <div className="text-xs text-muted-foreground">COST</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Combined Stats */}
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50 text-sm">
                    <div className="flex gap-4">
                      <span>Paired: <strong>{pos.paired.toFixed(0)}</strong></span>
                      <span>Unpaired: <strong>{pos.unpaired.toFixed(0)}</strong></span>
                      <span>Combined: <strong>${pos.combined_cost.toFixed(3)}</strong></span>
                    </div>
                    <div className={`font-bold ${pos.locked_profit > 0 ? 'text-primary' : 'text-muted-foreground'}`}>
                      Locked: ${pos.locked_profit.toFixed(2)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
