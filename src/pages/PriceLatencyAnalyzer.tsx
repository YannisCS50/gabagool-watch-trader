import { usePriceLatencyComparison, Asset } from "@/hooks/usePriceLatencyComparison";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";
import { Activity, Wifi, WifiOff, RefreshCw, Download, Trash2, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

// Binance yellow and Chainlink blue
const COLORS = {
  binance: '#F0B90B',
  chainlink: '#375BD2',
  positive: '#3FB950',
  negative: '#F85149',
};

function formatPrice(price: number | null, asset: Asset): string {
  if (price === null) return '—';
  const decimals = asset === 'XRP' ? 4 : asset === 'SOL' ? 2 : 2;
  return `$${price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
    + '.' + String(ts % 1000).padStart(3, '0');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function PriceLatencyAnalyzer() {
  const {
    selectedAsset,
    binancePrice,
    chainlinkPrice,
    binanceLastUpdate,
    chainlinkLastUpdate,
    latencyMeasurements,
    sessionStart,
    totalBinanceTicks,
    totalChainlinkTicks,
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
  } = usePriceLatencyComparison();

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });
  const [histogramData, setHistogramData] = useState<{ range: string; count: number }[]>([]);

  // Update chart data periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
      setHistogramData(getLatencyHistogram());
    }, 500);
    return () => clearInterval(interval);
  }, [getChartData, getLatencyHistogram]);

  const exportCSV = () => {
    const rows = [
      ['timestamp', 'source', 'symbol', 'price', 'latency_lead_ms'],
      ...eventLog.map(e => [e.timestamp, e.source, e.symbol, e.price, e.latencyLead ?? ''])
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `price-latency-${selectedAsset}-${Date.now()}.csv`;
    a.click();
  };

  // Combine chart data for dual-line chart
  const combinedChartData = [...chartData.binanceData, ...chartData.chainlinkData]
    .sort((a, b) => a.time - b.time)
    .reduce((acc, point) => {
      const existing = acc.find((p: any) => Math.abs(p.time - point.time) < 100);
      if (existing) {
        existing[point.source] = point.price;
      } else {
        acc.push({ time: point.time, [point.source]: point.price });
      }
      return acc;
    }, [] as any[]);

  return (
    <div className="min-h-screen bg-[#0D1117] text-[#E6EDF3] p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="h-6 w-6" />
              PRICE FEED LATENCY ANALYZER
            </h1>
            <p className="text-sm text-muted-foreground">
              Comparing Binance vs Chainlink (Polymarket Settlement Source)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge 
              variant={connectionStatus === 'connected' ? 'default' : 'destructive'}
              className={connectionStatus === 'connected' ? 'bg-green-600' : ''}
            >
              {connectionStatus === 'connected' ? <Wifi className="h-3 w-3 mr-1" /> : <WifiOff className="h-3 w-3 mr-1" />}
              {connectionStatus}
            </Badge>
            {connectionStatus === 'connected' ? (
              <Button variant="outline" size="sm" onClick={disconnect}>
                <Square className="h-4 w-4 mr-1" />
                Disconnect
              </Button>
            ) : (
              <Button variant="default" size="sm" onClick={connect} disabled={connectionStatus === 'connecting'}>
                <Play className="h-4 w-4 mr-1" />
                {connectionStatus === 'connecting' ? 'Connecting...' : 'Connect'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={resetSession}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Reset
            </Button>
          </div>
        </div>
      </div>

      {/* Asset Selector */}
      <Tabs value={selectedAsset} onValueChange={(v) => setSelectedAsset(v as Asset)} className="mb-6">
        <TabsList className="bg-[#161B22]">
          {ASSETS.map(asset => (
            <TabsTrigger 
              key={asset} 
              value={asset}
              className="data-[state=active]:bg-[#21262D] data-[state=active]:text-white"
            >
              {asset}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Binance Price Card */}
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS.binance }} />
              BINANCE
              <span className="text-sm font-normal text-muted-foreground">(Direct)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-4xl font-bold mb-2" style={{ color: COLORS.binance }}>
              {formatPrice(binancePrice, selectedAsset)}
            </div>
            <div className="text-sm text-muted-foreground font-mono">
              Last update: {formatTimestamp(binanceLastUpdate)}
            </div>
            <div className="text-sm text-muted-foreground">
              Updates/sec: {stats.binanceUpdatesPerSec.toFixed(1)}
            </div>
          </CardContent>
        </Card>

        {/* Chainlink Price Card */}
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS.chainlink }} />
              CHAINLINK
              <span className="text-sm font-normal text-muted-foreground">(Settlement Oracle)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-4xl font-bold mb-2" style={{ color: COLORS.chainlink }}>
              {formatPrice(chainlinkPrice, selectedAsset)}
            </div>
            <div className="text-sm text-muted-foreground font-mono">
              Last update: {formatTimestamp(chainlinkLastUpdate)}
            </div>
            <div className="text-sm text-muted-foreground">
              Updates/sec: {stats.chainlinkUpdatesPerSec.toFixed(1)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Latency Metrics */}
      <Card className="bg-[#161B22] border-[#30363D] mb-6">
        <CardHeader>
          <CardTitle>LATENCY ANALYSIS</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <div className="text-sm text-muted-foreground">Current Latency</div>
              <div className="text-2xl font-mono font-bold" style={{ color: stats.currentLatency && stats.currentLatency > 0 ? COLORS.positive : COLORS.negative }}>
                {stats.currentLatency !== null ? `${stats.currentLatency > 0 ? '+' : ''}${stats.currentLatency.toFixed(0)}ms` : '—'}
              </div>
              <div className="text-xs text-muted-foreground">
                {stats.currentLatency && stats.currentLatency > 0 ? 'Binance leads' : stats.currentLatency ? 'Chainlink leads' : ''}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Average Latency</div>
              <div className="text-2xl font-mono font-bold">
                {stats.avgLatency !== null ? `${stats.avgLatency > 0 ? '+' : ''}${stats.avgLatency.toFixed(0)}ms` : '—'}
              </div>
              <div className="text-xs text-muted-foreground">last {latencyMeasurements.length} samples</div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Min / Max</div>
              <div className="text-2xl font-mono font-bold">
                {stats.minLatency !== null && stats.maxLatency !== null 
                  ? `${stats.minLatency.toFixed(0)} / ${stats.maxLatency.toFixed(0)}ms` 
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Price Difference</div>
              <div className="text-2xl font-mono font-bold">
                {stats.priceDiff !== null ? `$${stats.priceDiff.toFixed(2)}` : '—'}
              </div>
              <div className="text-xs text-muted-foreground">
                {stats.priceDiffPercent !== null ? `(${stats.priceDiffPercent.toFixed(5)}%)` : ''}
              </div>
            </div>
          </div>

          {/* Latency Histogram */}
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogramData}>
                <XAxis dataKey="range" tick={{ fill: '#8B949E', fontSize: 10 }} />
                <YAxis tick={{ fill: '#8B949E', fontSize: 10 }} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#21262D', border: '1px solid #30363D' }}
                  labelStyle={{ color: '#E6EDF3' }}
                />
                <Bar dataKey="count">
                  {histogramData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={index < 2 ? COLORS.positive : index < 4 ? COLORS.binance : COLORS.negative} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Live Chart */}
      <Card className="bg-[#161B22] border-[#30363D] mb-6">
        <CardHeader>
          <CardTitle>LIVE PRICE CHART (Last 60 seconds)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={combinedChartData}>
                <XAxis 
                  dataKey="time" 
                  tick={{ fill: '#8B949E', fontSize: 10 }}
                  tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' })}
                />
                <YAxis 
                  tick={{ fill: '#8B949E', fontSize: 10 }}
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `$${v.toLocaleString()}`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#21262D', border: '1px solid #30363D' }}
                  labelStyle={{ color: '#E6EDF3' }}
                  labelFormatter={(t) => new Date(t).toLocaleTimeString()}
                  formatter={(v: number, name: string) => [`$${v.toLocaleString()}`, name === 'binance' ? 'Binance' : 'Chainlink']}
                />
                <Line 
                  type="stepAfter" 
                  dataKey="binance" 
                  stroke={COLORS.binance} 
                  dot={false} 
                  strokeWidth={2}
                  connectNulls
                />
                <Line 
                  type="stepAfter" 
                  dataKey="chainlink" 
                  stroke={COLORS.chainlink} 
                  dot={false} 
                  strokeWidth={2}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-6 mt-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-1" style={{ backgroundColor: COLORS.binance }} />
              <span className="text-sm">Binance</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-1" style={{ backgroundColor: COLORS.chainlink }} />
              <span className="text-sm">Chainlink</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Event Log */}
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>EVENT LOG</CardTitle>
            <Button variant="ghost" size="sm" onClick={clearEventLog}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="font-mono text-xs space-y-1">
                {eventLog.map((event, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-muted-foreground">{formatTimestamp(event.timestamp)}</span>
                    <span style={{ color: event.source === 'binance' ? COLORS.binance : COLORS.chainlink }}>
                      {event.source.toUpperCase().padEnd(9)}
                    </span>
                    <span className="text-muted-foreground">{event.symbol.padEnd(10)}</span>
                    <span>{formatPrice(event.price, selectedAsset)}</span>
                    {event.latencyLead !== undefined && (
                      <span style={{ color: event.latencyLead > 0 ? COLORS.positive : COLORS.negative }}>
                        {event.latencyLead > 0 ? '+' : ''}{event.latencyLead.toFixed(0)}ms
                      </span>
                    )}
                  </div>
                ))}
                {eventLog.length === 0 && (
                  <div className="text-muted-foreground">Waiting for data...</div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Session Statistics */}
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>SESSION STATISTICS</CardTitle>
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="h-4 w-4 mr-1" />
              Export CSV
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Session Duration:</span>
                <span className="font-mono">{formatDuration(Date.now() - sessionStart)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Binance Ticks:</span>
                <span className="font-mono" style={{ color: COLORS.binance }}>{totalBinanceTicks.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Chainlink Ticks:</span>
                <span className="font-mono" style={{ color: COLORS.chainlink }}>{totalChainlinkTicks.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Binance Led:</span>
                <span className="font-mono" style={{ color: COLORS.positive }}>
                  {stats.binanceLeadPct !== null ? `${stats.binanceLeadPct.toFixed(1)}%` : '—'} of matched pairs
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Chainlink Led:</span>
                <span className="font-mono" style={{ color: COLORS.negative }}>
                  {stats.binanceLeadPct !== null ? `${(100 - stats.binanceLeadPct).toFixed(1)}%` : '—'} of matched pairs
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latency Samples:</span>
                <span className="font-mono">{latencyMeasurements.length}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
