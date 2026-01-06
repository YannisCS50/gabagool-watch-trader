import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, TrendingUp, TrendingDown, Activity, Zap, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface SnapshotLog {
  id: string;
  ts: number;
  iso: string;
  asset: string;
  market_id: string;
  seconds_remaining: number;
  bot_state: string;
  up_bid: number | null;
  up_ask: number | null;
  up_mid: number | null;
  down_bid: number | null;
  down_ask: number | null;
  down_mid: number | null;
  combined_mid: number | null;
  combined_ask: number | null;
  delta: number | null;
  skew: number | null;
  up_shares: number;
  down_shares: number;
  pair_cost: number | null;
  spread_up: number | null;
  spread_down: number | null;
  spot_price: number | null;
  strike_price: number | null;
  reason_code: string | null;
  created_at: string;
}

interface FillLog {
  id: string;
  ts: number;
  iso: string;
  asset: string;
  market_id: string;
  side: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  intent: string;
  seconds_remaining: number;
  spot_price: number | null;
  strike_price: number | null;
  delta: number | null;
  created_at: string;
}

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return '—';
  return `${(price * 100).toFixed(1)}¢`;
}

function formatDelta(delta: number | null | undefined): string {
  if (delta === null || delta === undefined) return '—';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(2)}%`;
}

function getStateColor(state: string): string {
  switch (state?.toUpperCase()) {
    case 'FLAT': return 'bg-muted text-muted-foreground';
    case 'ONE_SIDED': return 'bg-yellow-500/20 text-yellow-500';
    case 'ONE_SIDED_UP': return 'bg-green-500/20 text-green-500';
    case 'ONE_SIDED_DOWN': return 'bg-red-500/20 text-red-500';
    case 'PAIRING': return 'bg-blue-500/20 text-blue-500';
    case 'PAIRED': return 'bg-success/20 text-success';
    case 'HEDGED': return 'bg-success/20 text-success';
    case 'SKEWED': return 'bg-orange-500/20 text-orange-500';
    case 'DEEP_DISLOCATION': return 'bg-destructive/20 text-destructive';
    case 'UNWIND': return 'bg-purple-500/20 text-purple-500';
    default: return 'bg-muted text-muted-foreground';
  }
}

function MarketBookDisplay({ snapshot }: { snapshot: SnapshotLog }) {
  const combinedAsk = snapshot.combined_ask ?? ((snapshot.up_ask ?? 0) + (snapshot.down_ask ?? 0));
  const edge = 1 - combinedAsk;
  const edgePercent = (edge * 100).toFixed(2);
  const hasEdge = edge > 0.015; // 1.5% minimum edge
  
  const totalShares = snapshot.up_shares + snapshot.down_shares;
  const pairedShares = Math.min(snapshot.up_shares, snapshot.down_shares);
  const unpairedShares = Math.abs(snapshot.up_shares - snapshot.down_shares);
  const isHedged = pairedShares > 0 && unpairedShares < pairedShares;
  
  // Calculate avg prices from pair_cost if available
  const upAvg = snapshot.up_shares > 0 ? (snapshot.up_mid ?? 0.5) : 0;
  const downAvg = snapshot.down_shares > 0 ? (snapshot.down_mid ?? 0.5) : 0;
  
  return (
    <div className="glass rounded-lg p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm">{snapshot.asset}</span>
          <Badge variant="outline" className={cn('text-xs', getStateColor(snapshot.bot_state))}>
            {snapshot.bot_state}
          </Badge>
          {snapshot.seconds_remaining <= 60 && (
            <Badge variant="outline" className="text-xs bg-red-500/10 text-red-500 border-red-500/20">
              <Clock className="h-3 w-3 mr-1" />
              {snapshot.seconds_remaining}s
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {format(new Date(snapshot.iso), 'HH:mm:ss', { locale: nl })}
        </span>
      </div>

      {/* Position Summary - NEW PROMINENT SECTION */}
      {totalShares > 0 && (
        <div className="bg-primary/5 rounded-lg p-3 border border-primary/20">
          <div className="grid grid-cols-2 gap-4">
            {/* UP Position */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-success font-semibold text-sm">
                <TrendingUp className="h-4 w-4" />
                UP Position
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono">{snapshot.up_shares}</span>
                <span className="text-sm text-muted-foreground">shares</span>
              </div>
              <div className="text-sm text-muted-foreground">
                avg: <span className="font-mono text-foreground">{formatPrice(upAvg)}</span>
                <span className="mx-1">•</span>
                ask: <span className="font-mono text-foreground">{formatPrice(snapshot.up_ask)}</span>
              </div>
            </div>

            {/* DOWN Position */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-destructive font-semibold text-sm">
                <TrendingDown className="h-4 w-4" />
                DOWN Position
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono">{snapshot.down_shares}</span>
                <span className="text-sm text-muted-foreground">shares</span>
              </div>
              <div className="text-sm text-muted-foreground">
                avg: <span className="font-mono text-foreground">{formatPrice(downAvg)}</span>
                <span className="mx-1">•</span>
                ask: <span className="font-mono text-foreground">{formatPrice(snapshot.down_ask)}</span>
              </div>
            </div>
          </div>

          {/* Paired / Unpaired summary */}
          <div className="flex items-center justify-between mt-3 pt-2 border-t border-primary/20 text-sm">
            <div className="flex items-center gap-4">
              <span>
                <span className="text-muted-foreground">Paired:</span>{' '}
                <span className={cn('font-mono font-bold', isHedged ? 'text-success' : 'text-muted-foreground')}>
                  {pairedShares}
                </span>
              </span>
              <span>
                <span className="text-muted-foreground">Unpaired:</span>{' '}
                <span className={cn('font-mono font-bold', unpairedShares > 0 ? 'text-warning' : 'text-muted-foreground')}>
                  {unpairedShares}
                </span>
              </span>
            </div>
            {snapshot.pair_cost && (
              <span>
                <span className="text-muted-foreground">Cost/Pair:</span>{' '}
                <span className={cn('font-mono font-bold', snapshot.pair_cost < 1 ? 'text-success' : 'text-destructive')}>
                  {(snapshot.pair_cost * 100).toFixed(1)}¢
                </span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Orderbook Grid - Compact when position exists */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        {/* UP Side */}
        <div className="space-y-1">
          <div className="flex items-center gap-1 font-semibold text-success">
            <TrendingUp className="h-3 w-3" />
            UP Book
          </div>
          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
            <span>Bid:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.up_bid)}</span>
            <span>Ask:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.up_ask)}</span>
            <span>Spread:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.spread_up)}</span>
          </div>
        </div>

        {/* DOWN Side */}
        <div className="space-y-1">
          <div className="flex items-center gap-1 font-semibold text-destructive">
            <TrendingDown className="h-3 w-3" />
            DOWN Book
          </div>
          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
            <span>Bid:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.down_bid)}</span>
            <span>Ask:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.down_ask)}</span>
            <span>Spread:</span>
            <span className="font-mono text-foreground">{formatPrice(snapshot.spread_down)}</span>
          </div>
        </div>
      </div>

      {/* Combined Metrics */}
      <div className="grid grid-cols-4 gap-2 pt-2 border-t border-border/50 text-xs">
        <div>
          <div className="text-muted-foreground">Combined</div>
          <div className={cn('font-mono font-bold', combinedAsk < 1 ? 'text-success' : 'text-destructive')}>
            {formatPrice(combinedAsk)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Edge</div>
          <div className={cn('font-mono font-bold', hasEdge ? 'text-success' : 'text-muted-foreground')}>
            {edgePercent}%
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Delta</div>
          <div className={cn('font-mono', 
            (snapshot.delta ?? 0) > 0 ? 'text-success' : 
            (snapshot.delta ?? 0) < 0 ? 'text-destructive' : 'text-muted-foreground'
          )}>
            {formatDelta(snapshot.delta)}
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Pair Cost</div>
          <div className={cn('font-mono', 
            (snapshot.pair_cost ?? 1) < 1 ? 'text-success' : 'text-destructive'
          )}>
            {snapshot.pair_cost ? `${(snapshot.pair_cost * 100).toFixed(1)}¢` : '—'}
          </div>
        </div>
      </div>

      {/* Spot/Strike */}
      {(snapshot.spot_price || snapshot.strike_price) && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
          <span>Spot: ${snapshot.spot_price?.toLocaleString() ?? '—'}</span>
          <span>Strike: ${snapshot.strike_price?.toLocaleString() ?? '—'}</span>
        </div>
      )}

      {/* Reason Code */}
      {snapshot.reason_code && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <AlertTriangle className="h-3 w-3" />
          {snapshot.reason_code}
        </div>
      )}
    </div>
  );
}

function RecentFillRow({ fill }: { fill: FillLog }) {
  const isUp = fill.side?.toUpperCase() === 'UP' || fill.side?.toUpperCase() === 'BUY';
  
  return (
    <div className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn('text-xs', isUp ? 'text-success' : 'text-destructive')}>
          {isUp ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
          {fill.side}
        </Badge>
        <span className="font-medium">{fill.asset}</span>
        <Badge variant="outline" className="text-xs">{fill.intent}</Badge>
      </div>
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="font-mono">{fill.fill_qty.toFixed(1)} @ {formatPrice(fill.fill_price)}</span>
        <span>${fill.fill_notional.toFixed(2)}</span>
        <span>{format(new Date(fill.iso), 'HH:mm:ss', { locale: nl })}</span>
      </div>
    </div>
  );
}

export function LiveBotDataFeed() {
  const [snapshots, setSnapshots] = useState<SnapshotLog[]>([]);
  const [fills, setFills] = useState<FillLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchData = async () => {
    try {
      // Fetch latest snapshots (1 per asset, most recent)
      const { data: snapshotData, error: snapshotError } = await supabase
        .from('snapshot_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(20);

      if (snapshotError) throw snapshotError;

      // Dedupe to get latest per asset
      const latestByAsset = new Map<string, SnapshotLog>();
      for (const s of snapshotData || []) {
        if (!latestByAsset.has(s.asset)) {
          latestByAsset.set(s.asset, s);
        }
      }
      setSnapshots(Array.from(latestByAsset.values()));

      // Fetch recent fills
      const { data: fillData, error: fillError } = await supabase
        .from('fill_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(10);

      if (fillError) throw fillError;
      setFills(fillData || []);

      setLastUpdate(new Date());
    } catch (err) {
      console.error('Error fetching bot data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('live_bot_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'snapshot_logs' },
        () => fetchData()
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fill_logs' },
        () => fetchData()
      )
      .subscribe();

    // Also poll every 5s as backup
    const interval = setInterval(fetchData, 5000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const oldestSnapshot = snapshots.length > 0 
    ? Math.max(...snapshots.map(s => Date.now() - new Date(s.iso).getTime()))
    : null;
  const isStale = oldestSnapshot !== null && oldestSnapshot > 30000; // >30s old

  return (
    <Card className="glass">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Live Bot Data Feed
          {!isStale && snapshots.length > 0 && (
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
          )}
          {isStale && (
            <Badge variant="outline" className="text-xs bg-yellow-500/10 text-yellow-500">
              Stale
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {lastUpdate && (
            <span>
              Updated {formatDistanceToNow(lastUpdate, { addSuffix: true })}
            </span>
          )}
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && snapshots.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading bot data...
          </div>
        ) : snapshots.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <AlertTriangle className="h-6 w-6 mx-auto mb-2" />
            No active market data. Is the runner online?
          </div>
        ) : (
          <>
            {/* Market Books */}
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Live Orderbooks
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {snapshots.map(snapshot => (
                  <MarketBookDisplay key={snapshot.id} snapshot={snapshot} />
                ))}
              </div>
            </div>

            {/* Recent Fills */}
            {fills.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-success" />
                  Recent Fills
                </h3>
                <div className="glass rounded-lg p-3">
                  {fills.map(fill => (
                    <RecentFillRow key={fill.id} fill={fill} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
