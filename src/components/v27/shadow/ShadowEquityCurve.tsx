import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, ComposedChart, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, DollarSign, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EquityDataPoint {
  timestamp: number;
  iso: string;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  drawdown: number;
  fees: number;
}

interface ShadowEquityCurveProps {
  data: EquityDataPoint[];
  startingEquity: number;
  currentEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdown: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}

export function ShadowEquityCurve({
  data,
  startingEquity,
  currentEquity,
  realizedPnl,
  unrealizedPnl,
  maxDrawdown,
  winCount,
  lossCount,
  winRate,
}: ShadowEquityCurveProps) {
  const chartData = useMemo(() => {
    if (data.length === 0) {
      // Generate placeholder data
      const now = Date.now();
      return Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (24 - i) * 3600000,
        time: `${i}:00`,
        equity: startingEquity,
        drawdown: 0,
      }));
    }

    return data.map((d) => ({
      ...d,
      time: new Date(d.iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
    }));
  }, [data, startingEquity]);

  const totalPnl = realizedPnl + unrealizedPnl;
  const pnlPct = startingEquity > 0 ? (totalPnl / startingEquity) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-3 px-3 sm:px-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <CardTitle className="text-base sm:text-lg flex items-center gap-2">
            <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            Shadow Equity Curve
          </CardTitle>
          <div className="flex items-center gap-2">
            {totalPnl >= 0 ? (
              <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                <TrendingUp className="h-3 w-3 mr-1" />
                +{pnlPct.toFixed(2)}%
              </Badge>
            ) : (
              <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                <TrendingDown className="h-3 w-3 mr-1" />
                {pnlPct.toFixed(2)}%
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 sm:gap-3">
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Starting</div>
            <div className="text-sm sm:text-base font-bold font-mono">${startingEquity.toFixed(0)}</div>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Current</div>
            <div className={cn(
              "text-sm sm:text-base font-bold font-mono",
              currentEquity >= startingEquity ? "text-green-400" : "text-red-400"
            )}>
              ${currentEquity.toFixed(2)}
            </div>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Realized</div>
            <div className={cn(
              "text-sm sm:text-base font-bold font-mono",
              realizedPnl >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
            </div>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Unrealized</div>
            <div className={cn(
              "text-sm sm:text-base font-bold font-mono",
              unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
            </div>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Max DD</div>
            <div className="text-sm sm:text-base font-bold font-mono text-red-400">
              {maxDrawdown.toFixed(2)}%
            </div>
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/30 border">
            <div className="text-xs text-muted-foreground mb-0.5">Win Rate</div>
            <div className="text-sm sm:text-base font-bold font-mono">
              {(winRate * 100).toFixed(1)}%
              <span className="text-xs text-muted-foreground ml-1">
                ({winCount}/{winCount + lossCount})
              </span>
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="h-[250px] sm:h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--destructive))" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="equity"
                orientation="left"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v}`}
                domain={['auto', 'auto']}
              />
              <YAxis
                yAxisId="drawdown"
                orientation="right"
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${v}%`}
                domain={[0, 'auto']}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
                labelStyle={{ color: 'hsl(var(--foreground))' }}
                formatter={(value: number, name: string) => {
                  if (name === 'equity') return [`$${value.toFixed(2)}`, 'Equity'];
                  if (name === 'drawdown') return [`${value.toFixed(2)}%`, 'Drawdown'];
                  return [value, name];
                }}
              />
              <ReferenceLine
                yAxisId="equity"
                y={startingEquity}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="3 3"
                opacity={0.5}
              />
              <Area
                yAxisId="equity"
                type="monotone"
                dataKey="equity"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#equityGradient)"
              />
              <Area
                yAxisId="drawdown"
                type="monotone"
                dataKey="drawdown"
                stroke="hsl(var(--destructive))"
                strokeWidth={1}
                fill="url(#drawdownGradient)"
                opacity={0.5}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
