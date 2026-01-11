import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw, AlertTriangle, Target, Flame } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface LiveMarketRow {
  asset: string;
  marketId: string;
  timeRemaining: number;
  strikePrice: number;
  spotPrice: number;
  deltaAbs: number;
  deltaPct: number;
  stateScore: number;
  expectedUp: number;
  expectedDown: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  spreadTicks: number;
  mispricingCents: number;
  mispricingPctThreshold: number;
  nearSignal: boolean;
  hotSignal: boolean;
  blocked: boolean;
  blockReason: string | null;
  action: string;
  lastTs: number;
}

export function LiveMarketMonitor() {
  const [markets, setMarkets] = useState<LiveMarketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMarkets = useCallback(async () => {
    try {
      // Fetch recent v27_evaluations to show live market state
      const { data: evals, error } = await supabase
        .from('v27_evaluations')
        .select('*')
        .order('ts', { ascending: false })
        .limit(200);

      if (error) {
        console.error('Failed to fetch evaluations:', error);
        return;
      }

      if (evals && evals.length > 0) {
        // Group by market_id and take latest for each
        const marketMap = new Map<string, any>();
        for (const e of evals) {
          if (!marketMap.has(e.market_id) || marketMap.get(e.market_id).ts < e.ts) {
            marketMap.set(e.market_id, e);
          }
        }

        const now = Date.now();
        const activeMarkets: LiveMarketRow[] = Array.from(marketMap.values())
          .map((e) => {
            const spotPrice = Number(e.spot_price) || 0;
            const strikePrice = spotPrice; // Derive from market_id if needed
            const deltaAbs = Math.abs(Number(e.delta_up) || Number(e.delta_down) || 0);
            const deltaPct = deltaAbs * 100;
            
            const upBid = Number(e.pm_up_bid) || 0;
            const upAsk = Number(e.pm_up_ask) || 1;
            const downBid = Number(e.pm_down_bid) || 0;
            const downAsk = Number(e.pm_down_ask) || 1;
            
            const upMid = (upBid + upAsk) / 2;
            const downMid = (downBid + downAsk) / 2;
            
            // Expected from spot delta
            const expectedUp = Number(e.theoretical_up) || 0.5;
            const expectedDown = Number(e.theoretical_down) || 0.5;
            
            // mispricing_magnitude is already in decimal (e.g., 0.0325 = 3.25 cents)
            const mispricingDecimal = Number(e.mispricing_magnitude) || 0;
            const threshold = Number(e.dynamic_threshold) || Number(e.base_threshold) || 0.03;
            const mispricingPctThreshold = threshold > 0 ? (mispricingDecimal / threshold) * 100 : 0;
            
            const nearSignal = mispricingPctThreshold >= 60;
            const hotSignal = mispricingPctThreshold >= 85 || e.signal_valid;
            const blocked = e.adverse_blocked || false;
            
            // Extract time remaining from market_id (format: asset-updown-15m-timestamp)
            const parts = e.market_id.split('-');
            const endTs = parseInt(parts[parts.length - 1], 10) || 0;
            const timeRemaining = Math.max(0, (endTs * 1000 - now) / 1000);

            return {
              asset: e.asset,
              marketId: e.market_id,
              timeRemaining,
              strikePrice,
              spotPrice,
              deltaAbs,
              deltaPct,
              stateScore: mispricingPctThreshold,
              expectedUp,
              expectedDown,
              upBid,
              upAsk,
              downBid,
              downAsk,
              spreadTicks: Math.round(((upAsk - upBid) + (downAsk - downBid)) / 2 * 100),
              mispricingCents: mispricingDecimal * 100, // Convert decimal to cents (0.0325 -> 3.25¢)
              mispricingPctThreshold,
              nearSignal,
              hotSignal,
              blocked,
              blockReason: e.adverse_reason || e.skip_reason || null,
              action: e.action || 'SCAN',
              lastTs: e.ts,
            };
          })
          .filter((m) => m.timeRemaining > 0 || m.lastTs > now - 300000) // Recent or active
          .sort((a, b) => a.asset.localeCompare(b.asset) || a.marketId.localeCompare(b.marketId));

        setMarkets(activeMarkets);
      }
    } catch (err) {
      console.error('Error fetching markets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchMarkets();
    setRefreshing(false);
  };

  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 3000);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  const formatTime = (seconds: number) => {
    if (seconds <= 0) return 'Exp';
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          <span className="hidden xs:inline">Live Market Monitor</span>
          <span className="xs:hidden">Markets</span>
          <Badge variant="outline" className="ml-1 text-xs">{markets.length}</Badge>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing} className="h-8 w-8 p-0">
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {/* Mobile Card View */}
        <div className="block md:hidden">
          <ScrollArea className="h-[350px]">
            <div className="space-y-2 p-3">
              {markets.length === 0 && !loading && (
                <div className="text-center text-muted-foreground py-8 text-sm">
                  No active markets
                </div>
              )}
              {markets.map((m) => (
                <div
                  key={m.marketId}
                  className={cn(
                    "p-3 rounded-lg border",
                    m.blocked && "bg-red-500/10 border-red-500/30",
                    m.action === 'ENTRY' && "bg-green-500/10 border-green-500/30",
                    m.hotSignal && !m.blocked && m.action !== 'ENTRY' && "bg-orange-500/10 border-orange-500/30",
                    !m.blocked && !m.hotSignal && m.action !== 'ENTRY' && "bg-muted/20 border-border"
                  )}
                >
                  {/* Header: Asset, Status, Time */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono font-bold text-xs">
                        {m.asset}
                      </Badge>
                      {m.action === 'ENTRY' ? (
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                          ENTRY
                        </Badge>
                      ) : m.blocked ? (
                        <Badge variant="destructive" className="text-xs">Block</Badge>
                      ) : m.hotSignal ? (
                        <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
                          <Flame className="h-3 w-3 mr-0.5" />HOT
                        </Badge>
                      ) : m.nearSignal ? (
                        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">Near</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">Scan</Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatTime(m.timeRemaining)}
                    </span>
                  </div>
                  
                  {/* Price Info */}
                  <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                    <div>
                      <span className="text-muted-foreground">Spot: </span>
                      <span className="font-mono">${m.spotPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Δ: </span>
                      <span className={cn("font-mono", m.deltaPct > 0 ? 'text-green-400' : 'text-muted-foreground')}>
                        {m.deltaPct.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                  
                  {/* Bid/Ask */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">UP: </span>
                      <span className="font-mono text-green-400">{(m.upBid * 100).toFixed(0)}</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="font-mono text-green-400">{(m.upAsk * 100).toFixed(0)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">DN: </span>
                      <span className="font-mono text-red-400">{(m.downBid * 100).toFixed(0)}</span>
                      <span className="text-muted-foreground">/</span>
                      <span className="font-mono text-red-400">{(m.downAsk * 100).toFixed(0)}</span>
                    </div>
                  </div>
                  
                  {/* Mispricing */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50 text-xs">
                    <span className="text-muted-foreground">Mispricing</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{m.mispricingCents.toFixed(1)}¢</span>
                      <span className={cn(
                        "font-mono font-bold",
                        m.mispricingPctThreshold >= 100 && "text-green-400",
                        m.mispricingPctThreshold >= 85 && m.mispricingPctThreshold < 100 && "text-orange-400",
                        m.mispricingPctThreshold < 85 && "text-muted-foreground"
                      )}>
                        {m.mispricingPctThreshold.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[400px] hidden md:block">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[70px]">Asset</TableHead>
                <TableHead className="w-[60px]">Time</TableHead>
                <TableHead className="text-right">Spot</TableHead>
                <TableHead className="text-right">Δ%</TableHead>
                <TableHead className="text-right">UP bid/ask</TableHead>
                <TableHead className="text-right">DOWN bid/ask</TableHead>
                <TableHead className="text-right">Spread</TableHead>
                <TableHead className="text-right">Misp. ¢</TableHead>
                <TableHead className="text-right">% Thr</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {markets.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    No active markets - waiting for evaluations...
                  </TableCell>
                </TableRow>
              )}
              {markets.map((m) => (
                <TableRow 
                  key={m.marketId}
                  className={cn(
                    m.blocked && "bg-red-500/5",
                    m.action === 'ENTRY' && "bg-green-500/10",
                    m.hotSignal && !m.blocked && m.action !== 'ENTRY' && "bg-orange-500/10",
                    m.nearSignal && !m.hotSignal && !m.blocked && "bg-amber-500/5"
                  )}
                >
                  <TableCell>
                    <Badge variant="outline" className="font-mono font-bold">
                      {m.asset}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTime(m.timeRemaining)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    ${m.spotPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={m.deltaPct > 0 ? 'text-green-400' : 'text-muted-foreground'}>
                      {m.deltaPct.toFixed(2)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    <span className="text-green-400">{(m.upBid * 100).toFixed(1)}</span>
                    /
                    <span className="text-green-400">{(m.upAsk * 100).toFixed(1)}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    <span className="text-red-400">{(m.downBid * 100).toFixed(1)}</span>
                    /
                    <span className="text-red-400">{(m.downAsk * 100).toFixed(1)}</span>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {m.spreadTicks}t
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {m.mispricingCents.toFixed(1)}¢
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={cn(
                      "font-mono text-sm",
                      m.mispricingPctThreshold >= 100 && "text-green-400 font-bold",
                      m.mispricingPctThreshold >= 85 && m.mispricingPctThreshold < 100 && "text-orange-400",
                      m.mispricingPctThreshold >= 60 && m.mispricingPctThreshold < 85 && "text-amber-400",
                      m.mispricingPctThreshold < 60 && "text-muted-foreground"
                    )}>
                      {m.mispricingPctThreshold.toFixed(0)}%
                    </span>
                  </TableCell>
                  <TableCell>
                    {m.action === 'ENTRY' ? (
                      <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                        ENTRY
                      </Badge>
                    ) : m.blocked ? (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        Block
                      </Badge>
                    ) : m.hotSignal ? (
                      <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
                        <Flame className="h-3 w-3 mr-1" />
                        HOT
                      </Badge>
                    ) : m.nearSignal ? (
                      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
                        <Target className="h-3 w-3 mr-1" />
                        Near
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        Scan
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
