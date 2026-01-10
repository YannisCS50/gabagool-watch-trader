import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { format, startOfHour, subHours, startOfDay, endOfDay, differenceInHours, eachHourOfInterval } from 'date-fns';
import { TrendingUp, TrendingDown, CalendarIcon, Save, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

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
  upOutcomes: number;
  downOutcomes: number;
}

interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

export function HourlyPnLChart({ trades, hoursToShow = 24 }: HourlyPnLChartProps) {
  const [dateRange, setDateRange] = useState<DateRange>({ from: undefined, to: undefined });
  const [isSaving, setIsSaving] = useState(false);

  // Determine if we're using date range or default hours
  const isUsingDateRange = dateRange.from && dateRange.to;

  const hourlyData = useMemo(() => {
    const hourBuckets = new Map<string, HourlyData>();

    if (isUsingDateRange && dateRange.from && dateRange.to) {
      // Use date range
      const start = startOfDay(dateRange.from);
      const end = endOfDay(dateRange.to);
      const hours = eachHourOfInterval({ start, end });
      
      for (const hourStart of hours) {
        const key = hourStart.toISOString();
        hourBuckets.set(key, {
          hour: key,
          hourLabel: format(hourStart, 'MM/dd HH:mm'),
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
    } else {
      // Use default hours
      const now = new Date();
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
        let outcome = (trade.marketOutcome ?? '').toUpperCase();
        if (!outcome && (trade.result === 'WIN' || trade.result === 'LOSS')) {
          const betSide = side;
          if (trade.result === 'WIN') {
            outcome = betSide;
          } else {
            outcome = betSide === 'UP' ? 'DOWN' : 'UP';
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
  }, [trades, hoursToShow, dateRange, isUsingDateRange]);

  const summary = useMemo(() => {
    const withTrades = hourlyData.filter(h => h.trades > 0);
    const totalPnl = hourlyData.reduce((sum, h) => sum + h.pnl, 0);
    const totalInvested = hourlyData.reduce((sum, h) => sum + h.invested, 0);
    const profitableHours = withTrades.filter(h => h.pnl > 0).length;
    const losingHours = withTrades.filter(h => h.pnl < 0).length;
    const avgPnlPerHour = withTrades.length > 0 ? totalPnl / withTrades.length : 0;
    const bestHour = withTrades.reduce((best, h) => h.pnl > best.pnl ? h : best, { pnl: -Infinity, hourLabel: '-' });
    const worstHour = withTrades.reduce((worst, h) => h.pnl < worst.pnl ? h : worst, { pnl: Infinity, hourLabel: '-' });

    // Calculate Up/Down OUTCOME distribution
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
      totalInvested,
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
      totalTrades,
      winRate,
    };
  }, [hourlyData]);

  const handleSaveSnapshot = async () => {
    if (!isUsingDateRange || !dateRange.from || !dateRange.to) {
      toast.error('Selecteer eerst een datum range');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase.from('hourly_pnl_snapshots').insert({
        period_start: startOfDay(dateRange.from).toISOString(),
        period_end: endOfDay(dateRange.to).toISOString(),
        total_pnl: summary.totalPnl,
        total_invested: summary.totalInvested,
        total_wins: summary.totalWins,
        total_losses: summary.totalLosses,
        win_rate: summary.winRate,
        up_outcomes: summary.totalUpOutcomes,
        down_outcomes: summary.totalDownOutcomes,
        up_outcome_pct: summary.upOutcomePct,
        down_outcome_pct: summary.downOutcomePct,
        total_trades: summary.totalTrades,
        avg_pnl_per_hour: summary.avgPnlPerHour,
        profitable_hours: summary.profitableHours,
        losing_hours: summary.losingHours,
      });

      if (error) throw error;
      toast.success('Snapshot opgeslagen!');
    } catch (err) {
      console.error('Failed to save snapshot:', err);
      toast.error('Kon snapshot niet opslaan');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearDateRange = () => {
    setDateRange({ from: undefined, to: undefined });
  };

  const isPositive = summary.totalPnl >= 0;

  // Get period label
  const periodLabel = isUsingDateRange && dateRange.from && dateRange.to
    ? `${format(dateRange.from, 'dd/MM')} - ${format(dateRange.to, 'dd/MM')}`
    : `Last ${hoursToShow}h`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-medium">Hourly P&L</CardTitle>
            <span className="text-xs text-muted-foreground">({periodLabel})</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Date Range Picker */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs">
                  <CalendarIcon className="h-3 w-3 mr-1" />
                  {isUsingDateRange ? 'Range' : 'Select'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="range"
                  selected={{ from: dateRange.from, to: dateRange.to }}
                  onSelect={(range) => setDateRange({ from: range?.from, to: range?.to })}
                  numberOfMonths={1}
                  className={cn("p-3 pointer-events-auto")}
                />
                {isUsingDateRange && (
                  <div className="p-2 border-t">
                    <Button variant="ghost" size="sm" onClick={handleClearDateRange} className="w-full text-xs">
                      Reset to last {hoursToShow}h
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>

            {/* Save Button */}
            {isUsingDateRange && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={handleSaveSnapshot}
                disabled={isSaving}
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
                Save
              </Button>
            )}

            {/* P&L Total */}
            <div className={`flex items-center gap-1 text-sm font-semibold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
              {isPositive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              ${summary.totalPnl.toFixed(2)}
            </div>
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
                      Mkt: ⬆{data.upOutcomes} / ⬇{data.downOutcomes}
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
