import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  TrendingUp, 
  TrendingDown, 
  Clock,
  Activity,
  AlertTriangle,
  ShieldAlert,
  ShieldX,
  ArrowRightLeft
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface TimelineEntry {
  ts: number;
  iso: string;
  event_type: 'fill' | 'guard';
  side?: 'UP' | 'DOWN';
  price?: number;
  size?: number;
  guard_type?: string;
  up_qty: number;
  down_qty: number;
  unpaired: number;
  combined_cost?: number;
}

interface V35FillTimelineProps {
  marketSlug: string;
  asset: string;
}

export function V35FillTimeline({ marketSlug, asset }: V35FillTimelineProps) {
  // Fetch fills for this market
  const { data: fills, isLoading: fillsLoading } = useQuery({
    queryKey: ['v35-fills-timeline', marketSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v35_fills')
        .select('*')
        .eq('market_slug', marketSlug)
        .order('ts', { ascending: true });
      
      if (error) throw error;
      return data || [];
    },
  });

  // Fetch guard events for this market
  const { data: guardEvents, isLoading: guardsLoading } = useQuery({
    queryKey: ['v35-guard-events-timeline', marketSlug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bot_events')
        .select('*')
        .eq('event_type', 'guard')
        .ilike('data->>marketSlug', `%${marketSlug.split('-').pop()}%`)
        .order('ts', { ascending: true });
      
      if (error) throw error;
      return data || [];
    },
  });

  if (fillsLoading || guardsLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Fill Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    );
  }

  // Build timeline entries
  const timeline: TimelineEntry[] = [];
  let runningUpQty = 0;
  let runningDownQty = 0;
  let runningUpCost = 0;
  let runningDownCost = 0;

  // Process fills
  for (const fill of fills || []) {
    const side = fill.fill_type?.toUpperCase() as 'UP' | 'DOWN';
    const size = fill.size || 0;
    const price = fill.price || 0;
    const fillTs = new Date(fill.fill_ts || fill.created_at).getTime();

    if (side === 'UP') {
      runningUpQty += size;
      runningUpCost += size * price;
    } else if (side === 'DOWN') {
      runningDownQty += size;
      runningDownCost += size * price;
    }

    const paired = Math.min(runningUpQty, runningDownQty);
    const avgUp = runningUpQty > 0 ? runningUpCost / runningUpQty : 0;
    const avgDown = runningDownQty > 0 ? runningDownCost / runningDownQty : 0;
    const combinedCost = paired > 0 ? avgUp + avgDown : 0;

    timeline.push({
      ts: fillTs,
      iso: new Date(fillTs).toISOString(),
      event_type: 'fill',
      side,
      price,
      size,
      up_qty: runningUpQty,
      down_qty: runningDownQty,
      unpaired: Math.abs(runningUpQty - runningDownQty),
      combined_cost: combinedCost,
    });
  }

  // Add guard events
  for (const event of guardEvents || []) {
    const data = event.data as Record<string, unknown> | null;
    timeline.push({
      ts: event.ts,
      iso: new Date(event.ts).toISOString(),
      event_type: 'guard',
      guard_type: (data?.guardType as string) || 'UNKNOWN',
      up_qty: (data?.upQty as number) || 0,
      down_qty: (data?.downQty as number) || 0,
      unpaired: Math.abs(((data?.upQty as number) || 0) - ((data?.downQty as number) || 0)),
    });
  }

  // Sort by timestamp
  timeline.sort((a, b) => a.ts - b.ts);

  // Prepare chart data
  const chartData = timeline.map((entry, idx) => ({
    idx,
    time: new Date(entry.ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    up: entry.up_qty,
    down: entry.down_qty,
    unpaired: entry.unpaired,
    isGuard: entry.event_type === 'guard',
  }));

  const getGuardIcon = (guardType?: string) => {
    switch (guardType) {
      case 'CHEAP_SIDE_SKIP':
        return <ArrowRightLeft className="h-3.5 w-3.5 text-warning" />;
      case 'BURST_CAP':
        return <ShieldAlert className="h-3.5 w-3.5 text-warning" />;
      case 'EMERGENCY_STOP':
        return <ShieldX className="h-3.5 w-3.5 text-destructive" />;
      default:
        return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Chronologische Timeline
        </CardTitle>
        <CardDescription>
          Fills en guard events voor {asset} market
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Chart */}
        {chartData.length > 0 && (
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="upGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="downGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis 
                  dataKey="time" 
                  tick={{ fontSize: 10 }} 
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  tick={{ fontSize: 10 }} 
                  tickLine={false}
                  axisLine={false}
                  domain={[0, 'dataMax + 10']}
                />
                <Tooltip 
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const data = payload[0].payload;
                    return (
                      <div className="bg-popover border rounded-lg p-3 shadow-lg text-sm">
                        <div className="font-medium mb-1">{data.time}</div>
                        <div className="flex items-center gap-2 text-emerald-500">
                          <TrendingUp className="h-3 w-3" />
                          UP: {data.up.toFixed(1)}
                        </div>
                        <div className="flex items-center gap-2 text-rose-500">
                          <TrendingDown className="h-3 w-3" />
                          DOWN: {data.down.toFixed(1)}
                        </div>
                        <div className="flex items-center gap-2 text-warning mt-1 pt-1 border-t">
                          <AlertTriangle className="h-3 w-3" />
                          Unpaired: {data.unpaired.toFixed(1)}
                        </div>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={20} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Max 20', fontSize: 10, fill: '#ef4444' }} />
                <ReferenceLine y={15} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'Crit 15', fontSize: 10, fill: '#f59e0b' }} />
                <ReferenceLine y={10} stroke="#3b82f6" strokeDasharray="3 3" label={{ value: 'Warn 10', fontSize: 10, fill: '#3b82f6' }} />
                <Area 
                  type="stepAfter" 
                  dataKey="up" 
                  stroke="#10b981" 
                  fill="url(#upGradient)" 
                  strokeWidth={2}
                  name="UP"
                />
                <Area 
                  type="stepAfter" 
                  dataKey="down" 
                  stroke="#f43f5e" 
                  fill="url(#downGradient)" 
                  strokeWidth={2}
                  name="DOWN"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Table */}
        {timeline.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Geen events gevonden voor deze market</p>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Tijd</TableHead>
                  <TableHead className="w-[80px]">Type</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Prijs</TableHead>
                  <TableHead className="text-right">UP</TableHead>
                  <TableHead className="text-right">DOWN</TableHead>
                  <TableHead className="text-right">Unpaired</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeline.map((entry, idx) => (
                  <TableRow 
                    key={idx}
                    className={entry.event_type === 'guard' ? 'bg-warning/5' : ''}
                  >
                    <TableCell className="font-mono text-xs">
                      {new Date(entry.ts).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </TableCell>
                    <TableCell>
                      {entry.event_type === 'fill' ? (
                        <Badge 
                          variant="outline" 
                          className={entry.side === 'UP' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' : 'bg-rose-500/10 text-rose-500 border-rose-500/30'}
                        >
                          {entry.side === 'UP' ? (
                            <TrendingUp className="h-3 w-3 mr-1" />
                          ) : (
                            <TrendingDown className="h-3 w-3 mr-1" />
                          )}
                          {entry.side}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                          {getGuardIcon(entry.guard_type)}
                          <span className="ml-1">{entry.guard_type}</span>
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {entry.event_type === 'fill' ? entry.size?.toFixed(1) : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {entry.event_type === 'fill' ? `${((entry.price || 0) * 100).toFixed(1)}¢` : '-'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-emerald-500">
                      {entry.up_qty.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-rose-500">
                      {entry.down_qty.toFixed(1)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`font-mono font-bold ${
                        entry.unpaired >= 20 ? 'text-destructive' :
                        entry.unpaired >= 15 ? 'text-destructive' :
                        entry.unpaired >= 10 ? 'text-warning' : ''
                      }`}>
                        {entry.unpaired.toFixed(1)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
