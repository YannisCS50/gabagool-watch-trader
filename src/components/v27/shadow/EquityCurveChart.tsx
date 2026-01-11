import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, DollarSign, Percent } from 'lucide-react';
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, 
  ResponsiveContainer, Area, AreaChart, ReferenceLine
} from 'recharts';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { EquitySnapshot } from '@/hooks/useShadowDashboard';

interface EquityCurveChartProps {
  data: EquitySnapshot[];
  startingEquity: number;
  currentEquity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdown: number;
  winCount: number;
  lossCount: number;
  winRate: number;
}

export function EquityCurveChart({
  data,
  startingEquity,
  currentEquity,
  realizedPnl,
  unrealizedPnl,
  maxDrawdown,
  winCount,
  lossCount,
  winRate,
}: EquityCurveChartProps) {
  const totalPnl = realizedPnl + unrealizedPnl;
  const pnlPct = (totalPnl / startingEquity) * 100;

  const chartData = data.map((d) => ({
    ...d,
    time: format(d.timestamp, 'HH:mm'),
    drawdownPct: d.drawdown * 100,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" />
          Hypothetical PnL & Equity Curve
        </CardTitle>
        <CardDescription>
          Starting budget: ${startingEquity.toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Current Equity</span>
            </div>
            <div className="text-2xl font-bold">
              ${currentEquity.toFixed(2)}
            </div>
          </div>
          
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-1">
              {totalPnl >= 0 ? (
                <TrendingUp className="h-4 w-4 text-green-400" />
              ) : (
                <TrendingDown className="h-4 w-4 text-red-400" />
              )}
              <span className="text-sm text-muted-foreground">Total PnL</span>
            </div>
            <div className={cn(
              "text-2xl font-bold",
              totalPnl >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
              <span className="text-sm ml-1">({pnlPct.toFixed(2)}%)</span>
            </div>
          </div>
          
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-1">
              <Percent className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Win Rate</span>
            </div>
            <div className={cn(
              "text-2xl font-bold",
              winRate >= 50 ? "text-green-400" : "text-red-400"
            )}>
              {winRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {winCount}W / {lossCount}L
            </p>
          </div>
          
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-1">
              <TrendingDown className="h-4 w-4 text-red-400" />
              <span className="text-sm text-muted-foreground">Max Drawdown</span>
            </div>
            <div className="text-2xl font-bold text-red-400">
              {(maxDrawdown * 100).toFixed(2)}%
            </div>
          </div>
        </div>

        {/* Equity Chart */}
        {chartData.length > 0 ? (
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis 
                  dataKey="time" 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                />
                <YAxis 
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickFormatter={(v) => `$${v}`}
                  domain={['dataMin - 50', 'dataMax + 50']}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number) => [`$${value.toFixed(2)}`, 'Equity']}
                />
                <ReferenceLine 
                  y={startingEquity} 
                  stroke="hsl(var(--muted-foreground))" 
                  strokeDasharray="3 3"
                  label={{ value: 'Start', fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="hsl(var(--primary))"
                  fill="url(#equityGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-[300px] flex items-center justify-center bg-muted/20 rounded-lg">
            <p className="text-muted-foreground">No equity data yet</p>
          </div>
        )}

        {/* Realized vs Unrealized */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Realized PnL:</span>
            <span className={cn(
              "font-mono font-medium",
              realizedPnl >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Unrealized PnL:</span>
            <span className={cn(
              "font-mono font-medium",
              unrealizedPnl >= 0 ? "text-green-400" : "text-red-400"
            )}>
              {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
