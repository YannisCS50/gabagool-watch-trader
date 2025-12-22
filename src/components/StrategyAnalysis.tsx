import { useMemo } from 'react';
import { Trade } from '@/types/trade';
import { format, getHours, getDay } from 'date-fns';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis
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
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
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
