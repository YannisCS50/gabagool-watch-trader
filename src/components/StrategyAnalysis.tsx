import { useMemo } from 'react';
import { Trade } from '@/types/trade';
import { format, getHours, getDay, differenceInMinutes } from 'date-fns';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, ScatterChart, Scatter, ZAxis
} from 'recharts';

interface StrategyAnalysisProps {
  trades: Trade[];
}

const COLORS = ['hsl(142, 70%, 45%)', 'hsl(0, 72%, 51%)', 'hsl(38, 92%, 50%)', 'hsl(199, 89%, 48%)', 'hsl(280, 65%, 60%)'];

export function TradingPatterns({ trades }: StrategyAnalysisProps) {
  const hourlyData = useMemo(() => {
    const hours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, volume: 0 }));
    trades.forEach(trade => {
      const hour = getHours(trade.timestamp);
      hours[hour].count++;
      hours[hour].volume += trade.total;
    });
    return hours.filter(h => h.count > 0);
  }, [trades]);

  const dayData = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => ({ day: d, count: 0, volume: 0 }));
    trades.forEach(trade => {
      const day = getDay(trade.timestamp);
      days[day].count++;
      days[day].volume += trade.total;
    });
    return days;
  }, [trades]);

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div className="glass rounded-lg p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Trading Hours (UTC)
        </h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hourlyData}>
              <XAxis 
                dataKey="hour" 
                tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                tickFormatter={(h) => `${h}:00`}
              />
              <YAxis 
                tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 15%, 18%)',
                  borderRadius: '8px',
                  fontFamily: 'JetBrains Mono',
                  fontSize: '12px',
                }}
              />
              <Bar dataKey="count" fill="hsl(142, 70%, 45%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Peak activity hours reveal when the trader is most active
        </p>
      </div>

      <div className="glass rounded-lg p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Day of Week Activity
        </h3>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dayData}>
              <XAxis 
                dataKey="day" 
                tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              />
              <YAxis 
                tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 15%, 18%)',
                  borderRadius: '8px',
                  fontFamily: 'JetBrains Mono',
                  fontSize: '12px',
                }}
              />
              <Bar dataKey="count" fill="hsl(199, 89%, 48%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Shows preferred trading days
        </p>
      </div>
    </div>
  );
}

