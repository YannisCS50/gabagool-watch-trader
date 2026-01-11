import { usePriceLatencyComparison, Asset } from "@/hooks/usePriceLatencyComparison";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from "recharts";
import { Activity, Wifi, WifiOff, RefreshCw, Download, Trash2, Play, Square, Clock, Database } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { RealtimePriceLogger } from "@/components/RealtimePriceLogger";

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
    binanceWsStatus,
    chainlinkWsStatus,
    lastError,
  } = usePriceLatencyComparison();

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });
  const [histogramData, setHistogramData] = useState<{ range: string; count: number }[]>([]);
  
  // Export recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState<number>(5); // minutes
  const [recordedLogs, setRecordedLogs] = useState<typeof eventLog>([]);
  const [recordStartTime, setRecordStartTime] = useState<number | null>(null);
  const [recordProgress, setRecordProgress] = useState(0);
  const recordingRef = useRef<number | null>(null);

  // Update chart data periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
      setHistogramData(getLatencyHistogram());
    }, 500);
    return () => clearInterval(interval);
  }, [getChartData, getLatencyHistogram]);

  const exportCSV = (logs: typeof eventLog, prefix: string = 'price-latency') => {
    const rows = [
      ['timestamp', 'iso_time', 'source', 'symbol', 'price', 'latency_lead_ms'],
      ...logs.map(e => [
        e.timestamp, 
        new Date(e.timestamp).toISOString(),
        e.source, 
        e.symbol, 
        e.price, 
        e.latencyLead ?? ''
      ])
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}-${selectedAsset}-${recordDuration}min-${Date.now()}.csv`;
    a.click();
  };

  // Start recording
  const startRecording = () => {
    if (connectionStatus !== 'connected') {
      connect();
    }
    setRecordedLogs([]);
    setRecordStartTime(Date.now());
    setIsRecording(true);
    setRecordProgress(0);
  };

  // Stop recording and export
  const stopRecording = () => {
    setIsRecording(false);
    setRecordStartTime(null);
    if (recordingRef.current) {
      clearInterval(recordingRef.current);
      recordingRef.current = null;
    }
    if (recordedLogs.length > 0) {
      exportCSV(recordedLogs, 'price-recording');
    }
  };

  // Recording effect: capture logs during recording period
  useEffect(() => {
    if (!isRecording || !recordStartTime) return;

    const durationMs = recordDuration * 60 * 1000;
    
    // Update progress and capture logs
    recordingRef.current = window.setInterval(() => {
      const elapsed = Date.now() - recordStartTime;
      const progress = Math.min((elapsed / durationMs) * 100, 100);
      setRecordProgress(progress);

      // Auto-stop when time is up
      if (elapsed >= durationMs) {
        setIsRecording(false);
        setRecordStartTime(null);
        if (recordingRef.current) {
          clearInterval(recordingRef.current);
          recordingRef.current = null;
        }
      }
    }, 500);

    return () => {
      if (recordingRef.current) {
        clearInterval(recordingRef.current);
      }
    };
  }, [isRecording, recordStartTime, recordDuration]);

  // Capture event logs while recording
  useEffect(() => {
    if (isRecording && eventLog.length > 0) {
      // Add new events that we haven't captured yet
      setRecordedLogs(prev => {
        const newEvents = eventLog.filter(
          e => !prev.some(p => p.timestamp === e.timestamp && p.source === e.source)
        );
        return [...prev, ...newEvents].sort((a, b) => a.timestamp - b.timestamp);
      });
    }
  }, [eventLog, isRecording]);

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

  const [activeTab, setActiveTab] = useState<'realtime' | 'logger'>('realtime');

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
              Real-time WebSocket: Binance + Chainlink (Alchemy)
            </p>
            {lastError && (
              <p className="text-xs text-red-400 mt-1">{lastError}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Individual feed status */}
            <div className="flex gap-1">
              <Badge 
                variant="outline"
                className={`text-xs ${binanceWsStatus === 'connected' ? 'border-yellow-500 text-yellow-500' : 'border-gray-500'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${binanceWsStatus === 'connected' ? 'bg-yellow-500' : 'bg-gray-500'}`} />
                Binance
              </Badge>
              <Badge 
                variant="outline"
                className={`text-xs ${chainlinkWsStatus === 'connected' ? 'border-blue-500 text-blue-500' : 'border-gray-500'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${chainlinkWsStatus === 'connected' ? 'bg-blue-500' : 'bg-gray-500'}`} />
                Chainlink
              </Badge>
            </div>
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

      {/* Main Tabs: Realtime vs Logger */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'realtime' | 'logger')} className="mb-6">
        <TabsList className="bg-[#161B22]">
          <TabsTrigger value="realtime" className="data-[state=active]:bg-[#21262D] data-[state=active]:text-white">
            <Activity className="h-4 w-4 mr-2" />
            Realtime Analysis
          </TabsTrigger>
          <TabsTrigger value="logger" className="data-[state=active]:bg-[#21262D] data-[state=active]:text-white">
            <Database className="h-4 w-4 mr-2" />
            Database Logger
          </TabsTrigger>
        </TabsList>

        <TabsContent value="logger" className="mt-4">
          <RealtimePriceLogger />
        </TabsContent>

        <TabsContent value="realtime" className="mt-4">
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
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Clock className="h-4 w-4 mr-1" />
                    Record Export
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-64 bg-[#21262D] border-[#30363D]">
                  <div className="space-y-3">
                    <div className="text-sm font-medium">Record & Export Pricing Logs</div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Duration</label>
                      <Select 
                        value={recordDuration.toString()} 
                        onValueChange={(v) => setRecordDuration(Number(v))}
                        disabled={isRecording}
                      >
                        <SelectTrigger className="bg-[#161B22] border-[#30363D]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-[#21262D] border-[#30363D]">
                          <SelectItem value="1">1 minute</SelectItem>
                          <SelectItem value="2">2 minutes</SelectItem>
                          <SelectItem value="5">5 minutes</SelectItem>
                          <SelectItem value="10">10 minutes</SelectItem>
                          <SelectItem value="15">15 minutes</SelectItem>
                          <SelectItem value="30">30 minutes</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {isRecording ? (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span>Recording...</span>
                          <span>{recordedLogs.length} events</span>
                        </div>
                        <div className="h-2 bg-[#161B22] rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-red-500 transition-all" 
                            style={{ width: `${recordProgress}%` }} 
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button 
                            size="sm" 
                            variant="destructive" 
                            className="flex-1"
                            onClick={stopRecording}
                          >
                            <Square className="h-3 w-3 mr-1" />
                            Stop & Export
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button 
                        size="sm" 
                        className="w-full bg-red-600 hover:bg-red-700"
                        onClick={startRecording}
                      >
                        <Play className="h-3 w-3 mr-1" />
                        Start Recording
                      </Button>
                    )}
                    
                    <p className="text-xs text-muted-foreground">
                      Records all price updates during the selected period and exports as CSV.
                    </p>
                  </div>
                </PopoverContent>
              </Popover>
              
              <Button variant="outline" size="sm" onClick={() => exportCSV(eventLog, 'price-latency')}>
                <Download className="h-4 w-4 mr-1" />
                Export Log
              </Button>
            </div>
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
              {isRecording && (
                <div className="flex justify-between border-t border-[#30363D] pt-2 mt-2">
                  <span className="text-red-400 flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    Recording:
                  </span>
                  <span className="font-mono text-red-400">{recordedLogs.length} events captured</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
