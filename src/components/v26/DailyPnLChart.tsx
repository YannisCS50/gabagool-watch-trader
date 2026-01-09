import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, ComposedChart } from 'recharts';
import { useDailyPnlCumulative } from '@/hooks/useDailyPnl';
import { Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import { format, parseISO } from 'date-fns';

interface DailyPnLChartProps {
  wallet: string;
}

export function DailyPnLChart({ wallet }: DailyPnLChartProps) {
  const { data: dailyData, isLoading, error } = useDailyPnlCumulative(wallet);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Cumulative PnL</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error || !dailyData?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Cumulative PnL</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-[300px] text-muted-foreground">
          {error ? 'Error loading data' : 'No daily PnL data available. Run the reducer first.'}
        </CardContent>
      </Card>
    );
  }

  // Format data for chart
  const chartData = dailyData.map(d => ({
    date: d.date,
    dateLabel: format(parseISO(d.date), 'MMM d'),
    dailyPnl: d.realized_pnl,
    cumulativePnl: d.cumulative_realized_pnl,
    volume: d.volume_traded,
  }));

  const latestPnl = chartData[chartData.length - 1]?.cumulativePnl || 0;
  const isPositive = latestPnl >= 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Cumulative PnL Over Time</CardTitle>
        <div className={`flex items-center gap-1 text-sm font-semibold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
          {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
          ${latestPnl.toFixed(2)}
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <defs>
              <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3}/>
                <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="dateLabel" 
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis 
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${v.toFixed(0)}`}
            />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'hsl(var(--card))', 
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
              }}
              formatter={(value: number, name: string) => [
                `$${value.toFixed(2)}`,
                name === 'cumulativePnl' ? 'Total PnL' : 'Daily PnL'
              ]}
              labelFormatter={(label) => `Date: ${label}`}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
            <Area 
              type="monotone" 
              dataKey="cumulativePnl" 
              stroke={isPositive ? '#22c55e' : '#ef4444'}
              fillOpacity={1}
              fill="url(#colorPnl)"
            />
            <Line 
              type="monotone" 
              dataKey="cumulativePnl" 
              stroke={isPositive ? '#22c55e' : '#ef4444'}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
