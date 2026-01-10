import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { format, startOfHour, subHours } from 'date-fns';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface TradeLog {
  result: string;
  pnl: number | null;
  eventStartTime: string;
  total: number;
  side: string; // UP or DOWN (bet side)
  marketOutcome?: string; // UP or DOWN (winning side)
}

interface HourlyPnLChartProps {
  trades: TradeLog[];
  hoursToShow?: number;
}

interface HourlyData {
  hour: string;
  hourLabel: string;
  pnl: number;
  wins: number;
  losses: number;
  trades: number;
  invested: number;
  upBets: number;
  downBets: number;
  upOutcomes: number;   // Markets where UP won
  downOutcomes: number; // Markets where DOWN won
}

export function HourlyPnLChart({ trades, hoursToShow = 24 }: HourlyPnLChartProps) {
  const hourlyData = useMemo(() => {
    const now = new Date();
    const hourBuckets = new Map<string, HourlyData>();

    // Initialize buckets for the last N hours
    for (let i = hoursToShow - 1; i >= 0; i--) {
      const hourStart = startOfHour(subHours(now, i));
      const key = hourStart.toISOString();
      hourBuckets.set(key, {
        hour: key,
        hourLabel: format(hourStart, 'HH:mm'),
        pnl: 0,
        wins: 0,
        losses: 0,
        trades: 0,
        invested: 0,
        upBets: 0,
        downBets: 0,
        upOutcomes: 0,
        downOutcomes: 0,
      });
    }

    // Aggregate trades into hourly buckets
    const settledTrades = trades.filter(t => t.result === 'WIN' || t.result === 'LOSS');
    
    for (const trade of settledTrades) {
      const tradeHour = startOfHour(new Date(trade.eventStartTime));
      const key = tradeHour.toISOString();
      const bucket = hourBuckets.get(key);
      
      if (bucket) {
        bucket.trades++;
        bucket.invested += trade.total;
        if (trade.pnl !== null) {
          bucket.pnl += trade.pnl;
        }
        if (trade.result === 'WIN') {
          bucket.wins++;
        } else if (trade.result === 'LOSS') {
          bucket.losses++;
        }
        // Track UP/DOWN bet side
        const side = (trade.side ?? '').toUpperCase();
        if (side === 'UP') {
          bucket.upBets++;
        } else if (side === 'DOWN') {
          bucket.downBets++;
        }
        
        // Track market outcome (which side won)
        // If we have explicit marketOutcome, use that
        // Otherwise derive: if we bet DOWN and won, DOWN won. If we bet DOWN and lost, UP won.
        let outcome = (trade.marketOutcome ?? '').toUpperCase();
        if (!outcome && (trade.result === 'WIN' || trade.result === 'LOSS')) {
          const betSide = side;
          if (trade.result === 'WIN') {
            outcome = betSide; // We won, so our side won
          } else {
            outcome = betSide === 'UP' ? 'DOWN' : 'UP'; // We lost, so opposite side won
          }
        }
        if (outcome === 'UP') {
          bucket.upOutcomes++;
        } else if (outcome === 'DOWN') {
          bucket.downOutcomes++;
        }
      }
    }

    return Array.from(hourBuckets.values());
  }, [trades, hoursToShow]);

  const summary = useMemo(() => {
    const withTrades = hourlyData.filter(h => h.trades > 0);
    const totalPnl = hourlyData.reduce((sum, h) => sum + h.pnl, 0);
    const profitableHours = withTrades.filter(h => h.pnl > 0).length;
    const losingHours = withTrades.filter(h => h.pnl < 0).length;
    const avgPnlPerHour = withTrades.length > 0 ? totalPnl / withTrades.length : 0;
    const bestHour = withTrades.reduce((best, h) => h.pnl > best.pnl ? h : best, { pnl: -Infinity, hourLabel: '-' });
    const worstHour = withTrades.reduce((worst, h) => h.pnl < worst.pnl ? h : worst, { pnl: Infinity, hourLabel: '-' });

    // Calculate Up/Down OUTCOME distribution (which side won the market)
    const totalUpOutcomes = hourlyData.reduce((sum, h) => sum + h.upOutcomes, 0);
    const totalDownOutcomes = hourlyData.reduce((sum, h) => sum + h.downOutcomes, 0);
    const totalOutcomes = totalUpOutcomes + totalDownOutcomes;
    const upOutcomePct = totalOutcomes > 0 ? (totalUpOutcomes / totalOutcomes) * 100 : 0;
    const downOutcomePct = totalOutcomes > 0 ? (totalDownOutcomes / totalOutcomes) * 100 : 0;

    // Calculate Win/Loss ratio
    const totalWins = hourlyData.reduce((sum, h) => sum + h.wins, 0);
    const totalLosses = hourlyData.reduce((sum, h) => sum + h.losses, 0);
    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    return {
      totalPnl,
      profitableHours,
      losingHours,
      avgPnlPerHour,
      bestHour: bestHour.pnl !== -Infinity ? bestHour : null,
      worstHour: worstHour.pnl !== Infinity ? worstHour : null,
      totalHoursWithTrades: withTrades.length,
      totalUpOutcomes,
      totalDownOutcomes,
      upOutcomePct,
      downOutcomePct,
      totalWins,
      totalLosses,
      winRate,
    };
  }, [hourlyData]);

  const isPositive = summary.totalPnl >= 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Hourly P&L (Last {hoursToShow}h)</CardTitle>
          <div className={`flex items-center gap-1 text-sm font-semibold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            ${summary.totalPnl.toFixed(2)}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
          <span>Avg/hr: <span className={summary.avgPnlPerHour >= 0 ? 'text-green-500' : 'text-red-500'}>${summary.avgPnlPerHour.toFixed(2)}</span></span>
          <span title="Win/Loss ratio">
            W/L: <span className={summary.winRate >= 50 ? 'text-green-500' : 'text-red-500'}>{summary.winRate.toFixed(0)}%</span>
            <span className="text-muted-foreground/70"> ({summary.totalWins}W/{summary.totalLosses}L)</span>
          </span>
          <span title="Market outcomes - which side won">
            Mkt: <span className="text-green-500">⬆{summary.upOutcomePct.toFixed(0)}%</span>
            {' / '}
            <span className="text-red-500">⬇{summary.downOutcomePct.toFixed(0)}%</span>
          </span>
          {summary.bestHour && <span>Best: {summary.bestHour.hourLabel} (+${summary.bestHour.pnl.toFixed(2)})</span>}
          {summary.worstHour && <span>Worst: {summary.worstHour.hourLabel} (${summary.worstHour.pnl.toFixed(2)})</span>}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={hourlyData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
            <XAxis 
              dataKey="hourLabel" 
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis 
              tick={{ fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${v}`}
            />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'hsl(var(--card))', 
                border: '1px solid hsl(var(--border))',
                borderRadius: '8px',
                fontSize: '12px',
              }}
              formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, 'P&L']}
              labelFormatter={(label) => `Hour: ${label}`}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0].payload as HourlyData;
                return (
                  <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-lg">
                    <p className="font-medium">{label}</p>
                    <p className={data.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                      P&L: ${data.pnl.toFixed(2)}
                    </p>
                    <p className="text-muted-foreground">
                      {data.wins}W / {data.losses}L ({data.trades} trades)
                    </p>
                    <p className="text-muted-foreground">
                      ⬆ {data.upBets} / ⬇ {data.downBets}
                    </p>
                    <p className="text-muted-foreground">
                      Invested: ${data.invested.toFixed(2)}
                    </p>
                  </div>
                );
              }}
            />
            <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
            <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
              {hourlyData.map((entry, index) => (
                <Cell 
                  key={`cell-${index}`} 
                  fill={entry.pnl >= 0 ? 'hsl(142, 70%, 45%)' : 'hsl(0, 70%, 50%)'}
                  fillOpacity={entry.trades > 0 ? 0.8 : 0.2}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