export function OutcomeAnalysis({ trades }: StrategyAnalysisProps) {
  const outcomeData = useMemo(() => {
    const yes = trades.filter(t => t.outcome === 'Yes');
    const no = trades.filter(t => t.outcome === 'No');
    return [
      { name: 'Yes Positions', value: yes.length, volume: yes.reduce((s, t) => s + t.total, 0) },
      { name: 'No Positions', value: no.length, volume: no.reduce((s, t) => s + t.total, 0) },
    ];
  }, [trades]);

  const sideData = useMemo(() => {
    const buys = trades.filter(t => t.side === 'buy');
    const sells = trades.filter(t => t.side === 'sell');
    return [
      { name: 'Buys', value: buys.length, volume: buys.reduce((s, t) => s + t.total, 0) },
      { name: 'Sells', value: sells.length, volume: sells.reduce((s, t) => s + t.total, 0) },
    ];
  }, [trades]);

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div className="glass rounded-lg p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Outcome Preference
        </h3>
        <div className="h-48 flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={outcomeData}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={70}
                paddingAngle={5}
                dataKey="value"
                label={({ name, percent }) => `${name.split(' ')[0]} ${(percent * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {outcomeData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 15%, 18%)',
                  borderRadius: '8px',
                  fontFamily: 'JetBrains Mono',
                  fontSize: '12px',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-center gap-6 mt-2">
          {outcomeData.map((item, i) => (
            <div key={item.name} className="text-center">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                <span className="text-xs text-muted-foreground">{item.name}</span>
              </div>
              <span className="font-mono text-sm">${item.volume.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="glass rounded-lg p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
          Buy vs Sell Ratio
        </h3>
        <div className="h-48 flex items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={sideData}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={70}
                paddingAngle={5}
                dataKey="value"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                labelLine={false}
              >
                {sideData.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index + 2]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 15%, 18%)',
                  borderRadius: '8px',
                  fontFamily: 'JetBrains Mono',
                  fontSize: '12px',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-center gap-6 mt-2">
          {sideData.map((item, i) => (
            <div key={item.name} className="text-center">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i + 2] }} />
                <span className="text-xs text-muted-foreground">{item.name}</span>
              </div>
              <span className="font-mono text-sm">${item.volume.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MarketAnalysis({ trades }: StrategyAnalysisProps) {
  const marketData = useMemo(() => {
    const markets: Record<string, { count: number; volume: number; market: string }> = {};
    trades.forEach(trade => {
      const key = trade.market.substring(0, 40);
      if (!markets[key]) {
        markets[key] = { count: 0, volume: 0, market: trade.market };
      }
      markets[key].count++;
      markets[key].volume += trade.total;
    });
    return Object.values(markets)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 8);
  }, [trades]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Most Traded Markets
      </h3>
      <div className="space-y-3">
        {marketData.map((market, i) => {
          const maxVolume = marketData[0]?.volume || 1;
          const width = (market.volume / maxVolume) * 100;
          return (
            <div key={i} className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="truncate max-w-[70%]">{market.market}</span>
                <span className="font-mono text-muted-foreground">{market.count} trades</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-primary to-emerald-400 rounded-full transition-all"
                  style={{ width: `${width}%` }}
                />
              </div>
              <div className="text-right text-xs font-mono text-primary">
                ${market.volume.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PositionSizing({ trades }: StrategyAnalysisProps) {
  const sizeData = useMemo(() => {
    const ranges = [
      { label: '<$100', min: 0, max: 100, count: 0 },
      { label: '$100-500', min: 100, max: 500, count: 0 },
      { label: '$500-1k', min: 500, max: 1000, count: 0 },
      { label: '$1k-5k', min: 1000, max: 5000, count: 0 },
      { label: '>$5k', min: 5000, max: Infinity, count: 0 },
    ];
    
    trades.forEach(trade => {
      const range = ranges.find(r => trade.total >= r.min && trade.total < r.max);
      if (range) range.count++;
    });
    
    return ranges;
  }, [trades]);

  const avgSize = trades.length > 0 
    ? trades.reduce((s, t) => s + t.total, 0) / trades.length 
    : 0;

  const maxTrade = trades.length > 0 
    ? Math.max(...trades.map(t => t.total))
    : 0;

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Position Sizing Strategy
      </h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Avg Position</p>
          <p className="text-xl font-mono font-semibold text-primary">${avgSize.toFixed(0)}</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Max Position</p>
          <p className="text-xl font-mono font-semibold text-warning">${maxTrade.toFixed(0)}</p>
        </div>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={sizeData} layout="vertical">
            <XAxis type="number" tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }} />
            <YAxis 
              type="category" 
              dataKey="label" 
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              width={70}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
            />
            <Bar dataKey="count" fill="hsl(280, 65%, 60%)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Helper to determine if an outcome is the "positive" side of a binary market
const isPositiveOutcome = (outcome: string): boolean => {
  const positive = ['yes', 'up', 'over', 'true', 'win', 'higher', 'above'];
  return positive.some(p => outcome.toLowerCase().includes(p));
};

const isNegativeOutcome = (outcome: string): boolean => {
  const negative = ['no', 'down', 'under', 'false', 'lose', 'lower', 'below'];
  return negative.some(p => outcome.toLowerCase().includes(p));
};

// NEW: Arbitrage/Risk Analysis - detects when OUTCOME_A + OUTCOME_B < 1
export function ArbitrageAnalysis({ trades }: StrategyAnalysisProps) {
  // Separate complete arbs from exposed/unhedged positions
  const { completeArbs, exposedPositions } = useMemo(() => {
    const marketBuyTrades: Record<string, Record<string, Trade[]>> = {};
    
    // Only consider BUY trades
    trades.filter(t => t.side === 'buy').forEach(trade => {
      const key = trade.market;
      if (!marketBuyTrades[key]) marketBuyTrades[key] = {};
      if (!marketBuyTrades[key][trade.outcome]) marketBuyTrades[key][trade.outcome] = [];
      marketBuyTrades[key][trade.outcome].push(trade);
    });

    const complete: Array<{
      market: string;
      outcome1: string;
      outcome2: string;
      price1: number;
      price2: number;
      shares1: number;
      shares2: number;
      sum: number;
      spread: number;
      isArbitrage: boolean;
      minShares: number;
    }> = [];

    const exposed: Array<{
      market: string;
      outcome: string;
      avgPrice: number;
      totalShares: number;
      totalVolume: number;
      tradesCount: number;
    }> = [];

    Object.entries(marketBuyTrades).forEach(([market, outcomeMap]) => {
      const outcomes = Object.keys(outcomeMap);
      
      // Find positive and negative outcomes
      const positiveOutcome = outcomes.find(o => isPositiveOutcome(o));
      const negativeOutcome = outcomes.find(o => isNegativeOutcome(o));
      
      if (positiveOutcome && negativeOutcome) {
        // COMPLETE ARB: Both sides bought
        const posTrades = outcomeMap[positiveOutcome];
        const negTrades = outcomeMap[negativeOutcome];
        const avgPrice1 = posTrades.reduce((s, t) => s + t.price * t.shares, 0) / posTrades.reduce((s, t) => s + t.shares, 0);
        const avgPrice2 = negTrades.reduce((s, t) => s + t.price * t.shares, 0) / negTrades.reduce((s, t) => s + t.shares, 0);
        const shares1 = posTrades.reduce((s, t) => s + t.shares, 0);
        const shares2 = negTrades.reduce((s, t) => s + t.shares, 0);
        const sum = avgPrice1 + avgPrice2;
        
        complete.push({
          market: market.substring(0, 50),
          outcome1: positiveOutcome,
          outcome2: negativeOutcome,
          price1: avgPrice1,
          price2: avgPrice2,
          shares1,
          shares2,
          sum,
          spread: 1 - sum,
          isArbitrage: sum < 1,
          minShares: Math.min(shares1, shares2),
        });
      } else {
        // EXPOSED: Only one side bought
        outcomes.forEach(outcome => {
          const outcomeTrades = outcomeMap[outcome];
          const totalShares = outcomeTrades.reduce((s, t) => s + t.shares, 0);
          const totalVolume = outcomeTrades.reduce((s, t) => s + t.total, 0);
          const avgPrice = totalVolume / totalShares;
          
          exposed.push({
            market: market.substring(0, 50),
            outcome,
            avgPrice,
            totalShares,
            totalVolume,
            tradesCount: outcomeTrades.length,
          });
        });
      }
    });

    return {
      completeArbs: complete.sort((a, b) => a.sum - b.sum),
      exposedPositions: exposed.sort((a, b) => b.totalVolume - a.totalVolume),
    };
  }, [trades]);

  // Stats for complete arbs only
  const avgSum = completeArbs.length > 0
    ? completeArbs.reduce((s, d) => s + d.sum, 0) / completeArbs.length
    : 0;

  const profitableArbs = completeArbs.filter(d => d.isArbitrage);
  const unprofitableArbs = completeArbs.filter(d => !d.isArbitrage);
  
  const totalArbProfit = profitableArbs.reduce((s, a) => s + (a.spread * a.minShares), 0);
  const totalExposedVolume = exposedPositions.reduce((s, e) => s + e.totalVolume, 0);

  const sumDistribution = useMemo(() => {
    const ranges = [
      { label: '<0.90', min: 0, max: 0.90, count: 0, color: 'hsl(142, 70%, 45%)' },
      { label: '0.90-0.95', min: 0.90, max: 0.95, count: 0, color: 'hsl(142, 70%, 55%)' },
      { label: '0.95-1.00', min: 0.95, max: 1.00, count: 0, color: 'hsl(38, 92%, 50%)' },
      { label: '1.00-1.05', min: 1.00, max: 1.05, count: 0, color: 'hsl(0, 60%, 50%)' },
      { label: '>1.05', min: 1.05, max: 2, count: 0, color: 'hsl(0, 72%, 51%)' },
    ];

    completeArbs.forEach(d => {
      const range = ranges.find(r => d.sum >= r.min && d.sum < r.max);
      if (range) range.count++;
    });

    return ranges;
  }, [completeArbs]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Arbitrage & Risk Analysis
      </h3>
      
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Complete Arbs</p>
          <p className="text-xl font-mono font-semibold text-primary">{completeArbs.length}</p>
        </div>
        <div className="bg-warning/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Exposed Positions</p>
          <p className="text-xl font-mono font-semibold text-warning">{exposedPositions.length}</p>
        </div>
        <div className={`${avgSum < 1 ? 'bg-success/10' : 'bg-destructive/10'} rounded-lg p-3 text-center`}>
          <p className="text-xs text-muted-foreground">Avg Sum (Complete)</p>
          <p className={`text-xl font-mono font-semibold ${avgSum < 1 ? 'text-success' : 'text-destructive'}`}>
            {avgSum > 0 ? avgSum.toFixed(3) : '-'}
          </p>
        </div>
        <div className="bg-success/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Est. Arb Profit</p>
          <p className="text-xl font-mono font-semibold text-success">${totalArbProfit.toFixed(0)}</p>
        </div>
      </div>

      {/* Distribution Chart for Complete Arbs */}
      {completeArbs.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-2">
            ✅ Complete Arbitrage (YES + NO gekocht) - {completeArbs.length} markets
          </p>
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sumDistribution}>
                <XAxis 
                  dataKey="label" 
                  tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                />
                <YAxis tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(220, 18%, 10%)',
                    border: '1px solid hsl(220, 15%, 18%)',
                    borderRadius: '8px',
                    fontFamily: 'JetBrains Mono',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [value, 'Markets']}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {sumDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          
          {/* Show profitable arbs */}
          {profitableArbs.length > 0 && (
            <div className="mt-2 max-h-32 overflow-y-auto space-y-2">
              {profitableArbs.slice(0, 5).map((arb, i) => (
                <div key={i} className="bg-success/10 border border-success/20 rounded-lg p-2">
                  <p className="text-xs truncate mb-1">{arb.market}...</p>
                  <div className="flex justify-between text-xs font-mono">
                    <span>{arb.outcome1}: ${arb.price1.toFixed(3)}</span>
                    <span>{arb.outcome2}: ${arb.price2.toFixed(3)}</span>
                    <span className="text-success font-semibold">
                      Σ: {arb.sum.toFixed(3)} (+{(arb.spread * 100).toFixed(1)}%)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Show unprofitable arbs */}
          {unprofitableArbs.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-destructive mb-1">⚠️ Overpaid (sum &gt; 1): {unprofitableArbs.length} markets</p>
              <div className="max-h-24 overflow-y-auto space-y-1">
                {unprofitableArbs.slice(0, 3).map((arb, i) => (
                  <div key={i} className="bg-destructive/10 border border-destructive/20 rounded-lg p-2 text-xs">
                    <p className="truncate">{arb.market}...</p>
                    <span className="font-mono text-destructive">
                      {arb.outcome1}: ${arb.price1.toFixed(2)} + {arb.outcome2}: ${arb.price2.toFixed(2)} = {arb.sum.toFixed(3)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Exposed Positions */}
      {exposedPositions.length > 0 && (
        <div className="border-t border-border pt-4">
          <p className="text-xs font-semibold text-warning uppercase tracking-wider mb-2">
            ⏳ Exposed/Unhedged Positions (slechts 1 side) - ${totalExposedVolume.toFixed(0)} volume
          </p>
          <p className="text-xs text-muted-foreground mb-2">
            Deze posities hebben nog geen tegengestelde trade - mogelijk wachtend op betere prijs
          </p>
          <div className="max-h-40 overflow-y-auto space-y-2">
            {exposedPositions.slice(0, 10).map((pos, i) => (
              <div key={i} className="bg-warning/10 border border-warning/20 rounded-lg p-2">
                <div className="flex justify-between items-start">
                  <p className="text-xs truncate max-w-[60%]">{pos.market}...</p>
                  <span className={`text-xs font-semibold ${isPositiveOutcome(pos.outcome) ? 'text-success' : 'text-destructive'}`}>
                    {pos.outcome}
                  </span>
                </div>
                <div className="flex justify-between text-xs font-mono mt-1 text-muted-foreground">
                  <span>Avg: ${pos.avgPrice.toFixed(3)}</span>
                  <span>{pos.totalShares.toFixed(0)} shares</span>
                  <span>${pos.totalVolume.toFixed(0)}</span>
                  <span>{pos.tradesCount} trades</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {completeArbs.length === 0 && exposedPositions.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">
          Geen arbitrage data gevonden
        </p>
      )}
    </div>
  );
}

// NEW: Entry Price Analysis - relevant for arbitrage detection
export function EntryPriceAnalysis({ trades }: StrategyAnalysisProps) {
  const priceData = useMemo(() => {
    // Group trades by price ranges (0.01-0.99)
    const priceRanges = [
      { label: '0.01-0.20', min: 0.01, max: 0.20, count: 0, volume: 0 },
      { label: '0.20-0.40', min: 0.20, max: 0.40, count: 0, volume: 0 },
      { label: '0.40-0.60', min: 0.40, max: 0.60, count: 0, volume: 0 },
      { label: '0.60-0.80', min: 0.60, max: 0.80, count: 0, volume: 0 },
      { label: '0.80-0.99', min: 0.80, max: 0.99, count: 0, volume: 0 },
    ];
    
    trades.forEach(trade => {
      const range = priceRanges.find(r => trade.price >= r.min && trade.price < r.max);
      if (range) {
        range.count++;
        range.volume += trade.total;
      }
    });
    
    return priceRanges;
  }, [trades]);

  // Calculate average entry price
  const avgPrice = trades.length > 0
    ? trades.reduce((s, t) => s + t.price, 0) / trades.length
    : 0;

  // Find if trader prefers low probability (cheap) or high probability (expensive) outcomes
  const cheapTrades = trades.filter(t => t.price < 0.40);
  const expensiveTrades = trades.filter(t => t.price >= 0.60);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Entry Price Distribution
      </h3>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-muted/50 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Avg Price</p>
          <p className="text-lg font-mono font-semibold">${avgPrice.toFixed(2)}</p>
        </div>
        <div className="bg-success/10 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Low Prob</p>
          <p className="text-lg font-mono font-semibold text-success">{cheapTrades.length}</p>
        </div>
        <div className="bg-destructive/10 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">High Prob</p>
          <p className="text-lg font-mono font-semibold text-destructive">{expensiveTrades.length}</p>
        </div>
      </div>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={priceData}>
            <XAxis 
              dataKey="label" 
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 9, fontFamily: 'JetBrains Mono' }}
            />
            <YAxis tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
              formatter={(value, name) => [value, name === 'count' ? 'Trades' : 'Volume']}
            />
            <Bar dataKey="count" fill="hsl(38, 92%, 50%)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {avgPrice < 0.40 
          ? '🎲 Prefers low probability (high risk/reward) entries'
          : avgPrice > 0.60 
            ? '🎯 Prefers high probability (low risk/reward) entries'
            : '⚖️ Balanced approach to entry prices'}
      </p>
    </div>
  );
}

// NEW: Trade Velocity - how quickly does the trader execute
export function TradeVelocity({ trades }: StrategyAnalysisProps) {
  const velocityData = useMemo(() => {
    if (trades.length < 2) return [];
    
    const sorted = [...trades].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = differenceInMinutes(sorted[i].timestamp, sorted[i-1].timestamp);
      if (diff > 0 && diff < 1440) { // Ignore gaps > 24 hours
        intervals.push(diff);
      }
    }
    
    // Group intervals
    const groups = [
      { label: '<5m', min: 0, max: 5, count: 0 },
      { label: '5-15m', min: 5, max: 15, count: 0 },
      { label: '15m-1h', min: 15, max: 60, count: 0 },
      { label: '1-4h', min: 60, max: 240, count: 0 },
      { label: '>4h', min: 240, max: Infinity, count: 0 },
    ];
    
    intervals.forEach(interval => {
      const group = groups.find(g => interval >= g.min && interval < g.max);
      if (group) group.count++;
    });
    
    return groups;
  }, [trades]);

  const avgInterval = useMemo(() => {
    if (trades.length < 2) return 0;
    const sorted = [...trades].sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    let total = 0;
    let count = 0;
    for (let i = 1; i < sorted.length; i++) {
      const diff = differenceInMinutes(sorted[i].timestamp, sorted[i-1].timestamp);
      if (diff > 0 && diff < 1440) {
        total += diff;
        count++;
      }
    }
    return count > 0 ? total / count : 0;
  }, [trades]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Trade Velocity
      </h3>
      <div className="bg-muted/50 rounded-lg p-3 text-center mb-4">
        <p className="text-xs text-muted-foreground">Avg Time Between Trades</p>
        <p className="text-xl font-mono font-semibold">
          {avgInterval < 60 
            ? `${avgInterval.toFixed(0)} min`
            : `${(avgInterval / 60).toFixed(1)} hrs`}
        </p>
      </div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={velocityData}>
            <XAxis 
              dataKey="label" 
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 9, fontFamily: 'JetBrains Mono' }}
            />
            <YAxis tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 15%, 18%)',
                borderRadius: '8px',
                fontFamily: 'JetBrains Mono',
                fontSize: '12px',
              }}
            />
            <Bar dataKey="count" fill="hsl(142, 70%, 45%)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {avgInterval < 30 
          ? '⚡ High-frequency trader - acts quickly on opportunities'
          : avgInterval < 120 
            ? '🎯 Active trader - monitors markets regularly'
            : '🧘 Patient trader - waits for clear setups'}
      </p>
    </div>
  );
}

export function StrategyInsights({ trades }: StrategyAnalysisProps) {
  const insights = useMemo(() => {
    if (trades.length === 0) return [];
    
    const results: string[] = [];
    
    // Outcome preference
    const yesCount = trades.filter(t => t.outcome === 'Yes').length;
    const noCount = trades.filter(t => t.outcome === 'No').length;
    const yesPct = (yesCount / trades.length) * 100;
    
    if (yesPct > 60) {
      results.push(`🎯 Bullish bias: ${yesPct.toFixed(0)}% of positions are YES bets`);
    } else if (yesPct < 40) {
      results.push(`🔻 Bearish bias: ${(100 - yesPct).toFixed(0)}% of positions are NO bets`);
    } else {
      results.push(`⚖️ Balanced approach: roughly equal YES/NO positions`);
    }
    
    // Buy vs Sell
    const buyCount = trades.filter(t => t.side === 'buy').length;
    const buyPct = (buyCount / trades.length) * 100;
    
    if (buyPct > 70) {
      results.push(`📈 Position builder: ${buyPct.toFixed(0)}% of trades are buys (accumulating)`);
    } else if (buyPct < 30) {
      results.push(`📉 Active trader: ${(100 - buyPct).toFixed(0)}% of trades are sells (taking profits)`);
    }
    
    // Volume analysis
    const avgSize = trades.reduce((s, t) => s + t.total, 0) / trades.length;
    if (avgSize > 1000) {
      results.push(`💰 High-conviction sizing: Average position $${avgSize.toFixed(0)}`);
    } else if (avgSize < 200) {
      results.push(`🎲 Small position sizing: Testing markets with ~$${avgSize.toFixed(0)} average`);
    }
    
    // Price preference - NEW: relevant for arbitrage
    const avgPrice = trades.reduce((s, t) => s + t.price, 0) / trades.length;
    if (avgPrice < 0.35) {
      results.push(`🎰 Prefers long-shot bets (avg entry $${avgPrice.toFixed(2)}) - high risk/reward`);
    } else if (avgPrice > 0.65) {
      results.push(`🛡️ Prefers safe bets (avg entry $${avgPrice.toFixed(2)}) - low risk/consistent`);
    } else {
      results.push(`⚖️ Balanced risk profile (avg entry $${avgPrice.toFixed(2)})`);
    }
    
    // Trading frequency
    if (trades.length > 20) {
      results.push(`⚡ Active trader: ${trades.length} trades in sample period`);
    }
    
    return results;
  }, [trades]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Strategy Insights
      </h3>
      <div className="space-y-3">
        {insights.length > 0 ? (
          insights.map((insight, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span>{insight}</span>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            Not enough trade data to generate insights. Click "Refresh Data" to fetch more trades.
          </p>
        )}
      </div>
    </div>
  );
}
