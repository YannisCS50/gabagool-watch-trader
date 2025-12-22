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
  Pie
} from 'recharts';
import { TrendingDown, Layers, Zap, Target, AlertTriangle } from 'lucide-react';
import type { Trade } from '@/types/trade';

interface TradeSizeEvolutionChartProps {
  trades: Trade[];
}

interface OrderGroup {
  market: string;
  outcome: string;
  timestamp: Date;
  totalShares: number;
  tradeCount: number;
}

export function TradeSizeEvolutionChart({ trades }: TradeSizeEvolutionChartProps) {
  const analysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market-outcome
    const marketGroups = new Map<string, Trade[]>();
    trades.forEach(t => {
      if (t.side === 'buy') {
        const key = `${t.market}-${t.outcome}`;
        if (!marketGroups.has(key)) marketGroups.set(key, []);
        marketGroups.get(key)!.push(t);
      }
    });

    // For each market, group trades by second (partial fills → single order)
    const marketOrders = new Map<string, OrderGroup[]>();
    
    marketGroups.forEach((marketTrades, key) => {
      const sorted = [...marketTrades].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const orders: OrderGroup[] = [];
      
      let currentOrder: OrderGroup | null = null;
      
      sorted.forEach(trade => {
        const tradeSecond = Math.floor(trade.timestamp.getTime() / 1000);
        
        if (currentOrder && Math.floor(currentOrder.timestamp.getTime() / 1000) === tradeSecond) {
          // Same second = same order (partial fill)
          currentOrder.totalShares += trade.shares;
          currentOrder.tradeCount++;
        } else {
          // New order
          if (currentOrder) orders.push(currentOrder);
          currentOrder = {
            market: trade.market,
            outcome: trade.outcome,
            timestamp: trade.timestamp,
            totalShares: trade.shares,
            tradeCount: 1
          };
        }
      });
      
      if (currentOrder) orders.push(currentOrder);
      marketOrders.set(key, orders);
    });

    // Collect first order sizes from each market
    const firstOrderSizes: number[] = [];
    const allOrderSizes: number[] = [];
    
    marketOrders.forEach(orders => {
      if (orders.length > 0) {
        firstOrderSizes.push(orders[0].totalShares);
      }
      orders.forEach(order => {
        allOrderSizes.push(order.totalShares);
      });
    });

    // Calculate distribution of first order sizes
    const sizeDistribution = {
      klein: firstOrderSizes.filter(s => s < 20).length,
      medium: firstOrderSizes.filter(s => s >= 20 && s < 50).length,
      groot: firstOrderSizes.filter(s => s >= 50 && s < 100).length,
      zeerGroot: firstOrderSizes.filter(s => s >= 100).length
    };

    const total = firstOrderSizes.length || 1;
    const distributionPercent = {
      klein: Math.round((sizeDistribution.klein / total) * 100),
      medium: Math.round((sizeDistribution.medium / total) * 100),
      groot: Math.round((sizeDistribution.groot / total) * 100),
      zeerGroot: Math.round((sizeDistribution.zeerGroot / total) * 100)
    };

    // Pie chart data
    const pieData = [
      { name: 'Klein (<20)', value: distributionPercent.klein, fill: 'hsl(var(--primary))' },
      { name: 'Medium (20-50)', value: distributionPercent.medium, fill: 'hsl(var(--chart-2))' },
      { name: 'Groot (50-100)', value: distributionPercent.groot, fill: 'hsl(var(--chart-4))' },
      { name: 'Zeer groot (100+)', value: distributionPercent.zeerGroot, fill: 'hsl(var(--destructive))' }
    ].filter(d => d.value > 0);

    // Calculate order number statistics (using aggregated orders, not individual trades)
    const orderNumberStats = new Map<number, { totalShares: number; count: number }>();
    
    marketOrders.forEach(orders => {
      orders.forEach((order, idx) => {
        const orderNum = idx + 1;
        if (orderNum <= 10) {
          if (!orderNumberStats.has(orderNum)) {
            orderNumberStats.set(orderNum, { totalShares: 0, count: 0 });
          }
          const stats = orderNumberStats.get(orderNum)!;
          stats.totalShares += order.totalShares;
          stats.count++;
        }
      });
    });

    // Evolution data for line chart
    const evolutionData = Array.from(orderNumberStats.entries())
      .map(([orderNum, stats]) => ({
        orderNum,
        avgShares: stats.count > 0 ? Math.round((stats.totalShares / stats.count) * 10) / 10 : 0,
        count: stats.count
      }))
      .sort((a, b) => a.orderNum - b.orderNum);

    // Histogram data for first order sizes
    const histogramBuckets = [
      { range: '1-10', min: 1, max: 10, count: 0 },
      { range: '11-20', min: 11, max: 20, count: 0 },
      { range: '21-30', min: 21, max: 30, count: 0 },
      { range: '31-50', min: 31, max: 50, count: 0 },
      { range: '51-75', min: 51, max: 75, count: 0 },
      { range: '76-100', min: 76, max: 100, count: 0 },
      { range: '100+', min: 100, max: Infinity, count: 0 }
    ];

    firstOrderSizes.forEach(size => {
      const bucket = histogramBuckets.find(b => size >= b.min && size <= b.max);
      if (bucket) bucket.count++;
    });

    // Statistics
    const avgFirstOrder = firstOrderSizes.length > 0 
      ? firstOrderSizes.reduce((a, b) => a + b, 0) / firstOrderSizes.length 
      : 0;
    const avgAllOrders = allOrderSizes.length > 0
      ? allOrderSizes.reduce((a, b) => a + b, 0) / allOrderSizes.length
      : 0;
    const maxFirstOrder = firstOrderSizes.length > 0 ? Math.max(...firstOrderSizes) : 0;
    const minFirstOrder = firstOrderSizes.length > 0 ? Math.min(...firstOrderSizes) : 0;

    return {
      evolutionData,
      pieData,
      histogramData: histogramBuckets,
      distributionPercent,
      avgFirstOrder,
      avgAllOrders,
      maxFirstOrder,
      minFirstOrder,
      totalMarkets: marketOrders.size,
      totalOrders: allOrderSizes.length
    };
  }, [trades]);

  if (!analysis) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Layers className="w-5 h-5 text-primary" />
        Order Size Analyse (Gecorrigeerd)
      </h2>
      
      <p className="text-sm text-muted-foreground">
        <strong>Correctie:</strong> Partial fills zijn nu samengevoegd tot orders. De gemiddelde eerste order is ~{analysis.avgFirstOrder.toFixed(0)} shares, 
        niet ~140 shares zoals eerder vermeld. De order grootte varieert sterk afhankelijk van liquiditeit.
      </p>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass border-primary/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Gem. Eerste Order</p>
                <p className="text-2xl font-mono font-bold text-primary">
                  {analysis.avgFirstOrder.toFixed(0)} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">Per markt</p>
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
                <p className="text-xs text-muted-foreground">Gem. Alle Orders</p>
                <p className="text-2xl font-mono font-bold">
                  {analysis.avgAllOrders.toFixed(0)} shares
                </p>
                <p className="text-xs text-muted-foreground mt-1">Totaal</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Layers className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Range</p>
                <p className="text-2xl font-mono font-bold">
                  {analysis.minFirstOrder.toFixed(0)}-{analysis.maxFirstOrder.toFixed(0)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Min-Max shares</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <TrendingDown className="w-5 h-5 text-muted-foreground" />
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
                  {analysis.totalMarkets}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{analysis.totalOrders} orders</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Layers className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Distribution Badges */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary">
          Klein (&lt;20): {analysis.distributionPercent.klein}%
        </Badge>
        <Badge variant="outline" className="bg-chart-2/10 border-chart-2/30 text-chart-2">
          Medium (20-50): {analysis.distributionPercent.medium}%
        </Badge>
        <Badge variant="outline" className="bg-chart-4/10 border-chart-4/30 text-chart-4">
          Groot (50-100): {analysis.distributionPercent.groot}%
        </Badge>
        <Badge variant="outline" className="bg-destructive/10 border-destructive/30 text-destructive">
          Zeer groot (100+): {analysis.distributionPercent.zeerGroot}%
        </Badge>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Pie Chart - Distribution */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Eerste Order Verdeling</CardTitle>
            <CardDescription>Meeste eerste orders zijn klein (&lt;20 shares)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={analysis.pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${value}%`}
                  >
                    {analysis.pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value}%`, 'Percentage']}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-2 mt-2 justify-center">
              {analysis.pieData.map((entry, index) => (
                <div key={index} className="flex items-center gap-1 text-xs">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.fill }} />
                  <span className="text-muted-foreground">{entry.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Histogram - First Order Sizes */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Eerste Order Histogram</CardTitle>
            <CardDescription>Verdeling van order sizes per markt</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analysis.histogramData}>
                  <XAxis dataKey="range" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number) => [`${value} markten`, 'Aantal']}
                  />
                  <Bar 
                    dataKey="count" 
                    fill="hsl(var(--primary))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Order Evolution Line Chart */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm">Order Size per Ordernummer</CardTitle>
          <CardDescription>Gemiddelde order size (partial fills samengevoegd) per ordernummer binnen een markt</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analysis.evolutionData}>
                <XAxis 
                  dataKey="orderNum" 
                  tick={{ fontSize: 11 }} 
                  label={{ value: 'Order #', position: 'insideBottom', offset: -5, fontSize: 10 }}
                />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))', 
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px'
                  }}
                  formatter={(value: number) => [`${value.toFixed(1)} shares`, 'Gemiddeld']}
                  labelFormatter={(label) => `Order ${label}`}
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

      {/* Corrected Explanation */}
      <Card className="glass border-warning/30 bg-warning/5">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            Gecorrigeerde Conclusie
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="p-4 bg-destructive/10 rounded-lg border border-destructive/20">
              <h4 className="font-semibold text-sm mb-2 text-destructive">❌ Vorige Conclusie (Incorrect)</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• "Trade 1-2 zijn altijd ~140 shares"</li>
                <li>• "Duidelijke twee-fasen strategie"</li>
                <li>• "Initiële orders zijn 10x groter"</li>
              </ul>
            </div>
            <div className="p-4 bg-success/10 rounded-lg border border-success/20">
              <h4 className="font-semibold text-sm mb-2 text-success">✓ Correcte Conclusie</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• <strong>Gemiddeld ~{analysis.avgFirstOrder.toFixed(0)} shares</strong> eerste order</li>
                <li>• <strong>{analysis.distributionPercent.klein}% kleine orders</strong> (&lt;20 shares)</li>
                <li>• <strong>Grote spreiding:</strong> {analysis.minFirstOrder.toFixed(0)}-{analysis.maxFirstOrder.toFixed(0)} shares</li>
              </ul>
            </div>
          </div>

          <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
            <h4 className="font-semibold text-sm mb-2 text-primary">💡 Wat Dit Betekent</h4>
            <p className="text-sm text-muted-foreground">
              De bot heeft <strong>geen vaste initiële order size</strong>. Order grootte is <strong>opportunistisch</strong> en 
              hangt af van beschikbare liquiditeit. Grote orders (100+ shares) zijn <strong>uitzonderingen</strong> ({analysis.distributionPercent.zeerGroot}%), 
              niet de norm. De strategie is flexibeler dan eerder gedacht - de bot pakt wat beschikbaar is.
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
