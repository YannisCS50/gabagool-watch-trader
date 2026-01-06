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

interface BotEvent {
  id: string;
  ts: number;
  event_type: string;
  asset: string;
  market_id: string | null;
  reason_code: string | null;
  data: unknown;
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
  
  return (
    <div className="glass rounded-lg p-3 space-y-2">
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

      {/* Orderbook Grid */}
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

      {/* Position Info */}
      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/50 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">UP Shares:</span>
          <span className={cn('font-mono font-bold', snapshot.up_shares > 0 ? 'text-success' : 'text-muted-foreground')}>
            {snapshot.up_shares.toFixed(1)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">DOWN Shares:</span>
          <span className={cn('font-mono font-bold', snapshot.down_shares > 0 ? 'text-destructive' : 'text-muted-foreground')}>
            {snapshot.down_shares.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Combined Metrics */}
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/50 text-xs">
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
      </div>

      {/* Spot/Strike */}
      {(snapshot.spot_price || snapshot.strike_price) && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
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

function getEventColor(eventType: string): string {
  if (eventType.includes('ORDER_ATTEMPT')) return 'text-blue-400';
  if (eventType.includes('ORDER_FAILED')) return 'text-destructive';
  if (eventType.includes('HEDGE')) return 'text-purple-400';
  if (eventType.includes('EMERGENCY')) return 'text-red-400';
  if (eventType.includes('GUARDRAIL')) return 'text-orange-400';
  if (eventType.includes('PAIRING')) return 'text-cyan-400';
  if (eventType.includes('SKIPPED')) return 'text-yellow-400';
  return 'text-muted-foreground';
}

function getEventIcon(eventType: string): string {
  if (eventType.includes('ORDER_ATTEMPT')) return '📤';
  if (eventType.includes('ORDER_FAILED')) return '❌';
  if (eventType.includes('HEDGE')) return '🛡️';
  if (eventType.includes('EMERGENCY')) return '🚨';
  if (eventType.includes('GUARDRAIL')) return '⚠️';
  if (eventType.includes('PAIRING')) return '🔗';
  if (eventType.includes('SKIPPED')) return '⏭️';
  if (eventType.includes('PNL')) return '💰';
  return '📋';
}

function BotEventRow({ event }: { event: BotEvent }) {
  const data = (typeof event.data === 'object' && event.data !== null) ? event.data as Record<string, unknown> : null;
  
  // Extract useful info from data
  let details = '';
  if (data) {
    if (data.side) details += `${data.side} `;
    if (data.qty) details += `${data.qty} shares `;
    if (data.price) details += `@ ${((data.price as number) * 100).toFixed(1)}¢ `;
    if (data.reason) details += `- ${data.reason}`;
    if (data.error) details += `- ${data.error}`;
  }
  if (event.reason_code && !details.includes(event.reason_code)) {
    details += event.reason_code;
  }
  
  return (
    <div className="flex items-start gap-2 text-xs py-1.5 border-b border-border/30 last:border-0">
      <span className="flex-shrink-0">{getEventIcon(event.event_type)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('font-medium', getEventColor(event.event_type))}>
            {event.event_type.replace(/_/g, ' ')}
          </span>
          <span className="text-muted-foreground">{event.asset}</span>
        </div>
        {details && (
          <div className="text-muted-foreground truncate">{details}</div>
        )}
      </div>
      <span className="text-muted-foreground flex-shrink-0">
        {format(new Date(event.created_at), 'HH:mm:ss', { locale: nl })}
      </span>
    </div>
  );
}

export function LiveBotDataFeed() {
  const [snapshots, setSnapshots] = useState<SnapshotLog[]>([]);
  const [fills, setFills] = useState<FillLog[]>([]);
  const [events, setEvents] = useState<BotEvent[]>([]);
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

      // Dedupe to get latest per asset, then sort by fixed order
      const ASSET_ORDER = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK'];
      const latestByAsset = new Map<string, SnapshotLog>();
      for (const s of snapshotData || []) {
        if (!latestByAsset.has(s.asset)) {
          latestByAsset.set(s.asset, s);
        }
      }
      // Sort by fixed asset order
      const sorted = Array.from(latestByAsset.values()).sort((a, b) => {
        const aIdx = ASSET_ORDER.indexOf(a.asset);
        const bIdx = ASSET_ORDER.indexOf(b.asset);
        const aOrder = aIdx === -1 ? 999 : aIdx;
        const bOrder = bIdx === -1 ? 999 : bIdx;
        return aOrder - bOrder;
      });
      setSnapshots(sorted);

      // Fetch recent fills
      const { data: fillData, error: fillError } = await supabase
        .from('fill_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(15);

      if (fillError) throw fillError;
      setFills(fillData || []);

      // Fetch recent bot events (order attempts, hedge decisions, etc.)
      const { data: eventData, error: eventError } = await supabase
        .from('bot_events')
        .select('id, ts, event_type, asset, market_id, reason_code, data, created_at')
        .in('event_type', [
          'ORDER_ATTEMPT', 'ORDER_FAILED', 'V73_HEDGE_DECISION', 
          'EMERGENCY_DECISION', 'GUARDRAIL_TRIGGERED', 'PAIRING_STARTED',
          'ACTION_SKIPPED', 'EMERGENCY_SELL', 'PNL_SNAPSHOT'
        ])
        .order('ts', { ascending: false })
        .limit(20);

      if (eventError) throw eventError;
      setEvents(eventData || []);

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
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bot_events' },
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
            {/* Info banner */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              <span>Dit toont de <strong>bot's view</strong> van de markt (orderbook data). Echte posities staan in "Open Positions" hieronder.</span>
            </div>

            {/* Market Books */}
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Live Orderbooks (Bot View)
              </h3>
              <div className="grid gap-3 md:grid-cols-2">
                {snapshots.map(snapshot => (
                  <MarketBookDisplay key={snapshot.id} snapshot={snapshot} />
                ))}
              </div>
            </div>

            {/* Side by Side: Recent Fills (50%) + Bot Events (50%) */}
            <div className="grid md:grid-cols-2 gap-4">
              {/* Recent Fills */}
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-success" />
                  Recent Fills ({fills.length})
                </h3>
                <div className="glass rounded-lg p-3 max-h-80 overflow-y-auto">
                  {fills.length > 0 ? (
                    fills.map(fill => (
                      <RecentFillRow key={fill.id} fill={fill} />
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      No recent fills
                    </div>
                  )}
                </div>
              </div>

              {/* Bot Events / Order Log */}
              <div>
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-blue-400" />
                  Bot Decisions & Orders ({events.length})
                </h3>
                <div className="glass rounded-lg p-3 max-h-80 overflow-y-auto">
                  {events.length > 0 ? (
                    events.map(event => (
                      <BotEventRow key={event.id} event={event} />
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground text-center py-4">
                      No recent events
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
