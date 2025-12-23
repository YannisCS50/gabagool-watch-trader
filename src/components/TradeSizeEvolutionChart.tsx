import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  PieChart,
  Pie,
  Legend
} from 'recharts';
import { TrendingDown, Layers, Target, Bitcoin, Coins } from 'lucide-react';
import type { Trade } from '@/types/trade';

interface TradeSizeEvolutionChartProps {
  trades: Trade[];
}

type MarketType = 'BTC 15min' | 'ETH 15min' | 'BTC Hourly' | 'ETH Hourly' | 'Other';

interface MarketTypeStats {
  marketType: MarketType;
  avgFirstTrade: number;
  mostCommonSize: number;
  marketCount: number;
  sizeDistribution: { size: number; count: number }[];
}

export function TradeSizeEvolutionChart({ trades }: TradeSizeEvolutionChartProps) {
  const analysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Classify market type
    const getMarketType = (marketSlug: string): MarketType => {
      if (marketSlug.includes('btc-updown-15m')) return 'BTC 15min';
      if (marketSlug.includes('eth-updown-15m')) return 'ETH 15min';
      if (marketSlug.includes('bitcoin-up-or-down')) return 'BTC Hourly';
      if (marketSlug.includes('ethereum-up-or-down')) return 'ETH Hourly';
      return 'Other';
    };

    // Group trades by market
    const marketFirstTrades = new Map<string, { trade: Trade; marketType: MarketType }>();
    
    // Get first trade per market
    const sortedTrades = [...trades].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    sortedTrades.forEach(t => {
      if (!marketFirstTrades.has(t.marketSlug)) {
        marketFirstTrades.set(t.marketSlug, {
          trade: t,
          marketType: getMarketType(t.marketSlug)
        });
      }
    });

    // Group by market type
    const byMarketType = new Map<MarketType, number[]>();
    
    marketFirstTrades.forEach(({ trade, marketType }) => {
      if (!byMarketType.has(marketType)) byMarketType.set(marketType, []);
      byMarketType.get(marketType)!.push(trade.shares);
    });

    // Calculate stats per market type
    const marketTypeStats: MarketTypeStats[] = [];
    
    (['BTC 15min', 'BTC Hourly', 'ETH 15min', 'ETH Hourly'] as MarketType[]).forEach(marketType => {
      const sizes = byMarketType.get(marketType) || [];
      if (sizes.length === 0) return;

      // Find most common size (rounded)
      const sizeFreq = new Map<number, number>();
      sizes.forEach(s => {
        const rounded = Math.round(s);
        sizeFreq.set(rounded, (sizeFreq.get(rounded) || 0) + 1);
      });

      let mostCommonSize = 0;
      let maxFreq = 0;
      sizeFreq.forEach((freq, size) => {
        if (freq > maxFreq) {
          maxFreq = freq;
          mostCommonSize = size;
        }
      });

      // Size distribution for chart
      const sizeDistribution = Array.from(sizeFreq.entries())
        .map(([size, count]) => ({ size, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      marketTypeStats.push({
        marketType,
        avgFirstTrade: sizes.reduce((a, b) => a + b, 0) / sizes.length,
        mostCommonSize,
        marketCount: sizes.length,
        sizeDistribution
      });
    });

    // Prepare bar chart data for comparison
    const comparisonData = marketTypeStats.map(stats => ({
      name: stats.marketType,
      gemiddeld: Math.round(stats.avgFirstTrade * 10) / 10,
      meestVoorkomend: stats.mostCommonSize,
      aantalMarkten: stats.marketCount
    }));

    // BTC vs ETH summary
    const btcStats = marketTypeStats.filter(s => s.marketType.includes('BTC'));
    const ethStats = marketTypeStats.filter(s => s.marketType.includes('ETH'));

    const btcAvg = btcStats.length > 0 
      ? btcStats.reduce((sum, s) => sum + s.avgFirstTrade * s.marketCount, 0) / 
        btcStats.reduce((sum, s) => sum + s.marketCount, 0)
      : 0;
    
    const ethAvg = ethStats.length > 0 
      ? ethStats.reduce((sum, s) => sum + s.avgFirstTrade * s.marketCount, 0) / 
        ethStats.reduce((sum, s) => sum + s.marketCount, 0)
      : 0;

    const btcMostCommon = btcStats.length > 0 ? btcStats[0].mostCommonSize : 0;
    const ethMostCommon = ethStats.length > 0 ? ethStats[0].mostCommonSize : 0;

    // Pie chart for BTC size distribution
    const btc15m = marketTypeStats.find(s => s.marketType === 'BTC 15min');
    const btcPieData = btc15m?.sizeDistribution.map(d => ({
      name: `${d.size} shares`,
      value: d.count,
      fill: d.size >= 20 ? 'hsl(var(--chart-1))' : 'hsl(var(--chart-3))'
    })) || [];

    // Pie chart for ETH size distribution  
    const eth15m = marketTypeStats.find(s => s.marketType === 'ETH 15min');
    const ethPieData = eth15m?.sizeDistribution.map(d => ({
      name: `${d.size} shares`,
      value: d.count,
      fill: d.size >= 14 ? 'hsl(var(--chart-2))' : 'hsl(var(--chart-4))'
    })) || [];

    return {
      marketTypeStats,
      comparisonData,
      btcAvg,
      ethAvg,
      btcMostCommon,
      ethMostCommon,
      btcPieData,
      ethPieData,
      totalMarkets: marketFirstTrades.size
    };
  }, [trades]);

  if (!analysis) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Layers className="w-5 h-5 text-primary" />
        Initiële Trade Size Analyse
      </h2>
      
      <p className="text-sm text-muted-foreground">
        <strong>Patroon gevonden:</strong> Gabagool gebruikt <strong>verschillende initiële order sizes per asset</strong>. 
        BTC markten starten met ~20-24 shares, ETH markten met ~14-16 shares.
      </p>

      {/* Key Finding: Two Strategies */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="glass border-chart-1/30 bg-chart-1/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Bitcoin className="w-5 h-5 text-chart-1" />
                  <p className="text-sm font-medium text-chart-1">BTC Markten</p>
                </div>
                <p className="text-3xl font-mono font-bold text-chart-1">
                  {analysis.btcMostCommon} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Meest voorkomend (gem: {analysis.btcAvg.toFixed(1)})
                </p>
              </div>
              <div className="text-right">
                <Badge variant="outline" className="border-chart-1/30 text-chart-1">
                  20-24 range
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-chart-2/30 bg-chart-2/5">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Coins className="w-5 h-5 text-chart-2" />
                  <p className="text-sm font-medium text-chart-2">ETH Markten</p>
                </div>
                <p className="text-3xl font-mono font-bold text-chart-2">
                  {analysis.ethMostCommon} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Meest voorkomend (gem: {analysis.ethAvg.toFixed(1)})
                </p>
              </div>
              <div className="text-right">
                <Badge variant="outline" className="border-chart-2/30 text-chart-2">
                  14-16 range
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Comparison Bar Chart */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm">Initiële Trade Size per Markttype</CardTitle>
          <CardDescription>Gemiddelde vs meest voorkomende size per categorie</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analysis.comparisonData} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number, name: string) => [
                    `${value} shares`, 
                    name === 'gemiddeld' ? 'Gemiddeld' : 'Meest voorkomend'
                  ]}
                />
                <Legend />
                <Bar 
                  dataKey="gemiddeld" 
                  fill="hsl(var(--primary))"
                  radius={[0, 4, 4, 0]}
                  name="Gemiddeld"
                />
                <Bar 
                  dataKey="meestVoorkomend" 
                  fill="hsl(var(--chart-3))"
                  radius={[0, 4, 4, 0]}
                  name="Meest voorkomend"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Distribution Pie Charts */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Bitcoin className="w-4 h-4 text-chart-1" />
              BTC 15min - Size Verdeling
            </CardTitle>
            <CardDescription>Top 5 meest voorkomende initiële sizes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analysis.btcPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}x`}
                    labelLine={false}
                  >
                    {analysis.btcPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value} markten`, 'Aantal']}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Coins className="w-4 h-4 text-chart-2" />
              ETH 15min - Size Verdeling
            </CardTitle>
            <CardDescription>Top 5 meest voorkomende initiële sizes</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analysis.ethPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={35}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}x`}
                    labelLine={false}
                  >
                    {analysis.ethPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value} markten`, 'Aantal']}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Breakdown by Market Type */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm">Strategie per Markttype</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-4">
            {analysis.marketTypeStats.map(stats => (
              <div 
                key={stats.marketType} 
                className="p-4 rounded-lg border border-border/50 bg-card/50"
              >
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-sm">{stats.marketType}</h4>
                  <Badge variant="secondary">{stats.marketCount} markten</Badge>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gemiddeld:</span>
                    <span className="font-mono">{stats.avgFirstTrade.toFixed(1)} shares</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Meest voorkomend:</span>
                    <span className="font-mono font-bold text-primary">{stats.mostCommonSize} shares</span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-border/30">
                    <p className="text-xs text-muted-foreground">Top sizes:</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {stats.sizeDistribution.slice(0, 3).map((d, i) => (
                        <Badge key={i} variant="outline" className="text-xs">
                          {d.size}: {d.count}x
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Conclusion */}
      <Card className="glass border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Conclusie: Asset-Specifieke Sizing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="p-3 rounded-lg bg-chart-1/10 border border-chart-1/20">
              <h4 className="font-semibold text-sm text-chart-1 mb-2">BTC Strategie</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Initiële order: <strong>20-24 shares</strong></li>
                <li>• Grotere posities dan ETH</li>
                <li>• Consistent patroon over 15min en hourly</li>
              </ul>
            </div>
            <div className="p-3 rounded-lg bg-chart-2/10 border border-chart-2/20">
              <h4 className="font-semibold text-sm text-chart-2 mb-2">ETH Strategie</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Initiële order: <strong>14-16 shares</strong></li>
                <li>• Kleinere posities dan BTC</li>
                <li>• Mogelijk vanwege lagere liquiditeit</li>
              </ul>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-secondary/50 border border-border/50">
            <h4 className="font-semibold text-sm mb-2">💡 Waarom Dit Verschil?</h4>
            <p className="text-sm text-muted-foreground">
              BTC markten hebben doorgaans <strong>hogere liquiditeit</strong>, waardoor grotere initiële orders mogelijk zijn 
              zonder te veel slippage. ETH markten zijn minder liquide, dus de bot start conservatiever met kleinere orders.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
