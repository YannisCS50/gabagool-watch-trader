import { useWindowTicks } from '@/hooks/useChainlinkWindows';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, ComposedChart } from 'recharts';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

interface WindowPriceChartProps {
  marketSlug: string;
  strikePrice: number;
  windowStart: number;
  windowEnd: number;
}

export function WindowPriceChart({ marketSlug, strikePrice, windowStart, windowEnd }: WindowPriceChartProps) {
  const { data: ticks, isLoading, error } = useWindowTicks(marketSlug);

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (error || !ticks || ticks.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
        No tick data available
      </div>
    );
  }

  const chartData = ticks.map(t => ({
    ts: t.ts,
    chainlink: t.chainlink_price,
    binance: t.binance_price,
    signal: t.signal_direction,
    orderPlaced: t.order_placed,
    fillPrice: t.fill_price,
  }));

  const allPrices = [...chartData.map(d => d.chainlink), ...chartData.map(d => d.binance), strikePrice].filter(Boolean);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const padding = (maxPrice - minPrice) * 0.05;

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="aboveStrike" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="belowStrike" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0} />
              <stop offset="100%" stopColor="hsl(0, 84%, 60%)" stopOpacity={0.3} />
            </linearGradient>
          </defs>
          
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
            formatter={(value: number, name: string) => [
              `$${value?.toLocaleString() || '-'}`, 
              name === 'chainlink' ? 'Chainlink' : 'Binance'
            ]}
          />
          
          {/* Strike price reference */}
          <ReferenceLine 
            y={strikePrice} 
            stroke="hsl(var(--primary))" 
            strokeWidth={2}
            strokeDasharray="5 5"
            label={{ 
              value: `Strike: $${strikePrice.toLocaleString()}`, 
              position: 'right', 
              fontSize: 11,
              fill: 'hsl(var(--primary))'
            }}
          />
          
          {/* Window boundaries */}
          <ReferenceLine 
            x={windowStart} 
            stroke="hsl(var(--muted-foreground))" 
            strokeDasharray="3 3" 
          />
          <ReferenceLine 
            x={windowEnd} 
            stroke="hsl(var(--muted-foreground))" 
            strokeDasharray="3 3"
          />
          
          {/* Binance price (thinner, secondary) */}
          <Line 
            type="monotone" 
            dataKey="binance" 
            stroke="hsl(var(--muted-foreground))" 
            dot={false}
            strokeWidth={1}
            opacity={0.5}
          />
          
          {/* Chainlink price (main) */}
          <Line 
            type="monotone" 
            dataKey="chainlink" 
            stroke="hsl(var(--primary))" 
            dot={false}
            strokeWidth={2}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
