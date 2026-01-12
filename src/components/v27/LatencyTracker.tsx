import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { RefreshCw, Zap, Clock, TrendingUp, Activity } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

interface LatencyEvent {
  id: string;
  signal_ts: number;
  order_ts: number | null;
  fill_ts: number | null;
  signal_to_order_ms: number | null;
  order_to_fill_ms: number | null;
  total_ms: number | null;
  asset: string;
  direction: string;
  status: string;
}

interface LatencyStats {
  avgSignalToOrder: number;
  avgOrderToFill: number;
  avgTotal: number;
  minTotal: number;
  maxTotal: number;
  p50Total: number;
  p95Total: number;
  count: number;
}

export function LatencyTracker() {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: latencyEvents, refetch, isLoading } = useQuery({
    queryKey: ['latency-events'],
    queryFn: async () => {
      // Get paper signals with fill data
      const { data: signals, error: signalsError } = await supabase
        .from('paper_signals')
        .select('*')
        .not('fill_ts', 'is', null)
        .order('signal_ts', { ascending: false })
        .limit(100);

      if (signalsError) throw signalsError;

      // Also get fill_logs for real trades
      const { data: fills, error: fillsError } = await supabase
        .from('fill_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(100);

      if (fillsError) throw fillsError;

      const events: LatencyEvent[] = [];

      // Process paper signals
      if (signals) {
        for (const sig of signals) {
          const signalTs = sig.signal_ts;
          const fillTs = sig.fill_ts;
          
          if (signalTs && fillTs) {
            const totalMs = fillTs - signalTs;
            events.push({
              id: sig.id,
              signal_ts: signalTs,
              order_ts: null, // Paper trades don't have separate order timestamp
              fill_ts: fillTs,
              signal_to_order_ms: null,
              order_to_fill_ms: null,
              total_ms: totalMs,
              asset: sig.asset || 'unknown',
              direction: sig.direction || 'unknown',
              status: sig.status || 'unknown',
            });
          }
        }
      }

      // Process real fills
      if (fills) {
        for (const fill of fills) {
          // fill_logs has ts as the fill timestamp
          // We don't have signal_ts directly, but we can use created_at vs ts
          const createdAt = new Date(fill.created_at).getTime();
          const fillTs = fill.ts;
          
          if (createdAt && fillTs) {
            const totalMs = fillTs - createdAt;
            // Only include reasonable latencies (< 60 seconds)
            if (totalMs > 0 && totalMs < 60000) {
              events.push({
                id: fill.id,
                signal_ts: createdAt,
                order_ts: null,
                fill_ts: fillTs,
                signal_to_order_ms: null,
                order_to_fill_ms: null,
                total_ms: totalMs,
                asset: fill.asset || 'unknown',
                direction: fill.side || 'unknown',
                status: 'filled',
              });
            }
          }
        }
      }

      return events.sort((a, b) => b.signal_ts - a.signal_ts);
    },
    refetchInterval: 5000,
  });

  const stats = useMemo<LatencyStats | null>(() => {
    if (!latencyEvents || latencyEvents.length === 0) return null;

    const validEvents = latencyEvents.filter(e => e.total_ms !== null && e.total_ms > 0);
    if (validEvents.length === 0) return null;

    const totals = validEvents.map(e => e.total_ms!).sort((a, b) => a - b);
    
    const sum = totals.reduce((a, b) => a + b, 0);
    const avg = sum / totals.length;
    const min = totals[0];
    const max = totals[totals.length - 1];
    const p50 = totals[Math.floor(totals.length * 0.5)];
    const p95 = totals[Math.floor(totals.length * 0.95)] || max;

    return {
      avgSignalToOrder: 0,
      avgOrderToFill: 0,
      avgTotal: avg,
      minTotal: min,
      maxTotal: max,
      p50Total: p50,
      p95Total: p95,
      count: validEvents.length,
    };
  }, [latencyEvents]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refetch();
    setIsRefreshing(false);
  };

  const formatMs = (ms: number | null) => {
    if (ms === null) return '-';
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getLatencyColor = (ms: number | null) => {
    if (ms === null) return 'text-muted-foreground';
    if (ms < 500) return 'text-green-400';
    if (ms < 1500) return 'text-yellow-400';
    if (ms < 3000) return 'text-orange-400';
    return 'text-red-400';
  };

  const getLatencyBadge = (ms: number | null) => {
    if (ms === null) return 'secondary';
    if (ms < 500) return 'default';
    if (ms < 1500) return 'secondary';
    return 'destructive';
  };

  return (
    <div className="space-y-4">
      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card/50 border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Zap className="h-3 w-3" />
              <span>Avg Latency</span>
            </div>
            <div className={`text-2xl font-mono font-bold ${getLatencyColor(stats?.avgTotal ?? null)}`}>
              {formatMs(stats?.avgTotal ?? null)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <TrendingUp className="h-3 w-3" />
              <span>P50 (Median)</span>
            </div>
            <div className={`text-2xl font-mono font-bold ${getLatencyColor(stats?.p50Total ?? null)}`}>
              {formatMs(stats?.p50Total ?? null)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Activity className="h-3 w-3" />
              <span>P95</span>
            </div>
            <div className={`text-2xl font-mono font-bold ${getLatencyColor(stats?.p95Total ?? null)}`}>
              {formatMs(stats?.p95Total ?? null)}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/50">
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3" />
              <span>Min / Max</span>
            </div>
            <div className="text-lg font-mono font-bold text-foreground">
              {formatMs(stats?.minTotal ?? null)} / {formatMs(stats?.maxTotal ?? null)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Events */}
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">
            Recent Latency Events ({stats?.count ?? 0} measured)
          </CardTitle>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={handleRefresh}
            disabled={isRefreshing || isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {isLoading ? (
              <div className="text-center text-muted-foreground py-4">Loading...</div>
            ) : latencyEvents && latencyEvents.length > 0 ? (
              latencyEvents.slice(0, 20).map((event) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between p-2 rounded bg-background/50 border border-border/30"
                >
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs">
                      {event.asset}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {event.direction === 'UP' ? '🟢' : '🔴'} {event.direction}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(event.signal_ts).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={getLatencyBadge(event.total_ms) as any}>
                      <Zap className="h-3 w-3 mr-1" />
                      {formatMs(event.total_ms)}
                    </Badge>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center text-muted-foreground py-4">
                No latency data yet. Run the bot to collect measurements.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Interpretation */}
      <Card className="bg-card/50 border-border/50">
        <CardContent className="pt-4">
          <h4 className="font-medium mb-2">📊 Latency Interpretatie</h4>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>• <span className="text-green-400">{"<"}500ms</span> = Uitstekend - sneller dan market makers</p>
            <p>• <span className="text-yellow-400">500-1500ms</span> = Goed - competitief voor arbitrage</p>
            <p>• <span className="text-orange-400">1500-3000ms</span> = Matig - mogelijk te laat voor snelle moves</p>
            <p>• <span className="text-red-400">{">"}3000ms</span> = Traag - markt kan al gecorrigeerd zijn</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
