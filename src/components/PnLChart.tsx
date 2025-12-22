import { Trade } from '@/types/trade';
import { useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar } from 'recharts';
import { format, subDays, subHours, startOfDay, startOfHour, differenceInMinutes } from 'date-fns';
import { Button } from '@/components/ui/button';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface PnLChartProps {
  trades: Trade[];
}

type TimeFrame = 'hourly' | 'daily';

interface ArbitragePair {
  market: string;
  timestamp: Date;
  yesPrice: number;
  noPrice: number;
  shares: number;
  profit: number;
}

// Detect arbitrage pairs: Yes + No buys in the same market within 5 minutes
function detectArbitragePairs(trades: Trade[]): ArbitragePair[] {
  const pairs: ArbitragePair[] = [];
  const buyTrades = trades.filter(t => t.side === 'buy');
  
  // Group by market
  const byMarket = new Map<string, Trade[]>();
  buyTrades.forEach(trade => {
    const key = trade.market;
    if (!byMarket.has(key)) {
      byMarket.set(key, []);
    }
    byMarket.get(key)!.push(trade);
  });

  // Find opposing outcome pairs within each market (Yes/No or Up/Down)
  byMarket.forEach((marketTrades, market) => {
    const outcome1 = marketTrades.filter(t => 
      t.outcome.toLowerCase() === 'yes' || t.outcome.toLowerCase() === 'up'
    );
    const outcome2 = marketTrades.filter(t => 
      t.outcome.toLowerCase() === 'no' || t.outcome.toLowerCase() === 'down'
    );
    
    const usedOutcome2Indices = new Set<number>();
    
    outcome1.forEach(trade1 => {
      // Find matching opposite outcome trade within 5 minutes
      const matchIdx = outcome2.findIndex((trade2, idx) => {
        if (usedOutcome2Indices.has(idx)) return false;
        const timeDiff = Math.abs(differenceInMinutes(trade1.timestamp, trade2.timestamp));
        return timeDiff <= 5;
      });
      
      if (matchIdx !== -1) {
        usedOutcome2Indices.add(matchIdx);
        const trade2 = outcome2[matchIdx];
        const shares = Math.min(trade1.shares, trade2.shares);
        const totalCost = trade1.price + trade2.price;
        
        // Arbitrage profit: $1.00 payout - cost per share
        const profitPerShare = 1.0 - totalCost;
        const profit = shares * profitPerShare;
        
        pairs.push({
          market,
          timestamp: trade1.timestamp,
          yesPrice: trade1.price,
          noPrice: trade2.price,
          shares,
          profit,
        });
      }
    });
  });

  return pairs;
}

