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
  Activity,
  Shield,
  ShieldAlert,
  DollarSign,
  TrendingDown,
  Layers,
  ArrowRight,
  CheckCircle2,
  XCircle,
  BookOpen,
  Code2,
  Lightbulb,
  Scale,
  Repeat,
  PieChart as PieChartIcon
} from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
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
  const { trades, positions } = useTrades('gabagool22');

  // Calculate position exposure and unrealized P&L
  const exposureAnalysis = useMemo(() => {
    if (positions.length === 0) return null;

    // Group positions by market
    const marketPositions = new Map<string, typeof positions>();
    positions.forEach(p => {
      if (!marketPositions.has(p.market)) marketPositions.set(p.market, []);
      marketPositions.get(p.market)!.push(p);
    });

    let totalExposedCapital = 0;
    let totalHedgedCapital = 0;
    let upExposedShares = 0;
    let downExposedShares = 0;
    let upExposedValue = 0;
    let downExposedValue = 0;
    const exposedPositions: Array<{
      market: string;
      side: string;
      exposedShares: number;
      exposedValue: number;
      pnl: number;
      avgPrice: number;
      currentPrice: number;
    }> = [];

    marketPositions.forEach((marketPos, market) => {
      const upPos = marketPos.find(p => 
        p.outcome === 'Yes' || p.outcome.toLowerCase().includes('up') || p.outcome.toLowerCase().includes('above')
      );
      const downPos = marketPos.find(p => 
        p.outcome === 'No' || p.outcome.toLowerCase().includes('down') || p.outcome.toLowerCase().includes('below')
      );

      const upShares = upPos?.shares || 0;
      const downShares = downPos?.shares || 0;
      const minShares = Math.min(upShares, downShares);
      
      // Hedged capital (matched shares)
      const hedgedValue = minShares * ((upPos?.avgPrice || 0) + (downPos?.avgPrice || 0));
      totalHedgedCapital += hedgedValue;

      // Exposed capital (unmatched shares)
      if (upShares > downShares && upPos) {
        const exposed = upShares - downShares;
        const exposedVal = exposed * upPos.avgPrice;
        upExposedShares += exposed;
        upExposedValue += exposedVal;
        totalExposedCapital += exposedVal;
        
        exposedPositions.push({
          market,
          side: 'Up',
          exposedShares: exposed,
          exposedValue: exposedVal,
          pnl: upPos.pnl || 0,
          avgPrice: upPos.avgPrice,
          currentPrice: upPos.currentPrice
        });
      } else if (downShares > upShares && downPos) {
        const exposed = downShares - upShares;
        const exposedVal = exposed * downPos.avgPrice;
        downExposedShares += exposed;
        downExposedValue += exposedVal;
        totalExposedCapital += exposedVal;
        
        exposedPositions.push({
          market,
          side: 'Down',
          exposedShares: exposed,
          exposedValue: exposedVal,
          pnl: downPos.pnl || 0,
          avgPrice: downPos.avgPrice,
          currentPrice: downPos.currentPrice
        });
      }
    });

    // Sort by exposure value
    const topExposed = [...exposedPositions].sort((a, b) => b.exposedValue - a.exposedValue).slice(0, 10);

    // Calculate total unrealized P&L
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const winningPositions = positions.filter(p => (p.pnl || 0) > 0);
    const losingPositions = positions.filter(p => (p.pnl || 0) < 0);
    const totalWinning = winningPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const totalLosing = losingPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);

    // Top winners and losers
    const topWinners = [...positions].filter(p => (p.pnl || 0) > 0).sort((a, b) => (b.pnl || 0) - (a.pnl || 0)).slice(0, 5);
    const topLosers = [...positions].filter(p => (p.pnl || 0) < 0).sort((a, b) => (a.pnl || 0) - (b.pnl || 0)).slice(0, 5);

    return {
      totalExposedCapital,
      totalHedgedCapital,
      exposurePercent: totalHedgedCapital + totalExposedCapital > 0 
        ? (totalExposedCapital / (totalHedgedCapital + totalExposedCapital)) * 100 
        : 0,
      upExposedShares,
      downExposedShares,
      upExposedValue,
      downExposedValue,
      topExposed,
      totalPnl,
      winningCount: winningPositions.length,
      losingCount: losingPositions.length,
      totalWinning,
      totalLosing,
      topWinners,
      topLosers
    };
  }, [positions]);

  // DCA Analysis - analyze buy patterns by price bucket
  const dcaAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    const buyTrades = trades.filter(t => t.side === 'buy');
    
    // Price buckets for entry analysis
    const priceBuckets = [
      { label: '< 20¢', min: 0, max: 0.20, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '20-35¢', min: 0.20, max: 0.35, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '35-45¢', min: 0.35, max: 0.45, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '45-50¢', min: 0.45, max: 0.50, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '50-55¢', min: 0.50, max: 0.55, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
      { label: '> 55¢', min: 0.55, max: 1.0, count: 0, totalShares: 0, totalValue: 0, avgSize: 0 },
    ];

    buyTrades.forEach(t => {
      const bucket = priceBuckets.find(b => t.price >= b.min && t.price < b.max);
      if (bucket) {
        bucket.count++;
        bucket.totalShares += t.shares;
        bucket.totalValue += t.total;
      }
    });

    priceBuckets.forEach(b => {
      b.avgSize = b.count > 0 ? b.totalShares / b.count : 0;
    });

    // Share size distribution
    const sizeBuckets = [
      { label: '1-5', min: 1, max: 5, count: 0 },
      { label: '6-10', min: 6, max: 10, count: 0 },
      { label: '11-15', min: 11, max: 15, count: 0 },
      { label: '16-20', min: 16, max: 20, count: 0 },
      { label: '> 20', min: 21, max: Infinity, count: 0 },
    ];

    buyTrades.forEach(t => {
      const bucket = sizeBuckets.find(b => t.shares >= b.min && t.shares <= b.max);
      if (bucket) bucket.count++;
    });

    // Calculate price improvement rate (DCA success)
    // Group by market and check if subsequent buys are at better prices
    const marketBuys = new Map<string, typeof buyTrades>();
    buyTrades.forEach(t => {
      const key = `${t.market}-${t.outcome}`;
      if (!marketBuys.has(key)) marketBuys.set(key, []);
      marketBuys.get(key)!.push(t);
    });

    let improvedBuys = 0;
    let subsequentBuys = 0;
    
    marketBuys.forEach((buys) => {
      if (buys.length < 2) return;
      
      // Sort by timestamp
      const sorted = [...buys].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const firstPrice = sorted[0].price;
      
      sorted.slice(1).forEach(buy => {
        subsequentBuys++;
        if (buy.price < firstPrice) improvedBuys++;
      });
    });

    const priceImprovementRate = subsequentBuys > 0 ? (improvedBuys / subsequentBuys) * 100 : 0;

    return {
      priceBuckets,
      sizeBuckets,
      priceImprovementRate,
      totalBuys: buyTrades.length,
      avgBuyPrice: buyTrades.reduce((sum, t) => sum + t.price, 0) / buyTrades.length,
      avgShareSize: buyTrades.reduce((sum, t) => sum + t.shares, 0) / buyTrades.length
    };
  }, [trades]);

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

        {/* Strategy Flow Diagram - ENHANCED FOR DEVELOPERS */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-primary" />
            Strategy Decision Flow
          </h2>

          {/* Developer Documentation Card with Accordions */}
          <Card className="glass border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-primary" />
                Gabagool22 Strategy Documentation
              </CardTitle>
              <CardDescription>
                Klik op een sectie om de volledige technische documentatie te bekijken
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Quick Stats Overview - Always Visible */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 p-4 rounded-lg bg-secondary/30 border border-border">
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-success">{analysis ? Math.round((analysis.arbitrageCount / analysis.totalPairs) * 100) : 0}%</p>
                  <p className="text-xs text-muted-foreground">Arbitrage Success</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-chart-4">{analysis?.avgDelay?.toFixed(0) || 0}s</p>
                  <p className="text-xs text-muted-foreground">Avg Hedge Time</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold">{dcaAnalysis ? (dcaAnalysis.avgBuyPrice * 100).toFixed(0) : 0}¢</p>
                  <p className="text-xs text-muted-foreground">Avg Entry Price</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold text-primary">{dcaAnalysis?.priceImprovementRate?.toFixed(0) || 0}%</p>
                  <p className="text-xs text-muted-foreground">DCA Improvement</p>
                </div>
              </div>

              <Accordion type="multiple" className="space-y-2">
                {/* Section 1: Strategy Overview */}
                <AccordionItem value="overview" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <Lightbulb className="w-4 h-4 text-primary" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Wat is deze strategie?</p>
                        <p className="text-xs text-muted-foreground font-normal">DCA Market Making op prediction markets uitgelegd</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3 text-primary">Het Kernprincipe: Gegarandeerde Winst door Arbitrage</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Deze bot exploiteert een fundamentele eigenschap van prediction markets: <strong>de uitkomsten zijn binair</strong>. 
                        Bij een markt over Bitcoin prijs zijn er maar twee mogelijkheden: de prijs gaat omhoog (Up) óf naar beneden (Down). 
                        Eén van deze twee zal altijd uitbetalen op $1.00.
                      </p>
                      
                      <div className="p-3 bg-success/10 rounded-lg border border-success/20 mb-4">
                        <p className="text-sm font-medium text-success mb-2">💡 De Arbitrage Logica:</p>
                        <p className="text-sm text-muted-foreground">
                          Als je <strong>Up shares koopt voor $0.45</strong> en <strong>Down shares koopt voor $0.50</strong>, 
                          dan is je totale investering $0.95. Maar één van de twee betaalt gegarandeerd $1.00 uit. 
                          <strong className="text-success"> Dat is 5.26% gegarandeerde winst!</strong>
                        </p>
                      </div>

                      <h4 className="font-semibold text-sm mb-2">Waarom DCA (Dollar Cost Averaging)?</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                        In plaats van één grote order te plaatsen (wat de markt kan bewegen en het moeilijker maakt om beide 
                        kanten te vullen), koopt de bot systematisch kleine batches van 5-20 shares. Dit heeft meerdere voordelen:
                      </p>
                      <ul className="space-y-2 text-sm text-muted-foreground">
                        <li className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
                          <span><strong>Prijsverbetering:</strong> {dcaAnalysis?.priceImprovementRate?.toFixed(0) || '?'}% van vervolgaankopen is goedkoper dan de eerste entry</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
                          <span><strong>Lagere marktimpact:</strong> Kleine orders bewegen de prijs minder dan grote orders</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
                          <span><strong>Flexibiliteit:</strong> Je kunt stoppen met kopen als de prijs ongunstig wordt</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 text-success mt-0.5 shrink-0" />
                          <span><strong>Betere gemiddelde prijs:</strong> Door te spreiden over prijsniveaus krijg je een betere average</span>
                        </li>
                      </ul>
                    </div>

                    <div className="p-4 rounded-lg bg-warning/10 border border-warning/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
                        <AlertTriangle className="w-4 h-4" />
                        Belangrijke Risicos
                      </h4>
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        <li>• <strong>Onvolledige hedges:</strong> Als je maar één kant kunt kopen, heb je directional exposure</li>
                        <li>• <strong>Liquiditeit:</strong> Niet altijd genoeg volume om beide kanten snel te vullen</li>
                        <li>• <strong>Timing:</strong> Prijzen kunnen bewegen voordat je de hedge completeert</li>
                        <li>• <strong>Fees:</strong> Transactiekosten eten in je edge</li>
                      </ul>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 2: The 4-Step Flow */}
                <AccordionItem value="flow" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-chart-4/20 flex items-center justify-center">
                        <GitBranch className="w-4 h-4 text-chart-4" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">De 4-Stappen Decision Flow</p>
                        <p className="text-xs text-muted-foreground font-normal">Scan → Analyze → Entry → Hedge</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    {/* Visual Flow Diagram */}
                    <div className="flex flex-col lg:flex-row items-stretch gap-2">
                      <div className="flex-1 p-3 rounded-lg bg-primary/10 border border-primary/30 text-center">
                        <Target className="w-6 h-6 text-primary mx-auto mb-1" />
                        <p className="text-xs font-bold">1. SCAN</p>
                        <p className="text-xs text-muted-foreground">Monitor markets</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-chart-4/10 border border-chart-4/30 text-center">
                        <BarChart3 className="w-6 h-6 text-chart-4 mx-auto mb-1" />
                        <p className="text-xs font-bold">2. ANALYZE</p>
                        <p className="text-xs text-muted-foreground">Check prices</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-success/10 border border-success/30 text-center">
                        <TrendingDown className="w-6 h-6 text-success mx-auto mb-1" />
                        <p className="text-xs font-bold">3. ENTRY</p>
                        <p className="text-xs text-muted-foreground">Buy cheap side</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
                      <div className="flex-1 p-3 rounded-lg bg-warning/10 border border-warning/30 text-center">
                        <Shield className="w-6 h-6 text-warning mx-auto mb-1" />
                        <p className="text-xs font-bold">4. HEDGE</p>
                        <p className="text-xs text-muted-foreground">Complete arb</p>
                      </div>
                    </div>

                    {/* Detailed Step Explanations */}
                    <div className="space-y-3">
                      <div className="p-4 rounded-lg bg-gradient-to-r from-primary/10 to-transparent border-l-4 border-primary">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">1</span>
                          Market Scanning
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De bot monitort continu alle actieve prediction markets. Voor elke markt haalt hij de laagste 
                          vraagprijs (lowest ask) op voor beide uitkomsten. Markten worden geprioriteerd op basis van 
                          de combined price - hoe lager de som van Up + Down, hoe aantrekkelijker de opportunity.
                        </p>
                        <div className="mt-3 p-3 bg-background/80 rounded font-mono text-xs overflow-x-auto">
                          <div className="text-muted-foreground">// Opportunity Detection</div>
                          <div><span className="text-primary">for each</span> market <span className="text-primary">in</span> activeMarkets:</div>
                          <div className="pl-4">upAsk = orderbook.getLowestAsk(<span className="text-success">"Up"</span>)</div>
                          <div className="pl-4">downAsk = orderbook.getLowestAsk(<span className="text-success">"Down"</span>)</div>
                          <div className="pl-4">combined = upAsk + downAsk</div>
                          <div className="pl-4"></div>
                          <div className="pl-4"><span className="text-primary">if</span> combined {"<"} <span className="text-chart-4">0.98</span>:</div>
                          <div className="pl-8">priority = <span className="text-success">HIGH</span> <span className="text-muted-foreground">// 2%+ edge</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-chart-4">1.00</span>:</div>
                          <div className="pl-8">priority = <span className="text-chart-4">MEDIUM</span></div>
                          <div className="pl-4"><span className="text-primary">else</span>:</div>
                          <div className="pl-8">priority = <span className="text-warning">LOW</span> <span className="text-muted-foreground">// No immediate arb</span></div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          <strong>Live data:</strong> Momenteel {analysis?.totalPairs || 0} hedge pairs geïdentificeerd
                        </p>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-chart-4/10 to-transparent border-l-4 border-chart-4">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-chart-4 text-primary-foreground flex items-center justify-center text-xs font-bold">2</span>
                          Price Analysis & Position Sizing
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De agressiviteit van de bot schaalt omgekeerd met de prijs. Bij lagere prijzen is het risico 
                          lager en de potentiële opbrengst hoger, dus worden grotere posities genomen.
                        </p>
                        <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-2">
                          <div className="p-3 bg-success/10 rounded border border-success/20">
                            <div className="text-sm font-mono text-success font-bold">{"<"} 35¢</div>
                            <div className="text-xs text-muted-foreground mt-1">Max: 20 shares</div>
                            <div className="text-xs text-success">AGGRESSIVE</div>
                          </div>
                          <div className="p-3 bg-chart-4/10 rounded border border-chart-4/20">
                            <div className="text-sm font-mono text-chart-4 font-bold">35-50¢</div>
                            <div className="text-xs text-muted-foreground mt-1">10-14 shares</div>
                            <div className="text-xs text-chart-4">STANDARD</div>
                          </div>
                          <div className="p-3 bg-warning/10 rounded border border-warning/20">
                            <div className="text-sm font-mono text-warning font-bold">50-55¢</div>
                            <div className="text-xs text-muted-foreground mt-1">5-8 shares</div>
                            <div className="text-xs text-warning">CAUTIOUS</div>
                          </div>
                          <div className="p-3 bg-destructive/10 rounded border border-destructive/20">
                            <div className="text-sm font-mono text-destructive font-bold">{">"}55¢</div>
                            <div className="text-xs text-muted-foreground mt-1">2-5 shares</div>
                            <div className="text-xs text-destructive">MINIMAL</div>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground mt-3">
                          <strong>Waarom?</strong> Bij een prijs van 30¢ heb je maximaal $0.30 risico per share maar 
                          $0.70 potentiële winst (als die kant wint). Bij 55¢ is dat $0.55 risico voor $0.45 winst - veel minder aantrekkelijk.
                        </p>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-success/10 to-transparent border-l-4 border-success">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-success text-success-foreground flex items-center justify-center text-xs font-bold">3</span>
                          Entry: Koop de Goedkoopste Kant Eerst
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          De bot begint altijd met de kant die het goedkoopst is. Dit maximaliseert de kans om 
                          een profitable hedge te completeren. Als de goedkope kant later duurder wordt, heb je 
                          al een goede entry. Als hij goedkoop blijft, kun je DCA-en.
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <div className="p-3 bg-background/50 rounded border border-border">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium">Down First</span>
                              <span className="text-lg font-mono font-bold text-primary">{analysis ? Math.round((analysis.downFirst / analysis.totalPairs) * 100) : '?'}%</span>
                            </div>
                            <p className="text-xs text-muted-foreground">Vaker goedkoper - mogelijk sentiment bias</p>
                          </div>
                          <div className="p-3 bg-background/50 rounded border border-border">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium">Up First</span>
                              <span className="text-lg font-mono font-bold">{analysis ? Math.round((analysis.upFirst / analysis.totalPairs) * 100) : '?'}%</span>
                            </div>
                            <p className="text-xs text-muted-foreground">Minder vaak de goedkoopste optie</p>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 rounded-lg bg-gradient-to-r from-warning/10 to-transparent border-l-4 border-warning">
                        <h4 className="font-semibold text-sm flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-warning text-warning-foreground flex items-center justify-center text-xs font-bold">4</span>
                          Hedge: Completeer de Arbitrage
                        </h4>
                        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                          Zodra er een positie is op één kant, zoekt de bot naar mogelijkheden om de andere kant 
                          te kopen zodat de gecombineerde prijs onder $1.00 komt. Dit is waar de gegarandeerde winst wordt gelocked.
                        </p>
                        <div className="mt-3 p-3 bg-background/80 rounded font-mono text-xs overflow-x-auto">
                          <div className="text-muted-foreground">// Hedge Decision Tree</div>
                          <div><span className="text-primary">function</span> evaluateHedge(myAvgPrice, otherSideAsk):</div>
                          <div className="pl-4">combined = myAvgPrice + otherSideAsk</div>
                          <div className="pl-4">edge = (1.00 - combined) * 100  <span className="text-muted-foreground">// % profit</span></div>
                          <div className="pl-4"></div>
                          <div className="pl-4"><span className="text-primary">if</span> combined {"<"} <span className="text-success">0.95</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-success">EXECUTE_MAX</span>  <span className="text-muted-foreground">// {">"} 5% edge, go all in</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-success">0.98</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-success">EXECUTE</span>  <span className="text-muted-foreground">// 2-5% edge, solid trade</span></div>
                          <div className="pl-4"><span className="text-primary">elif</span> combined {"<"} <span className="text-chart-4">1.00</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-chart-4">PARTIAL</span>  <span className="text-muted-foreground">// Small edge, partial fill</span></div>
                          <div className="pl-4"><span className="text-primary">else</span>:</div>
                          <div className="pl-8"><span className="text-primary">return</span> <span className="text-warning">WAIT</span>  <span className="text-muted-foreground">// No profit, hold position</span></div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-success/10 rounded">
                            <div className="text-lg font-mono font-bold text-success">{analysis?.arbitrageCount || 0}</div>
                            <div className="text-xs text-muted-foreground">Profitable ({"<"}98¢)</div>
                          </div>
                          <div className="p-2 bg-chart-4/10 rounded">
                            <div className="text-lg font-mono font-bold text-chart-4">{analysis?.neutralCount || 0}</div>
                            <div className="text-xs text-muted-foreground">Neutral</div>
                          </div>
                          <div className="p-2 bg-destructive/10 rounded">
                            <div className="text-lg font-mono font-bold text-destructive">{analysis?.riskCount || 0}</div>
                            <div className="text-xs text-muted-foreground">At Risk ({">"}102¢)</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 3: DCA Deep Dive */}
                <AccordionItem value="dca" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center">
                        <Repeat className="w-4 h-4 text-success" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">DCA Mechaniek in Detail</p>
                        <p className="text-xs text-muted-foreground font-normal">Waarom kleine batches beter werken dan grote orders</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Het DCA Principe Toegepast op Prediction Markets</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Dollar Cost Averaging is een bekende strategie in traditionele finance: in plaats van al je geld 
                        in één keer te investeren, spreid je je aankopen over tijd. Dit werkt bijzonder goed op prediction 
                        markets omdat prijzen volatiel zijn en er vaak geen duidelijke trend richting is.
                      </p>
                      
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="p-3 bg-background/50 rounded border border-border">
                          <h5 className="font-medium text-sm mb-2 flex items-center gap-2">
                            <TrendingDown className="w-4 h-4 text-success" />
                            Voordelen van DCA
                          </h5>
                          <ul className="space-y-1 text-xs text-muted-foreground">
                            <li>• Vermindert timing risico</li>
                            <li>• Betere average entry price</li>
                            <li>• Flexibiliteit om te stoppen</li>
                            <li>• Minder marktimpact per trade</li>
                            <li>• Emotie uit de beslissing</li>
                          </ul>
                        </div>
                        <div className="p-3 bg-background/50 rounded border border-border">
                          <h5 className="font-medium text-sm mb-2 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-warning" />
                            Nadelen van DCA
                          </h5>
                          <ul className="space-y-1 text-xs text-muted-foreground">
                            <li>• Meer transacties = meer fees</li>
                            <li>• Kan langzamer zijn dan nodig</li>
                            <li>• Mist soms de beste prijs</li>
                            <li>• Complexere execution logic</li>
                            <li>• Vereist constante monitoring</li>
                          </ul>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-success/10 border border-success/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-success">
                        <CheckCircle2 className="w-4 h-4" />
                        DCA Performance van Gabagool22
                      </h4>
                      <div className="grid grid-cols-3 gap-4 mt-3">
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold text-success">{dcaAnalysis?.priceImprovementRate?.toFixed(0) || '?'}%</p>
                          <p className="text-xs text-muted-foreground">Vervolgkopen goedkoper</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold">{dcaAnalysis?.avgShareSize?.toFixed(1) || '?'}</p>
                          <p className="text-xs text-muted-foreground">Gem. shares per trade</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-mono font-bold">{dcaAnalysis?.totalBuys || '?'}</p>
                          <p className="text-xs text-muted-foreground">Totaal buy trades</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-3">
                        Dit betekent dat in {dcaAnalysis?.priceImprovementRate?.toFixed(0) || '?'}% van de gevallen waar de bot 
                        een tweede (of latere) aankoop deed, die aankoop goedkoper was dan de eerste entry. 
                        Dit valideert de DCA approach.
                      </p>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 4: Risk Management */}
                <AccordionItem value="risk" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-warning/20 flex items-center justify-center">
                        <Scale className="w-4 h-4 text-warning" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Risk Management & Exposure</p>
                        <p className="text-xs text-muted-foreground font-normal">Hoe de bot risico beheert en exposure limiteert</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Hedged vs Exposed Capital</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                        Niet alle posities zijn volledig gehedged. Sommige markten hebben een onbalans tussen 
                        Up en Down shares. Dit exposed capital heeft directional risk - als de verkeerde kant wint, 
                        verlies je dat bedrag.
                      </p>
                      
                      {exposureAnalysis && (
                        <div className="grid grid-cols-2 gap-4">
                          <div className="p-3 bg-success/10 rounded border border-success/20 text-center">
                            <Shield className="w-6 h-6 text-success mx-auto mb-2" />
                            <p className="text-xl font-mono font-bold text-success">${exposureAnalysis.totalHedgedCapital.toFixed(0)}</p>
                            <p className="text-xs text-muted-foreground">Hedged Capital</p>
                            <p className="text-xs text-success">{(100 - exposureAnalysis.exposurePercent).toFixed(1)}% beschermd</p>
                          </div>
                          <div className="p-3 bg-warning/10 rounded border border-warning/20 text-center">
                            <ShieldAlert className="w-6 h-6 text-warning mx-auto mb-2" />
                            <p className="text-xl font-mono font-bold text-warning">${exposureAnalysis.totalExposedCapital.toFixed(0)}</p>
                            <p className="text-xs text-muted-foreground">Exposed Capital</p>
                            <p className="text-xs text-warning">{exposureAnalysis.exposurePercent.toFixed(1)}% at risk</p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="p-4 rounded-lg bg-background/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3">Risk Categorieën</h4>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between p-2 bg-success/10 rounded">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-success" />
                            <span className="text-sm">Arbitrage Trades ({"<"}98¢)</span>
                          </div>
                          <span className="font-mono text-sm text-success">{analysis?.arbitrageCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Gegarandeerde winst van 2%+ ongeacht uitkomst. Dit is het doel van de strategie.
                        </p>
                        
                        <div className="flex items-center justify-between p-2 bg-chart-4/10 rounded mt-3">
                          <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4 text-chart-4" />
                            <span className="text-sm">Neutral Trades (98-102¢)</span>
                          </div>
                          <span className="font-mono text-sm text-chart-4">{analysis?.neutralCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Breakeven of kleine winst/verlies. Acceptabel als opstap naar betere prijzen.
                        </p>
                        
                        <div className="flex items-center justify-between p-2 bg-destructive/10 rounded mt-3">
                          <div className="flex items-center gap-2">
                            <XCircle className="w-4 h-4 text-destructive" />
                            <span className="text-sm">Risk Trades ({">"}102¢)</span>
                          </div>
                          <span className="font-mono text-sm text-destructive">{analysis?.riskCount || 0} trades</span>
                        </div>
                        <p className="text-xs text-muted-foreground px-2">
                          Gegarandeerd verlies als beide kanten tot expiry worden gehouden. Kan wijzen op 
                          directional bets of timing issues.
                        </p>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Section 5: Developer Implementation Guide */}
                <AccordionItem value="implementation" className="border border-border rounded-lg px-4 bg-card/50">
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-destructive/20 flex items-center justify-center">
                        <Code2 className="w-4 h-4 text-destructive" />
                      </div>
                      <div className="text-left">
                        <p className="font-semibold text-sm">Developer Implementation Guide</p>
                        <p className="text-xs text-muted-foreground font-normal">Technische details voor het bouwen van vergelijkbare bots</p>
                      </div>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="space-y-4 pt-2">
                    <div className="p-4 rounded-lg bg-muted/50 border border-border">
                      <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-warning" />
                        Kritieke Implementatie Overwegingen
                      </h4>
                      <div className="space-y-3">
                        <div className="p-3 bg-background/50 rounded border-l-4 border-primary">
                          <h5 className="font-medium text-sm text-primary">1. Latency is Cruciaal</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            De gemiddelde hedge delay is {analysis?.avgDelay?.toFixed(0) || '?'} seconden. Trades met {"<"}5s delay 
                            hebben significant betere edges. Investeer in snelle API connections en co-location indien mogelijk.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-chart-4">
                          <h5 className="font-medium text-sm text-chart-4">2. Order Book Monitoring</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Real-time orderbook data is essentieel. Gebruik WebSocket connections in plaats van REST polling. 
                            Track niet alleen de beste prijzen maar ook de diepte om je order sizing te bepalen.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-success">
                          <h5 className="font-medium text-sm text-success">3. Position Tracking</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Houd per markt bij: totale shares per kant, gemiddelde entry prijs, en de unrealized P&L. 
                            Dit bepaalt je hedge sizing en urgentie.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-warning">
                          <h5 className="font-medium text-sm text-warning">4. Error Handling</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            API failures, partial fills, en rejected orders komen voor. Bouw robuuste retry logic 
                            en zorg dat je nooit in een inconsistente state terechtkomt.
                          </p>
                        </div>
                        
                        <div className="p-3 bg-background/50 rounded border-l-4 border-destructive">
                          <h5 className="font-medium text-sm text-destructive">5. Risk Limits</h5>
                          <p className="text-xs text-muted-foreground mt-1">
                            Implementeer harde limieten: max exposed capital per markt, max totale exposure, 
                            en circuit breakers bij onverwacht gedrag.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                      <h4 className="font-semibold text-sm mb-2 flex items-center gap-2 text-primary">
                        <Code2 className="w-4 h-4" />
                        Aanbevolen Tech Stack
                      </h4>
                      <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
                        <div>
                          <p className="font-medium">Language</p>
                          <p className="text-muted-foreground">Python (snelle prototyping) of Rust (productie latency)</p>
                        </div>
                        <div>
                          <p className="font-medium">Data Store</p>
                          <p className="text-muted-foreground">Redis voor real-time state, PostgreSQL voor history</p>
                        </div>
                        <div>
                          <p className="font-medium">Messaging</p>
                          <p className="text-muted-foreground">WebSockets voor orderbook, async queues voor orders</p>
                        </div>
                        <div>
                          <p className="font-medium">Monitoring</p>
                          <p className="text-muted-foreground">Prometheus + Grafana voor real-time metrics</p>
                        </div>
                      </div>
                    </div>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>
        </section>

        {/* DCA & Sizing Analysis */}
        {dcaAnalysis && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              DCA & Sizing Analysis
            </h2>

            <div className="grid lg:grid-cols-2 gap-4">
              {/* Price Bucket Distribution */}
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="text-sm">Entry Price Distribution</CardTitle>
                  <CardDescription>Buy volume by price range</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dcaAnalysis.priceBuckets}>
                        <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                        <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px'
                          }}
                          formatter={(value: number, name: string) => {
                            if (name === 'count') return [`${value} trades`, 'Trades'];
                            if (name === 'totalValue') return [`$${value.toFixed(2)}`, 'Volume'];
                            return [value, name];
                          }}
                        />
                        <Legend />
                        <Bar dataKey="count" fill="hsl(var(--primary))" name="Trades" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 p-3 rounded-lg bg-secondary/50">
                    <p className="text-xs text-muted-foreground">
                      <strong>Pattern:</strong> {dcaAnalysis.priceBuckets[0].count + dcaAnalysis.priceBuckets[1].count > dcaAnalysis.priceBuckets[4].count + dcaAnalysis.priceBuckets[5].count
                        ? 'More aggressive buying at lower prices (<35¢)'
                        : 'Conservative approach with buys spread across price ranges'
                      }
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* Share Size Distribution */}
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="text-sm">Position Sizing Strategy</CardTitle>
                  <CardDescription>Share size per trade</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dcaAnalysis.sizeBuckets} layout="vertical">
                        <XAxis type="number" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} />
                        <YAxis type="category" dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} width={50} />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px'
                          }}
                          formatter={(value: number) => [`${value} trades`, 'Count']}
                        />
                        <Bar dataKey="count" fill="hsl(var(--chart-4))" name="Trades" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-4 text-center">
                    <div className="p-3 rounded-lg bg-secondary/50">
                      <p className="text-xs text-muted-foreground">Avg Size</p>
                      <p className="text-lg font-mono font-bold">{dcaAnalysis.avgShareSize.toFixed(1)}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-secondary/50">
                      <p className="text-xs text-muted-foreground">Total Buys</p>
                      <p className="text-lg font-mono font-bold">{dcaAnalysis.totalBuys.toLocaleString()}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* DCA Performance */}
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-sm">DCA Price Improvement</CardTitle>
                <CardDescription>How often does averaging down result in better entry prices?</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-6">
                  <div className="relative w-32 h-32">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="hsl(var(--secondary))"
                        strokeWidth="12"
                      />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="hsl(var(--success))"
                        strokeWidth="12"
                        strokeDasharray={`${dcaAnalysis.priceImprovementRate * 2.51} 251`}
                        strokeLinecap="round"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-2xl font-mono font-bold">{dcaAnalysis.priceImprovementRate.toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-4">
                    <div>
                      <p className="text-sm font-medium">Price Improvement Rate</p>
                      <p className="text-xs text-muted-foreground">
                        {dcaAnalysis.priceImprovementRate.toFixed(0)}% of subsequent DCA buys are at a better price than the initial entry
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-3 rounded-lg bg-success/10 border border-success/20">
                        <p className="text-xs text-muted-foreground">Avg Entry</p>
                        <p className="text-lg font-mono font-bold text-success">{(dcaAnalysis.avgBuyPrice * 100).toFixed(1)}¢</p>
                      </div>
                      <div className="p-3 rounded-lg bg-chart-4/10 border border-chart-4/20">
                        <p className="text-xs text-muted-foreground">Entry Target</p>
                        <p className="text-lg font-mono font-bold text-chart-4">&lt; 50¢</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sizing Rules */}
                <div className="mt-6 p-4 rounded-lg bg-secondary/30 border border-border/50">
                  <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                    <Coins className="w-4 h-4 text-primary" />
                    Inferred Sizing Rules
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className="flex items-center gap-2 p-2 rounded bg-success/10">
                      <div className="w-2 h-2 rounded-full bg-success" />
                      <span>&lt; 35¢: Max batch (~{dcaAnalysis.priceBuckets[0].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[1].avgSize.toFixed(0)} shares)</span>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded bg-chart-4/10">
                      <div className="w-2 h-2 rounded-full bg-chart-4" />
                      <span>35-50¢: Medium (~{dcaAnalysis.priceBuckets[2].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[3].avgSize.toFixed(0)} shares)</span>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded bg-warning/10">
                      <div className="w-2 h-2 rounded-full bg-warning" />
                      <span>&gt; 50¢: Small (~{dcaAnalysis.priceBuckets[4].avgSize.toFixed(0)}-{dcaAnalysis.priceBuckets[5].avgSize.toFixed(0)} shares)</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

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
