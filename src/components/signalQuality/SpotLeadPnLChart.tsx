import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SignalQualityAnalysis } from '@/types/signalQuality';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';

interface SpotLeadPnLChartProps {
  signals: SignalQualityAnalysis[];
  isLoading?: boolean;
}

export function SpotLeadPnLChart({ signals, isLoading }: SpotLeadPnLChartProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="h-[300px] animate-pulse bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }
  
  // Group by spot lead bucket
  const buckets = ['<300ms', '300-800ms', '>800ms'];
  
  const data = buckets.map(bucket => {
    const bucketSignals = signals.filter(s => s.spot_lead_bucket === bucket);
    const count = bucketSignals.length;
    const avgPnl = count > 0 
      ? bucketSignals.reduce((sum, s) => sum + (s.actual_pnl ?? 0), 0) / count
      : 0;
    const winRate = count > 0
      ? (bucketSignals.filter(s => (s.actual_pnl ?? 0) > 0).length / count) * 100
      : 0;
    
    return {
      bucket,
      count,
      avgPnl: avgPnl * 100, // Convert to cents
      winRate,
    };
  });
  
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
        <div className="font-medium">Spot Lead: {d.bucket}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
          <span className="text-muted-foreground">Signals:</span>
          <span className="font-mono">{d.count}</span>
          <span className="text-muted-foreground">Avg PnL:</span>
          <span className={`font-mono ${d.avgPnl > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {d.avgPnl.toFixed(2)}¢
          </span>
          <span className="text-muted-foreground">Win Rate:</span>
          <span className={`font-mono ${d.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
            {d.winRate.toFixed(0)}%
          </span>
        </div>
      </div>
    );
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Spot Lead vs Realized PnL</CardTitle>
        <p className="text-sm text-muted-foreground">
          Average PnL by spot lead time. Longer lead time should correlate with better outcomes.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="bucket" className="text-xs" />
              <YAxis 
                label={{ value: 'Avg PnL (¢)', angle: -90, position: 'insideLeft' }}
                className="text-xs"
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
              <Bar dataKey="avgPnl" name="Avg PnL">
                {data.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`}
                    fill={entry.avgPnl > 0 ? 'hsl(142, 76%, 36%)' : 'hsl(0, 84%, 60%)'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        
        {/* Win rate row */}
        <div className="flex justify-around mt-4 pt-4 border-t">
          {data.map(d => (
            <div key={d.bucket} className="text-center">
              <div className="text-xs text-muted-foreground">{d.bucket}</div>
              <div className={`text-lg font-bold ${d.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                {d.winRate.toFixed(0)}%
              </div>
              <div className="text-xs text-muted-foreground">{d.count} signals</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