export function PnLChart({ trades }: PnLChartProps) {
  const [timeFrame, setTimeFrame] = useState<TimeFrame>('daily');

  const { chartData, totalPnL, isPositive, pairCount, avgMargin } = useMemo(() => {
    // Detect arbitrage pairs
    const pairs = detectArbitragePairs(trades);
    
    const now = new Date();
    
    if (timeFrame === 'hourly') {
      // Last 24 hours
      const hours = Array.from({ length: 24 }, (_, i) => {
        const hour = startOfHour(subHours(now, 23 - i));
        const nextHour = startOfHour(subHours(now, 22 - i));
        
        const hourPairs = pairs.filter(p => 
          p.timestamp >= hour && p.timestamp < nextHour
        );
        
        const periodPnL = hourPairs.reduce((sum, p) => sum + p.profit, 0);
        
        return {
          label: format(hour, 'HH:mm'),
          pnl: Math.round(periodPnL * 100) / 100,
          pairs: hourPairs.length,
        };
      });
      
      // Calculate cumulative
      let cumulative = 0;
      const withCumulative = hours.map(item => {
        cumulative += item.pnl;
        return {
          ...item,
          cumulativePnL: Math.round(cumulative * 100) / 100,
        };
      });
      
      const total = cumulative;
      const totalPairs = pairs.filter(p => p.timestamp >= subHours(now, 24)).length;
      const margins = pairs
        .filter(p => p.timestamp >= subHours(now, 24))
        .map(p => 1 - (p.yesPrice + p.noPrice));
      const avgMarg = margins.length > 0 
        ? (margins.reduce((a, b) => a + b, 0) / margins.length) * 100 
        : 0;
      
      return {
        chartData: withCumulative,
        totalPnL: total,
        isPositive: total >= 0,
        pairCount: totalPairs,
        avgMargin: avgMarg,
      };
    } else {
      // Last 7 days
      const days = Array.from({ length: 7 }, (_, i) => {
        const day = startOfDay(subDays(now, 6 - i));
        const nextDay = startOfDay(subDays(now, 5 - i));
        
        const dayPairs = pairs.filter(p => 
          p.timestamp >= day && p.timestamp < nextDay
        );
        
        const periodPnL = dayPairs.reduce((sum, p) => sum + p.profit, 0);
        
        return {
          label: format(day, 'MMM dd'),
          pnl: Math.round(periodPnL * 100) / 100,
          pairs: dayPairs.length,
        };
      });
      
      // Calculate cumulative
      let cumulative = 0;
      const withCumulative = days.map(item => {
        cumulative += item.pnl;
        return {
          ...item,
          cumulativePnL: Math.round(cumulative * 100) / 100,
        };
      });
      
      const total = cumulative;
      const totalPairs = pairs.filter(p => p.timestamp >= subDays(now, 7)).length;
      const margins = pairs
        .filter(p => p.timestamp >= subDays(now, 7))
        .map(p => 1 - (p.yesPrice + p.noPrice));
      const avgMarg = margins.length > 0 
        ? (margins.reduce((a, b) => a + b, 0) / margins.length) * 100 
        : 0;
      
      return {
        chartData: withCumulative,
        totalPnL: total,
        isPositive: total >= 0,
        pairCount: totalPairs,
        avgMargin: avgMarg,
      };
    }
  }, [trades, timeFrame]);

  const gradientId = isPositive ? 'pnlGradientPositive' : 'pnlGradientNegative';
  const strokeColor = isPositive ? 'hsl(142, 70%, 45%)' : 'hsl(0, 70%, 50%)';

  return (
    <div className="glass rounded-lg p-4 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Arbitrage P/L
          </h2>
          <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono ${
            isPositive 
              ? 'bg-success/20 text-success' 
              : 'bg-destructive/20 text-destructive'
          }`}>
            {isPositive ? (
              <TrendingUp className="w-3 h-3" />
            ) : (
              <TrendingDown className="w-3 h-3" />
            )}
            {isPositive ? '+' : ''}{totalPnL.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            {pairCount} pairs • {avgMargin.toFixed(2)}% avg margin
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            variant={timeFrame === 'hourly' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTimeFrame('hourly')}
            className="text-xs h-7 px-2"
          >
            24H
          </Button>
          <Button
            variant={timeFrame === 'daily' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTimeFrame('daily')}
            className="text-xs h-7 px-2"
          >
            7D
          </Button>
        </div>
      </div>
      
      {/* Main Chart - Cumulative P/L */}
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="pnlGradientPositive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(142, 70%, 45%)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="pnlGradientNegative" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0, 70%, 50%)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="hsl(0, 70%, 50%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis 
              dataKey="label" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              interval={timeFrame === 'hourly' ? 3 : 0}
            />
            <YAxis 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              tickFormatter={(value) => `$${value}`}
            />
            <ReferenceLine y={0} stroke="hsl(215, 15%, 25%)" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
              labelStyle={{ color: 'hsl(210, 20%, 95%)' }}
              formatter={(value: number, name: string) => {
                if (name === 'cumulativePnL') {
                  return [`$${value.toFixed(2)}`, 'Cumulative P/L'];
                }
                return [value, name];
              }}
            />
            <Area
              type="monotone"
              dataKey="cumulativePnL"
              stroke={strokeColor}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Period Bar Chart */}
      <div className="h-20 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <XAxis 
              dataKey="label" 
              axisLine={false}
              tickLine={false}
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 9, fontFamily: 'JetBrains Mono' }}
              interval={timeFrame === 'hourly' ? 5 : 0}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '11px',
              }}
              formatter={(value: number, name: string) => {
                if (name === 'pnl') {
                  return [`$${value.toFixed(2)}`, 'Period P/L'];
                }
                if (name === 'pairs') {
                  return [value, 'Arb Pairs'];
                }
                return [value, name];
              }}
            />
            <Bar 
              dataKey="pnl" 
              fill="hsl(215, 70%, 50%)"
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      
      {/* Summary Stats */}
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        {chartData.slice(-4).map((item, idx) => (
          <div key={idx} className="p-2 rounded-lg bg-muted/30">
            <div className="text-[10px] text-muted-foreground font-mono">{item.label}</div>
            <div className={`text-xs font-mono font-semibold ${
              item.pnl >= 0 ? 'text-success' : 'text-destructive'
            }`}>
              {item.pnl >= 0 ? '+' : ''}${item.pnl.toFixed(0)}
            </div>
            <div className="text-[10px] text-muted-foreground">{item.pairs} pairs</div>
          </div>
        ))}
      </div>

      {/* Formula Explanation */}
      <div className="mt-3 text-[10px] text-muted-foreground text-center font-mono">
        P/L = shares × (1.00 - (ask_yes + ask_no))
      </div>
    </div>
  );
}
