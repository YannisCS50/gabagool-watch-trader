import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend, Cell } from 'recharts';
import { format, subHours, startOfHour } from 'date-fns';
import { TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { useMemo } from "react";

interface TruePnLModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HourlyPnLData {
  hour: string;
  hourLabel: string;
  botPnl: number;
  trades: number;
  volume: number;
}

export function TruePnLModal({ open, onOpenChange }: TruePnLModalProps) {
  const { data: hourlyData, isLoading } = useQuery<HourlyPnLData[]>({
    queryKey: ["hourly-pnl-comparison"],
    queryFn: async () => {
      const now = new Date();
      const hoursToShow = 24;

      // Initialize empty buckets for last 24 hours
      const buckets = new Map<string, HourlyPnLData>();
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

      // Fetch hourly P&L from settled v26_trades
      const twentyFourHoursAgo = subHours(now, 24).toISOString();
      const { data: trades } = await supabase
        .from("v26_trades")
        .select("settled_at, pnl, notional")
        .not("settled_at", "is", null)
        .not("pnl", "is", null)
        .gte("settled_at", twentyFourHoursAgo);

      // Aggregate trades into hourly buckets
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

  const summary = useMemo(() => {
    if (!hourlyData) return null;

    const withTrades = hourlyData.filter(h => h.trades > 0);
    const totalBotPnl = hourlyData.reduce((sum, h) => sum + h.botPnl, 0);
    const totalTrades = hourlyData.reduce((sum, h) => sum + h.trades, 0);
    const totalVolume = hourlyData.reduce((sum, h) => sum + h.volume, 0);
    const profitableHours = withTrades.filter(h => h.botPnl > 0).length;
    const losingHours = withTrades.filter(h => h.botPnl < 0).length;
    const avgPnlPerHour = withTrades.length > 0 ? totalBotPnl / withTrades.length : 0;
    const bestHour = withTrades.reduce((best, h) => h.botPnl > best.botPnl ? h : best, { botPnl: -Infinity, hourLabel: '-' } as HourlyPnLData);
    const worstHour = withTrades.reduce((worst, h) => h.botPnl < worst.botPnl ? h : worst, { botPnl: Infinity, hourLabel: '-' } as HourlyPnLData);

    return {
      totalBotPnl,
      totalTrades,
      totalVolume,
      profitableHours,
      losingHours,
      avgPnlPerHour,
      bestHour: bestHour.botPnl !== -Infinity ? bestHour : null,
      worstHour: worstHour.botPnl !== Infinity ? worstHour : null,
      hoursWithTrades: withTrades.length,
    };
  }, [hourlyData]);

  const isPositive = (summary?.totalBotPnl ?? 0) >= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Hourly P&L (Last 24h)
            {summary && (
              <span className={`flex items-center gap-1 text-lg ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                {isPositive ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {isPositive ? '+' : ''}${summary.totalBotPnl.toFixed(2)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary Stats */}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Total Trades</div>
                  <div className="text-lg font-semibold">{summary.totalTrades}</div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Volume</div>
                  <div className="text-lg font-semibold">${summary.totalVolume.toFixed(0)}</div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Avg P&L/hr</div>
                  <div className={`text-lg font-semibold ${summary.avgPnlPerHour >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${summary.avgPnlPerHour.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-muted/30">
                  <div className="text-xs text-muted-foreground">Win/Loss Hours</div>
                  <div className="text-lg font-semibold">
                    <span className="text-green-500">{summary.profitableHours}</span>
                    {' / '}
                    <span className="text-red-500">{summary.losingHours}</span>
                  </div>
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
                      {summary.bestHour.hourLabel} (+${summary.bestHour.botPnl.toFixed(2)})
                    </span>
                  </div>
                )}
                {summary.worstHour && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Worst Hour:</span>
                    <span className="text-red-500 font-medium">
                      {summary.worstHour.hourLabel} (${summary.worstHour.botPnl.toFixed(2)})
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Chart */}
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -10, bottom: 5 }}>
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
                      const data = payload[0].payload as HourlyPnLData;
                      return (
                        <div className="bg-card border border-border rounded-lg p-3 text-sm shadow-lg">
                          <p className="font-medium mb-2">{label}</p>
                          <div className="space-y-1">
                            <p className={data.botPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                              P&L: {data.botPnl >= 0 ? '+' : ''}${data.botPnl.toFixed(2)}
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
                  <Bar dataKey="botPnl" name="Bot P&L" radius={[3, 3, 0, 0]}>
                    {hourlyData?.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.botPnl >= 0 ? 'hsl(142, 70%, 45%)' : 'hsl(0, 70%, 50%)'}
                        fillOpacity={entry.trades > 0 ? 0.85 : 0.15}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Hourly Breakdown Table */}
            <div className="max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left py-2 px-2 font-medium">Hour</th>
                    <th className="text-right py-2 px-2 font-medium">Trades</th>
                    <th className="text-right py-2 px-2 font-medium">Volume</th>
                    <th className="text-right py-2 px-2 font-medium">P&L</th>
                    <th className="text-right py-2 px-2 font-medium">ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {hourlyData?.filter(h => h.trades > 0).slice().reverse().map((h, i) => {
                    const roi = h.volume > 0 ? (h.botPnl / h.volume) * 100 : 0;
                    return (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-1.5 px-2">{h.hourLabel}</td>
                        <td className="text-right py-1.5 px-2">{h.trades}</td>
                        <td className="text-right py-1.5 px-2">${h.volume.toFixed(0)}</td>
                        <td className={`text-right py-1.5 px-2 font-medium ${h.botPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {h.botPnl >= 0 ? '+' : ''}${h.botPnl.toFixed(2)}
                        </td>
                        <td className={`text-right py-1.5 px-2 ${roi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
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
