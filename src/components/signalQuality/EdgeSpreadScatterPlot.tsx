import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SignalQualityAnalysis } from '@/types/signalQuality';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell, Legend } from 'recharts';

interface EdgeSpreadScatterPlotProps {
  signals: SignalQualityAnalysis[];
  isLoading?: boolean;
}

export function EdgeSpreadScatterPlot({ signals, isLoading }: EdgeSpreadScatterPlotProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="h-[300px] animate-pulse bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }
  
  // Transform data for scatter plot
  const data = signals
    .filter(s => s.effective_spread_sell !== null && s.edge_after_spread_7s !== null)
    .map(s => ({
      spread: (s.effective_spread_sell ?? 0) * 100, // Convert to cents
      edge: (s.edge_after_spread_7s ?? 0) * 100, // Convert to cents
      pnl: s.actual_pnl ?? 0,
      shouldTrade: s.should_trade,
      isFalseEdge: s.is_false_edge,
      asset: s.asset,
    }));
  
  const CustomTooltip = ({ active, payload }: any) => {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-popover border rounded-lg shadow-lg p-3 text-sm">
        <div className="font-medium">{d.asset}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
          <span className="text-muted-foreground">Spread:</span>
          <span className="font-mono">{d.spread.toFixed(2)}¢</span>
          <span className="text-muted-foreground">Edge:</span>
          <span className={`font-mono ${d.edge > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {d.edge.toFixed(2)}¢
          </span>
          <span className="text-muted-foreground">PnL:</span>
          <span className={`font-mono ${d.pnl > 0 ? 'text-green-500' : 'text-red-500'}`}>
            {(d.pnl * 100).toFixed(2)}¢
          </span>
        </div>
      </div>
    );
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Edge vs Spread Scatter</CardTitle>
        <p className="text-sm text-muted-foreground">
          Green = profitable, Red = loss, Orange = false edge. 
          Points above the line have positive edge after spread.
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                type="number" 
                dataKey="spread" 
                name="Spread" 
                unit="¢"
                label={{ value: 'Spread (¢)', position: 'bottom', offset: 0 }}
                className="text-xs"
              />
              <YAxis 
                type="number" 
                dataKey="edge" 
                name="Edge" 
                unit="¢"
                label={{ value: 'Edge @ 7s (¢)', angle: -90, position: 'left' }}
                className="text-xs"
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
              <Scatter name="Signals" data={data}>
                {data.map((entry, index) => (
                  <Cell 
                    key={`cell-${index}`}
                    fill={
                      entry.isFalseEdge 
                        ? 'hsl(38, 92%, 50%)' // amber
                        : entry.pnl > 0 
                          ? 'hsl(142, 76%, 36%)' // green
                          : 'hsl(0, 84%, 60%)' // red
                    }
                    opacity={entry.shouldTrade ? 1 : 0.4}
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
