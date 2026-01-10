import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell, LineChart, Line, ComposedChart } from 'recharts';
import { format, subHours, startOfHour } from 'date-fns';
import { TrendingUp, TrendingDown, Loader2, RefreshCw, Camera } from "lucide-react";
import { useMemo } from "react";

interface TruePnLModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SnapshotData {
  hour: string;
  hourLabel: string;
  truePnl: number;
  portfolioValue: number;
  clobBalance: number;
  openOrdersValue: number;
  runningBetsValue: number;
  hourlyChange: number;
}

interface BotPnLData {
  hour: string;
  hourLabel: string;
  botPnl: number;
  trades: number;
  volume: number;
}

export function TruePnLModal({ open, onOpenChange }: TruePnLModalProps) {
  const queryClient = useQueryClient();

  // Fetch True P&L snapshots
  const { data: snapshotData, isLoading: snapshotsLoading } = useQuery<SnapshotData[]>({
    queryKey: ["true-pnl-snapshots"],
    queryFn: async () => {
      const twentyFourHoursAgo = subHours(new Date(), 24).toISOString();
      
      const { data: snapshots } = await supabase
        .from("true_pnl_snapshots")
        .select("*")
        .gte("hour", twentyFourHoursAgo)
        .order("hour", { ascending: true });

      if (!snapshots || snapshots.length === 0) {
        return [];
      }

      // Calculate hourly changes
      return snapshots.map((s, i) => {
        const prevPnl = i > 0 ? Number(snapshots[i - 1].true_pnl) : Number(s.true_pnl);
        return {
          hour: s.hour,
          hourLabel: format(new Date(s.hour), 'HH:mm'),
          truePnl: Number(s.true_pnl),
          portfolioValue: Number(s.portfolio_value),
          clobBalance: Number(s.clob_balance),
          openOrdersValue: Number(s.open_orders_value),
          runningBetsValue: Number(s.running_bets_value),
          hourlyChange: Number(s.true_pnl) - prevPnl,
        };
      });
    },
    refetchInterval: 60000,
    enabled: open,
  });

  // Fetch bot P&L from settled trades
  const { data: botPnlData, isLoading: botLoading } = useQuery<BotPnLData[]>({
    queryKey: ["hourly-bot-pnl"],
    queryFn: async () => {
      const now = new Date();
      const hoursToShow = 24;

      // Initialize empty buckets
      const buckets = new Map<string, BotPnLData>();
      for (let i = hoursToShow - 1; i >= 0; i--) {
        const hourStart = startOfHour(subHours(now, i));
        const key = hourStart.toISOString();
        buckets.set(key, {
          hour: key,
          hourLabel: format(hourStart, 'HH:mm'),
          botPnl: 0,
          trades: 0,
          volume: 0,
        });
      }

      // Fetch settled trades
      const twentyFourHoursAgo = subHours(now, 24).toISOString();
      const { data: trades } = await supabase
        .from("v26_trades")
        .select("settled_at, pnl, notional")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .gte("settled_at", twentyFourHoursAgo);

      if (trades) {
        for (const trade of trades) {
          const tradeHour = startOfHour(new Date(trade.settled_at));
          const key = tradeHour.toISOString();
          const bucket = buckets.get(key);
          if (bucket) {
            bucket.botPnl += Number(trade.pnl) || 0;
            bucket.trades += 1;
            bucket.volume += Number(trade.notional) || 0;
          }
        }
      }

      return Array.from(buckets.values());
    },
    refetchInterval: 60000,
    enabled: open,
  });

  // Mutation to trigger snapshot
  const snapshotMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('true-pnl-snapshot');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["true-pnl-snapshots"] });
    },
  });

  // Combine data for comparison chart
  const combinedData = useMemo(() => {
    if (!snapshotData || !botPnlData) return [];

    // Create a map of bot P&L by hour
    const botMap = new Map(botPnlData.map(b => [b.hourLabel, b]));

    return snapshotData.map(s => ({
      hourLabel: s.hourLabel,
      truePnlChange: s.hourlyChange,
      botPnl: botMap.get(s.hourLabel)?.botPnl || 0,
      trades: botMap.get(s.hourLabel)?.trades || 0,
      volume: botMap.get(s.hourLabel)?.volume || 0,
      cumulativeTruePnl: s.truePnl,
    }));
  }, [snapshotData, botPnlData]);

  const summary = useMemo(() => {
    if (!snapshotData || snapshotData.length === 0) return null;

    const latest = snapshotData[snapshotData.length - 1];
    const first = snapshotData[0];
    const totalChange = latest.truePnl - first.truePnl;
    
    const hourlyChanges = snapshotData.filter(s => s.hourlyChange !== 0);
    const profitableHours = hourlyChanges.filter(s => s.hourlyChange > 0).length;
    const losingHours = hourlyChanges.filter(s => s.hourlyChange < 0).length;
    
    const bestHour = hourlyChanges.reduce((best, s) => s.hourlyChange > best.hourlyChange ? s : best, { hourlyChange: -Infinity, hourLabel: '-' } as SnapshotData);
    const worstHour = hourlyChanges.reduce((worst, s) => s.hourlyChange < worst.hourlyChange ? s : worst, { hourlyChange: Infinity, hourLabel: '-' } as SnapshotData);

    const totalBotPnl = botPnlData?.reduce((sum, b) => sum + b.botPnl, 0) || 0;

    return {
      currentTruePnl: latest.truePnl,
      totalChange,
      profitableHours,
      losingHours,
      bestHour: bestHour.hourlyChange !== -Infinity ? bestHour : null,
      worstHour: worstHour.hourlyChange !== Infinity ? worstHour : null,
      snapshotCount: snapshotData.length,
      totalBotPnl,
    };
  }, [snapshotData, botPnlData]);

  const isLoading = snapshotsLoading || botLoading;
  const hasSnapshots = snapshotData && snapshotData.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              Hourly P&L Comparison (Last 24h)
              {summary && (
                <span className={`flex items-center gap-1 text-lg ${summary.currentTruePnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {summary.currentTruePnl >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                  {summary.currentTruePnl >= 0 ? '+' : ''}${summary.currentTruePnl.toFixed(2)}
                </span>
              )}
            </DialogTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => snapshotMutation.mutate()}
              disabled={snapshotMutation.isPending}
            >
              {snapshotMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Camera className="h-4 w-4 mr-2" />
              )}
              Snapshot Now
            </Button>
          </div>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : !hasSnapshots ? (
          <div className="flex flex-col items-center justify-center h-64 gap-4">
            <p className="text-muted-foreground text-center">
              No hourly snapshots yet. Click "Snapshot Now" to create the first one,<br />
              or wait for automatic hourly snapshots.
            </p>
            <Button onClick={() => snapshotMutation.mutate()} disabled={snapshotMutation.isPending}>
              {snapshotMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Camera className="h-4 w-4 mr-2" />
              )}
              Create First Snapshot
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Stats */}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">24h True P&L Change</div>
                  <div className={`text-lg font-semibold ${summary.totalChange >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {summary.totalChange >= 0 ? '+' : ''}${summary.totalChange.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">24h Bot Realized P&L</div>
                  <div className={`text-lg font-semibold ${summary.totalBotPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {summary.totalBotPnl >= 0 ? '+' : ''}${summary.totalBotPnl.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Profitable / Losing Hours</div>
                  <div className="text-lg font-semibold">
                    <span className="text-green-500">{summary.profitableHours}</span>
                    {' / '}
                    <span className="text-red-500">{summary.losingHours}</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Snapshots</div>
                  <div className="text-lg font-semibold">{summary.snapshotCount}</div>
                </div>
              </div>
            )}

            {/* Best/Worst Hours */}
            {summary && (summary.bestHour || summary.worstHour) && (
              <div className="flex flex-wrap gap-4 text-sm">
                {summary.bestHour && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Best Hour:</span>
                    <span className="text-green-500 font-medium">
                      {summary.bestHour.hourLabel} (+${summary.bestHour.hourlyChange.toFixed(2)})
                    </span>
                  </div>
                )}
                {summary.worstHour && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Worst Hour:</span>
                    <span className="text-red-500 font-medium">
                      {summary.worstHour.hourLabel} (${summary.worstHour.hourlyChange.toFixed(2)})
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Comparison Chart - Hourly Changes */}
            <div>
              <h4 className="text-sm font-medium mb-2">Hourly P&L Changes: True P&L vs Bot Realized</h4>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={combinedData} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
                    <XAxis 
                      dataKey="hourLabel" 
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval={2}
                    />
                    <YAxis 
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v}`}
                    />
                    <Tooltip 
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const data = payload[0].payload;
                        return (
                          <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg">
                            <p className="font-medium mb-2">{label}</p>
                            <div className="space-y-1">
                              <p className={data.truePnlChange >= 0 ? 'text-blue-500' : 'text-blue-400'}>
                                True P&L Δ: {data.truePnlChange >= 0 ? '+' : ''}${data.truePnlChange.toFixed(2)}
                              </p>
                              <p className={data.botPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                                Bot Realized: {data.botPnl >= 0 ? '+' : ''}${data.botPnl.toFixed(2)}
                              </p>
                              <p className="text-muted-foreground">
                                {data.trades} trades · ${data.volume.toFixed(0)} volume
                              </p>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Bar dataKey="truePnlChange" name="True P&L Δ" fill="hsl(217, 91%, 60%)" radius={[3, 3, 0, 0]} opacity={0.7} />
                    <Bar dataKey="botPnl" name="Bot Realized" radius={[3, 3, 0, 0]}>
                      {combinedData?.map((entry, index) => (
                        <Cell 
                          key={`cell-${index}`} 
                          fill={entry.botPnl >= 0 ? 'hsl(142, 70%, 45%)' : 'hsl(0, 70%, 50%)'}
                          fillOpacity={entry.trades > 0 ? 0.85 : 0.15}
                        />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Cumulative True P&L Line Chart */}
            <div>
              <h4 className="text-sm font-medium mb-2">Cumulative True P&L Over Time</h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={combinedData} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
                    <XAxis 
                      dataKey="hourLabel" 
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      interval={2}
                    />
                    <YAxis 
                      tick={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v}`}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value.toFixed(2)}`, 'True P&L']}
                      labelFormatter={(label) => `Hour: ${label}`}
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Line 
                      type="monotone" 
                      dataKey="cumulativeTruePnl" 
                      stroke="hsl(217, 91%, 60%)" 
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Hourly Breakdown Table */}
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left py-2 px-2 font-medium">Hour</th>
                    <th className="text-right py-2 px-2 font-medium">True P&L</th>
                    <th className="text-right py-2 px-2 font-medium">Δ Change</th>
                    <th className="text-right py-2 px-2 font-medium">Bot P&L</th>
                    <th className="text-right py-2 px-2 font-medium">Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshotData?.slice().reverse().map((s, i) => {
                    const botData = botPnlData?.find(b => b.hourLabel === s.hourLabel);
                    return (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-1.5 px-2">{s.hourLabel}</td>
                        <td className={`text-right py-1.5 px-2 font-medium ${s.truePnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          ${s.truePnl.toFixed(2)}
                        </td>
                        <td className={`text-right py-1.5 px-2 ${s.hourlyChange >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {s.hourlyChange >= 0 ? '+' : ''}${s.hourlyChange.toFixed(2)}
                        </td>
                        <td className={`text-right py-1.5 px-2 ${(botData?.botPnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {(botData?.botPnl || 0) >= 0 ? '+' : ''}${(botData?.botPnl || 0).toFixed(2)}
                        </td>
                        <td className="text-right py-1.5 px-2 text-muted-foreground">
                          {botData?.trades || 0}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
