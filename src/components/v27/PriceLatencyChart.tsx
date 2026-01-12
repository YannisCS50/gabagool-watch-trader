import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ComposedChart, Bar } from 'recharts';
import { RefreshCw, Activity, Play, Square, Wifi, WifiOff } from 'lucide-react';
import { usePriceLatencyComparison, Asset } from '@/hooks/usePriceLatencyComparison';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

const COLORS = {
  binance: '#F0B90B',
  chainlink: '#375BD2',
  positive: '#3FB950',
  negative: '#F85149',
};

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
    + '.' + String(ts % 1000).padStart(3, '0');
}

export function PriceLatencyChart() {
  const {
    selectedAsset,
    binancePrice,
    chainlinkPrice,
    binanceLastUpdate,
    chainlinkLastUpdate,
    connectionStatus,
    eventLog,
    stats,
    setSelectedAsset,
    clearEventLog,
    resetSession,
    connect,
    disconnect,
    getChartData,
    getLatencyHistogram,
    binanceWsStatus,
    chainlinkWsStatus,
    lastError,
  } = usePriceLatencyComparison();

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });
  const [histogramData, setHistogramData] = useState<{ range: string; count: number }[]>([]);

  // Update chart data at high frequency (50ms) for real-time feel
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
      setHistogramData(getLatencyHistogram());
    }, 50);
    return () => clearInterval(interval);
  }, [getChartData, getLatencyHistogram]);

  // Combine chart data for dual-line chart with ms precision
  const combinedChartData = useMemo(() => {
    const merged = [...chartData.binanceData, ...chartData.chainlinkData]
      .sort((a, b) => a.time - b.time)
      .reduce((acc, point) => {
        // Use smaller window (50ms) for matching points
        const existing = acc.find((p: any) => Math.abs(p.time - point.time) < 50);
        if (existing) {
          existing[point.source] = point.price;
        } else {
          acc.push({ time: point.time, [point.source]: point.price });
        }
        return acc;
      }, [] as any[]);
    
    // Keep last 600 data points (approx 30 seconds at 50ms intervals)
    return merged.slice(-600);
  }, [chartData]);

  // Calculate price deltas for delta chart
  const deltaChartData = useMemo(() => {
    const data: { time: number; binanceDelta: number | null; chainlinkDelta: number | null }[] = [];
    let prevBinance: number | null = null;
    let prevChainlink: number | null = null;

    for (const point of combinedChartData) {
      const binanceDelta = point.binance && prevBinance ? point.binance - prevBinance : null;
      const chainlinkDelta = point.chainlink && prevChainlink ? point.chainlink - prevChainlink : null;

      if (binanceDelta !== null || chainlinkDelta !== null) {
        data.push({
          time: point.time,
          binanceDelta: binanceDelta && Math.abs(binanceDelta) > 0.01 ? binanceDelta : null,
          chainlinkDelta: chainlinkDelta && Math.abs(chainlinkDelta) > 0.01 ? chainlinkDelta : null,
        });
      }

      if (point.binance) prevBinance = point.binance;
      if (point.chainlink) prevChainlink = point.chainlink;
    }

    return data.slice(-300);
  }, [combinedChartData]);

  // Calculate spread data
  const spreadChartData = useMemo(() => {
    return combinedChartData
      .filter(p => p.binance && p.chainlink)
      .map(p => ({
        time: p.time,
        spread: p.binance - p.chainlink,
      }));
  }, [combinedChartData]);

  // Recent significant moves from event log
  const significantMoves = useMemo(() => {
    const moves: { time: number; source: string; price: number; latencyLead?: number }[] = [];
    let prevPrice: Record<string, number> = {};

    for (const event of eventLog.slice(0, 100)) {
      const prev = prevPrice[event.source];
      if (prev && Math.abs(event.price - prev) > (selectedAsset === 'BTC' ? 5 : 0.1)) {
        moves.push({
          time: event.timestamp,
          source: event.source,
          price: event.price,
          latencyLead: event.latencyLead,
        });
      }
      prevPrice[event.source] = event.price;
    }

    return moves.slice(0, 10);
  }, [eventLog, selectedAsset]);

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Realtime Price Latency Analysis
            </CardTitle>
            <CardDescription>
              Live WebSocket vergelijking: Binance vs Chainlink RTDS (50ms resolution)
            </CardDescription>
            {lastError && (
              <p className="text-xs text-destructive mt-1">{lastError}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Asset selector */}
            <Tabs value={selectedAsset} onValueChange={(v) => setSelectedAsset(v as Asset)}>
              <TabsList>
                {ASSETS.map(a => (
                  <TabsTrigger key={a} value={a} className="px-3">{a}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            
            {/* Connection status */}
            <div className="flex gap-1">
              <Badge 
                variant="outline"
                className={`text-xs ${binanceWsStatus === 'connected' ? 'border-yellow-500 text-yellow-500' : 'border-muted'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${binanceWsStatus === 'connected' ? 'bg-yellow-500' : 'bg-muted'}`} />
                Binance
              </Badge>
              <Badge 
                variant="outline"
                className={`text-xs ${chainlinkWsStatus === 'connected' ? 'border-blue-500 text-blue-500' : 'border-muted'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${chainlinkWsStatus === 'connected' ? 'bg-blue-500' : 'bg-muted'}`} />
                Chainlink
              </Badge>
            </div>

            {/* Controls */}
            {connectionStatus === 'connected' ? (
              <Button variant="outline" size="sm" onClick={disconnect}>
                <Square className="h-4 w-4 mr-1" />
                Stop
              </Button>
            ) : (
              <Button variant="default" size="sm" onClick={connect} disabled={connectionStatus === 'connecting'}>
                <Play className="h-4 w-4 mr-1" />
                {connectionStatus === 'connecting' ? 'Connecting...' : 'Start'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={resetSession}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Live price cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.binance }} />
              Binance
            </div>
            <div className="text-xl font-mono font-bold" style={{ color: COLORS.binance }}>
              {binancePrice ? `$${binancePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {binanceLastUpdate ? formatTimestamp(binanceLastUpdate) : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.chainlink }} />
              Chainlink (Price to Beat)
            </div>
            <div className="text-xl font-mono font-bold" style={{ backgroundColor: COLORS.chainlink }}>
              {chainlinkPrice ? `$${chainlinkPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {chainlinkLastUpdate ? formatTimestamp(chainlinkLastUpdate) : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Current Latency</div>
            <div className={`text-xl font-mono font-bold ${stats.currentLatency && stats.currentLatency > 0 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.currentLatency !== null ? `${stats.currentLatency > 0 ? '+' : ''}${stats.currentLatency.toFixed(0)}ms` : '—'}
            </div>
            <div className="text-xs text-muted-foreground">
              {stats.currentLatency && stats.currentLatency > 0 ? 'Binance leads' : stats.currentLatency ? 'Chainlink leads' : ''}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Price Diff</div>
            <div className="text-xl font-mono font-bold">
              {stats.priceDiff !== null ? `$${stats.priceDiff.toFixed(2)}` : '—'}
            </div>
            <div className="text-xs text-muted-foreground">
              {stats.priceDiffPercent !== null ? `(${stats.priceDiffPercent.toFixed(4)}%)` : ''}
            </div>
          </div>
        </div>

        {/* Charts */}
        <Tabs defaultValue="prices" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="prices">Live Prices</TabsTrigger>
            <TabsTrigger value="spread">Spread</TabsTrigger>
            <TabsTrigger value="deltas">Price Deltas</TabsTrigger>
            <TabsTrigger value="log">Event Log</TabsTrigger>
          </TabsList>

          <TabsContent value="prices">
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="time" 
                    tick={{ fontSize: 9 }}
                    tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' }) + '.' + String(t % 1000).padStart(3, '0').slice(0, 1)}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    domain={['auto', 'auto']}
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number, name: string) => [`$${v?.toLocaleString()}`, name === 'binance' ? 'Binance' : 'Chainlink']}
                  />
                  <Legend />
                  <Line 
                    type="stepAfter" 
                    dataKey="binance" 
                    stroke={COLORS.binance}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="Binance"
                    isAnimationActive={false}
                  />
                  <Line 
                    type="stepAfter" 
                    dataKey="chainlink" 
                    stroke={COLORS.chainlink}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="Chainlink"
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="spread">
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={spreadChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="time" 
                    tick={{ fontSize: 9 }}
                    tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' })}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    tickFormatter={(v) => `$${v.toFixed(0)}`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number) => [`$${v?.toFixed(2)}`, 'Spread']}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                  <Bar 
                    dataKey="spread" 
                    fill="hsl(var(--chart-4))"
                    name="Binance - Chainlink"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Spread = Binance - Chainlink. Positief = Binance hoger (bullish signal)
            </p>
          </TabsContent>

          <TabsContent value="deltas">
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={deltaChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="time" 
                    tick={{ fontSize: 9 }}
                    tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' })}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    tickFormatter={(v) => `$${v.toFixed(0)}`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number, name: string) => [`$${v?.toFixed(2)}`, name]}
                  />
                  <Legend />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                  <Bar 
                    dataKey="binanceDelta" 
                    fill={COLORS.binance}
                    name="Binance Δ"
                    isAnimationActive={false}
                    opacity={0.8}
                  />
                  <Bar 
                    dataKey="chainlinkDelta" 
                    fill={COLORS.chainlink}
                    name="Chainlink Δ"
                    isAnimationActive={false}
                    opacity={0.8}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Prijsverandering per tick. Binance moves die niet in Chainlink verschijnen = arbitrage window
            </p>
          </TabsContent>

          <TabsContent value="log">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-muted-foreground">Laatste {eventLog.length} events</span>
              <Button variant="ghost" size="sm" onClick={clearEventLog}>Clear</Button>
            </div>
            <div className="h-[350px] overflow-auto font-mono text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left py-1 px-2">Time</th>
                    <th className="text-left py-1 px-2">Source</th>
                    <th className="text-right py-1 px-2">Price</th>
                    <th className="text-right py-1 px-2">Lead</th>
                  </tr>
                </thead>
                <tbody>
                  {eventLog.slice(0, 100).map((e, i) => (
                    <tr key={i} className="border-b border-muted/50 hover:bg-muted/30">
                      <td className="py-1 px-2">{formatTimestamp(e.timestamp)}</td>
                      <td className="py-1 px-2">
                        <span style={{ color: e.source === 'binance' ? COLORS.binance : COLORS.chainlink }}>
                          {e.source}
                        </span>
                      </td>
                      <td className="py-1 px-2 text-right">${e.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="py-1 px-2 text-right">
                        {e.latencyLead !== undefined ? (
                          <span className={e.latencyLead > 0 ? 'text-green-500' : 'text-red-500'}>
                            {e.latencyLead > 0 ? '+' : ''}{e.latencyLead}ms
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
