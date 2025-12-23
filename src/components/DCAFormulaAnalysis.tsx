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
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area
} from 'recharts';
import { 
  Scale, 
  TrendingUp, 
  Target, 
  Repeat,
  AlertCircle,
  CheckCircle2,
  ArrowRightLeft,
  Percent,
  Timer,
  Layers
} from 'lucide-react';
import type { Trade } from '@/types/trade';

interface DCAFormulaAnalysisProps {
  trades: Trade[];
}

export function DCAFormulaAnalysis({ trades }: DCAFormulaAnalysisProps) {
  const analysis = useMemo(() => {
    if (trades.length === 0) return null;

    const buyTrades = trades.filter(t => t.side === 'buy');
    
    // Group by market+outcome for running average analysis
    const marketOutcomes = new Map<string, Trade[]>();
    buyTrades.forEach(t => {
      const key = `${t.market}-${t.outcome}`;
      if (!marketOutcomes.has(key)) marketOutcomes.set(key, []);
      marketOutcomes.get(key)!.push(t);
    });

    // Calculate running average and check if trades are above/below it
    let tradesAboveAvg = 0;
    let tradesBelowAvg = 0;
    let tradesAtAvg = 0;
    
    const priceVsAvgData: { tradeNum: number; aboveAvg: number; belowAvg: number }[] = [];
    
    marketOutcomes.forEach(marketTrades => {
      if (marketTrades.length < 2) return;
      
      const sorted = [...marketTrades].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      let runningTotal = 0;
      let runningShares = 0;
      
      sorted.forEach((trade, idx) => {
        if (idx === 0) {
          runningTotal = trade.total;
          runningShares = trade.shares;
          return;
        }
        
        const runningAvg = runningTotal / runningShares;
        
        if (trade.price < runningAvg * 0.99) {
          tradesBelowAvg++;
        } else if (trade.price > runningAvg * 1.01) {
          tradesAboveAvg++;
        } else {
          tradesAtAvg++;
        }
        
        runningTotal += trade.total;
        runningShares += trade.shares;
      });
    });

    const totalSubsequent = tradesAboveAvg + tradesBelowAvg + tradesAtAvg;
    const abovePercent = totalSubsequent > 0 ? (tradesAboveAvg / totalSubsequent) * 100 : 0;
    const belowPercent = totalSubsequent > 0 ? (tradesBelowAvg / totalSubsequent) * 100 : 0;
    const atPercent = totalSubsequent > 0 ? (tradesAtAvg / totalSubsequent) * 100 : 0;

    // Bimodal price distribution analysis
    const pricesBelow50 = buyTrades.filter(t => t.price < 0.50);
    const pricesAbove50 = buyTrades.filter(t => t.price >= 0.50);
    
    const avgPriceBelow50 = pricesBelow50.length > 0 
      ? pricesBelow50.reduce((sum, t) => sum + t.price, 0) / pricesBelow50.length 
      : 0;
    const avgPriceAbove50 = pricesAbove50.length > 0 
      ? pricesAbove50.reduce((sum, t) => sum + t.price, 0) / pricesAbove50.length 
      : 0;

    const bimodalData = [
      { 
        name: '< 50¢', 
        count: pricesBelow50.length, 
        avgPrice: avgPriceBelow50,
        percent: (pricesBelow50.length / buyTrades.length) * 100
      },
      { 
        name: '≥ 50¢', 
        count: pricesAbove50.length, 
        avgPrice: avgPriceAbove50,
        percent: (pricesAbove50.length / buyTrades.length) * 100
      }
    ];

    // Exposure balance analysis - group by market
    const marketBalances: { market: string; upShares: number; downShares: number; exposure: number }[] = [];
    
    const marketGroups = new Map<string, { up: number; down: number }>();
    buyTrades.forEach(t => {
      if (!marketGroups.has(t.market)) marketGroups.set(t.market, { up: 0, down: 0 });
      const group = marketGroups.get(t.market)!;
      
      const isUp = t.outcome.toLowerCase().includes('up') || 
                   t.outcome.toLowerCase().includes('above') ||
                   t.outcome === 'Yes';
      
      if (isUp) {
        group.up += t.shares;
      } else {
        group.down += t.shares;
      }
    });

    marketGroups.forEach((shares, market) => {
      const total = shares.up + shares.down;
      const exposure = total > 0 ? Math.abs(shares.up - shares.down) / total * 100 : 0;
      marketBalances.push({ 
        market, 
        upShares: shares.up, 
        downShares: shares.down, 
        exposure 
      });
    });

    // Exposure distribution
    const exposureBuckets = [
      { label: '< 5%', min: 0, max: 5, count: 0 },
      { label: '5-10%', min: 5, max: 10, count: 0 },
      { label: '10-20%', min: 10, max: 20, count: 0 },
      { label: '20-50%', min: 20, max: 50, count: 0 },
      { label: '> 50%', min: 50, max: 100, count: 0 }
    ];

    marketBalances.forEach(m => {
      const bucket = exposureBuckets.find(b => m.exposure >= b.min && m.exposure < b.max);
      if (bucket) bucket.count++;
    });

    const lowExposure = exposureBuckets[0].count + exposureBuckets[1].count;
    const lowExposurePercent = marketBalances.length > 0 
      ? (lowExposure / marketBalances.length) * 100 
      : 0;

    // Combined price analysis per market
    const combinedPrices: { market: string; combinedPrice: number; profitable: boolean }[] = [];
    
    const marketPrices = new Map<string, { upTotal: number; upShares: number; downTotal: number; downShares: number }>();
    buyTrades.forEach(t => {
      if (!marketPrices.has(t.market)) {
        marketPrices.set(t.market, { upTotal: 0, upShares: 0, downTotal: 0, downShares: 0 });
      }
      const mp = marketPrices.get(t.market)!;
      
      const isUp = t.outcome.toLowerCase().includes('up') || 
                   t.outcome.toLowerCase().includes('above') ||
                   t.outcome === 'Yes';
      
      if (isUp) {
        mp.upTotal += t.total;
        mp.upShares += t.shares;
      } else {
        mp.downTotal += t.total;
        mp.downShares += t.shares;
      }
    });

    marketPrices.forEach((data, market) => {
      if (data.upShares > 0 && data.downShares > 0) {
        const upAvg = data.upTotal / data.upShares;
        const downAvg = data.downTotal / data.downShares;
        const combined = upAvg + downAvg;
        combinedPrices.push({
          market,
          combinedPrice: combined,
          profitable: combined < 1.0
        });
      }
    });

    const profitableMarkets = combinedPrices.filter(c => c.profitable).length;
    const profitablePercent = combinedPrices.length > 0 
      ? (profitableMarkets / combinedPrices.length) * 100 
      : 0;

    // Combined price distribution
    const combinedBuckets = [
      { label: '< 0.93', desc: '> 7% edge', count: 0, color: 'hsl(var(--chart-1))' },
      { label: '0.93-0.95', desc: '5-7% edge', count: 0, color: 'hsl(var(--chart-2))' },
      { label: '0.95-0.97', desc: '3-5% edge', count: 0, color: 'hsl(var(--chart-3))' },
      { label: '0.97-0.99', desc: '1-3% edge', count: 0, color: 'hsl(var(--chart-4))' },
      { label: '0.99-1.00', desc: 'Break-even', count: 0, color: 'hsl(var(--muted-foreground))' },
      { label: '≥ 1.00', desc: 'Loss', count: 0, color: 'hsl(var(--destructive))' }
    ];

    combinedPrices.forEach(c => {
      if (c.combinedPrice < 0.93) combinedBuckets[0].count++;
      else if (c.combinedPrice < 0.95) combinedBuckets[1].count++;
      else if (c.combinedPrice < 0.97) combinedBuckets[2].count++;
      else if (c.combinedPrice < 0.99) combinedBuckets[3].count++;
      else if (c.combinedPrice < 1.00) combinedBuckets[4].count++;
      else combinedBuckets[5].count++;
    });

    return {
      // Price vs running average
      tradesAboveAvg,
      tradesBelowAvg,
      tradesAtAvg,
      abovePercent,
      belowPercent,
      atPercent,
      
      // Bimodal distribution
      bimodalData,
      avgPriceBelow50,
      avgPriceAbove50,
      
      // Exposure
      exposureBuckets,
      lowExposurePercent,
      marketCount: marketBalances.length,
      
      // Combined price
      profitablePercent,
      profitableMarkets,
      totalMarketsWithBoth: combinedPrices.length,
      combinedBuckets,
      
      // Totals
      totalBuys: buyTrades.length
    };
  }, [trades]);

  if (!analysis) return null;

  const priceVsAvgPieData = [
    { name: 'Boven gem.', value: analysis.abovePercent, color: 'hsl(var(--chart-4))' },
    { name: 'Onder gem.', value: analysis.belowPercent, color: 'hsl(var(--chart-2))' },
    { name: 'Rond gem.', value: analysis.atPercent, color: 'hsl(var(--muted-foreground))' }
  ];

  const exposurePieData = analysis.exposureBuckets.map((b, i) => ({
    name: b.label,
    value: b.count,
    color: i < 2 ? 'hsl(var(--chart-2))' : i < 4 ? 'hsl(var(--chart-4))' : 'hsl(var(--destructive))'
  }));

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Scale className="w-5 h-5 text-primary" />
        DCA Formule Analyse
      </h2>
      
      <p className="text-sm text-muted-foreground">
        Analyse van Gabagool's trade patronen: <strong>geen traditionele DCA</strong>, maar een 
        dual-side market making strategie met opportunistische aankopen.
      </p>

      {/* Key Finding Alert */}
      <Card className="glass border-warning/30 bg-warning/5">
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-warning/10 shrink-0">
              <AlertCircle className="w-5 h-5 text-warning" />
            </div>
            <div>
              <h4 className="font-semibold text-sm text-warning mb-1">Belangrijke Ontdekking: Geen Vaste DCA Trigger</h4>
              <p className="text-sm text-muted-foreground">
                De bot koopt <strong>bijna evenveel boven ({analysis.abovePercent.toFixed(0)}%) als onder ({analysis.belowPercent.toFixed(0)}%)</strong> zijn 
                gemiddelde prijs. Dit wijst op <strong>dual-side market making</strong>, niet traditionele DCA bij dips.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass border-chart-2/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Onder Gemiddelde</p>
                <p className="text-2xl font-mono font-bold text-chart-2">{analysis.belowPercent.toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground mt-1">"Echte" DCA</p>
              </div>
              <div className="p-2 rounded-lg bg-chart-2/10">
                <TrendingUp className="w-5 h-5 text-chart-2" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-chart-4/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Boven Gemiddelde</p>
                <p className="text-2xl font-mono font-bold text-chart-4">{analysis.abovePercent.toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground mt-1">"Geen" DCA</p>
              </div>
              <div className="p-2 rounded-lg bg-chart-4/10">
                <ArrowRightLeft className="w-5 h-5 text-chart-4" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-primary/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Winstgevend</p>
                <p className="text-2xl font-mono font-bold text-primary">{analysis.profitablePercent.toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground mt-1">Combined &lt; 1.0</p>
              </div>
              <div className="p-2 rounded-lg bg-primary/10">
                <CheckCircle2 className="w-5 h-5 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Laag Exposed</p>
                <p className="text-2xl font-mono font-bold">{analysis.lowExposurePercent.toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground mt-1">&lt;10% exposure</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Layers className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bimodal Price Distribution */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Repeat className="w-4 h-4 text-primary" />
            Bimodale Prijsverdeling
          </CardTitle>
          <CardDescription>
            Bot koopt actief op twee prijsniveaus - niet alleen "goedkoop"
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analysis.bimodalData}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--card))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }}
                      formatter={(value: number, name: string) => {
                        if (name === 'count') return [`${value} trades`, 'Aantal'];
                        if (name === 'avgPrice') return [`${(value * 100).toFixed(0)}¢`, 'Gem. prijs'];
                        return [value, name];
                      }}
                    />
                    <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-chart-2/10 border border-chart-2/20">
                <h4 className="font-semibold text-sm text-chart-2 mb-2">Prijzen &lt; 50¢</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Aantal trades:</span>
                    <span className="font-mono">{analysis.bimodalData[0].count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gemiddeld:</span>
                    <span className="font-mono font-bold">{(analysis.avgPriceBelow50 * 100).toFixed(0)}¢</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Percentage:</span>
                    <span className="font-mono">{analysis.bimodalData[0].percent.toFixed(0)}%</span>
                  </div>
                </div>
              </div>
              
              <div className="p-4 rounded-lg bg-chart-4/10 border border-chart-4/20">
                <h4 className="font-semibold text-sm text-chart-4 mb-2">Prijzen ≥ 50¢</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Aantal trades:</span>
                    <span className="font-mono">{analysis.bimodalData[1].count}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gemiddeld:</span>
                    <span className="font-mono font-bold">{(analysis.avgPriceAbove50 * 100).toFixed(0)}¢</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Percentage:</span>
                    <span className="font-mono">{analysis.bimodalData[1].percent.toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Price vs Running Average */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Prijs vs Lopend Gemiddelde</CardTitle>
            <CardDescription>Koopt de bot alleen bij "dips"?</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={priceVsAvgPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value.toFixed(0)}%`}
                    labelLine={false}
                  >
                    {priceVsAvgPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)}%`, 'Percentage']}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-center text-muted-foreground mt-2">
              Nee! Bot koopt bijna evenveel boven als onder gemiddelde
            </p>
          </CardContent>
        </Card>

        {/* Exposure Distribution */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Exposure Verdeling per Markt</CardTitle>
            <CardDescription>Hoe gebalanceerd zijn de posities?</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analysis.exposureBuckets}>
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value} markten`, 'Aantal']}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {analysis.exposureBuckets.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={index < 2 ? 'hsl(var(--chart-2))' : index < 4 ? 'hsl(var(--chart-4))' : 'hsl(var(--destructive))'} 
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-center text-muted-foreground mt-2">
              {analysis.lowExposurePercent.toFixed(0)}% van markten heeft &lt;10% exposure
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Combined Price Distribution */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Combined Price Verdeling
          </CardTitle>
          <CardDescription>
            Eindresultaat per markt: Up prijs + Down prijs (doel: &lt; 1.0)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analysis.combinedBuckets}>
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number, name: string, props: any) => [
                    `${value} markten (${props.payload.desc})`, 
                    'Aantal'
                  ]}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {analysis.combinedBuckets.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {analysis.combinedBuckets.map((bucket, i) => (
              <Badge 
                key={i} 
                variant="outline" 
                className="text-xs"
                style={{ borderColor: bucket.color, color: bucket.color }}
              >
                {bucket.label}: {bucket.count} ({bucket.desc})
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Strategy Conclusion */}
      <Card className="glass border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Target className="w-4 h-4 text-primary" />
            Conclusie: Dual-Side Market Making
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
              <h4 className="font-semibold text-sm text-destructive mb-2 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Wat het NIET is
              </h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• ❌ Traditionele DCA (alleen bij dips kopen)</li>
                <li>• ❌ Vaste prijs trigger voor bijkopen</li>
                <li>• ❌ Altijd "goedkoopste kant eerst"</li>
                <li>• ❌ Strikte combined price &lt;1.0 regel tijdens trading</li>
              </ul>
            </div>
            
            <div className="p-4 rounded-lg bg-chart-2/10 border border-chart-2/20">
              <h4 className="font-semibold text-sm text-chart-2 mb-2 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                Wat het WEL is
              </h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• ✅ Actief beide kanten kopen (market making)</li>
                <li>• ✅ Opportunistisch: koopt wanneer prijs aantrekkelijk is</li>
                <li>• ✅ Geleidelijk balanceren over tijd</li>
                <li>• ✅ Doel: combined price &lt;1.0 aan einde</li>
              </ul>
            </div>
          </div>

          <div className="p-4 rounded-lg bg-secondary/50 border border-border/50">
            <h4 className="font-semibold text-sm mb-2">💡 Hoe Werkt Het?</h4>
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>Start met initiële orders op beide kanten (~20 BTC / ~14 ETH shares)</li>
              <li>Koop opportunistisch bij wanneer prijzen aantrekkelijk zijn (ongeacht kant)</li>
              <li>Balanceer geleidelijk zodat exposure &lt;10% blijft</li>
              <li>Einddoel: combined price (Up avg + Down avg) &lt; 1.0 = gegarandeerde winst</li>
            </ol>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
