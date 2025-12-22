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

// Arbitrage Analysis - ONLY shows markets where BOTH YES and NO were bought
// Helper to check if market is crypto-related
const isCryptoMarket = (market: string): boolean => {
  const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'xrp', 'crypto', 'doge', 'dogecoin'];
  const lowerMarket = market.toLowerCase();
  return cryptoKeywords.some(keyword => lowerMarket.includes(keyword));
};

export function ArbitrageAnalysis({ trades }: StrategyAnalysisProps) {
  // Helper function to calculate arb stats for a given set of trades
  const calculateArbStats = (tradesToAnalyze: Trade[]) => {
    const marketBuyTrades: Record<string, Record<string, Trade[]>> = {};
    
    tradesToAnalyze.filter(t => t.side === 'buy').forEach(trade => {
      const key = trade.market;
      if (!marketBuyTrades[key]) marketBuyTrades[key] = {};
      if (!marketBuyTrades[key][trade.outcome]) marketBuyTrades[key][trade.outcome] = [];
      marketBuyTrades[key][trade.outcome].push(trade);
    });

    const arbs: Array<{
      market: string;
      fullMarket: string;
      outcome1: string;
      outcome2: string;
      price1: number;
      price2: number;
      shares1: number;
      shares2: number;
      value1: number;  // NEW: total value for outcome1
      value2: number;  // NEW: total value for outcome2
      sum: number;
      spread: number;
      isArbitrage: boolean;
      minShares: number;
      hedgedVolume: number;
      isCrypto: boolean;
    }> = [];

    Object.entries(marketBuyTrades).forEach(([market, outcomeMap]) => {
      const outcomes = Object.keys(outcomeMap);
      const positiveOutcome = outcomes.find(o => isPositiveOutcome(o));
      const negativeOutcome = outcomes.find(o => isNegativeOutcome(o));
      
      if (positiveOutcome && negativeOutcome) {
        const posTrades = outcomeMap[positiveOutcome];
        const negTrades = outcomeMap[negativeOutcome];
        const avgPrice1 = posTrades.reduce((s, t) => s + t.price * t.shares, 0) / posTrades.reduce((s, t) => s + t.shares, 0);
        const avgPrice2 = negTrades.reduce((s, t) => s + t.price * t.shares, 0) / negTrades.reduce((s, t) => s + t.shares, 0);
        const shares1 = posTrades.reduce((s, t) => s + t.shares, 0);
        const shares2 = negTrades.reduce((s, t) => s + t.shares, 0);
        const value1 = posTrades.reduce((s, t) => s + t.total, 0);  // NEW: total value spent on outcome1
        const value2 = negTrades.reduce((s, t) => s + t.total, 0);  // NEW: total value spent on outcome2
        const sum = avgPrice1 + avgPrice2;
        const minShares = Math.min(shares1, shares2);
        
        arbs.push({
          market: market.substring(0, 50),
          fullMarket: market,
          outcome1: positiveOutcome,
          outcome2: negativeOutcome,
          price1: avgPrice1,
          price2: avgPrice2,
          shares1,
          shares2,
          value1,  // NEW
          value2,  // NEW
          sum,
          spread: 1 - sum,
          isArbitrage: sum < 1,
          minShares,
          hedgedVolume: minShares * sum,
          isCrypto: isCryptoMarket(market),
        });
      }
    });

    const sorted = arbs.sort((a, b) => a.sum - b.sum);
    const avgSum = sorted.length > 0 ? sorted.reduce((s, d) => s + d.sum, 0) / sorted.length : 0;
    const profitable = sorted.filter(d => d.isArbitrage);
    const unprofitable = sorted.filter(d => !d.isArbitrage);
    // Calculate net profit: gains from profitable arbs minus losses from unprofitable arbs
    const gains = profitable.reduce((s, a) => s + (a.spread * a.minShares), 0);
    const losses = unprofitable.reduce((s, a) => s + (Math.abs(a.spread) * a.minShares), 0);
    const netProfit = gains - losses;
    const volume = sorted.reduce((s, a) => s + a.hedgedVolume, 0);

    // Split by crypto vs other
    const cryptoArbs = sorted.filter(a => a.isCrypto);
    const otherArbs = sorted.filter(a => !a.isCrypto);
    
    const cryptoAvgSum = cryptoArbs.length > 0 ? cryptoArbs.reduce((s, d) => s + d.sum, 0) / cryptoArbs.length : 0;
    const otherAvgSum = otherArbs.length > 0 ? otherArbs.reduce((s, d) => s + d.sum, 0) / otherArbs.length : 0;
    
    const cryptoProfitable = cryptoArbs.filter(d => d.isArbitrage);
    const cryptoUnprofitable = cryptoArbs.filter(d => !d.isArbitrage);
    const cryptoGains = cryptoProfitable.reduce((s, a) => s + (a.spread * a.minShares), 0);
    const cryptoLosses = cryptoUnprofitable.reduce((s, a) => s + (Math.abs(a.spread) * a.minShares), 0);
    const cryptoProfit = cryptoGains - cryptoLosses;
    
    const otherProfitable = otherArbs.filter(d => d.isArbitrage);
    const otherUnprofitable = otherArbs.filter(d => !d.isArbitrage);
    const otherGains = otherProfitable.reduce((s, a) => s + (a.spread * a.minShares), 0);
    const otherLosses = otherUnprofitable.reduce((s, a) => s + (Math.abs(a.spread) * a.minShares), 0);
    const otherProfit = otherGains - otherLosses;

    return { 
      arbs: sorted, 
      avgSum, 
      profitable, 
      unprofitable, 
      profit: netProfit, 
      gains, 
      losses, 
      volume, 
      count: sorted.length,
      crypto: {
        arbs: cryptoArbs,
        avgSum: cryptoAvgSum,
        profit: cryptoProfit,
        count: cryptoArbs.length,
        profitable: cryptoProfitable.length,
        unprofitable: cryptoUnprofitable.length,
      },
      other: {
        arbs: otherArbs,
        avgSum: otherAvgSum,
        profit: otherProfit,
        count: otherArbs.length,
        profitable: otherProfitable.length,
        unprofitable: otherUnprofitable.length,
      }
    };
  };

  // Time-based filtering
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const stats = useMemo(() => {
    const allTime = calculateArbStats(trades);
    const today = calculateArbStats(trades.filter(t => new Date(t.timestamp) >= oneDayAgo));
    const week = calculateArbStats(trades.filter(t => new Date(t.timestamp) >= sevenDaysAgo));
    const month = calculateArbStats(trades.filter(t => new Date(t.timestamp) >= thirtyDaysAgo));
    
    return { allTime, today, week, month };
  }, [trades]);

  const sumDistribution = useMemo(() => {
    const ranges = [
      { label: '<0.90', min: 0, max: 0.90, count: 0, color: 'hsl(142, 70%, 45%)' },
      { label: '0.90-0.95', min: 0.90, max: 0.95, count: 0, color: 'hsl(142, 70%, 55%)' },
      { label: '0.95-1.00', min: 0.95, max: 1.00, count: 0, color: 'hsl(38, 92%, 50%)' },
      { label: '1.00-1.05', min: 1.00, max: 1.05, count: 0, color: 'hsl(0, 60%, 50%)' },
      { label: '>1.05', min: 1.05, max: 2, count: 0, color: 'hsl(0, 72%, 51%)' },
    ];

    stats.allTime.arbs.forEach(d => {
      const range = ranges.find(r => d.sum >= r.min && d.sum < r.max);
      if (range) range.count++;
    });

    return ranges;
  }, [stats.allTime.arbs]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Arbitrage Analysis (YES + NO Pairs Only)
      </h3>
      
      {/* Time Period Stats */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">
          📅 Performance per Periode
        </p>
        <div className="grid grid-cols-4 gap-2">
          {/* Today */}
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">24 uur</p>
            <p className={`text-lg font-mono font-semibold ${stats.today.avgSum > 0 ? (stats.today.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
              {stats.today.avgSum > 0 ? stats.today.avgSum.toFixed(3) : '-'}
            </p>
            <p className="text-xs text-muted-foreground">{stats.today.count} arbs</p>
            <p className={`text-xs font-mono ${stats.today.profit >= 0 ? 'text-success' : 'text-destructive'}`}>{stats.today.profit >= 0 ? '+' : ''}${stats.today.profit.toFixed(0)}</p>
          </div>
          
          {/* 7 Days */}
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">7 dagen</p>
            <p className={`text-lg font-mono font-semibold ${stats.week.avgSum > 0 ? (stats.week.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
              {stats.week.avgSum > 0 ? stats.week.avgSum.toFixed(3) : '-'}
            </p>
            <p className="text-xs text-muted-foreground">{stats.week.count} arbs</p>
            <p className={`text-xs font-mono ${stats.week.profit >= 0 ? 'text-success' : 'text-destructive'}`}>{stats.week.profit >= 0 ? '+' : ''}${stats.week.profit.toFixed(0)}</p>
          </div>
          
          {/* 30 Days */}
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">30 dagen</p>
            <p className={`text-lg font-mono font-semibold ${stats.month.avgSum > 0 ? (stats.month.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
              {stats.month.avgSum > 0 ? stats.month.avgSum.toFixed(3) : '-'}
            </p>
            <p className="text-xs text-muted-foreground">{stats.month.count} arbs</p>
            <p className={`text-xs font-mono ${stats.month.profit >= 0 ? 'text-success' : 'text-destructive'}`}>{stats.month.profit >= 0 ? '+' : ''}${stats.month.profit.toFixed(0)}</p>
          </div>
          
          {/* All Time */}
          <div className="bg-primary/10 rounded-lg p-3 text-center border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">All Time</p>
            <p className={`text-lg font-mono font-semibold ${stats.allTime.avgSum > 0 ? (stats.allTime.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
              {stats.allTime.avgSum > 0 ? stats.allTime.avgSum.toFixed(3) : '-'}
            </p>
            <p className="text-xs text-muted-foreground">{stats.allTime.count} arbs</p>
            <p className={`text-xs font-mono ${stats.allTime.profit >= 0 ? 'text-success' : 'text-destructive'}`}>{stats.allTime.profit >= 0 ? '+' : ''}${stats.allTime.profit.toFixed(0)}</p>
          </div>
        </div>
      </div>

      {/* Crypto vs Other Split */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">
          🔀 Crypto vs Andere Arbitrage
        </p>
        <div className="grid grid-cols-2 gap-4">
          {/* Crypto */}
          <div className="bg-amber-500/10 rounded-lg p-4 border border-amber-500/20">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">₿</span>
              <p className="text-sm font-semibold">Crypto (BTC/ETH/SOL/XRP)</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Avg YES+NO</p>
                <p className={`text-lg font-mono font-semibold ${stats.allTime.crypto.avgSum > 0 ? (stats.allTime.crypto.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
                  {stats.allTime.crypto.avgSum > 0 ? stats.allTime.crypto.avgSum.toFixed(3) : '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Profit</p>
                <p className={`text-lg font-mono font-semibold ${stats.allTime.crypto.profit >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {stats.allTime.crypto.profit >= 0 ? '+' : ''}${stats.allTime.crypto.profit.toFixed(0)}
                </p>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground text-center">
              {stats.allTime.crypto.count} arbs ({stats.allTime.crypto.profitable} ✓ / {stats.allTime.crypto.unprofitable} ✗)
            </div>
          </div>

          {/* Other */}
          <div className="bg-blue-500/10 rounded-lg p-4 border border-blue-500/20">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">📊</span>
              <p className="text-sm font-semibold">Andere Markets</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Avg YES+NO</p>
                <p className={`text-lg font-mono font-semibold ${stats.allTime.other.avgSum > 0 ? (stats.allTime.other.avgSum < 1 ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
                  {stats.allTime.other.avgSum > 0 ? stats.allTime.other.avgSum.toFixed(3) : '-'}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Profit</p>
                <p className={`text-lg font-mono font-semibold ${stats.allTime.other.profit >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {stats.allTime.other.profit >= 0 ? '+' : ''}${stats.allTime.other.profit.toFixed(0)}
                </p>
              </div>
            </div>
            <div className="mt-2 text-xs text-muted-foreground text-center">
              {stats.allTime.other.count} arbs ({stats.allTime.other.profitable} ✓ / {stats.allTime.other.unprofitable} ✗)
            </div>
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Total Arb Markets</p>
          <p className="text-xl font-mono font-semibold text-primary">{stats.allTime.count}</p>
        </div>
        <div className="bg-success/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Profitable</p>
          <p className="text-xl font-mono font-semibold text-success">{stats.allTime.profitable.length}</p>
        </div>
        <div className="bg-destructive/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Overpaid</p>
          <p className="text-xl font-mono font-semibold text-destructive">{stats.allTime.unprofitable.length}</p>
        </div>
        <div className={`${stats.allTime.profit >= 0 ? 'bg-success/10' : 'bg-destructive/10'} rounded-lg p-3 text-center`}>
          <p className="text-xs text-muted-foreground">Net Profit</p>
          <p className={`text-xl font-mono font-semibold ${stats.allTime.profit >= 0 ? 'text-success' : 'text-destructive'}`}>
            {stats.allTime.profit >= 0 ? '+' : ''}${stats.allTime.profit.toFixed(0)}
          </p>
        </div>
      </div>

      {/* Info box */}
      <div className="bg-muted/30 rounded-lg p-3 mb-4 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">ℹ️ Alleen echte arbitrage pairs</p>
        <p>
          Toont alleen markets waar zowel YES als NO gekocht zijn. 
          Hedged volume: <span className="font-mono text-primary">${stats.allTime.volume.toFixed(0)}</span>
        </p>
      </div>

      {/* Distribution Chart for Complete Arbs */}
      {stats.allTime.arbs.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-2">
            📊 Sum Distribution - {stats.allTime.arbs.length} arbitrage markets
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
          {stats.allTime.profitable.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-success mb-2">✅ Profitable ({stats.allTime.profitable.length})</p>
              <div className="max-h-48 overflow-y-auto space-y-2">
                {stats.allTime.profitable.map((arb, i) => (
                  <div key={i} className="bg-success/10 border border-success/20 rounded-lg p-3">
                    <p className="text-xs truncate mb-2 font-medium">{arb.fullMarket}</p>
                    <div className="grid grid-cols-2 gap-2 text-xs font-mono mb-2">
                      <div className="bg-success/10 rounded p-2">
                        <span className="text-muted-foreground">{arb.outcome1}: </span>
                        <span className="text-success">${arb.price1.toFixed(3)}</span>
                        <span className="text-muted-foreground ml-1">({arb.shares1.toFixed(0)} sh)</span>
                        <div className="text-primary font-semibold mt-1">Value: ${arb.value1.toFixed(2)}</div>
                      </div>
                      <div className="bg-destructive/10 rounded p-2">
                        <span className="text-muted-foreground">{arb.outcome2}: </span>
                        <span className="text-destructive">${arb.price2.toFixed(3)}</span>
                        <span className="text-muted-foreground ml-1">({arb.shares2.toFixed(0)} sh)</span>
                        <div className="text-primary font-semibold mt-1">Value: ${arb.value2.toFixed(2)}</div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        Sum: <span className="text-success font-semibold font-mono">{arb.sum.toFixed(3)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        Total: <span className="text-warning font-semibold font-mono">${(arb.value1 + arb.value2).toFixed(2)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        Edge: <span className="text-success font-semibold font-mono">+{(arb.spread * 100).toFixed(2)}%</span>
                      </span>
                      <span className="text-muted-foreground">
                        Profit: <span className="text-warning font-semibold font-mono">${(arb.spread * arb.minShares).toFixed(2)}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Show unprofitable arbs */}
          {stats.allTime.unprofitable.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-semibold text-destructive mb-2">
                ⚠️ Overpaid / sum &gt; 1 ({stats.allTime.unprofitable.length})
              </p>
              <div className="max-h-32 overflow-y-auto space-y-2">
                {stats.allTime.unprofitable.slice(0, 5).map((arb, i) => (
                  <div key={i} className="bg-destructive/10 border border-destructive/20 rounded-lg p-2 text-xs">
                    <p className="truncate mb-1">{arb.fullMarket}</p>
                    <div className="flex justify-between font-mono flex-wrap gap-1">
                      <span>{arb.outcome1}: ${arb.price1.toFixed(3)} <span className="text-primary">(${arb.value1.toFixed(0)})</span></span>
                      <span>{arb.outcome2}: ${arb.price2.toFixed(3)} <span className="text-primary">(${arb.value2.toFixed(0)})</span></span>
                      <span className="text-destructive font-semibold">
                        Σ: {arb.sum.toFixed(3)} ({((arb.sum - 1) * 100).toFixed(1)}% loss)
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {stats.allTime.arbs.length === 0 && (
        <div className="text-center py-8">
          <p className="text-muted-foreground mb-2">Geen arbitrage pairs gevonden</p>
          <p className="text-xs text-muted-foreground">
            Er zijn geen markets waar zowel YES als NO gekocht is.
            Alle trades zijn directional bets (slechts 1 outcome).
          </p>
        </div>
      )}
    </div>
  );
}

// NEW: Entry Price Analysis - shows extreme odds and near-certain trades
export function EntryPriceAnalysis({ trades }: StrategyAnalysisProps) {
  const analysis = useMemo(() => {
    const buyTrades = trades.filter(t => t.side === 'buy');
    
    // Near-certain trades (very high or very low probability)
    const nearCertain = buyTrades.filter(t => t.price >= 0.90 || t.price <= 0.10);
    const highProb = buyTrades.filter(t => t.price >= 0.90);
    const longshots = buyTrades.filter(t => t.price <= 0.10);
    
    // Extreme odds breakdown
    const ultraCertain = buyTrades.filter(t => t.price >= 0.95); // 95%+ probability
    const almostCertain = buyTrades.filter(t => t.price >= 0.90 && t.price < 0.95);
    const pennies = buyTrades.filter(t => t.price <= 0.05); // 5% or less
    const cheapLongshots = buyTrades.filter(t => t.price > 0.05 && t.price <= 0.10);
    
    // Mid-range trades
    const midRange = buyTrades.filter(t => t.price > 0.10 && t.price < 0.90);
    
    // Volume calculations
    const nearCertainVolume = nearCertain.reduce((s, t) => s + t.total, 0);
    const highProbVolume = highProb.reduce((s, t) => s + t.total, 0);
    const longshotVolume = longshots.reduce((s, t) => s + t.total, 0);
    const midRangeVolume = midRange.reduce((s, t) => s + t.total, 0);
    
    // Expected profit for near-certain trades
    // If you buy at 0.95 and it wins, you profit 0.05 per share
    const expectedProfitHighProb = highProb.reduce((s, t) => s + ((1 - t.price) * t.shares), 0);
    const expectedProfitLongshots = longshots.reduce((s, t) => s + (t.price * t.shares * (1/t.price - 1)), 0);
    
    return {
      nearCertain,
      highProb,
      longshots,
      ultraCertain,
      almostCertain,
      pennies,
      cheapLongshots,
      midRange,
      nearCertainVolume,
      highProbVolume,
      longshotVolume,
      midRangeVolume,
      expectedProfitHighProb,
      expectedProfitLongshots,
      total: buyTrades.length,
    };
  }, [trades]);

  // Price distribution for chart
  const priceData = useMemo(() => {
    const buyTrades = trades.filter(t => t.side === 'buy');
    const ranges = [
      { label: '≤5¢', min: 0, max: 0.05, count: 0, volume: 0, color: 'hsl(280, 65%, 60%)' },
      { label: '5-10¢', min: 0.05, max: 0.10, count: 0, volume: 0, color: 'hsl(280, 50%, 50%)' },
      { label: '10-40¢', min: 0.10, max: 0.40, count: 0, volume: 0, color: 'hsl(38, 70%, 50%)' },
      { label: '40-60¢', min: 0.40, max: 0.60, count: 0, volume: 0, color: 'hsl(215, 50%, 50%)' },
      { label: '60-90¢', min: 0.60, max: 0.90, count: 0, volume: 0, color: 'hsl(38, 70%, 50%)' },
      { label: '90-95¢', min: 0.90, max: 0.95, count: 0, volume: 0, color: 'hsl(142, 50%, 50%)' },
      { label: '≥95¢', min: 0.95, max: 1.01, count: 0, volume: 0, color: 'hsl(142, 70%, 45%)' },
    ];
    
    buyTrades.forEach(trade => {
      const range = ranges.find(r => trade.price >= r.min && trade.price < r.max);
      if (range) {
        range.count++;
        range.volume += trade.total;
      }
    });
    
    return ranges;
  }, [trades]);

  const nearCertainPct = analysis.total > 0 
    ? ((analysis.nearCertain.length / analysis.total) * 100).toFixed(1)
    : '0';

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        Entry Price & Extreme Odds Analysis
      </h3>
      
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className="bg-success/10 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Near Certain (≥90¢)</p>
          <p className="text-lg font-mono font-semibold text-success">{analysis.highProb.length}</p>
          <p className="text-xs text-muted-foreground">${analysis.highProbVolume.toFixed(0)} vol</p>
        </div>
        <div className="bg-purple-500/10 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Longshots (≤10¢)</p>
          <p className="text-lg font-mono font-semibold text-purple-400">{analysis.longshots.length}</p>
          <p className="text-xs text-muted-foreground">${analysis.longshotVolume.toFixed(0)} vol</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Mid-Range</p>
          <p className="text-lg font-mono font-semibold">{analysis.midRange.length}</p>
          <p className="text-xs text-muted-foreground">${analysis.midRangeVolume.toFixed(0)} vol</p>
        </div>
        <div className="bg-warning/10 rounded-lg p-2 text-center">
          <p className="text-xs text-muted-foreground">Extreme %</p>
          <p className="text-lg font-mono font-semibold text-warning">{nearCertainPct}%</p>
          <p className="text-xs text-muted-foreground">of all buys</p>
        </div>
      </div>

      {/* Price Distribution Chart */}
      <div className="h-32 mb-4">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={priceData}>
            <XAxis 
              dataKey="label" 
              tick={{ fill: 'hsl(215, 15%, 55%)', fontSize: 8, fontFamily: 'JetBrains Mono' }}
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
            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
              {priceData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Near-Certain Trades Detail */}
      {analysis.highProb.length > 0 && (
        <div className="mb-4 border-t border-border pt-3">
          <p className="text-xs font-semibold text-success uppercase tracking-wider mb-2">
            🎯 Near-Certain Trades (90¢+) - {analysis.highProb.length} trades
          </p>
          <div className="grid grid-cols-2 gap-2 mb-2 text-xs">
            <div className="bg-success/10 rounded p-2">
              <span className="text-muted-foreground">95¢+ (ultra-certain): </span>
              <span className="font-mono font-semibold">{analysis.ultraCertain.length}</span>
            </div>
            <div className="bg-success/10 rounded p-2">
              <span className="text-muted-foreground">90-95¢: </span>
              <span className="font-mono font-semibold">{analysis.almostCertain.length}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            💰 Max profit if all win: <span className="text-success font-mono">${analysis.expectedProfitHighProb.toFixed(0)}</span>
            <span className="ml-2">(avg {analysis.highProb.length > 0 ? ((1 - analysis.highProb.reduce((s,t) => s + t.price, 0) / analysis.highProb.length) * 100).toFixed(1) : 0}% edge per trade)</span>
          </p>
          <div className="max-h-24 overflow-y-auto space-y-1 mt-2">
            {analysis.ultraCertain.slice(0, 5).map((t, i) => (
              <div key={i} className="bg-success/5 rounded p-1 text-xs flex justify-between">
                <span className="truncate max-w-[60%]">{t.market}</span>
                <span className="font-mono">
                  {t.outcome} @ <span className="text-success">{(t.price * 100).toFixed(1)}¢</span>
                  <span className="text-muted-foreground ml-1">(+{((1-t.price)*100).toFixed(1)}%)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Longshot Trades Detail */}
      {analysis.longshots.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider mb-2">
            🎲 Longshot Trades (≤10¢) - {analysis.longshots.length} trades
          </p>
          <div className="grid grid-cols-2 gap-2 mb-2 text-xs">
            <div className="bg-purple-500/10 rounded p-2">
              <span className="text-muted-foreground">≤5¢ (pennies): </span>
              <span className="font-mono font-semibold">{analysis.pennies.length}</span>
            </div>
            <div className="bg-purple-500/10 rounded p-2">
              <span className="text-muted-foreground">5-10¢: </span>
              <span className="font-mono font-semibold">{analysis.cheapLongshots.length}</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            🎰 Potential payout: <span className="text-purple-400 font-mono">${analysis.longshots.reduce((s,t) => s + t.shares, 0).toFixed(0)}</span>
            <span className="ml-2">(if all hit)</span>
          </p>
          <div className="max-h-24 overflow-y-auto space-y-1 mt-2">
            {analysis.pennies.slice(0, 5).map((t, i) => (
              <div key={i} className="bg-purple-500/5 rounded p-1 text-xs flex justify-between">
                <span className="truncate max-w-[60%]">{t.market}</span>
                <span className="font-mono">
                  {t.outcome} @ <span className="text-purple-400">{(t.price * 100).toFixed(1)}¢</span>
                  <span className="text-muted-foreground ml-1">({(1/t.price).toFixed(0)}x)</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strategy Summary */}
      <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
        {analysis.nearCertain.length > analysis.midRange.length * 0.5 
          ? '📊 Strategie: Focus op "near-certain" trades met kleine maar frequente winsten'
          : analysis.longshots.length > analysis.total * 0.1
            ? '🎲 Strategie: Mix van longshots voor grote payouts'
            : '⚖️ Strategie: Gebalanceerde benadering met mid-range odds'}
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

// NEW: Closed Bets History - shows markets where positions were sold/closed
export function ClosedBetsHistory({ trades }: StrategyAnalysisProps) {
  const analysis = useMemo(() => {
    // Group trades by market AND outcome for proper tracking
    const positionTrades: Record<string, { buys: Trade[]; sells: Trade[] }> = {};
    
    trades.forEach(trade => {
      const key = `${trade.market}|||${trade.outcome}`;
      if (!positionTrades[key]) positionTrades[key] = { buys: [], sells: [] };
      if (trade.side === 'buy') {
        positionTrades[key].buys.push(trade);
      } else {
        positionTrades[key].sells.push(trade);
      }
    });
    
    // Process all positions with sells
    const allPositions = Object.entries(positionTrades)
      .filter(([_, data]) => data.sells.length > 0)
      .map(([key, data]) => {
        const [market, outcome] = key.split('|||');
        
        const buyVolume = data.buys.reduce((s, t) => s + t.total, 0);
        const buyShares = data.buys.reduce((s, t) => s + t.shares, 0);
        const avgBuyPrice = buyShares > 0 ? buyVolume / buyShares : 0;
        
        const sellVolume = data.sells.reduce((s, t) => s + t.total, 0);
        const sellShares = data.sells.reduce((s, t) => s + t.shares, 0);
        const avgSellPrice = sellShares > 0 ? sellVolume / sellShares : 0;
        
        // Realized P&L based on matched shares
        const closedShares = Math.min(buyShares, sellShares);
        const realizedPnL = sellVolume - (closedShares * avgBuyPrice);
        const pnlPercent = avgBuyPrice > 0 ? ((avgSellPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
        
        const remainingShares = buyShares - sellShares;
        const isFullyClosed = remainingShares <= 0.01; // Tolerance for rounding
        
        const lastSellTime = data.sells.reduce((max, t) => {
          const time = new Date(t.timestamp).getTime();
          return time > max ? time : max;
        }, 0);
        
        return {
          market,
          outcome,
          buyVolume,
          buyShares,
          avgBuyPrice,
          sellVolume,
          sellShares,
          avgSellPrice,
          closedShares,
          realizedPnL,
          pnlPercent,
          lastSellTime,
          remainingShares: Math.max(0, remainingShares),
          isFullyClosed,
        };
      })
      .sort((a, b) => b.lastSellTime - a.lastSellTime);
    
    // Split into fully closed and partially closed
    const fullyClosed = allPositions.filter(p => p.isFullyClosed);
    const partiallyClosed = allPositions.filter(p => !p.isFullyClosed);
    
    // Performance metrics
    const totalRealizedClosed = fullyClosed.reduce((s, c) => s + c.realizedPnL, 0);
    const totalRealizedPartial = partiallyClosed.reduce((s, c) => s + c.realizedPnL, 0);
    const totalRealized = totalRealizedClosed + totalRealizedPartial;
    
    const winningClosed = fullyClosed.filter(c => c.realizedPnL > 0);
    const losingClosed = fullyClosed.filter(c => c.realizedPnL < 0);
    
    const winRate = fullyClosed.length > 0 
      ? (winningClosed.length / fullyClosed.length) * 100 
      : 0;
    
    const avgWin = winningClosed.length > 0 
      ? winningClosed.reduce((s, c) => s + c.realizedPnL, 0) / winningClosed.length 
      : 0;
    
    const avgLoss = losingClosed.length > 0 
      ? losingClosed.reduce((s, c) => s + c.realizedPnL, 0) / losingClosed.length 
      : 0;
    
    const profitFactor = avgLoss !== 0 
      ? Math.abs(avgWin / avgLoss) 
      : avgWin > 0 ? Infinity : 0;
    
    return { 
      fullyClosed, 
      partiallyClosed, 
      totalRealized, 
      totalRealizedClosed,
      totalRealizedPartial,
      winningClosed, 
      losingClosed,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
    };
  }, [trades]);

  return (
    <div className="glass rounded-lg p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-4">
        📜 Gesloten Posities
      </h3>
      
      {/* Performance Summary */}
      <div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
        <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">📊 Performance</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Win Rate</p>
            <p className={`text-lg font-mono font-semibold ${analysis.winRate >= 50 ? 'text-success' : 'text-destructive'}`}>
              {analysis.winRate.toFixed(1)}%
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Profit Factor</p>
            <p className={`text-lg font-mono font-semibold ${analysis.profitFactor >= 1 ? 'text-success' : 'text-destructive'}`}>
              {analysis.profitFactor === Infinity ? '∞' : analysis.profitFactor.toFixed(2)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Avg Win</p>
            <p className="text-lg font-mono font-semibold text-success">
              +${analysis.avgWin.toFixed(2)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Avg Loss</p>
            <p className="text-lg font-mono font-semibold text-destructive">
              ${analysis.avgLoss.toFixed(2)}
            </p>
          </div>
        </div>
      </div>
      
      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Volledig Gesloten</p>
          <p className="text-xl font-mono font-semibold text-primary">{analysis.fullyClosed.length}</p>
        </div>
        <div className="bg-success/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Winst</p>
          <p className="text-xl font-mono font-semibold text-success">{analysis.winningClosed.length}</p>
        </div>
        <div className="bg-destructive/10 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground">Verlies</p>
          <p className="text-xl font-mono font-semibold text-destructive">{analysis.losingClosed.length}</p>
        </div>
        <div className={`${analysis.totalRealizedClosed >= 0 ? 'bg-success/10' : 'bg-destructive/10'} rounded-lg p-3 text-center`}>
          <p className="text-xs text-muted-foreground">Realized P&L</p>
          <p className={`text-xl font-mono font-semibold ${analysis.totalRealizedClosed >= 0 ? 'text-success' : 'text-destructive'}`}>
            {analysis.totalRealizedClosed >= 0 ? '+' : ''}${analysis.totalRealizedClosed.toFixed(2)}
          </p>
        </div>
      </div>
      
      {/* Fully Closed positions */}
      {analysis.fullyClosed.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold text-success mb-2">✅ Volledig Gesloten ({analysis.fullyClosed.length})</p>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {analysis.fullyClosed.map((bet, i) => (
              <div 
                key={i} 
                className={`${bet.realizedPnL >= 0 ? 'bg-success/5 border-success/20' : 'bg-destructive/5 border-destructive/20'} border rounded-lg p-3`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{bet.market}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className={bet.outcome.toLowerCase().includes('yes') || bet.outcome.toLowerCase().includes('up') ? 'text-success' : 'text-destructive'}>
                        {bet.outcome}
                      </span>
                      {' • '}{format(new Date(bet.lastSellTime), 'MMM dd HH:mm')}
                    </p>
                  </div>
                  <div className={`text-right ml-2 ${bet.realizedPnL >= 0 ? 'text-success' : 'text-destructive'}`}>
                    <p className="font-mono font-semibold">
                      {bet.realizedPnL >= 0 ? '+' : ''}${bet.realizedPnL.toFixed(2)}
                    </p>
                    <p className="text-xs font-mono">
                      {bet.pnlPercent >= 0 ? '+' : ''}{bet.pnlPercent.toFixed(1)}%
                    </p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-muted/30 rounded p-2">
                    <span className="text-muted-foreground">Buy: </span>
                    <span>${bet.avgBuyPrice.toFixed(3)}</span>
                    <span className="text-muted-foreground"> × {bet.buyShares.toFixed(0)}</span>
                    <div className="text-primary">Total: ${bet.buyVolume.toFixed(2)}</div>
                  </div>
                  <div className="bg-muted/30 rounded p-2">
                    <span className="text-muted-foreground">Sell: </span>
                    <span>${bet.avgSellPrice.toFixed(3)}</span>
                    <span className="text-muted-foreground"> × {bet.sellShares.toFixed(0)}</span>
                    <div className="text-primary">Total: ${bet.sellVolume.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Partially Closed positions */}
      {analysis.partiallyClosed.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-warning mb-2">⏳ Deels Gesloten ({analysis.partiallyClosed.length})</p>
          <div className="max-h-48 overflow-y-auto space-y-2">
            {analysis.partiallyClosed.map((bet, i) => (
              <div 
                key={i} 
                className="bg-warning/5 border border-warning/20 rounded-lg p-3"
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{bet.market}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className={bet.outcome.toLowerCase().includes('yes') || bet.outcome.toLowerCase().includes('up') ? 'text-success' : 'text-destructive'}>
                        {bet.outcome}
                      </span>
                      {' • '}{format(new Date(bet.lastSellTime), 'MMM dd HH:mm')}
                    </p>
                  </div>
                  <div className={`text-right ml-2 ${bet.realizedPnL >= 0 ? 'text-success' : 'text-destructive'}`}>
                    <p className="font-mono font-semibold">
                      {bet.realizedPnL >= 0 ? '+' : ''}${bet.realizedPnL.toFixed(2)}
                    </p>
                    <p className="text-xs font-mono text-warning">
                      {bet.remainingShares.toFixed(0)} open
                    </p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-muted/30 rounded p-2">
                    <span className="text-muted-foreground">Bought: </span>
                    <span>{bet.buyShares.toFixed(0)} @ ${bet.avgBuyPrice.toFixed(3)}</span>
                    <div className="text-primary">${bet.buyVolume.toFixed(2)}</div>
                  </div>
                  <div className="bg-muted/30 rounded p-2">
                    <span className="text-muted-foreground">Sold: </span>
                    <span>{bet.sellShares.toFixed(0)} @ ${bet.avgSellPrice.toFixed(3)}</span>
                    <div className="text-primary">${bet.sellVolume.toFixed(2)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {analysis.fullyClosed.length === 0 && analysis.partiallyClosed.length === 0 && (
        <div className="text-center py-8">
          <p className="text-muted-foreground mb-2">Geen gesloten posities</p>
          <p className="text-xs text-muted-foreground">
            Er zijn nog geen SELL trades gevonden. Alle posities zijn nog open.
          </p>
        </div>
      )}
    </div>
  );
}
