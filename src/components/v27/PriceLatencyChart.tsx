import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, Area, AreaChart, ComposedChart, Bar } from 'recharts';
import { RefreshCw, TrendingUp, TrendingDown, Clock, Activity } from 'lucide-react';
import { usePriceLatencyAnalysis } from '@/hooks/usePriceLatencyAnalysis';
import { format } from 'date-fns';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

// Generate time windows for last few 15-min intervals
function getRecentIntervals(): { label: string; start: number; end: number }[] {
  const now = Date.now();
  const intervalMs = 15 * 60 * 1000;
  const currentIntervalStart = Math.floor(now / intervalMs) * intervalMs;
  
  const intervals = [];
  for (let i = 0; i < 8; i++) {
    const start = currentIntervalStart - (i * intervalMs);
    const end = start + intervalMs;
    intervals.push({
      label: format(new Date(start), 'HH:mm') + ' - ' + format(new Date(end), 'HH:mm'),
      start,
      end,
    });
  }
  return intervals;
}

export function PriceLatencyChart() {
  const [asset, setAsset] = useState('BTC');
  const intervals = useMemo(() => getRecentIntervals(), []);
  const [selectedInterval, setSelectedInterval] = useState(0);
  
  const interval = intervals[selectedInterval];
  const { data, stats, loading, error, refetch } = usePriceLatencyAnalysis(
    asset,
    interval?.start || 0,
    interval?.end || 0
  );

  // Prepare chart data
  const chartData = useMemo(() => {
    return data.map(point => ({
      time: format(new Date(point.timestamp), 'HH:mm:ss'),
      timestamp: point.timestamp,
      binance: point.binance,
      polymarket: point.polymarket,
      chainlink: point.chainlink,
      upShare: point.upShare ? point.upShare * 100 : null, // Convert to cents
      downShare: point.downShare ? point.downShare * 100 : null,
      binanceDelta: point.binanceDelta,
      polymarketDelta: point.polymarketDelta,
      spread: point.binanceVsChainlink,
      // Calculate theoretical value
      delta: point.binance && point.chainlink ? ((point.binance - point.chainlink) / point.chainlink * 100).toFixed(3) : null,
    }));
  }, [data]);

  // Find significant price moves
  const significantMoves = useMemo(() => {
    const moves: { timestamp: number; binanceDelta: number; polymarketLag: number | null; sharePriceReaction: number | null }[] = [];
    
    for (let i = 1; i < data.length; i++) {
      const curr = data[i];
      if (curr.binanceDelta !== null && Math.abs(curr.binanceDelta) > 5) {
        // Look for polymarket reaction
        let polymarketLag = null;
        let sharePriceReaction = null;
        
        for (let j = i; j < Math.min(i + 10, data.length); j++) {
          const future = data[j];
          if (future.polymarketDelta !== null && Math.abs(future.polymarketDelta) > 1) {
            polymarketLag = future.timestamp - curr.timestamp;
            break;
          }
        }
        
        // Look at share price change
        if (curr.upShareDelta !== null) {
          sharePriceReaction = curr.upShareDelta;
        }
        
        moves.push({
          timestamp: curr.timestamp,
          binanceDelta: curr.binanceDelta,
          polymarketLag,
          sharePriceReaction,
        });
      }
    }
    return moves;
  }, [data]);

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Price Latency & Arbitrage Analysis
            </CardTitle>
            <CardDescription>
              Vergelijk prijsbewegingen tussen Binance, Chainlink en Polymarket share prices
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={asset} onValueChange={setAsset}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSETS.map(a => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select 
              value={selectedInterval.toString()} 
              onValueChange={(v) => setSelectedInterval(parseInt(v))}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervals.map((int, i) => (
                  <SelectItem key={i} value={i.toString()}>{int.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon" onClick={refetch} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Stats row */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs text-muted-foreground">Binance Ticks</div>
              <div className="text-xl font-bold">{stats.binanceTickCount.toLocaleString()}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs text-muted-foreground">Chainlink Ticks</div>
              <div className="text-xl font-bold">{stats.chainlinkTickCount.toLocaleString()}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs text-muted-foreground">Polymarket Ticks</div>
              <div className="text-xl font-bold">{stats.polymarketTickCount.toLocaleString()}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs text-muted-foreground">UP Share Ticks</div>
              <div className="text-xl font-bold">{stats.upShareTickCount.toLocaleString()}</div>
            </div>
            <div className="bg-muted rounded-lg p-3">
              <div className="text-xs text-muted-foreground">DOWN Share Ticks</div>
              <div className="text-xl font-bold">{stats.downShareTickCount.toLocaleString()}</div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-destructive text-center py-8">{error}</div>
        )}

        {!error && chartData.length > 0 && (
          <Tabs defaultValue="prices" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="prices">Prijzen</TabsTrigger>
              <TabsTrigger value="spread">Spread (Binance vs Chainlink)</TabsTrigger>
              <TabsTrigger value="shares">Share Prices</TabsTrigger>
              <TabsTrigger value="deltas">Price Deltas</TabsTrigger>
            </TabsList>

            <TabsContent value="prices">
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      domain={['auto', 'auto']}
                      tickFormatter={(v) => `$${v.toLocaleString()}`}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value?.toLocaleString()}`, '']}
                      labelFormatter={(label) => `Time: ${label}`}
                    />
                    <Legend />
                    <Line 
                      type="monotone" 
                      dataKey="binance" 
                      stroke="hsl(var(--chart-1))" 
                      dot={false} 
                      strokeWidth={2}
                      name="Binance"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="polymarket" 
                      stroke="hsl(var(--chart-2))" 
                      dot={false} 
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                      name="Polymarket RTDS"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="chainlink" 
                      stroke="hsl(var(--chart-3))" 
                      dot={false} 
                      strokeWidth={1.5}
                      name="Chainlink (Price to Beat)"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Let op: Chainlink (oranje) is de "Price to Beat" die Polymarket gebruikt voor settlement
              </p>
            </TabsContent>

            <TabsContent value="spread">
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      tickFormatter={(v) => `$${v.toFixed(0)}`}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value?.toFixed(2)}`, '']}
                    />
                    <Legend />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Area 
                      type="monotone" 
                      dataKey="spread" 
                      fill="hsl(var(--chart-4))" 
                      fillOpacity={0.3}
                      stroke="hsl(var(--chart-4))" 
                      name="Binance - Chainlink Spread"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Spread = Binance prijs - Chainlink prijs. Positief = Binance hoger, Negatief = Chainlink hoger
              </p>
            </TabsContent>

            <TabsContent value="shares">
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}¢`}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`${value?.toFixed(1)}¢`, '']}
                    />
                    <Legend />
                    <ReferenceLine y={50} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" label="50¢" />
                    <Line 
                      type="monotone" 
                      dataKey="upShare" 
                      stroke="hsl(142 76% 36%)" 
                      dot={false} 
                      strokeWidth={2}
                      name="UP Share Price"
                    />
                    <Line 
                      type="monotone" 
                      dataKey="downShare" 
                      stroke="hsl(0 84% 60%)" 
                      dot={false} 
                      strokeWidth={2}
                      name="DOWN Share Price"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </TabsContent>

            <TabsContent value="deltas">
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      tickFormatter={(v) => `$${v.toFixed(0)}`}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value?.toFixed(2)}`, '']}
                    />
                    <Legend />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                    <Bar 
                      dataKey="binanceDelta" 
                      fill="hsl(var(--chart-1))" 
                      name="Binance Δ"
                      opacity={0.7}
                    />
                    <Bar 
                      dataKey="polymarketDelta" 
                      fill="hsl(var(--chart-2))" 
                      name="Polymarket Δ"
                      opacity={0.7}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Prijsverandering per seconde. Grote Binance moves die niet in Polymarket verschijnen = arbitrage kans
              </p>
            </TabsContent>
          </Tabs>
        )}

        {!error && chartData.length === 0 && !loading && (
          <div className="text-center text-muted-foreground py-12">
            Geen data gevonden voor dit interval
          </div>
        )}

        {/* Significant moves table */}
        {significantMoves.length > 0 && (
          <div className="mt-6">
            <h4 className="font-medium mb-3 flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Significante Prijsbewegingen (&gt;$5)
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3">Tijd</th>
                    <th className="text-right py-2 px-3">Binance Δ</th>
                    <th className="text-right py-2 px-3">Polymarket Lag</th>
                    <th className="text-right py-2 px-3">Share Reactie</th>
                  </tr>
                </thead>
                <tbody>
                  {significantMoves.slice(0, 10).map((move, i) => (
                    <tr key={i} className="border-b border-muted">
                      <td className="py-2 px-3">{format(new Date(move.timestamp), 'HH:mm:ss')}</td>
                      <td className={`py-2 px-3 text-right font-mono ${move.binanceDelta > 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {move.binanceDelta > 0 ? '+' : ''}{move.binanceDelta.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right">
                        {move.polymarketLag !== null ? (
                          <Badge variant={move.polymarketLag <= 1000 ? 'default' : 'secondary'}>
                            {move.polymarketLag}ms
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {move.sharePriceReaction !== null ? (
                          <span className={move.sharePriceReaction > 0 ? 'text-green-500' : 'text-red-500'}>
                            {move.sharePriceReaction > 0 ? '+' : ''}{(move.sharePriceReaction * 100).toFixed(2)}¢
                          </span>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
