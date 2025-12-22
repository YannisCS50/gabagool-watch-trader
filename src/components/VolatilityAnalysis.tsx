import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  ScatterChart, 
  Scatter, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer,
  Cell
} from 'recharts';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table';
import { Activity, TrendingUp, AlertTriangle, Clock, Zap } from 'lucide-react';
import type { Trade } from '@/types/trade';

interface VolatilityAnalysisProps {
  trades: Trade[];
}

interface MarketVolatility {
  market: string;
  marketType: 'BTC' | 'ETH' | 'Other';
  minPrice: number;
  maxPrice: number;
  spread: number;
  tradesCount: number;
  avgPrice: number;
  priceRange: string; // e.g., "0.15 - 0.85"
  timeSpan: number; // minutes between first and last trade
}

export function VolatilityAnalysis({ trades }: VolatilityAnalysisProps) {
  const volatilityAnalysis = useMemo(() => {
    if (trades.length === 0) return null;

    // Group trades by market
    const marketGroups = new Map<string, Trade[]>();
    trades.forEach(t => {
      if (t.side === 'buy') {
        if (!marketGroups.has(t.market)) marketGroups.set(t.market, []);
        marketGroups.get(t.market)!.push(t);
      }
    });

    const marketVolatilities: MarketVolatility[] = [];

    marketGroups.forEach((marketTrades, market) => {
      if (marketTrades.length < 3) return; // Need at least 3 trades for meaningful analysis

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

      const prices = marketTrades.map(t => t.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const spread = maxPrice - minPrice;
      const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;

      // Calculate time span
      const timestamps = marketTrades.map(t => t.timestamp.getTime());
      const timeSpan = (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60);

      marketVolatilities.push({
        market,
        marketType,
        minPrice,
        maxPrice,
        spread,
        tradesCount: marketTrades.length,
        avgPrice,
        priceRange: `${(minPrice * 100).toFixed(0)}¢ - ${(maxPrice * 100).toFixed(0)}¢`,
        timeSpan: Math.round(timeSpan)
      });
    });

    // Sort by spread (most volatile first)
    const sortedBySpread = [...marketVolatilities].sort((a, b) => b.spread - a.spread);
    const topVolatile = sortedBySpread.slice(0, 10);

    // Calculate statistics
    const avgSpread = marketVolatilities.reduce((sum, m) => sum + m.spread, 0) / marketVolatilities.length;
    const highVolatileCount = marketVolatilities.filter(m => m.spread > 0.3).length;
    const mediumVolatileCount = marketVolatilities.filter(m => m.spread > 0.1 && m.spread <= 0.3).length;
    const lowVolatileCount = marketVolatilities.filter(m => m.spread <= 0.1).length;

    // Scatter data for spread vs trades
    const scatterData = marketVolatilities.map(m => ({
      x: m.tradesCount,
      y: m.spread * 100,
      market: m.market.slice(0, 30),
      marketType: m.marketType
    }));

    // Volatility distribution
    const volatilityBuckets = [
      { label: '0-10%', min: 0, max: 0.1, count: 0, color: 'hsl(var(--success))' },
      { label: '10-20%', min: 0.1, max: 0.2, count: 0, color: 'hsl(var(--chart-4))' },
      { label: '20-30%', min: 0.2, max: 0.3, count: 0, color: 'hsl(var(--warning))' },
      { label: '30-50%', min: 0.3, max: 0.5, count: 0, color: 'hsl(var(--warning))' },
      { label: '>50%', min: 0.5, max: 1, count: 0, color: 'hsl(var(--destructive))' },
    ];

    marketVolatilities.forEach(m => {
      const bucket = volatilityBuckets.find(b => m.spread >= b.min && m.spread < b.max);
      if (bucket) bucket.count++;
    });

    return {
      totalMarkets: marketVolatilities.length,
      avgSpread,
      highVolatileCount,
      mediumVolatileCount,
      lowVolatileCount,
      topVolatile,
      scatterData,
      volatilityBuckets,
      maxSpread: sortedBySpread[0]?.spread || 0
    };
  }, [trades]);

  if (!volatilityAnalysis) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Activity className="w-5 h-5 text-warning" />
        Volatiliteit Analyse
      </h2>
      
      <p className="text-sm text-muted-foreground">
        15-minuten BTC/ETH markten convergeren naar 0 of 1 - dat verklaart de hoge spreads die we zien.
      </p>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass border-warning/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Max Spread</p>
                <p className="text-2xl font-mono font-bold text-warning">
                  {(volatilityAnalysis.maxSpread * 100).toFixed(0)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">Hoogste volatiliteit</p>
              </div>
              <div className="p-2 rounded-lg bg-warning/10">
                <AlertTriangle className="w-5 h-5 text-warning" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Gem. Spread</p>
                <p className="text-2xl font-mono font-bold">
                  {(volatilityAnalysis.avgSpread * 100).toFixed(0)}%
                </p>
                <p className="text-xs text-muted-foreground mt-1">Per markt</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <TrendingUp className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass border-destructive/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Hoog Volatiel</p>
                <p className="text-2xl font-mono font-bold text-destructive">
                  {volatilityAnalysis.highVolatileCount}
                </p>
                <p className="text-xs text-muted-foreground mt-1">&gt;30% spread</p>
              </div>
              <div className="p-2 rounded-lg bg-destructive/10">
                <Zap className="w-5 h-5 text-destructive" />
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
                  {volatilityAnalysis.totalMarkets}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Geanalyseerd</p>
              </div>
              <div className="p-2 rounded-lg bg-secondary">
                <Activity className="w-5 h-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Insights */}
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline" className="bg-warning/10 border-warning/30 text-warning">
          <Clock className="w-3 h-3 mr-1" />
          15-min markten = inherent volatiel
        </Badge>
        <Badge variant="outline" className="bg-success/10 border-success/30 text-success">
          <TrendingUp className="w-3 h-3 mr-1" />
          Prijzen convergeren naar 0 of 1
        </Badge>
        <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary">
          <Zap className="w-3 h-3 mr-1" />
          Bot handelt gedurende hele lifecycle
        </Badge>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Scatter Plot: Spread vs Trades */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Spread vs Aantal Trades</CardTitle>
            <CardDescription>Relatie tussen volatiliteit en trading activiteit</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <XAxis 
                    type="number" 
                    dataKey="x" 
                    name="Trades" 
                    tick={{ fontSize: 11 }}
                    label={{ value: 'Aantal trades', position: 'insideBottom', offset: -10, fontSize: 10 }}
                  />
                  <YAxis 
                    type="number" 
                    dataKey="y" 
                    name="Spread %" 
                    tick={{ fontSize: 11 }}
                    label={{ value: 'Spread %', angle: -90, position: 'insideLeft', fontSize: 10 }}
                  />
                  <Tooltip 
                    cursor={{ strokeDasharray: '3 3' }}
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))', 
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px'
                    }}
                    formatter={(value: number, name: string) => [
                      name === 'x' ? `${value} trades` : `${value.toFixed(0)}%`,
                      name === 'x' ? 'Trades' : 'Spread'
                    ]}
                  />
                  <Scatter data={volatilityAnalysis.scatterData}>
                    {volatilityAnalysis.scatterData.map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.marketType === 'BTC' ? 'hsl(var(--chart-4))' : 'hsl(var(--primary))'}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-4 mt-2">
              <div className="flex items-center gap-1 text-xs">
                <div className="w-3 h-3 rounded-full bg-chart-4" />
                <span className="text-muted-foreground">BTC</span>
              </div>
              <div className="flex items-center gap-1 text-xs">
                <div className="w-3 h-3 rounded-full bg-primary" />
                <span className="text-muted-foreground">ETH</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Volatility Distribution */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-sm">Volatiliteit Distributie</CardTitle>
            <CardDescription>Verdeling van price spreads per markt</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {volatilityAnalysis.volatilityBuckets.map((bucket, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-16">{bucket.label}</span>
                  <div className="flex-1 h-6 bg-secondary/50 rounded overflow-hidden">
                    <div 
                      className="h-full rounded transition-all duration-500"
                      style={{ 
                        width: `${(bucket.count / volatilityAnalysis.totalMarkets) * 100}%`,
                        backgroundColor: bucket.color
                      }}
                    />
                  </div>
                  <span className="text-sm font-mono w-12 text-right">{bucket.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Explanation Card */}
      <Card className="glass border-warning/30">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-warning" />
            Waarom Hoge Volatiliteit?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="p-4 bg-warning/10 rounded-lg border border-warning/20">
              <h4 className="font-semibold text-sm mb-2 text-warning">📊 15-Minuten Markten</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Binaire uitkomst: prijs wordt 0 of 1</li>
                <li>• Start rond 50¢ (onzeker)</li>
                <li>• Convergeert naar uitkomst in 15 min</li>
                <li>• Spreads tot {(volatilityAnalysis.maxSpread * 100).toFixed(0)}% zijn normaal</li>
              </ul>
            </div>
            <div className="p-4 bg-success/10 rounded-lg border border-success/20">
              <h4 className="font-semibold text-sm mb-2 text-success">✓ Bot Strategie</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• Handelt gedurende hele lifecycle</li>
                <li>• Profiteert van prijsbewegingen</li>
                <li>• Koopt bij dips op beide kanten</li>
                <li>• Volatiliteit = opportunity</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Volatile Markets Table */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-sm">Meest Volatiele Markten</CardTitle>
          <CardDescription>Top 10 markten gesorteerd op price spread</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Markt</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Spread</TableHead>
                  <TableHead className="text-right">Price Range</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {volatilityAnalysis.topVolatile.map((market, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {market.market.slice(0, 40)}...
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={
                        market.marketType === 'BTC' 
                          ? 'bg-chart-4/10 text-chart-4 border-chart-4/30' 
                          : 'bg-primary/10 text-primary border-primary/30'
                      }>
                        {market.marketType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className={market.spread > 0.3 ? 'text-destructive' : market.spread > 0.15 ? 'text-warning' : ''}>
                        {(market.spread * 100).toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {market.priceRange}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {market.tradesCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
