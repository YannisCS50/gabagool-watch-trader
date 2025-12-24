import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { PaperTradeResult } from '@/hooks/usePaperTrades';
import { format, parseISO, subHours } from 'date-fns';

interface HourlyPnLChartProps {
  results: PaperTradeResult[];
  hoursToShow?: number;
}

interface HourlyData {
  hour: string;
  hourLabel: string;
  pnl: number;
  trades: number;
  invested: number;
  roi: number;
}

export const HourlyPnLChart: React.FC<HourlyPnLChartProps> = ({ 
  results, 
  hoursToShow = 24 
}) => {
  // Group settled results by hour
  const hourlyData = React.useMemo(() => {
    const settledResults = results.filter(r => r.settled_at);
    
    // Create hourly buckets for the last N hours
    const now = new Date();
    const hours: Record<string, HourlyData> = {};
    
    for (let i = 0; i < hoursToShow; i++) {
      const hourDate = subHours(now, i);
      const hourKey = format(hourDate, 'yyyy-MM-dd HH:00');
      const hourLabel = format(hourDate, 'HH:mm');
      hours[hourKey] = {
        hour: hourKey,
        hourLabel,
        pnl: 0,
        trades: 0,
        invested: 0,
        roi: 0,
      };
    }
    
    // Aggregate results into hourly buckets
    settledResults.forEach(result => {
      if (!result.settled_at) return;
      const settledDate = parseISO(result.settled_at);
      const hourKey = format(settledDate, 'yyyy-MM-dd HH:00');
      
      if (hours[hourKey]) {
        hours[hourKey].pnl += result.profit_loss || 0;
        hours[hourKey].trades += 1;
        hours[hourKey].invested += result.total_invested || 0;
      }
    });
    
    // Calculate ROI for each hour
    Object.values(hours).forEach(h => {
      h.roi = h.invested > 0 ? (h.pnl / h.invested) * 100 : 0;
    });
    
    // Sort by hour (oldest first) and return
    return Object.values(hours)
      .sort((a, b) => a.hour.localeCompare(b.hour));
  }, [results, hoursToShow]);

  // Calculate summary stats
  const summaryStats = React.useMemo(() => {
    const totalPnl = hourlyData.reduce((sum, h) => sum + h.pnl, 0);
    const totalTrades = hourlyData.reduce((sum, h) => sum + h.trades, 0);
    const totalInvested = hourlyData.reduce((sum, h) => sum + h.invested, 0);
    const positiveHours = hourlyData.filter(h => h.pnl > 0).length;
    const negativeHours = hourlyData.filter(h => h.pnl < 0).length;
    const bestHour = hourlyData.reduce((best, h) => h.pnl > best.pnl ? h : best, hourlyData[0]);
    const worstHour = hourlyData.reduce((worst, h) => h.pnl < worst.pnl ? h : worst, hourlyData[0]);
    
    return {
      totalPnl,
      totalTrades,
      totalInvested,
      avgPnlPerHour: totalPnl / hoursToShow,
      positiveHours,
      negativeHours,
      bestHour,
      worstHour,
      avgRoi: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
    };
  }, [hourlyData, hoursToShow]);

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload as HourlyData;
      return (
        <div className="bg-card border border-border/50 rounded-lg p-3 shadow-lg">
          <div className="font-medium text-sm mb-2">{data.hour}</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">P/L:</span>
              <span className={`font-mono font-medium ${data.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Trades:</span>
              <span className="font-mono">{data.trades}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Invested:</span>
              <span className="font-mono">${data.invested.toFixed(2)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">ROI:</span>
              <span className={`font-mono ${data.roi >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {data.roi >= 0 ? '+' : ''}{data.roi.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <BarChart3 className="w-5 h-5 text-primary" />
            Hourly Performance
            <Badge variant="secondary" className="text-xs">Last {hoursToShow}h</Badge>
          </CardTitle>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
            summaryStats.totalPnl >= 0 
              ? 'bg-emerald-500/10 text-emerald-500' 
              : 'bg-red-500/10 text-red-500'
          }`}>
            {summaryStats.totalPnl >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {summaryStats.totalPnl >= 0 ? '+' : ''}${summaryStats.totalPnl.toFixed(2)} total
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">Avg P/L / Hour</div>
            <div className={`font-mono font-semibold ${summaryStats.avgPnlPerHour >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {summaryStats.avgPnlPerHour >= 0 ? '+' : ''}${summaryStats.avgPnlPerHour.toFixed(2)}
            </div>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">Avg ROI</div>
            <div className={`font-mono font-semibold ${summaryStats.avgRoi >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {summaryStats.avgRoi >= 0 ? '+' : ''}{summaryStats.avgRoi.toFixed(1)}%
            </div>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">Profitable Hours</div>
            <div className="font-mono font-semibold">
              <span className="text-emerald-500">{summaryStats.positiveHours}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-red-500">{summaryStats.negativeHours}</span>
            </div>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">Best Hour</div>
            <div className="font-mono font-semibold text-emerald-500">
              +${summaryStats.bestHour?.pnl.toFixed(2) || '0.00'}
            </div>
            <div className="text-xs text-muted-foreground">{summaryStats.bestHour?.hourLabel}</div>
          </div>
          <div className="bg-muted/30 rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground mb-1">Worst Hour</div>
            <div className="font-mono font-semibold text-red-500">
              ${summaryStats.worstHour?.pnl.toFixed(2) || '0.00'}
            </div>
            <div className="text-xs text-muted-foreground">{summaryStats.worstHour?.hourLabel}</div>
          </div>
        </div>

        {/* Chart */}
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hourlyData} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
              <XAxis 
                dataKey="hourLabel" 
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis 
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) => `$${value}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {hourlyData.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`} 
                    fill={entry.pnl >= 0 ? 'hsl(142.1 76.2% 36.3%)' : 'hsl(0 84.2% 60.2%)'}
                    opacity={entry.trades > 0 ? 1 : 0.3}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Hour-by-hour breakdown */}
        <div className="mt-6 max-h-[200px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-background">
              <tr className="text-muted-foreground border-b border-border/50">
                <th className="text-left pb-2 font-medium">Hour</th>
                <th className="text-right pb-2 font-medium">Trades</th>
                <th className="text-right pb-2 font-medium">Invested</th>
                <th className="text-right pb-2 font-medium">P/L</th>
                <th className="text-right pb-2 font-medium">ROI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {[...hourlyData].reverse().filter(h => h.trades > 0).map(h => (
                <tr key={h.hour} className="hover:bg-muted/30">
                  <td className="py-1.5 font-mono">{h.hour}</td>
                  <td className="py-1.5 text-right font-mono">{h.trades}</td>
                  <td className="py-1.5 text-right font-mono">${h.invested.toFixed(2)}</td>
                  <td className={`py-1.5 text-right font-mono font-medium ${h.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {h.pnl >= 0 ? '+' : ''}${h.pnl.toFixed(2)}
                  </td>
                  <td className={`py-1.5 text-right font-mono ${h.roi >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {h.roi >= 0 ? '+' : ''}{h.roi.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};
