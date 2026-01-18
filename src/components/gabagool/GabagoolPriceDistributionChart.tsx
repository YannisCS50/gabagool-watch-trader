import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { BarChart3 } from 'lucide-react';
import { PriceBucketStats } from '@/hooks/useGabagoolDeltaAnalysis';

interface Props {
  data: PriceBucketStats[];
  isLoading?: boolean;
}

export function GabagoolPriceDistributionChart({ data, isLoading }: Props) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Price Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map(d => ({
    bucket: d.bucket,
    Up: d.upTrades,
    Down: d.downTrades,
    'Up Volume': d.upVolume,
    'Down Volume': d.downVolume,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Entry Price Distributie
        </CardTitle>
        <CardDescription>Bij welke prijzen koopt Gabagool UP vs DOWN?</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="bucket" className="text-xs" />
              <YAxis className="text-xs" />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--card))', 
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px'
                }}
                formatter={(value: number) => value.toLocaleString()}
              />
              <Legend />
              <Bar dataKey="Up" name="Up Trades" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Down" name="Down Trades" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
          <strong>Observatie:</strong> De distributie is vrijwel symmetrisch tussen UP en DOWN trades. 
          Dit bevestigt de dual-side hedging strategie waar beide kanten gelijk worden behandeld.
        </div>
      </CardContent>
    </Card>
  );
}
