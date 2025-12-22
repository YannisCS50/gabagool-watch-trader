import { Trade } from '@/types/trade';
import { useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { format, subDays, subHours, startOfDay, startOfHour, isSameDay, isSameHour } from 'date-fns';
import { Button } from '@/components/ui/button';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface PnLChartProps {
  trades: Trade[];
}

type TimeFrame = 'hourly' | 'daily';

export function PnLChart({ trades }: PnLChartProps) {
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('daily');

  const { chartData, totalPnL, isPositive } = useMemo(() => {
    if (timeFrame === 'hourly') {
      // Last 24 hours
      const last24Hours = Array.from({ length: 24 }, (_, i) => {
        const hour = startOfHour(subHours(new Date(), 23 - i));
        const hourTrades = trades.filter(t => isSameHour(t.timestamp, hour));
        
        // Calculate PnL: for arbitrage, estimate based on buy/sell pairs
        // Simplified: buys are negative, sells are positive
        const pnl = hourTrades.reduce((sum, t) => {
          if (t.side === 'sell') {
            return sum + t.total;
          } else {
            return sum - t.total;
          }
        }, 0);
        
        return {
          label: format(hour, 'HH:mm'),
          pnl: Math.round(pnl * 100) / 100,
          trades: hourTrades.length,
        };
      });
      
      // Calculate cumulative PnL
      let cumulative = 0;
      const withCumulative = last24Hours.map(item => {
        cumulative += item.pnl;
        return {
          ...item,
          cumulativePnL: Math.round(cumulative * 100) / 100,
        };
      });
      
      const total = withCumulative[withCumulative.length - 1]?.cumulativePnL || 0;
      
      return {
        chartData: withCumulative,
        totalPnL: total,
        isPositive: total >= 0,
      };
    } else {
      // Last 7 days
      const last7Days = Array.from({ length: 7 }, (_, i) => {
        const date = startOfDay(subDays(new Date(), 6 - i));
        const dayTrades = trades.filter(t => isSameDay(t.timestamp, date));
        
        // Calculate PnL
        const pnl = dayTrades.reduce((sum, t) => {
          if (t.side === 'sell') {
            return sum + t.total;
          } else {
            return sum - t.total;
          }
        }, 0);
        
        return {
          label: format(date, 'MMM dd'),
          pnl: Math.round(pnl * 100) / 100,
          trades: dayTrades.length,
        };
      });
      
      // Calculate cumulative PnL
      let cumulative = 0;
      const withCumulative = last7Days.map(item => {
        cumulative += item.pnl;
        return {
          ...item,
          cumulativePnL: Math.round(cumulative * 100) / 100,
        };
      });
      
      const total = withCumulative[withCumulative.length - 1]?.cumulativePnL || 0;
      
      return {
        chartData: withCumulative,
        totalPnL: total,
        isPositive: total >= 0,
      };
    }
  }, [trades, timeFrame]);

  const gradientId = isPositive ? 'pnlGradientPositive' : 'pnlGradientNegative';
  const strokeColor = isPositive ? 'hsl(142, 70%, 45%)' : 'hsl(0, 70%, 50%)';

  return (
    <div className="glass rounded-lg p-4 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Profit / Loss
          </h2>
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono ${
            isPositive 
              ? 'bg-success/20 text-success' 
              : 'bg-destructive/20 text-destructive'
          }`}>
            {isPositive ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {isPositive ? '+' : ''}{totalPnL.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant={timeFrame === 'hourly' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTimeFrame('hourly')}
            className="text-xs h-7 px-2"
          >
            24H
          </Button>
          <Button
            variant={timeFrame === 'daily' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTimeFrame('daily')}
            className="text-xs h-7 px-2"
          >
            7D
          </Button>
        </div>
      </div>
      
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="pnlGradientPositive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="pnlGradientNegative" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0, 70%, 50%)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(0, 70%, 50%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="label" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              interval={timeFrame === 'hourly' ? 3 : 0}
            />
            <YAxis 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(value) => `$${value}`}
            />
            <ReferenceLine y={0} stroke="hsl(215, 15%, 25%)" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'hsl(210, 20%, 95%)' }}
              formatter={(value: number, name: string) => {
                if (name === 'cumulativePnL') {
                  return [`$${value.toFixed(2)}`, 'Cumulative P/L'];
                }
                if (name === 'pnl') {
                  return [`$${value.toFixed(2)}`, 'Period P/L'];
                }
                return [value, name];
              }}
            />
            <Area
              type="monotone"
              dataKey="cumulativePnL"
              stroke={strokeColor}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      {/* Period breakdown */}
      <div className="mt-4 grid grid-cols-4 gap-2">
        {chartData.slice(-4).map((item, idx) => (
          <div key={idx} className="text-center p-2 rounded-lg bg-muted/30">
            <div className="text-[10px] text-muted-foreground font-mono">{item.label}</div>
            <div className={`text-xs font-mono font-semibold ${
              item.pnl >= 0 ? 'text-success' : 'text-destructive'
            }`}>
              {item.pnl >= 0 ? '+' : ''}{item.pnl.toFixed(0)}
            </div>
            <div className="text-[10px] text-muted-foreground">{item.trades} trades</div>
          </div>
        ))}
      </div>
    </div>
  );
}
