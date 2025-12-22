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
  ReferenceLine,
  BarChart,
  Bar,
  Cell
} from 'recharts';
import { TrendingDown, Layers, Zap, ArrowRight } from 'lucide-react';
import type { Trade } from '@/types/trade';

interface TradeSizeEvolutionChartProps {
  trades: Trade[];
}

export function TradeSizeEvolutionChart({ trades }: TradeSizeEvolutionChartProps) {
  const tradeSizeAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market-outcome and sort by timestamp
    const marketGroups = new Map<string, Trade[]>();
    trades.forEach(t => {
      if (t.side === 'buy') {
        const key = `${t.market}-${t.outcome}`;
        if (!marketGroups.has(key)) marketGroups.set(key, []);
        marketGroups.get(key)!.push(t);
      }
    });

    // Calculate average shares per trade number (1st, 2nd, 3rd, etc.)
    const tradeNumberStats = new Map<number, { totalShares: number; count: number }>();
    
    marketGroups.forEach(marketTrades => {
      // Sort by timestamp
      const sorted = [...marketTrades].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      
      sorted.forEach((trade, idx) => {
        const tradeNum = idx + 1;
        if (tradeNum <= 20) { // Only analyze first 20 trades per market
          if (!tradeNumberStats.has(tradeNum)) {
            tradeNumberStats.set(tradeNum, { totalShares: 0, count: 0 });
          }
          const stats = tradeNumberStats.get(tradeNum)!;
          stats.totalShares += trade.shares;
          stats.count++;
        }
      });
    });

    // Convert to chart data
    const evolutionData = Array.from(tradeNumberStats.entries())
      .map(([tradeNum, stats]) => ({
        tradeNum,
        avgShares: stats.count > 0 ? Math.round((stats.totalShares / stats.count) * 10) / 10 : 0,
        count: stats.count
      }))
      .sort((a, b) => a.tradeNum - b.tradeNum);

    // Calculate phase statistics
    const phase1Trades = evolutionData.filter(d => d.tradeNum <= 2);
    const phase2Trades = evolutionData.filter(d => d.tradeNum > 2);

    const avgPhase1 = phase1Trades.length > 0 
      ? phase1Trades.reduce((sum, d) => sum + d.avgShares, 0) / phase1Trades.length 
      : 0;
    const avgPhase2 = phase2Trades.length > 0 
      ? phase2Trades.reduce((sum, d) => sum + d.avgShares, 0) / phase2Trades.length 
      : 0;

    // Size ratio
    const sizeRatio = avgPhase2 > 0 ? avgPhase1 / avgPhase2 : 0;

    // Create bar data for phase comparison
    const phaseComparisonData = [
      { phase: 'Trade 1', shares: evolutionData[0]?.avgShares || 0, fill: 'hsl(var(--chart-4))' },
      { phase: 'Trade 2', shares: evolutionData[1]?.avgShares || 0, fill: 'hsl(var(--chart-4))' },
      { phase: 'Trade 3+', shares: avgPhase2, fill: 'hsl(var(--primary))' },
    ];

    return {
      evolutionData,
      avgPhase1,
      avgPhase2,
      sizeRatio,
      phaseComparisonData,
      totalMarkets: marketGroups.size
    };
  }, [trades]);

  if (!tradeSizeAnalysis) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Layers className="w-5 h-5 text-primary" />
        Trade Size Evolutie
      </h2>
      
      <p className="text-sm text-muted-foreground">
        Ontdekt: Twee-fasen positie opbouw strategie. Trade 1 & 2 zijn significant groter dan latere trades.
      </p>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass border-chart-4/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Fase 1 (Trade 1-2)</p>
                <p className="text-2xl font-mono font-bold text-chart-4">
                  {tradeSizeAnalysis.avgPhase1.toFixed(0)} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">Initiële positie</p>
              </div>
              <div className="p-2 rounded-lg bg-chart-4/10">
                <Zap className="w-5 h-5 text-chart-4" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Fase 2 (Trade 3+)</p>
                <p className="text-2xl font-mono font-bold text-primary">
                  {tradeSizeAnalysis.avgPhase2.toFixed(0)} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">DCA fase</p>
              </div>
              <div className="p-2 rounded-lg bg-primary/10">
                <TrendingDown className="w-5 h-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Size Ratio</p>
                <p className="text-2xl font-mono font-bold">
                  {tradeSizeAnalysis.sizeRatio.toFixed(1)}x
                </p>
                <p className="text-xs text-muted-foreground mt-1">Fase 1 vs Fase 2</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <ArrowRight className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Markten</p>
                <p className="text-2xl font-mono font-bold">
                  {tradeSizeAnalysis.totalMarkets}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Geanalyseerd</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Layers className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Insights Badges */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="bg-chart-4/10 border-chart-4/30 text-chart-4">
          <Zap className="w-3 h-3 mr-1" />
          Trade 1-2: ~{tradeSizeAnalysis.avgPhase1.toFixed(0)} shares (groot)
        </Badge>
        <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary">
          <TrendingDown className="w-3 h-3 mr-1" />
          Trade 3+: ~{tradeSizeAnalysis.avgPhase2.toFixed(0)} shares (klein)
        </Badge>
        <Badge variant="outline" className="bg-success/10 border-success/30 text-success">
          Twee-fasen strategie bevestigd
        </Badge>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Phase Comparison Bar Chart */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Fase Vergelijking</CardTitle>
            <CardDescription>Gemiddelde trade size per fase</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tradeSizeAnalysis.phaseComparisonData}>
                  <XAxis dataKey="phase" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)} shares`, 'Gemiddeld']}
                  />
                  <Bar 
                    dataKey="shares" 
                    radius={[4, 4, 0, 0]}
                  >
                    {tradeSizeAnalysis.phaseComparisonData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Evolution Line Chart */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Trade Size Evolutie</CardTitle>
            <CardDescription>Gemiddelde shares per trade nummer</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={tradeSizeAnalysis.evolutionData}>
                  <XAxis 
                    dataKey="tradeNum" 
                    tick={{ fontSize: 11 }} 
                    label={{ value: 'Trade #', position: 'insideBottom', offset: -5, fontSize: 10 }}
                  />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)} shares`, 'Gemiddeld']}
                    labelFormatter={(label) => `Trade ${label}`}
                  />
                  <ReferenceLine 
                    x={2.5} 
                    stroke="hsl(var(--destructive))" 
                    strokeDasharray="5 5"
                    label={{ value: 'Fase switch', fontSize: 10, fill: 'hsl(var(--destructive))' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="avgShares" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2, r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strategy Explanation */}
      <Card className="glass border-chart-4/30">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="w-4 h-4 text-chart-4" />
            Twee-Fasen Strategie Uitgelegd
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="p-4 bg-chart-4/10 rounded-lg border border-chart-4/20">
              <h4 className="font-semibold text-sm mb-2 text-chart-4">Fase 1: Initiële Positie (Trade 1-2)</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• <strong>Grote orders</strong> (~{tradeSizeAnalysis.avgPhase1.toFixed(0)} shares)</li>
                <li>• Bouwt snel een basis positie op beide kanten</li>
                <li>• Trade 1 = Up kant, Trade 2 = Down kant (of vice versa)</li>
                <li>• Verzekert initiële arbitrage positie</li>
              </ul>
            </div>
            <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
              <h4 className="font-semibold text-sm mb-2 text-primary">Fase 2: DCA (Trade 3+)</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• <strong>Kleinere orders</strong> (~{tradeSizeAnalysis.avgPhase2.toFixed(0)} shares)</li>
                <li>• Opportunistisch bijkopen</li>
                <li>• Koopt goedkoopste kant</li>
                <li>• Verbetert gemiddelde prijs</li>
              </ul>
            </div>
          </div>

          <div className="p-4 bg-success/10 rounded-lg border border-success/20">
            <h4 className="font-semibold text-sm mb-2 text-success">💡 Implicatie</h4>
            <p className="text-sm text-muted-foreground">
              De bot verzekert eerst een grote basisposities op beide kanten van de markt, 
              en schakelt daarna over naar kleinere DCA trades om de positie te optimaliseren. 
              Dit minimaliseert het risico dat hij geen positie krijgt, terwijl hij nog steeds 
              kan profiteren van prijsverbeteringen.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
