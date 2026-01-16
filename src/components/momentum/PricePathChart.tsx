import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MomentumSignal } from '@/hooks/useMomentumAnalysis';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Activity, HelpCircle } from 'lucide-react';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PricePathChartProps {
  signals: MomentumSignal[];
  isLoading?: boolean;
}

export function PricePathChart({ signals, isLoading }: PricePathChartProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse h-64 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  // Filter signals with price path data
  const withPath = signals.filter(s => s.price_at_5s !== null);
  
  if (withPath.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Geen price path data beschikbaar
        </CardContent>
      </Card>
    );
  }

  // Group by delta bucket and calculate average path
  const buckets: Record<string, MomentumSignal[]> = {};
  for (const s of withPath) {
    if (!buckets[s.delta_bucket]) buckets[s.delta_bucket] = [];
    buckets[s.delta_bucket].push(s);
  }

  // Calculate average normalized path per bucket
  // Normalize: start at 0, show relative movement
  const chartData = ['t0', '1s', '2s', '3s', '5s'].map((time, idx) => {
    const point: Record<string, any> = { time };
    
    for (const [bucket, group] of Object.entries(buckets)) {
      const validSignals = group.filter(s => {
        if (idx === 0) return true;
        if (idx === 1) return s.price_at_1s !== null;
        if (idx === 2) return s.price_at_2s !== null;
        if (idx === 3) return s.price_at_3s !== null;
        if (idx === 4) return s.price_at_5s !== null;
        return false;
      });
      
      if (validSignals.length === 0) {
        point[bucket] = null;
        continue;
      }
      
      const avgMove = validSignals.reduce((sum, s) => {
        const t0 = s.share_price_t0;
        let price = t0;
        if (idx === 1) price = s.price_at_1s!;
        if (idx === 2) price = s.price_at_2s!;
        if (idx === 3) price = s.price_at_3s!;
        if (idx === 4) price = s.price_at_5s!;
        
        // Normalize by direction
        const move = price - t0;
        return sum + (s.direction === 'UP' ? move : -move);
      }, 0) / validSignals.length;
      
      point[bucket] = avgMove * 100; // Convert to cents
    }
    
    return point;
  });

  const colors: Record<string, string> = {
    'd<10': '#ef4444',
    'd10-15': '#f59e0b',
    'd15-20': '#22c55e',
    'd20+': '#3b82f6',
  };

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle>Gemiddelde Price Path per Bucket</CardTitle>
            <UITooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <p className="text-xs">
                  Toont hoe de Polymarket prijs gemiddeld beweegt van entry (t0) tot 5 seconden later.
                  Positief = prijs beweegt in onze richting. Negatief = tegen ons.
                  Grotere delta buckets zouden stabieler/hoger moeten liggen.
                </p>
              </TooltipContent>
            </UITooltip>
          </div>
          <p className="text-sm text-muted-foreground">
            Genormaliseerde beweging in centen (positief = in onze richting)
          </p>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="time" 
                  tick={{ fontSize: 12 }}
                  className="text-muted-foreground"
                />
                <YAxis 
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => `${v.toFixed(1)}¢`}
                  className="text-muted-foreground"
                />
                <Tooltip 
                  formatter={(value: number) => [`${value.toFixed(2)}¢`, '']}
                  labelStyle={{ color: 'var(--foreground)' }}
                  contentStyle={{ 
                    backgroundColor: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px'
                  }}
                />
                <Legend />
                {Object.keys(buckets).map(bucket => (
                  <Line
                    key={bucket}
                    type="monotone"
                    dataKey={bucket}
                    stroke={colors[bucket] || '#888'}
                    strokeWidth={2}
                    dot={true}
                    connectNulls
                  />
                ))}
                {/* Zero line */}
                <Line
                  type="monotone"
                  dataKey={() => 0}
                  stroke="#666"
                  strokeDasharray="5 5"
                  dot={false}
                  name="Break-even"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Interpretation */}
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="p-2 rounded bg-green-500/10 border border-green-500/30">
              <span className="text-green-500 font-medium">Boven 0:</span>
              <span className="text-muted-foreground ml-1">Prijs beweegt in onze richting</span>
            </div>
            <div className="p-2 rounded bg-red-500/10 border border-red-500/30">
              <span className="text-red-500 font-medium">Onder 0:</span>
              <span className="text-muted-foreground ml-1">Prijs beweegt tegen ons</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
