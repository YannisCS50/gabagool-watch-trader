import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SignalQualityAnalysis } from '@/types/signalQuality';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';

interface TakerZscorePnLChartProps {
  signals: SignalQualityAnalysis[];
  isLoading?: boolean;
}

export function TakerZscorePnLChart({ signals, isLoading }: TakerZscorePnLChartProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="h-[300px] animate-pulse bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }
  
  // Transform data - only include signals with taker data
  const data = signals
    .filter(s => s.taker_volume_zscore !== null)
    .map(s => ({
      zscore: s.taker_volume_zscore ?? 0,
      pnl: (s.actual_pnl ?? 0) * 100, // cents
      shouldTrade: s.should_trade,
      asset: s.asset,
    }));
  
  // If no taker data, show placeholder with explanation
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Taker Z-Score vs PnL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p>No taker volume data available yet.</p>
              <p className="text-sm mt-2">
                Taker z-score measures abnormal aggressive trading activity,
                which often indicates adverse selection (toxic flow).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
        <div className="font-medium">{d.asset}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
          <span className="text-muted-foreground">Taker Z:</span>
          <span className="font-mono">{d.zscore.toFixed(2)}</span>
          <span className="text-muted-foreground">PnL:</span>
          <span className={`font-mono ${d.pnl > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {d.pnl.toFixed(2)}¢
          </span>
        </div>
      </div>
    );
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Taker Z-Score vs PnL</CardTitle>
        <p className="text-sm text-muted-foreground">
          High taker z-score (&gt;1.5) often indicates adverse selection. 
          Signals with high z-score should be avoided.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                type="number" 
                dataKey="zscore" 
                name="Taker Z-Score"
                domain={[-2, 4]}
                label={{ value: 'Taker Z-Score', position: 'bottom', offset: 0 }}
                className="text-xs"
              />
              <YAxis 
                type="number" 
                dataKey="pnl" 
                name="PnL" 
                unit="¢"
                label={{ value: 'PnL (¢)', angle: -90, position: 'left' }}
                className="text-xs"
              />
              <Tooltip content={<CustomTooltip />} />
              {/* Danger zone line at z=1.5 */}
              <ReferenceLine 
                x={1.5} 
                stroke="hsl(0, 84%, 60%)" 
                strokeDasharray="5 5"
                label={{ value: 'Danger', position: 'top', fill: 'hsl(0, 84%, 60%)' }}
              />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Scatter name="Signals" data={data}>
                {data.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`}
                    fill={entry.pnl > 0 ? 'hsl(142, 76%, 36%)' : 'hsl(0, 84%, 60%)'}
                    opacity={entry.zscore > 1.5 ? 0.5 : 1}
                  />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
