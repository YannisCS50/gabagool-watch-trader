import { useBetPriceHistory } from '@/hooks/useBetsHistory';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

interface BetPriceChartProps {
  asset: string;
  windowStart: number;
  windowEnd: number;
  strikePrice: number | null;
}

export function BetPriceChart({ asset, windowStart, windowEnd, strikePrice }: BetPriceChartProps) {
  const { data: prices, isLoading, error } = useBetPriceHistory(asset, windowStart, windowEnd);

  if (isLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (error || !prices || prices.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
        No price data available for this window
      </div>
    );
  }

  const minPrice = Math.min(...prices.map(p => p.price), strikePrice || Infinity);
  const maxPrice = Math.max(...prices.map(p => p.price), strikePrice || 0);
  const padding = (maxPrice - minPrice) * 0.1;

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={prices} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <XAxis 
            dataKey="ts" 
            tickFormatter={(ts) => format(new Date(ts), 'HH:mm:ss')}
            fontSize={10}
            stroke="hsl(var(--muted-foreground))"
          />
          <YAxis 
            domain={[minPrice - padding, maxPrice + padding]}
            tickFormatter={(v) => `$${v.toLocaleString()}`}
            fontSize={10}
            stroke="hsl(var(--muted-foreground))"
            width={80}
          />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: 'hsl(var(--card))', 
              border: '1px solid hsl(var(--border))',
              borderRadius: '8px',
            }}
            labelFormatter={(ts) => format(new Date(ts as number), 'HH:mm:ss.SSS')}
            formatter={(value: number) => [`$${value.toLocaleString()}`, 'Price']}
          />
          
          {/* Window boundaries */}
          <ReferenceLine 
            x={windowStart} 
            stroke="hsl(var(--muted-foreground))" 
            strokeDasharray="3 3" 
            label={{ value: 'Start', position: 'top', fontSize: 10 }}
          />
          <ReferenceLine 
            x={windowEnd} 
            stroke="hsl(var(--muted-foreground))" 
            strokeDasharray="3 3"
            label={{ value: 'End', position: 'top', fontSize: 10 }}
          />
          
          {/* Strike price */}
          {strikePrice && (
            <ReferenceLine 
              y={strikePrice} 
              stroke="hsl(var(--primary))" 
              strokeDasharray="5 5"
              label={{ value: `Strike: $${strikePrice.toLocaleString()}`, position: 'right', fontSize: 10 }}
            />
          )}
          
          <Line 
            type="monotone" 
            dataKey="price" 
            stroke="hsl(var(--primary))" 
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
