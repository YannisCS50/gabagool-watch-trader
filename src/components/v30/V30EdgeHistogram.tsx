import { forwardRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import type { V30Tick } from '@/hooks/useV30Data';

interface Props {
  ticks: V30Tick[];
}

export const V30EdgeHistogram = forwardRef<HTMLDivElement, Props>(({ ticks }, ref) => {
  // Bucket edges into histogram
  const bucketSize = 0.5; // 0.5% buckets
  const minEdge = -10;
  const maxEdge = 10;
  
  const buckets: Record<number, { up: number; down: number }> = {};
  
  for (let i = minEdge; i <= maxEdge; i += bucketSize) {
    buckets[i] = { up: 0, down: 0 };
  }
  
  for (const tick of ticks) {
    if (tick.edge_up !== null) {
      const edgePct = tick.edge_up * 100;
      const bucket = Math.round(edgePct / bucketSize) * bucketSize;
      const clampedBucket = Math.max(minEdge, Math.min(maxEdge, bucket));
      if (buckets[clampedBucket]) {
        buckets[clampedBucket].up++;
      }
    }
    if (tick.edge_down !== null) {
      const edgePct = tick.edge_down * 100;
      const bucket = Math.round(edgePct / bucketSize) * bucketSize;
      const clampedBucket = Math.max(minEdge, Math.min(maxEdge, bucket));
      if (buckets[clampedBucket]) {
        buckets[clampedBucket].down++;
      }
    }
  }
  
  const data = Object.entries(buckets).map(([edge, counts]) => ({
    edge: Number(edge),
    up: counts.up,
    down: -counts.down, // Negative for bottom
  }));

  // Calculate average theta for reference line
  const avgTheta = ticks
    .filter(t => t.theta_current !== null)
    .reduce((sum, t) => sum + (t.theta_current ?? 0), 0) / 
    Math.max(1, ticks.filter(t => t.theta_current !== null).length);

  return (
    <Card ref={ref}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Edge Distribution
          <span className="text-sm font-normal text-muted-foreground">
            θ ≈ {(avgTheta * 100).toFixed(1)}%
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis 
                dataKey="edge" 
                tick={{ fontSize: 10 }} 
                tickFormatter={(v) => `${v}%`}
                interval={3}
              />
              <YAxis tick={{ fontSize: 10 }} />
              <ReferenceLine x={-avgTheta * 100} stroke="hsl(var(--primary))" strokeDasharray="3 3" />
              <ReferenceLine x={avgTheta * 100} stroke="hsl(var(--primary))" strokeDasharray="3 3" />
              <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" />
              <Bar dataKey="up" stackId="a">
                {data.map((entry, index) => (
                  <Cell 
                    key={`up-${index}`} 
                    fill={entry.edge < -avgTheta * 100 ? 'hsl(142, 76%, 36%)' : 'hsl(var(--muted))'} 
                  />
                ))}
              </Bar>
              <Bar dataKey="down" stackId="a">
                {data.map((entry, index) => (
                  <Cell 
                    key={`down-${index}`} 
                    fill={entry.edge < -avgTheta * 100 ? 'hsl(0, 84%, 60%)' : 'hsl(var(--muted))'} 
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground mt-2">
          <span className="text-green-400">← Underpriced (BUY)</span>
          <span className="text-red-400">Overpriced →</span>
        </div>
      </CardContent>
    </Card>
  );
});

V30EdgeHistogram.displayName = 'V30EdgeHistogram';
