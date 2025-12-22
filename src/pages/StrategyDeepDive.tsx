import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { 
  ArrowLeft, 
  Clock, 
  TrendingUp, 
  Target, 
  Zap,
  AlertTriangle,
  BarChart3,
  GitBranch,
  Coins,
  Timer,
  Activity
} from 'lucide-react';
import { useTrades } from '@/hooks/useTrades';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  Legend,
  AreaChart,
  Area
} from 'recharts';

interface HedgePair {
  market: string;
  trade1: { outcome: string; price: number; shares: number; timestamp: Date; side: string };
  trade2: { outcome: string; price: number; shares: number; timestamp: Date; side: string };
  delaySeconds: number;
  combinedPrice: number;
  edge: number;
  category: 'arbitrage' | 'neutral' | 'risk';
  firstSide: 'Up' | 'Down';
  asset: 'BTC' | 'ETH' | 'Other';
  hourOfDay: number;
}

const StrategyDeepDive = () => {
  const { trades } = useTrades('gabagool22');

  const analysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market
    const marketGroups = new Map<string, typeof trades>();
    trades.forEach(t => {
      const key = t.market;
      if (!marketGroups.has(key)) marketGroups.set(key, []);
      marketGroups.get(key)!.push(t);
    });

    const hedgePairs: HedgePair[] = [];

    marketGroups.forEach((marketTrades, market) => {
      // Find buys for both outcomes
      const buys = marketTrades.filter(t => t.side === 'buy');
      const upBuys = buys.filter(t => t.outcome === 'Yes' || t.outcome.toLowerCase().includes('up') || t.outcome.toLowerCase().includes('above'));
      const downBuys = buys.filter(t => t.outcome === 'No' || t.outcome.toLowerCase().includes('down') || t.outcome.toLowerCase().includes('below'));

      if (upBuys.length > 0 && downBuys.length > 0) {
        // Match pairs by time proximity
        upBuys.forEach(upBuy => {
          const closestDown = downBuys.reduce((closest, down) => {
            const currentDiff = Math.abs(down.timestamp.getTime() - upBuy.timestamp.getTime());
            const closestDiff = closest ? Math.abs(closest.timestamp.getTime() - upBuy.timestamp.getTime()) : Infinity;
            return currentDiff < closestDiff ? down : closest;
          }, null as typeof downBuys[0] | null);

          if (closestDown) {
            const delayMs = Math.abs(closestDown.timestamp.getTime() - upBuy.timestamp.getTime());
            const delaySeconds = delayMs / 1000;
            const combinedPrice = upBuy.price + closestDown.price;
            const edge = (1 - combinedPrice) * 100;
            
            let category: 'arbitrage' | 'neutral' | 'risk' = 'neutral';
            if (combinedPrice < 0.98) category = 'arbitrage';
            else if (combinedPrice > 1.02) category = 'risk';

            const firstTrade = upBuy.timestamp < closestDown.timestamp ? upBuy : closestDown;
            const secondTrade = upBuy.timestamp < closestDown.timestamp ? closestDown : upBuy;
            const firstSide: 'Up' | 'Down' = firstTrade === upBuy ? 'Up' : 'Down';

            let asset: 'BTC' | 'ETH' | 'Other' = 'Other';
            const marketLower = market.toLowerCase();
            if (marketLower.includes('bitcoin') || marketLower.includes('btc')) asset = 'BTC';
            else if (marketLower.includes('ethereum') || marketLower.includes('eth')) asset = 'ETH';

            hedgePairs.push({
              market,
              trade1: { outcome: firstTrade.outcome, price: firstTrade.price, shares: firstTrade.shares, timestamp: firstTrade.timestamp, side: firstTrade.side },
              trade2: { outcome: secondTrade.outcome, price: secondTrade.price, shares: secondTrade.shares, timestamp: secondTrade.timestamp, side: secondTrade.side },
              delaySeconds,
              combinedPrice,
              edge,
              category,
              firstSide,
              asset,
              hourOfDay: firstTrade.timestamp.getUTCHours()
            });
          }
        });
      }
    });

    // Calculate statistics
    const totalPairs = hedgePairs.length;
    const arbitragePairs = hedgePairs.filter(p => p.category === 'arbitrage');
    const neutralPairs = hedgePairs.filter(p => p.category === 'neutral');
    const riskPairs = hedgePairs.filter(p => p.category === 'risk');

    const avgEdge = hedgePairs.reduce((sum, p) => sum + p.edge, 0) / totalPairs;
    const avgDelay = hedgePairs.reduce((sum, p) => sum + p.delaySeconds, 0) / totalPairs;

    // Delay distribution
    const delayBuckets = [
      { label: '<5s', min: 0, max: 5, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '5-30s', min: 5, max: 30, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '30-60s', min: 30, max: 60, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '1-5m', min: 60, max: 300, count: 0, avgEdge: 0, edges: [] as number[] },
      { label: '>5m', min: 300, max: Infinity, count: 0, avgEdge: 0, edges: [] as number[] },
    ];

    hedgePairs.forEach(p => {
      const bucket = delayBuckets.find(b => p.delaySeconds >= b.min && p.delaySeconds < b.max);
      if (bucket) {
        bucket.count++;
        bucket.edges.push(p.edge);
      }
    });

    delayBuckets.forEach(b => {
      b.avgEdge = b.edges.length > 0 ? b.edges.reduce((a, c) => a + c, 0) / b.edges.length : 0;
    });

    // Entry pattern analysis
    const upFirst = hedgePairs.filter(p => p.firstSide === 'Up');
    const downFirst = hedgePairs.filter(p => p.firstSide === 'Down');
    const avgUpFirstPrice = upFirst.reduce((sum, p) => sum + p.trade1.price, 0) / (upFirst.length || 1);
    const avgDownFirstPrice = downFirst.reduce((sum, p) => sum + p.trade1.price, 0) / (downFirst.length || 1);

    // Asset comparison
    const btcPairs = hedgePairs.filter(p => p.asset === 'BTC');
    const ethPairs = hedgePairs.filter(p => p.asset === 'ETH');
    
    const btcStats = {
      count: btcPairs.length,
      avgDelay: btcPairs.reduce((sum, p) => sum + p.delaySeconds, 0) / (btcPairs.length || 1),
      avgEdge: btcPairs.reduce((sum, p) => sum + p.edge, 0) / (btcPairs.length || 1),
      arbitrageRate: btcPairs.filter(p => p.category === 'arbitrage').length / (btcPairs.length || 1) * 100
    };
    
    const ethStats = {
      count: ethPairs.length,
      avgDelay: ethPairs.reduce((sum, p) => sum + p.delaySeconds, 0) / (ethPairs.length || 1),
      avgEdge: ethPairs.reduce((sum, p) => sum + p.edge, 0) / (ethPairs.length || 1),
      arbitrageRate: ethPairs.filter(p => p.category === 'arbitrage').length / (ethPairs.length || 1) * 100
    };

    // Hourly performance
    const hourlyStats = Array.from({ length: 24 }, (_, hour) => {
      const hourPairs = hedgePairs.filter(p => p.hourOfDay === hour);
      return {
        hour: `${hour.toString().padStart(2, '0')}:00`,
        count: hourPairs.length,
        avgEdge: hourPairs.reduce((sum, p) => sum + p.edge, 0) / (hourPairs.length || 1),
        riskRate: hourPairs.filter(p => p.category === 'risk').length / (hourPairs.length || 1) * 100
      };
    }).filter(h => h.count > 0);

    // Best opportunities (sorted by edge)
    const bestOpportunities = [...hedgePairs]
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 15);

    // Risk trades
    const riskTrades = riskPairs.sort((a, b) => b.combinedPrice - a.combinedPrice);

    // Scatter data for delay vs edge
    const scatterData = hedgePairs.map(p => ({
      delay: Math.min(p.delaySeconds, 300),
      edge: p.edge,
      category: p.category
    }));

    return {
      totalPairs,
      arbitrageCount: arbitragePairs.length,
      neutralCount: neutralPairs.length,
      riskCount: riskPairs.length,
      avgEdge,
      avgDelay,
      delayBuckets,
      upFirst: upFirst.length,
      downFirst: downFirst.length,
      avgUpFirstPrice,
      avgDownFirstPrice,
      btcStats,
      ethStats,
      hourlyStats,
      bestOpportunities,
      riskTrades,
      scatterData,
      hedgePairs
    };
  }, [trades]);

  if (!analysis) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading analysis...</div>
      </div>
    );
  }

  const pieData = [
    { name: 'Arbitrage', value: analysis.arbitrageCount, color: 'hsl(var(--success))' },
    { name: 'Neutral', value: analysis.neutralCount, color: 'hsl(var(--chart-4))' },
    { name: 'Risk', value: analysis.riskCount, color: 'hsl(var(--destructive))' },
  ];

  const assetComparisonData = [
    { 
      asset: 'Bitcoin', 
      trades: analysis.btcStats.count, 
      avgDelay: analysis.btcStats.avgDelay,
      avgEdge: analysis.btcStats.avgEdge,
      arbitrageRate: analysis.btcStats.arbitrageRate
    },
    { 
      asset: 'Ethereum', 
      trades: analysis.ethStats.count, 
      avgDelay: analysis.ethStats.avgDelay,
      avgEdge: analysis.ethStats.avgEdge,
      arbitrageRate: analysis.ethStats.arbitrageRate
    },
  ];

  const entryPatternData = [
    { side: 'Up First', count: analysis.upFirst, avgPrice: analysis.avgUpFirstPrice * 100 },
    { side: 'Down First', count: analysis.downFirst, avgPrice: analysis.avgDownFirstPrice * 100 },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link to="/" className="p-2 hover:bg-secondary rounded-lg transition-colors">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-primary" />
                Strategy Deep Dive
              </h1>
              <p className="text-sm text-muted-foreground">
                Comprehensive analysis of Gabagool22's trading patterns
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Overview Dashboard */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            Overview Dashboard
          </h2>
          
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Total Hedge Pairs</p>
                    <p className="text-2xl font-mono font-bold">{analysis.totalPairs}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Target className="w-5 h-5 text-primary" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Edge</p>
                    <p className={`text-2xl font-mono font-bold ${analysis.avgEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                      {analysis.avgEdge.toFixed(2)}%
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-success/10">
                    <TrendingUp className="w-5 h-5 text-success" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Hedge Delay</p>
                    <p className="text-2xl font-mono font-bold">{analysis.avgDelay.toFixed(0)}s</p>
                  </div>
                  <div className="p-2 rounded-lg bg-chart-4/10">
                    <Clock className="w-5 h-5 text-chart-4" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="glass">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">Arbitrage Rate</p>
                    <p className="text-2xl font-mono font-bold text-success">
                      {((analysis.arbitrageCount / analysis.totalPairs) * 100).toFixed(0)}%
                    </p>
                  </div>
                  <div className="p-2 rounded-lg bg-success/10">
                    <Zap className="w-5 h-5 text-success" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Distribution Pie Chart */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Trade Category Distribution</CardTitle>
              <CardDescription>Arbitrage (&lt;0.98) vs Neutral (0.98-1.02) vs Risk (&gt;1.02)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }}
                    />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Timing Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Timer className="w-5 h-5 text-primary" />
            Timing Analysis
          </h2>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Delay Distribution */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Hedge Delay Distribution</CardTitle>
                <CardDescription>Time between buying both sides</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.delayBuckets}>
                      <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number, name: string) => [
                          name === 'count' ? `${value} trades` : `${value.toFixed(2)}%`,
                          name === 'count' ? 'Count' : 'Avg Edge'
                        ]}
                      />
                      <Legend />
                      <Bar dataKey="count" fill="hsl(var(--primary))" name="Count" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Edge vs Delay Scatter */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Edge vs Delay Correlation</CardTitle>
                <CardDescription>Does waiting longer improve edge?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart>
                      <XAxis 
                        dataKey="delay" 
                        name="Delay (s)" 
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        label={{ value: 'Delay (seconds)', position: 'bottom', fill: 'hsl(var(--muted-foreground))' }}
                      />
                      <YAxis 
                        dataKey="edge" 
                        name="Edge %" 
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
                        label={{ value: 'Edge %', angle: -90, position: 'insideLeft', fill: 'hsl(var(--muted-foreground))' }}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => value.toFixed(2)}
                      />
                      <Scatter 
                        data={analysis.scatterData} 
                        fill="hsl(var(--primary))"
                        opacity={0.6}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Delay Bucket Edge */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Average Edge by Delay Bucket</CardTitle>
                <CardDescription>Which delay range yields best results?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.delayBuckets}>
                      <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => [`${value.toFixed(2)}%`, 'Avg Edge']}
                      />
                      <Bar dataKey="avgEdge" fill="hsl(var(--success))" name="Avg Edge %" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Hourly Performance */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Performance by Hour (UTC)</CardTitle>
                <CardDescription>When does the bot perform best?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[250px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analysis.hourlyStats}>
                      <XAxis dataKey="hour" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                      <Legend />
                      <Area type="monotone" dataKey="avgEdge" stroke="hsl(var(--success))" fill="hsl(var(--success))" fillOpacity={0.3} name="Avg Edge %" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Entry Strategy Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5 text-primary" />
            Entry Strategy Analysis
          </h2>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* First Side Bought */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Which Side is Bought First?</CardTitle>
                <CardDescription>Entry order pattern</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={entryPatternData} layout="vertical">
                      <XAxis type="number" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                      <YAxis type="category" dataKey="side" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} width={80} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                      />
                      <Bar dataKey="count" fill="hsl(var(--chart-4))" name="Count" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 text-center">
                  <div className="p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">Up First Avg Price</p>
                    <p className="text-lg font-mono font-bold">{(analysis.avgUpFirstPrice * 100).toFixed(1)}¢</p>
                  </div>
                  <div className="p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">Down First Avg Price</p>
                    <p className="text-lg font-mono font-bold">{(analysis.avgDownFirstPrice * 100).toFixed(1)}¢</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Entry Decision Logic */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">Entry Decision Criteria</CardTitle>
                <CardDescription>Inferred from trading patterns</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-primary">1</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Buy the Cheaper Side First</p>
                    <p className="text-xs text-muted-foreground">
                      {analysis.downFirst > analysis.upFirst ? 'Down' : 'Up'} is bought first {Math.max(analysis.downFirst, analysis.upFirst)} times 
                      ({((Math.max(analysis.downFirst, analysis.upFirst) / analysis.totalPairs) * 100).toFixed(0)}%)
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-success/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-success">2</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Target Entry Price &lt; 50¢</p>
                    <p className="text-xs text-muted-foreground">
                      Average first entry: {(Math.min(analysis.avgUpFirstPrice, analysis.avgDownFirstPrice) * 100).toFixed(1)}¢
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-chart-4/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-chart-4">3</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Hedge Within 30 Seconds</p>
                    <p className="text-xs text-muted-foreground">
                      {((analysis.delayBuckets[0].count + analysis.delayBuckets[1].count) / analysis.totalPairs * 100).toFixed(0)}% 
                      of hedges complete within 30s
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/50">
                  <div className="w-6 h-6 rounded-full bg-warning/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-mono text-warning">4</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium">Accept Risk If Edge Not Available</p>
                    <p className="text-xs text-muted-foreground">
                      {((analysis.riskCount / analysis.totalPairs) * 100).toFixed(0)}% of trades are risk-exposed (combined &gt; 1.02)
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Asset Comparison */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Coins className="w-5 h-5 text-primary" />
            Asset Comparison
          </h2>

          <Card className="glass">
            <CardContent className="pt-6">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left p-3 font-medium text-muted-foreground">Asset</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Trades</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Avg Delay</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Avg Edge</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Arbitrage Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assetComparisonData.map((row) => (
                      <tr key={row.asset} className="border-b border-border/50 hover:bg-secondary/30">
                        <td className="p-3 font-mono">{row.asset}</td>
                        <td className="p-3 text-right font-mono">{row.trades}</td>
                        <td className="p-3 text-right font-mono">{row.avgDelay.toFixed(1)}s</td>
                        <td className={`p-3 text-right font-mono ${row.avgEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                          {row.avgEdge.toFixed(2)}%
                        </td>
                        <td className="p-3 text-right font-mono text-success">{row.arbitrageRate.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 p-3 rounded-lg bg-secondary/50">
                <p className="text-xs text-muted-foreground">
                  <strong>Insight:</strong> {analysis.ethStats.avgEdge > analysis.btcStats.avgEdge 
                    ? `Ethereum markets show better average edge (${analysis.ethStats.avgEdge.toFixed(2)}% vs ${analysis.btcStats.avgEdge.toFixed(2)}%) despite longer delays, suggesting more pricing inefficiencies.`
                    : `Bitcoin markets show better average edge (${analysis.btcStats.avgEdge.toFixed(2)}% vs ${analysis.ethStats.avgEdge.toFixed(2)}%) with faster execution.`
                  }
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Risk Analysis */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-warning" />
            Risk Analysis
          </h2>

          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Risk-Exposed Trades (Combined &gt; 1.02)</CardTitle>
              <CardDescription>Trades where hedging resulted in net exposure</CardDescription>
            </CardHeader>
            <CardContent>
              {analysis.riskTrades.length > 0 ? (
                <div className="overflow-x-auto max-h-[300px]">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card">
                      <tr className="border-b border-border">
                        <th className="text-left p-2 font-medium text-muted-foreground">Market</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Combined</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Exposure</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Delay</th>
                        <th className="text-right p-2 font-medium text-muted-foreground">Hour</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.riskTrades.slice(0, 10).map((trade, i) => (
                        <tr key={i} className="border-b border-border/50 hover:bg-secondary/30">
                          <td className="p-2 font-mono truncate max-w-[200px]">{trade.market}</td>
                          <td className="p-2 text-right font-mono text-destructive">
                            {(trade.combinedPrice * 100).toFixed(1)}¢
                          </td>
                          <td className="p-2 text-right font-mono text-destructive">
                            {((trade.combinedPrice - 1) * 100).toFixed(2)}%
                          </td>
                          <td className="p-2 text-right font-mono">{trade.delaySeconds.toFixed(0)}s</td>
                          <td className="p-2 text-right font-mono">{trade.hourOfDay}:00</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">No risk-exposed trades found</p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Best Opportunities */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-success" />
            Best Arbitrage Opportunities
          </h2>

          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-sm">Top 15 Best Edges Captured</CardTitle>
              <CardDescription>Highest profit opportunities successfully hedged</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-[400px]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border">
                      <th className="text-left p-2 font-medium text-muted-foreground">Market</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Combined</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Edge</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Delay</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Side 1</th>
                      <th className="text-right p-2 font-medium text-muted-foreground">Side 2</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.bestOpportunities.map((opp, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-secondary/30">
                        <td className="p-2 font-mono truncate max-w-[200px]">{opp.market}</td>
                        <td className="p-2 text-right font-mono text-success">
                          {(opp.combinedPrice * 100).toFixed(1)}¢
                        </td>
                        <td className="p-2 text-right font-mono text-success font-bold">
                          +{opp.edge.toFixed(2)}%
                        </td>
                        <td className="p-2 text-right font-mono">{opp.delaySeconds.toFixed(0)}s</td>
                        <td className="p-2 text-right font-mono">
                          <Badge variant="outline" className="text-[10px]">
                            {opp.trade1.outcome} @ {(opp.trade1.price * 100).toFixed(0)}¢
                          </Badge>
                        </td>
                        <td className="p-2 text-right font-mono">
                          <Badge variant="outline" className="text-[10px]">
                            {opp.trade2.outcome} @ {(opp.trade2.price * 100).toFixed(0)}¢
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Decision Flow Diagram */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Inferred Decision Flow
          </h2>

          <Card className="glass">
            <CardContent className="pt-6">
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-primary/10 to-transparent border-l-4 border-primary">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-primary">1</span>
                  </div>
                  <div>
                    <p className="font-medium">Scan Markets</p>
                    <p className="text-sm text-muted-foreground">Monitor binary markets for pricing inefficiencies</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-chart-4/10 to-transparent border-l-4 border-chart-4">
                  <div className="w-10 h-10 rounded-full bg-chart-4/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-chart-4">2</span>
                  </div>
                  <div>
                    <p className="font-medium">Entry: Buy Cheaper Side First (&lt;50¢)</p>
                    <p className="text-sm text-muted-foreground">
                      Preference for {analysis.downFirst > analysis.upFirst ? 'Down' : 'Up'} side 
                      (avg entry: {(Math.min(analysis.avgUpFirstPrice, analysis.avgDownFirstPrice) * 100).toFixed(1)}¢)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-success/10 to-transparent border-l-4 border-success">
                  <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-success">3</span>
                  </div>
                  <div>
                    <p className="font-medium">Hedge: Target Combined &lt; 0.98</p>
                    <p className="text-sm text-muted-foreground">
                      {((analysis.arbitrageCount / analysis.totalPairs) * 100).toFixed(0)}% success rate achieving arbitrage edge
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-warning/10 to-transparent border-l-4 border-warning">
                  <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-warning">4</span>
                  </div>
                  <div>
                    <p className="font-medium">Timing: Complete within 30 seconds</p>
                    <p className="text-sm text-muted-foreground">
                      {((analysis.delayBuckets[0].count + analysis.delayBuckets[1].count) / analysis.totalPairs * 100).toFixed(0)}% 
                      of trades hedged within 30s, avg delay {analysis.avgDelay.toFixed(0)}s
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-destructive/10 to-transparent border-l-4 border-destructive">
                  <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center">
                    <span className="text-lg font-bold text-destructive">5</span>
                  </div>
                  <div>
                    <p className="font-medium">Risk Tolerance: Accept up to ~5% exposure</p>
                    <p className="text-sm text-muted-foreground">
                      {analysis.riskCount} trades ({((analysis.riskCount / analysis.totalPairs) * 100).toFixed(0)}%) 
                      ended with combined &gt; 1.02 when hedge wasn't available at target price
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
};

export default StrategyDeepDive;
