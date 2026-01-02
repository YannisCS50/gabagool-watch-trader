import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp, TrendingDown } from 'lucide-react';
import { useLiveTrades, LiveTradeResult } from '@/hooks/useLiveTrades';
import { format, subHours, startOfHour, isWithinInterval } from 'date-fns';
import { nl } from 'date-fns/locale';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';

interface HourlyData {
  hour: string;
  hourStart: Date;
  pnl: number;
  trades: number;
  invested: number;
  roi: number;
}

interface LiveHourlyPnLProps {
  hoursToShow?: number;
}

export function LiveHourlyPnL({ hoursToShow = 24 }: LiveHourlyPnLProps) {
  const { results } = useLiveTrades();

  const hourlyData = useMemo(() => {
    const now = new Date();
    const hours: HourlyData[] = [];

    // Create buckets for each hour
    for (let i = hoursToShow - 1; i >= 0; i--) {
      const hourStart = startOfHour(subHours(now, i));
      const hourEnd = startOfHour(subHours(now, i - 1));
      
      hours.push({
        hour: format(hourStart, 'HH:mm', { locale: nl }),
        hourStart,
        pnl: 0,
        trades: 0,
        invested: 0,
        roi: 0,
      });
    }

    // Aggregate settled results into hourly buckets
    results.forEach((result) => {
      if (!result.settled_at) return;
      
      const settledAt = new Date(result.settled_at);
      
      // Find matching hour bucket
      for (let i = 0; i < hours.length; i++) {
        const hourStart = hours[i].hourStart;
        const hourEnd = i < hours.length - 1 ? hours[i + 1].hourStart : new Date();
        
        if (settledAt >= hourStart && settledAt < hourEnd) {
          hours[i].pnl += result.profit_loss || 0;
          hours[i].trades += 1;
          hours[i].invested += result.total_invested || 0;
          break;
        }
      }
    });

    // Calculate ROI
    hours.forEach((h) => {
      h.roi = h.invested > 0 ? (h.pnl / h.invested) * 100 : 0;
    });

    return hours;
  }, [results, hoursToShow]);

  const summaryStats = useMemo(() => {
    const totalPnL = hourlyData.reduce((sum, h) => sum + h.pnl, 0);
    const totalTrades = hourlyData.reduce((sum, h) => sum + h.trades, 0);
    const totalInvested = hourlyData.reduce((sum, h) => sum + h.invested, 0);
    const profitableHours = hourlyData.filter((h) => h.pnl > 0).length;
    const unprofitableHours = hourlyData.filter((h) => h.pnl < 0).length;
    const bestHour = hourlyData.reduce((best, h) => (h.pnl > best.pnl ? h : best), hourlyData[0]);
    const worstHour = hourlyData.reduce((worst, h) => (h.pnl < worst.pnl ? h : worst), hourlyData[0]);

    return {
      totalPnL,
      totalTrades,
      totalInvested,
      roi: totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0,
      profitableHours,
      unprofitableHours,
      bestHour,
      worstHour,
    };
  }, [hourlyData]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload as HourlyData;
      return (
        <div className="bg-background/95 backdrop-blur-sm border rounded-lg p-3 shadow-lg">
          <p className="font-semibold">{data.hour}</p>
          <p className={data.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
            P/L: ${data.pnl.toFixed(2)}
          </p>
          <p className="text-muted-foreground text-sm">
            Trades: {data.trades}
          </p>
          <p className="text-muted-foreground text-sm">
            Invested: ${data.invested.toFixed(2)}
          </p>
          <p className="text-muted-foreground text-sm">
            ROI: {data.roi.toFixed(1)}%
          </p>
        </div>
      );
    }
    return null;
  };

  const hasData = summaryStats.totalTrades > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock className="w-5 h-5" />
            Uurlijkse P/L
            <Badge variant="outline" className="ml-2">
              {hoursToShow}u
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            {summaryStats.totalPnL >= 0 ? (
              <TrendingUp className="w-5 h-5 text-green-500" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-500" />
            )}
            <span
              className={`text-xl font-bold ${
                summaryStats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'
              }`}
            >
              {summaryStats.totalPnL >= 0 ? '+' : ''}${summaryStats.totalPnL.toFixed(2)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Trades</div>
            <div className="font-semibold">{summaryStats.totalTrades}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Invested</div>
            <div className="font-semibold">${summaryStats.totalInvested.toFixed(2)}</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">ROI</div>
            <div className={`font-semibold ${summaryStats.roi >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {summaryStats.roi.toFixed(1)}%
            </div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2">
            <div className="text-muted-foreground">Winsturen</div>
            <div className="font-semibold">
              <span className="text-green-500">{summaryStats.profitableHours}</span>
              {' / '}
              <span className="text-red-500">{summaryStats.unprofitableHours}</span>
            </div>
          </div>
        </div>

        {/* Chart */}
        {hasData ? (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey="hour"
                  tick={{ fontSize: 10 }}
                  interval={Math.floor(hoursToShow / 8)}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {hourlyData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.pnl >= 0 ? 'hsl(142, 76%, 36%)' : 'hsl(0, 84%, 60%)'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[200px] flex items-center justify-center text-muted-foreground">
            Geen gesettelde trades in de afgelopen {hoursToShow} uur
          </div>
        )}

        {/* Best/Worst Hours */}
        {hasData && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2">
              <div className="text-green-500 text-xs font-semibold">Beste uur</div>
              <div className="font-semibold">{summaryStats.bestHour.hour}</div>
              <div className="text-green-500">+${summaryStats.bestHour.pnl.toFixed(2)}</div>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2">
              <div className="text-red-500 text-xs font-semibold">Slechtste uur</div>
              <div className="font-semibold">{summaryStats.worstHour.hour}</div>
              <div className="text-red-500">${summaryStats.worstHour.pnl.toFixed(2)}</div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
