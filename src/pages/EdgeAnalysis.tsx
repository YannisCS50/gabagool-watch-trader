import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTrades } from '@/hooks/useTrades';
import { useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend } from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, TrendingUp, Target, Clock, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

const EdgeAnalysis = () => {
  const { trades, isLoading } = useTrades('gabagool22');

  const analysis = useMemo(() => {
    if (!trades.length) return null;

    // Group trades by market to find paired trades
    const marketGroups = new Map<string, typeof trades>();
    trades.forEach(trade => {
      const key = trade.market;
      if (!marketGroups.has(key)) {
        marketGroups.set(key, []);
      }
      marketGroups.get(key)!.push(trade);
    });

    // Calculate edge for each market
    const edgeData: Array<{
      market: string;
      yesPrice: number;
      noPrice: number;
      combined: number;
      edge: number;
      edgeType: 'arbitrage' | 'neutral' | 'risk';
      timestamp: Date;
    }> = [];

    marketGroups.forEach((marketTrades, market) => {
      const yesTrades = marketTrades.filter(t => t.outcome === 'Yes');
      const noTrades = marketTrades.filter(t => t.outcome === 'No');

      if (yesTrades.length > 0 && noTrades.length > 0) {
        // Average prices for this market
        const avgYes = yesTrades.reduce((sum, t) => sum + t.price, 0) / yesTrades.length;
        const avgNo = noTrades.reduce((sum, t) => sum + t.price, 0) / noTrades.length;
        const combined = avgYes + avgNo;
        const edge = 1 - combined;

        edgeData.push({
          market,
          yesPrice: avgYes,
          noPrice: avgNo,
          combined,
          edge,
          edgeType: combined < 0.98 ? 'arbitrage' : combined > 1.02 ? 'risk' : 'neutral',
          timestamp: yesTrades[0].timestamp,
        });
      }
    });

    // Edge distribution
    const arbitrageCount = edgeData.filter(e => e.edgeType === 'arbitrage').length;
    const neutralCount = edgeData.filter(e => e.edgeType === 'neutral').length;
    const riskCount = edgeData.filter(e => e.edgeType === 'risk').length;
    const total = edgeData.length || 1;

    const pieData = [
      { name: 'Arbitrage (Edge < 1)', value: arbitrageCount, color: '#22c55e' },
      { name: 'Neutral (Edge ≈ 1)', value: neutralCount, color: '#6b7280' },
      { name: 'Risk (Edge > 1)', value: riskCount, color: '#ef4444' },
    ].filter(d => d.value > 0);

    // Edge buckets histogram
    const buckets = [
      { range: '<90%', min: 0, max: 0.90, count: 0 },
      { range: '90-95%', min: 0.90, max: 0.95, count: 0 },
      { range: '95-98%', min: 0.95, max: 0.98, count: 0 },
      { range: '98-100%', min: 0.98, max: 1.00, count: 0 },
      { range: '100-102%', min: 1.00, max: 1.02, count: 0 },
      { range: '102-105%', min: 1.02, max: 1.05, count: 0 },
      { range: '>105%', min: 1.05, max: 2.00, count: 0 },
    ];

    edgeData.forEach(e => {
      const bucket = buckets.find(b => e.combined >= b.min && e.combined < b.max);
      if (bucket) bucket.count++;
    });

    // Hourly activity
    const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({ hour: i, trades: 0, avgEdge: 0, edgeSum: 0 }));
    trades.forEach(trade => {
      const hour = new Date(trade.timestamp).getHours();
      hourlyActivity[hour].trades++;
    });

    edgeData.forEach(e => {
      const hour = e.timestamp.getHours();
      hourlyActivity[hour].edgeSum += e.combined;
    });

    hourlyActivity.forEach(h => {
      if (h.trades > 0) {
        h.avgEdge = h.edgeSum / h.trades;
      }
    });

    // Best arbitrage opportunities
    const topArbitrage = [...edgeData]
      .filter(e => e.edgeType === 'arbitrage')
      .sort((a, b) => a.combined - b.combined)
      .slice(0, 10);

    // Statistics
    const avgArbitrageEdge = edgeData
      .filter(e => e.edgeType === 'arbitrage')
      .reduce((sum, e) => sum + (1 - e.combined), 0) / (arbitrageCount || 1);

    const bestEdge = Math.min(...edgeData.map(e => e.combined));

    return {
      pieData,
      buckets,
      hourlyActivity,
      topArbitrage,
      stats: {
        totalMarkets: edgeData.length,
        arbitragePercent: ((arbitrageCount / total) * 100).toFixed(1),
        riskPercent: ((riskCount / total) * 100).toFixed(1),
        avgArbitrageEdge: (avgArbitrageEdge * 100).toFixed(2),
        bestEdge: ((1 - bestEdge) * 100).toFixed(2),
      },
    };
  }, [trades]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading trade data...</div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">No paired trades found for analysis</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Header */}
        <div className="mb-8">
          <Link to="/">
            <Button variant="ghost" size="sm" className="mb-4">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Dashboard
            </Button>
          </Link>
          <h1 className="text-3xl font-bold text-foreground mb-2">Edge Analysis: Gabagool22</h1>
          <p className="text-muted-foreground">
            Analyse van trading edge berekening en strategiepatronen
          </p>
        </div>

        {/* Edge Formula Explainer */}
        <Card className="mb-8 border-primary/20 bg-card/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Edge Formule
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/50 rounded-lg p-6 font-mono text-center mb-4">
              <div className="text-2xl mb-2">
                <span className="text-primary">Edge</span> = 1 - (
                <span className="text-green-500">Yes_Price</span> + 
                <span className="text-red-500">No_Price</span>)
              </div>
              <div className="text-sm text-muted-foreground mt-4">
                Als Yes = 0.45 en No = 0.33 → Combined = 0.78 → <span className="text-green-500 font-bold">Edge = 22%</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span><strong>Edge &lt; 1:</strong> Arbitrage mogelijk (risicovrije winst)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-gray-500" />
                <span><strong>Edge ≈ 1:</strong> Neutrale markt (geen edge)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500" />
                <span><strong>Edge &gt; 1:</strong> Risico/Directional bet</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Target className="w-4 h-4" />
                Arbitrage Trades
              </div>
              <div className="text-2xl font-bold text-green-500">{analysis.stats.arbitragePercent}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <TrendingUp className="w-4 h-4" />
                Risk Trades
              </div>
              <div className="text-2xl font-bold text-red-500">{analysis.stats.riskPercent}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Zap className="w-4 h-4" />
                Gem. Arbitrage Edge
              </div>
              <div className="text-2xl font-bold text-primary">{analysis.stats.avgArbitrageEdge}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                <Clock className="w-4 h-4" />
                Beste Edge Ooit
              </div>
              <div className="text-2xl font-bold text-yellow-500">{analysis.stats.bestEdge}%</div>
            </CardContent>
          </Card>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Pie Chart */}
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Trade Type Verdeling</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={analysis.pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    dataKey="value"
                    label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  >
                    {analysis.pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Histogram */}
          <Card className="bg-card/50">
            <CardHeader>
              <CardTitle>Edge Distribution (Combined Price)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analysis.buckets}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="range" tick={{ fill: '#888', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#888' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Hourly Activity */}
        <Card className="mb-8 bg-card/50">
          <CardHeader>
            <CardTitle>Trading Activiteit per Uur (UTC)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={analysis.hourlyActivity}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis 
                  dataKey="hour" 
                  tick={{ fill: '#888' }}
                  tickFormatter={(h) => `${h}:00`}
                />
                <YAxis tick={{ fill: '#888' }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                  labelFormatter={(h) => `${h}:00 UTC`}
                />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="trades" 
                  stroke="#22c55e" 
                  strokeWidth={2}
                  dot={{ fill: '#22c55e' }}
                  name="Aantal Trades"
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Top Arbitrage Table */}
        <Card className="bg-card/50">
          <CardHeader>
            <CardTitle>Top 10 Arbitrage Opportunities (Gevonden)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Yes Price</TableHead>
                  <TableHead className="text-right">No Price</TableHead>
                  <TableHead className="text-right">Combined</TableHead>
                  <TableHead className="text-right">Edge</TableHead>
                  <TableHead>Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {analysis.topArbitrage.map((trade, i) => (
                  <TableRow key={i}>
                    <TableCell className="max-w-[300px] truncate font-medium">
                      {trade.market}
                    </TableCell>
                    <TableCell className="text-right text-green-500">
                      {(trade.yesPrice * 100).toFixed(1)}¢
                    </TableCell>
                    <TableCell className="text-right text-red-500">
                      {(trade.noPrice * 100).toFixed(1)}¢
                    </TableCell>
                    <TableCell className="text-right">
                      {(trade.combined * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-right font-bold text-primary">
                      {((1 - trade.combined) * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">
                        Arbitrage
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Key Insights */}
        <Card className="mt-8 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
          <CardHeader>
            <CardTitle>🧠 Key Insights</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-green-500 mt-2" />
              <p>
                <strong>{analysis.stats.arbitragePercent}%</strong> van Gabagool22's trades zijn arbitrage opportunities 
                (combined price &lt; 98%), wat wijst op een systematische edge-hunting strategie.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-yellow-500 mt-2" />
              <p>
                De <strong>beste edge</strong> ooit gevonden was <strong>{analysis.stats.bestEdge}%</strong> - 
                dit betekent bij een perfecte hedge een gegarandeerde winst van {analysis.stats.bestEdge}%.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-red-500 mt-2" />
              <p>
                <strong>{analysis.stats.riskPercent}%</strong> zijn directional bets (edge &gt; 1), wat suggereert 
                dat hij ook bereid is risico te nemen wanneer hij een sterke mening heeft over de uitkomst.
              </p>
            </div>
            <div className="flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-2" />
              <p>
                <strong>Conclusie:</strong> Gabagool22 combineert systematische arbitrage-hunting met 
                selectieve directional trades - een hybride strategie die zowel risicovrije winst als 
                alpha-generatie nastreeft.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default EdgeAnalysis;
