import { Trade } from '@/types/trade';
import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { format, subDays, startOfDay, isSameDay } from 'date-fns';

interface ActivityChartProps {
  trades: Trade[];
}

export function ActivityChart({ trades }: ActivityChartProps) {
  const chartData = useMemo(() => {
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = startOfDay(subDays(new Date(), 6 - i));
      const dayTrades = trades.filter(t => isSameDay(t.timestamp, date));
      const volume = dayTrades.reduce((sum, t) => sum + t.total, 0);
      const count = dayTrades.length;
      
      return {
        date: format(date, 'MMM dd'),
        volume,
        count,
      };
    });
    
    return last7Days;
  }, [trades]);

  return (
    <div className="glass rounded-lg p-4 animate-fade-in">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        7-Day Activity
      </h2>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="volumeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="date" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 11, fontFamily: 'JetBrains Mono' }}
            />
            <YAxis 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 11, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(value) => `$${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'hsl(210, 20%, 95%)' }}
              itemStyle={{ color: 'hsl(142, 70%, 45%)' }}
            />
            <Area
              type="monotone"
              dataKey="volume"
              stroke="hsl(142, 70%, 45%)"
              strokeWidth={2}
              fill="url(#volumeGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
