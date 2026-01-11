import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Activity, RefreshCw, TrendingUp, TrendingDown, AlertTriangle, Target, Flame } from 'lucide-react';
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
}

export function LiveMarketMonitor() {
  const [markets, setMarkets] = useState<LiveMarketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchMarkets = useCallback(async () => {
    try {
      // Fetch live market data
      const { data, error } = await supabase.functions.invoke('clob-prices', {
        body: { assets: ['BTC', 'ETH', 'SOL', 'XRP'] }
      });

      if (error) {
        console.error('Failed to fetch markets:', error);
        return;
      }

      if (data?.markets) {
        const now = Date.now();
        const activeMarkets: LiveMarketRow[] = data.markets
          .filter((m: any) => new Date(m.eventEndTime).getTime() > now)
          .map((m: any) => {
            const spotPrice = data.spotPrices?.[m.asset] || 0;
            const deltaAbs = Math.abs(spotPrice - m.strikePrice);
            const deltaPct = m.strikePrice > 0 ? (deltaAbs / m.strikePrice) * 100 : 0;
            const timeRemaining = Math.max(0, (new Date(m.eventEndTime).getTime() - now) / 1000);
            
            const upMid = (m.upBid + m.upAsk) / 2 || m.upMid || 0.5;
            const downMid = (m.downBid + m.downAsk) / 2 || m.downMid || 0.5;
            
            // Calculate expected prices from spot
            const expectedUp = spotPrice > m.strikePrice ? 0.95 : 0.05;
            const expectedDown = spotPrice < m.strikePrice ? 0.95 : 0.05;
            
            const mispricingCents = Math.abs(upMid - expectedUp) * 100;
            const threshold = { BTC: 0.03, ETH: 0.04, SOL: 0.05, XRP: 0.06 }[m.asset] || 0.05;
            const mispricingPctThreshold = (mispricingCents / 100) / threshold * 100;
            
            const nearSignal = mispricingPctThreshold >= 60;
            const hotSignal = mispricingPctThreshold >= 85;

            return {
              asset: m.asset,
              marketId: m.id,
              timeRemaining,
              strikePrice: m.strikePrice,
              spotPrice,
              deltaAbs,
              deltaPct,
              stateScore: mispricingPctThreshold,
              expectedUp,
              expectedDown,
              upBid: m.upBid || 0,
              upAsk: m.upAsk || 0,
              downBid: m.downBid || 0,
              downAsk: m.downAsk || 0,
              spreadTicks: Math.round(((m.upAsk - m.upBid) + (m.downAsk - m.downBid)) / 2 * 100),
              mispricingCents,
              mispricingPctThreshold,
              nearSignal,
              hotSignal,
              blocked: false,
              blockReason: null,
            };
          })
          .sort((a: LiveMarketRow, b: LiveMarketRow) => a.timeRemaining - b.timeRemaining);

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
    const interval = setInterval(fetchMarkets, 5000);
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Live Market Monitor
          <Badge variant="outline" className="ml-2">{markets.length} active</Badge>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[400px]">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[70px]">Asset</TableHead>
                <TableHead className="w-[60px]">Time</TableHead>
                <TableHead className="text-right">Strike</TableHead>
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
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No active markets
                  </TableCell>
                </TableRow>
              )}
              {markets.map((m) => (
                <TableRow 
                  key={m.marketId}
                  className={cn(
                    m.blocked && "bg-red-500/5",
                    m.hotSignal && !m.blocked && "bg-orange-500/10",
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
                    ${m.strikePrice.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    ${m.spotPrice.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={m.spotPrice >= m.strikePrice ? 'text-green-400' : 'text-red-400'}>
                      {m.spotPrice >= m.strikePrice ? '+' : '-'}{m.deltaPct.toFixed(2)}%
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
                    {m.blocked ? (
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
