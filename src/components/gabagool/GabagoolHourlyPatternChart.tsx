import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Clock } from 'lucide-react';
import { HourlyPattern } from '@/hooks/useGabagoolDeltaAnalysis';

interface Props {
  data: HourlyPattern[];
  isLoading?: boolean;
}

export function GabagoolHourlyPatternChart({ data, isLoading }: Props) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Hourly Patterns
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map(d => ({
    hour: `${d.hour}:00`,
    trades: d.trades,
    volume: d.volume,
    'UP %': d.upPct,
  }));

  // Find peak hour
  const peakHour = data.reduce((max, h) => h.volume > max.volume ? h : max, data[0]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Trading Activiteit per Uur (UTC)
        </CardTitle>
        <CardDescription>Wanneer is Gabagool het meest actief?</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="hour" className="text-xs" />
              <YAxis yAxisId="left" className="text-xs" />
              <YAxis yAxisId="right" orientation="right" className="text-xs" domain={[45, 55]} />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--card))', 
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px'
                }}
                formatter={(value: number, name: string) => {
                  if (name === 'volume') return [`$${(value / 1000).toFixed(1)}K`, 'Volume'];
                  if (name === 'UP %') return [`${value.toFixed(1)}%`, 'UP %'];
                  return [value.toLocaleString(), name];
                }}
              />
              <Legend />
              <Bar yAxisId="left" dataKey="trades" name="Trades" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} opacity={0.7} />
              <Line yAxisId="right" type="monotone" dataKey="UP %" name="UP %" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="text-muted-foreground">Peak Hour</div>
            <div className="font-bold">{peakHour.hour}:00 UTC</div>
            <div className="text-xs text-muted-foreground">
              ${(peakHour.volume / 1000).toFixed(0)}K volume
            </div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="text-muted-foreground">UP Bias Range</div>
            <div className="font-bold">
              {Math.min(...data.map(d => d.upPct)).toFixed(1)}% - {Math.max(...data.map(d => d.upPct)).toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              Vrijwel altijd 49-51% balanced
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
