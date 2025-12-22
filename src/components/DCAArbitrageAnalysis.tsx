import { useMemo } from 'react';
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
  ScatterChart,
  Scatter,
  Legend,
  Cell
} from 'recharts';
import { TrendingUp, Coins, Target, Zap, Scale, ArrowRight, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Trade } from '@/types/trade';

interface DCAArbitrageAnalysisProps {
  trades: Trade[];
}

interface MarketArbitrageEntry {
  market: string;
  marketType: 'BTC' | 'ETH' | 'Other';
  firstUpTrade: Trade | null;
  firstDownTrade: Trade | null;
  combinedPrice: number;
  edge: number; // (1 - combinedPrice) * 100
  delayBetweenSides: number; // seconds
  isArbitrage: boolean; // combinedPrice < 0.98
  totalSharesUp: number;
  totalSharesDown: number;
}

interface DCAEvent {
  market: string;
  tradeNumber: number;
  price: number;
  shares: number;
  outcome: string;
  priceDropFromFirst: number; // percentage
  combinedPriceAtEntry: number;
}

export function DCAArbitrageAnalysis({ trades }: DCAArbitrageAnalysisProps) {
  const dcaArbitrageAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market
    const marketGroups = new Map<string, Trade[]>();
    trades.forEach(t => {
      if (t.side === 'buy') {
        if (!marketGroups.has(t.market)) marketGroups.set(t.market, []);
        marketGroups.get(t.market)!.push(t);
      }
    });

    const marketArbitrageEntries: MarketArbitrageEntry[] = [];
    const dcaEvents: DCAEvent[] = [];

    marketGroups.forEach((marketTrades, market) => {
      // Detect market type
      const marketLower = market.toLowerCase();
      let marketType: 'BTC' | 'ETH' | 'Other' = 'Other';
      if (marketLower.includes('bitcoin') || marketLower.includes('btc')) {
        marketType = 'BTC';
      } else if (marketLower.includes('ethereum') || marketLower.includes('eth')) {
        marketType = 'ETH';
      }

      // Only analyze BTC/ETH markets
      if (marketType === 'Other') return;

      // Separate by outcome
      const upTrades = marketTrades.filter(t => 
        t.outcome === 'Yes' || t.outcome.toLowerCase().includes('up') || t.outcome.toLowerCase().includes('above')
      ).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      const downTrades = marketTrades.filter(t => 
        t.outcome === 'No' || t.outcome.toLowerCase().includes('down') || t.outcome.toLowerCase().includes('below')
      ).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      if (upTrades.length === 0 || downTrades.length === 0) return;

      const firstUpTrade = upTrades[0];
      const firstDownTrade = downTrades[0];

      // Calculate combined price at first arbitrage entry (when both sides are first bought)
      const combinedPrice = firstUpTrade.price + firstDownTrade.price;
      const edge = (1 - combinedPrice) * 100;
      const isArbitrage = combinedPrice < 0.98;

      const delayBetweenSides = Math.abs(
        firstUpTrade.timestamp.getTime() - firstDownTrade.timestamp.getTime()
      ) / 1000;

      // Total shares on each side
      const totalSharesUp = upTrades.reduce((sum, t) => sum + t.shares, 0);
      const totalSharesDown = downTrades.reduce((sum, t) => sum + t.shares, 0);

      marketArbitrageEntries.push({
        market,
        marketType,
        firstUpTrade,
        firstDownTrade,
        combinedPrice,
        edge,
        delayBetweenSides,
        isArbitrage,
        totalSharesUp,
        totalSharesDown
      });

      // Analyze DCA events for this market
      const allTrades = [...upTrades, ...downTrades].sort((a, b) => 
        a.timestamp.getTime() - b.timestamp.getTime()
      );

      allTrades.forEach((trade, idx) => {
        if (idx === 0) return; // Skip first trade

        // Find first trade of same outcome
        const firstOfSameOutcome = allTrades.find(t => 
          t.outcome === trade.outcome && t.timestamp < trade.timestamp
        );

        if (!firstOfSameOutcome) return;

        const priceDropFromFirst = ((firstOfSameOutcome.price - trade.price) / firstOfSameOutcome.price) * 100;

        // Calculate combined price at this point
        const latestUp = upTrades.filter(t => t.timestamp <= trade.timestamp).pop();
        const latestDown = downTrades.filter(t => t.timestamp <= trade.timestamp).pop();
        const combinedPriceAtEntry = (latestUp?.price || 0) + (latestDown?.price || 0);

        dcaEvents.push({
          market,
          tradeNumber: idx + 1,
          price: trade.price,
          shares: trade.shares,
          outcome: trade.outcome,
          priceDropFromFirst,
          combinedPriceAtEntry
        });
      });
    });

    // Statistics
    const btcEntries = marketArbitrageEntries.filter(e => e.marketType === 'BTC');
    const ethEntries = marketArbitrageEntries.filter(e => e.marketType === 'ETH');

    const avgBtcEdge = btcEntries.length > 0 
      ? btcEntries.reduce((sum, e) => sum + e.edge, 0) / btcEntries.length 
      : 0;
    const avgEthEdge = ethEntries.length > 0 
      ? ethEntries.reduce((sum, e) => sum + e.edge, 0) / ethEntries.length 
      : 0;

    const btcArbitrageRate = btcEntries.length > 0 
      ? (btcEntries.filter(e => e.isArbitrage).length / btcEntries.length) * 100 
      : 0;
    const ethArbitrageRate = ethEntries.length > 0 
      ? (ethEntries.filter(e => e.isArbitrage).length / ethEntries.length) * 100 
      : 0;

    // Combined price distribution
    const combinedPriceBuckets = [
      { label: '<92¢', min: 0, max: 0.92, count: 0, color: 'hsl(var(--success))' },
      { label: '92-95¢', min: 0.92, max: 0.95, count: 0, color: 'hsl(var(--success))' },
      { label: '95-98¢', min: 0.95, max: 0.98, count: 0, color: 'hsl(var(--success) / 0.7)' },
      { label: '98-100¢', min: 0.98, max: 1.00, count: 0, color: 'hsl(var(--chart-4))' },
      { label: '100-102¢', min: 1.00, max: 1.02, count: 0, color: 'hsl(var(--warning))' },
      { label: '>102¢', min: 1.02, max: 2.00, count: 0, color: 'hsl(var(--destructive))' },
    ];

    marketArbitrageEntries.forEach(e => {
      const bucket = combinedPriceBuckets.find(b => 
        e.combinedPrice >= b.min && e.combinedPrice < b.max
      );
      if (bucket) bucket.count++;
    });

    // DCA trigger analysis - at what price drop do they DCA?
    const dcaPriceDropBuckets = [
      { label: '0-2%', min: 0, max: 2, count: 0 },
      { label: '2-5%', min: 2, max: 5, count: 0 },
      { label: '5-10%', min: 5, max: 10, count: 0 },
      { label: '10-20%', min: 10, max: 20, count: 0 },
      { label: '>20%', min: 20, max: Infinity, count: 0 },
    ];

    dcaEvents.forEach(e => {
      const bucket = dcaPriceDropBuckets.find(b => 
        e.priceDropFromFirst >= b.min && e.priceDropFromFirst < b.max
      );
      if (bucket) bucket.count++;
    });

    // Entry price levels most frequently used
    const entryPriceBuckets = [
      { label: '40-45¢', min: 0.40, max: 0.45, count: 0 },
      { label: '45-48¢', min: 0.45, max: 0.48, count: 0 },
      { label: '48-50¢', min: 0.48, max: 0.50, count: 0 },
      { label: '50-52¢', min: 0.50, max: 0.52, count: 0 },
      { label: '52-55¢', min: 0.52, max: 0.55, count: 0 },
    ];

    dcaEvents.forEach(e => {
      const bucket = entryPriceBuckets.find(b => 
        e.price >= b.min && e.price < b.max
      );
      if (bucket) bucket.count++;
    });

    // Best arbitrage opportunities
    const bestArbitrage = [...marketArbitrageEntries]
      .filter(e => e.isArbitrage)
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 8);

    return {
      totalMarkets: marketArbitrageEntries.length,
      btcCount: btcEntries.length,
      ethCount: ethEntries.length,
      avgBtcEdge,
      avgEthEdge,
      btcArbitrageRate,
      ethArbitrageRate,
      combinedPriceBuckets,
      dcaPriceDropBuckets,
      entryPriceBuckets,
      bestArbitrage,
      dcaEvents,
      avgCombinedPrice: marketArbitrageEntries.reduce((sum, e) => sum + e.combinedPrice, 0) / marketArbitrageEntries.length,
      totalArbitrageMarkets: marketArbitrageEntries.filter(e => e.isArbitrage).length
    };
  }, [trades]);

  if (!dcaArbitrageAnalysis) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Coins className="w-5 h-5 text-primary" />
        DCA & Arbitrage Strategie Analyse
      </h2>
      
      <p className="text-sm text-muted-foreground">
        Analyse van Gabagool22's arbitrage entry strategie en DCA patronen: combined prices, entry triggers, en edge opportuniteiten.
      </p>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass border-success/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Target Combined</p>
                <p className="text-2xl font-mono font-bold text-success">&lt;98¢</p>
                <p className="text-xs text-muted-foreground mt-1">2%+ edge</p>
              </div>
              <div className="p-2 rounded-lg bg-success/10">
                <Target className="w-5 h-5 text-success" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Avg Combined Price</p>
                <p className="text-2xl font-mono font-bold">
                  {(dcaArbitrageAnalysis.avgCombinedPrice * 100).toFixed(1)}¢
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {dcaArbitrageAnalysis.avgCombinedPrice < 0.98 ? 'Arbitrage ✓' : 'Neutral'}
                </p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Scale className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-chart-4/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">BTC Avg Edge</p>
                <p className={`text-2xl font-mono font-bold ${dcaArbitrageAnalysis.avgBtcEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                  {dcaArbitrageAnalysis.avgBtcEdge.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {dcaArbitrageAnalysis.btcArbitrageRate.toFixed(0)}% arb rate
                </p>
              </div>
              <div className="p-2 rounded-lg bg-chart-4/10">
                <span className="text-xl">₿</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">ETH Avg Edge</p>
                <p className={`text-2xl font-mono font-bold ${dcaArbitrageAnalysis.avgEthEdge > 0 ? 'text-success' : 'text-destructive'}`}>
                  {dcaArbitrageAnalysis.avgEthEdge.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {dcaArbitrageAnalysis.ethArbitrageRate.toFixed(0)}% arb rate
                </p>
              </div>
              <div className="p-2 rounded-lg bg-primary/10">
                <span className="text-xl">Ξ</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Insights Badges */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="bg-success/10 border-success/30 text-success">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Target: combined &lt; 98¢
        </Badge>
        <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary">
          <TrendingUp className="w-3 h-3 mr-1" />
          ETH: betere edges ({dcaArbitrageAnalysis.avgEthEdge.toFixed(1)}% vs {dcaArbitrageAnalysis.avgBtcEdge.toFixed(1)}%)
        </Badge>
        <Badge variant="outline" className="bg-secondary border-border">
          <Zap className="w-3 h-3 mr-1" />
          Continu bijkopen zolang edge blijft
        </Badge>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Combined Price Distribution */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Combined Price Distributie bij Entry</CardTitle>
            <CardDescription>Verdeling van combined prices (Up + Down) bij eerste arbitrage entry</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dcaArbitrageAnalysis.combinedPriceBuckets}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Bar 
                    dataKey="count" 
                    radius={[4, 4, 0, 0]}
                  >
                    {dcaArbitrageAnalysis.combinedPriceBuckets.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 p-3 bg-success/10 rounded-lg border border-success/20">
              <p className="text-sm text-success font-medium">
                {dcaArbitrageAnalysis.totalArbitrageMarkets} van {dcaArbitrageAnalysis.totalMarkets} markten 
                ({((dcaArbitrageAnalysis.totalArbitrageMarkets / dcaArbitrageAnalysis.totalMarkets) * 100).toFixed(0)}%) 
                met echte arbitrage edge (&lt;98¢)
              </p>
            </div>
          </CardContent>
        </Card>

        {/* DCA Pattern Analysis */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">DCA Trigger Analyse</CardTitle>
            <CardDescription>Bij welke prijsdaling koopt de bot extra? (% daling t.o.v. eerste entry)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dcaArbitrageAnalysis.dcaPriceDropBuckets}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                  />
                  <Bar 
                    dataKey="count" 
                    fill="hsl(var(--chart-4))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 p-3 bg-warning/10 rounded-lg border border-warning/20">
              <p className="text-sm text-warning font-medium flex items-center gap-1">
                <AlertTriangle className="w-4 h-4" />
                Geen vaste trigger - opportunistische DCA strategie
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* DCA Strategy Explanation */}
      <Card className="glass border-primary/30">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Coins className="w-4 h-4 text-primary" />
            DCA Mechanisme Ontdekt
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid lg:grid-cols-3 gap-4">
            <div className="p-4 bg-success/10 rounded-lg border border-success/20">
              <h4 className="font-semibold text-sm mb-2 text-success">✓ Wat we bevestigd hebben:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Target combined price: &lt;98¢</li>
                <li>• Koopt beide kanten binnen 20 trades</li>
                <li>• ETH markten: betere edges</li>
                <li>• Continu monitoren op kansen</li>
              </ul>
            </div>
            <div className="p-4 bg-warning/10 rounded-lg border border-warning/20">
              <h4 className="font-semibold text-sm mb-2 text-warning">⚠ DCA Strategie:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Geen vaste prijsdrop trigger</li>
                <li>• Koopt goedkoopste kant continu</li>
                <li>• Zolang combined &lt; 1.00 blijft</li>
                <li>• Opportunistisch, niet systematisch</li>
              </ul>
            </div>
            <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
              <h4 className="font-semibold text-sm mb-2 text-primary">💡 Hypothese:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Bot checkt orderbook continu</li>
                <li>• IF combined &lt; 0.98 → BUY</li>
                <li>• Koopt altijd de goedkopere kant</li>
                <li>• Geen sentiment, pure math</li>
              </ul>
            </div>
          </div>

          {/* Decision Logic Diagram */}
          <div className="p-4 bg-secondary/50 rounded-lg">
            <p className="text-xs text-muted-foreground mb-3">Inferred Decision Logic:</p>
            <div className="flex flex-col lg:flex-row items-stretch gap-2 text-sm">
              <div className="flex-1 p-3 rounded-lg bg-primary/10 border border-primary/30 text-center">
                <p className="font-mono text-xs">CHECK</p>
                <p className="text-xs text-muted-foreground">up_price + down_price</p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
              <div className="flex-1 p-3 rounded-lg bg-success/10 border border-success/30 text-center">
                <p className="font-mono text-xs">&lt; 0.98?</p>
                <p className="text-xs text-muted-foreground">→ BUY beide</p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
              <div className="flex-1 p-3 rounded-lg bg-chart-4/10 border border-chart-4/30 text-center">
                <p className="font-mono text-xs">&lt; 1.00?</p>
                <p className="text-xs text-muted-foreground">→ DCA goedkoopste</p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground self-center hidden lg:block" />
              <div className="flex-1 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-center">
                <p className="font-mono text-xs">&gt; 1.00?</p>
                <p className="text-xs text-muted-foreground">→ SKIP</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Best Arbitrage Opportunities */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm">Beste Arbitrage Opportunities (Top 8)</CardTitle>
          <CardDescription>Markten met de hoogste edges bij entry</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {dcaArbitrageAnalysis.bestArbitrage.map((entry, i) => (
              <div 
                key={i} 
                className="flex items-center justify-between p-3 bg-secondary/50 rounded-lg"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    entry.marketType === 'BTC' 
                      ? 'bg-chart-4/20 text-chart-4' 
                      : 'bg-primary/20 text-primary'
                  }`}>
                    {entry.marketType === 'BTC' ? '₿' : 'Ξ'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{entry.market.slice(0, 50)}...</p>
                    <p className="text-xs text-muted-foreground">
                      Combined: {(entry.combinedPrice * 100).toFixed(1)}¢
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-mono font-bold text-success">
                    +{entry.edge.toFixed(1)}%
                  </p>
                  <p className="text-xs text-muted-foreground">edge</p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
