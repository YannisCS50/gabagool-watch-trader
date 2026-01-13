import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ComposedChart, Bar, Area, ReferenceArea, ReferenceDot } from 'recharts';
import { Activity, Settings, Zap, Timer, TrendingUp, TrendingDown, AlertTriangle, Wifi } from 'lucide-react';
import { usePriceLatencyComparison, Asset } from '@/hooks/usePriceLatencyComparison';
import { usePaperTradingConfig } from '@/hooks/usePaperTraderData';
import { useClobOrderbook } from '@/hooks/useClobOrderbook';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

const COLORS = {
  binance: '#F0B90B',
  chainlink: '#375BD2',
  positive: '#3FB950',
  negative: '#F85149',
  trigger: '#8B5CF6',
  sharePrice: '#10B981',
};

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
    + '.' + String(ts % 1000).padStart(3, '0');
}

interface ClobPrices {
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  lastUpdate: number;
}

interface LatencyTestResult {
  testId: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  status: 'pending' | 'success' | 'error';
  error?: string;
}

export function PriceLatencyChart() {
  const {
    selectedAsset,
    setSelectedAsset,
    binancePrice,
    chainlinkPrice,
    binanceWsStatus,
    chainlinkWsStatus,
    connectionStatus,
    connect,
    getChartData,
    stats,
  } = usePriceLatencyComparison();
  
  const { data: config } = usePaperTradingConfig();
  
  // Use WebSocket-based CLOB orderbook for realtime share prices
  const clob = useClobOrderbook(true);
  
  // Track share price history from WebSocket updates
  const [clobPriceHistory, setClobPriceHistory] = useState<{ time: number; upAsk: number | null; downAsk: number | null }[]>([]);
  const lastClobUpdateRef = useRef<number>(0);
  
  const [latencyTests, setLatencyTests] = useState<LatencyTestResult[]>([]);
  const [testingLatency, setTestingLatency] = useState(false);

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });

  // Get current share prices from WebSocket CLOB - use orderbooks directly for reactivity
  const clobPrices = useMemo(() => {
    const upBook = clob.orderbooks.get(selectedAsset)?.up;
    const downBook = clob.orderbooks.get(selectedAsset)?.down;
    return {
      upBid: upBook?.bid ?? null,
      upAsk: upBook?.ask ?? null,
      downBid: downBook?.bid ?? null,
      downAsk: downBook?.ask ?? null,
      lastUpdate: Math.max(upBook?.timestamp ?? 0, downBook?.timestamp ?? 0),
    };
  }, [clob.orderbooks, selectedAsset]);

  // Track share price history at high frequency
  useEffect(() => {
    const now = Date.now();
    // Only add if we have valid data and it's newer than last update
    if (clobPrices.lastUpdate > 0 && clobPrices.lastUpdate > lastClobUpdateRef.current) {
      lastClobUpdateRef.current = clobPrices.lastUpdate;
      setClobPriceHistory(prev => {
        const newEntry = { time: now, upAsk: clobPrices.upAsk, downAsk: clobPrices.downAsk };
        // Log for debugging
        if (prev.length === 0 || prev.length % 50 === 0) {
          console.log(`[PriceLatency] CLOB history: ${prev.length + 1} entries, upAsk=${clobPrices.upAsk}, downAsk=${clobPrices.downAsk}`);
        }
        return [...prev, newEntry].slice(-1200);
      });
    }
  }, [clobPrices]);

  // Auto-connect on mount
  useEffect(() => {
    if (connectionStatus === 'disconnected') {
      connect();
    }
  }, [connectionStatus, connect]);

  // Update chart data at high frequency (100ms) for real-time feel
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
    }, 100);
    return () => clearInterval(interval);
  }, [getChartData]);

  // Combine chart data for dual-line chart with share price
  // REDUCED AGGREGATION: Use 10ms window instead of 50ms for more granular view
  const combinedChartData = useMemo(() => {
    const merged = [...chartData.binanceData, ...chartData.chainlinkData]
      .sort((a, b) => a.time - b.time)
      .reduce((acc, point) => {
        // Reduced from 50ms to 10ms for higher resolution
        const existing = acc.find((p: any) => Math.abs(p.time - point.time) < 10);
        if (existing) {
          existing[point.source] = point.price;
        } else {
          acc.push({ time: point.time, [point.source]: point.price });
        }
        return acc;
      }, [] as any[]);
    
    // Add share price to all data points for the chart
    const upAskCents = clobPrices?.upAsk ? clobPrices.upAsk * 100 : null;
    // Increased from 600 to 1200 for more data points
    return merged.slice(-1200).map(point => ({
      ...point,
      sharePrice: upAskCents,
    }));
  }, [chartData, clobPrices]);

  // Calculate price deltas for delta chart with share prices and trigger markers
  const deltaChartData = useMemo(() => {
    const triggerThreshold = config?.min_delta_usd ?? 20;
    const data: { 
      time: number; 
      binanceDelta: number | null; 
      chainlinkDelta: number | null;
      upSharePrice: number | null;
      downSharePrice: number | null;
      triggered: boolean;
      triggerDirection: 'UP' | 'DOWN' | null;
    }[] = [];
    let prevBinance: number | null = null;
    let prevChainlink: number | null = null;

    // Helper to find closest share price from history
    const findClosestSharePrice = (time: number) => {
      if (clobPriceHistory.length === 0) return { upAsk: null, downAsk: null };
      // Find the closest entry by time (within 5s window)
      let closest = clobPriceHistory[0];
      let minDiff = Math.abs(time - closest.time);
      for (const entry of clobPriceHistory) {
        const diff = Math.abs(time - entry.time);
        if (diff < minDiff) {
          minDiff = diff;
          closest = entry;
        }
      }
      return closest;
    };

    for (const point of combinedChartData) {
      const binanceDelta = point.binance && prevBinance ? point.binance - prevBinance : null;
      const chainlinkDelta = point.chainlink && prevChainlink ? point.chainlink - prevChainlink : null;

      // Check if this delta would trigger a trade
      const triggered = binanceDelta !== null && Math.abs(binanceDelta) >= triggerThreshold;
      const triggerDirection = triggered ? (binanceDelta! > 0 ? 'UP' : 'DOWN') : null;

      // Get share prices from history for this time
      const shareData = findClosestSharePrice(point.time);

      if (binanceDelta !== null || chainlinkDelta !== null) {
        data.push({
          time: point.time,
          binanceDelta: binanceDelta && Math.abs(binanceDelta) > 0.01 ? binanceDelta : null,
          chainlinkDelta: chainlinkDelta && Math.abs(chainlinkDelta) > 0.01 ? chainlinkDelta : null,
          upSharePrice: shareData.upAsk !== null ? shareData.upAsk * 100 : null,
          downSharePrice: shareData.downAsk !== null ? shareData.downAsk * 100 : null,
          triggered,
          triggerDirection,
        });
      }

      if (point.binance) prevBinance = point.binance;
      if (point.chainlink) prevChainlink = point.chainlink;
    }

    // Increased from 300 to 600 for more delta data points
    return data.slice(-600);
  }, [combinedChartData, config, clobPriceHistory]);

  // Check if current share price is in bounds
  const sharePriceInBounds = useMemo(() => {
    if (!clobPrices?.upAsk || !config) return null;
    const price = clobPrices.upAsk;
    return price >= config.min_share_price && price <= config.max_share_price;
  }, [clobPrices, config]);

  return (
    <Card className="col-span-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5 text-primary" />
              Live Price Feeds
            </CardTitle>
            <CardDescription>
              Binance & Chainlink WebSocket (50ms resolution)
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Asset selector */}
            <Tabs value={selectedAsset} onValueChange={(v) => setSelectedAsset(v as Asset)}>
              <TabsList className="h-8">
                {ASSETS.map(a => (
                  <TabsTrigger key={a} value={a} className="px-3 text-xs">{a}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            
            {/* Connection status */}
            <div className="flex gap-1">
              <Badge 
                variant="outline"
                className={`text-xs ${binanceWsStatus === 'connected' ? 'border-yellow-500 text-yellow-500' : 'border-muted'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${binanceWsStatus === 'connected' ? 'bg-yellow-500 animate-pulse' : 'bg-muted'}`} />
                Binance
              </Badge>
              <Badge 
                variant="outline"
                className={`text-xs ${chainlinkWsStatus === 'connected' ? 'border-blue-500 text-blue-500' : 'border-muted'}`}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${chainlinkWsStatus === 'connected' ? 'bg-blue-500 animate-pulse' : 'bg-muted'}`} />
                Chainlink
              </Badge>
              <Badge 
                variant="outline"
                className={`text-xs ${clob.connected ? 'border-green-500 text-green-500' : clob.connecting ? 'border-orange-500 text-orange-500' : 'border-muted'}`}
              >
                <Wifi className={`h-3 w-3 mr-1 ${clob.connected ? 'text-green-500' : 'text-muted'}`} />
                CLOB {clob.connected ? `(${clob.messageCount})` : clob.connecting ? '...' : '✗'}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        {/* Bot Settings Summary */}
        {config && (
          <div className="mb-4 p-3 bg-muted/50 rounded-lg border border-primary/20">
            <div className="flex items-center gap-2 mb-2">
              <Settings className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Paper Bot Settings</span>
              <Badge variant={config.enabled ? 'default' : 'secondary'} className="ml-auto">
                {config.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              <div>
                <span className="text-muted-foreground">Trigger Delta</span>
                <div className="font-mono font-bold text-purple-400">${config.min_delta_usd}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Share Range</span>
                <div className="font-mono font-bold">
                  {(config.min_share_price * 100).toFixed(0)}-{(config.max_share_price * 100).toFixed(0)}¢
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">TP / SL</span>
                <div className="font-mono font-bold">
                  <span className={config.tp_enabled ? 'text-green-400' : 'text-muted-foreground'}>
                    {config.tp_enabled ? `+${config.tp_cents}¢` : 'off'}
                  </span>
                  {' / '}
                  <span className={config.sl_enabled ? 'text-red-400' : 'text-muted-foreground'}>
                    {config.sl_enabled ? `-${config.sl_cents}¢` : 'off'}
                  </span>
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Trade Size</span>
                <div className="font-mono font-bold">${config.trade_size_usd}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Timeout</span>
                <div className="font-mono font-bold">{config.timeout_ms / 1000}s</div>
              </div>
            </div>
        </div>
        )}
        
        {/* Price Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.binance }} />
              Binance
            </div>
            <div className="text-lg font-mono font-bold" style={{ color: COLORS.binance }}>
              {binancePrice ? `$${binancePrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS.chainlink }} />
              Chainlink
            </div>
            <div className="text-lg font-mono font-bold" style={{ color: COLORS.chainlink }}>
              {chainlinkPrice ? `$${chainlinkPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" style={{ color: COLORS.sharePrice }} />
              UP Share
              {sharePriceInBounds !== null && (
                <Badge 
                  variant="outline" 
                  className={`ml-1 text-[9px] px-1 py-0 ${sharePriceInBounds ? 'border-green-500 text-green-500' : 'border-red-500 text-red-500'}`}
                >
                  {sharePriceInBounds ? 'IN BOUNDS' : 'OUT'}
                </Badge>
              )}
            </div>
            <div className="text-lg font-mono font-bold" style={{ color: sharePriceInBounds === false ? '#F85149' : COLORS.sharePrice }}>
              {clobPrices?.upAsk ? `${(clobPrices.upAsk * 100).toFixed(1)}¢` : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">
              bid: {clobPrices?.upBid ? `${(clobPrices.upBid * 100).toFixed(1)}¢` : '—'} | 
              range: {config ? `${(config.min_share_price * 100).toFixed(0)}-${(config.max_share_price * 100).toFixed(0)}¢` : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Latency Avg</div>
            <div className="text-lg font-mono font-bold">
              {stats.avgLatency > 0 ? `${stats.avgLatency.toFixed(0)}ms` : '—'}
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Trigger
            </div>
            <div className="text-lg font-mono font-bold text-purple-400">
              ${config?.min_delta_usd || '—'}
            </div>
          </div>
        </div>

        {/* Charts */}
        <Tabs defaultValue="prices" className="w-full">
          <TabsList className="mb-3">
            <TabsTrigger value="prices">Live Prices</TabsTrigger>
            <TabsTrigger value="deltas">Price Deltas</TabsTrigger>
          </TabsList>

          <TabsContent value="prices">
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={combinedChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="time" 
                    tick={{ fontSize: 9 }}
                    tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' })}
                    interval="preserveStartEnd"
                  />
                  <YAxis 
                    yAxisId="price"
                    domain={['auto', 'auto']}
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis 
                    yAxisId="share"
                    orientation="right"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}¢`}
                    tick={{ fontSize: 10, fill: COLORS.sharePrice }}
                  />
                  {/* Share price bounds reference areas */}
                  {config && (
                    <>
                      <ReferenceArea 
                        yAxisId="share"
                        y1={config.min_share_price * 100} 
                        y2={config.max_share_price * 100} 
                        fill={COLORS.sharePrice}
                        fillOpacity={0.1}
                      />
                      <ReferenceLine 
                        yAxisId="share"
                        y={config.min_share_price * 100} 
                        stroke={COLORS.sharePrice} 
                        strokeDasharray="3 3"
                        strokeOpacity={0.5}
                      />
                      <ReferenceLine 
                        yAxisId="share"
                        y={config.max_share_price * 100} 
                        stroke={COLORS.sharePrice} 
                        strokeDasharray="3 3"
                        strokeOpacity={0.5}
                      />
                    </>
                  )}
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number, name: string) => {
                      if (name === 'UP Share') return [`${v?.toFixed(1)}¢`, name];
                      return [`$${v?.toLocaleString()}`, name === 'binance' ? 'Binance' : 'Chainlink'];
                    }}
                  />
                  <Legend />
                  <Line 
                    yAxisId="price"
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
                    yAxisId="price"
                    type="stepAfter" 
                    dataKey="chainlink" 
                    stroke={COLORS.chainlink}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="Chainlink"
                    isAnimationActive={false}
                  />
                  <Line 
                    yAxisId="share"
                    type="monotone" 
                    dataKey="sharePrice" 
                    stroke={COLORS.sharePrice}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="UP Share"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="deltas">
            {/* Trigger count summary */}
            {(() => {
              const triggers = deltaChartData.filter(d => d.triggered);
              const upTriggers = triggers.filter(d => d.triggerDirection === 'UP').length;
              const downTriggers = triggers.filter(d => d.triggerDirection === 'DOWN').length;
              return triggers.length > 0 && (
                <div className="mb-3 flex items-center gap-3 p-2 bg-purple-500/10 border border-purple-500/30 rounded-lg">
                  <AlertTriangle className="h-4 w-4 text-purple-400" />
                  <span className="text-sm font-medium text-purple-400">
                    {triggers.length} trigger(s) in view
                  </span>
                  <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                    <TrendingUp className="h-3 w-3 mr-1" />
                    {upTriggers} UP
                  </Badge>
                  <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                    <TrendingDown className="h-3 w-3 mr-1" />
                    {downTriggers} DOWN
                  </Badge>
                </div>
              );
            })()}
            
            <div className="h-[320px]">
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
                    yAxisId="delta"
                    tickFormatter={(v) => `$${v.toFixed(0)}`}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis 
                    yAxisId="share"
                    orientation="right"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}¢`}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number, name: string) => {
                      if (name.includes('Share')) return [`${v?.toFixed(1)}¢`, name];
                      return [`$${v?.toFixed(2)}`, name];
                    }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const data = payload[0]?.payload;
                      return (
                        <div className="bg-background border rounded-lg p-2 shadow-lg text-xs">
                          <div className="font-mono text-muted-foreground mb-1">{formatTimestamp(label)}</div>
                          {data?.triggered && (
                            <div className="flex items-center gap-1 text-purple-400 font-bold mb-1">
                              <AlertTriangle className="h-3 w-3" />
                              TRIGGER! {data.triggerDirection}
                            </div>
                          )}
                          {payload.map((p: any, i: number) => (
                            <div key={i} className="flex justify-between gap-4">
                              <span style={{ color: p.color }}>{p.name}:</span>
                              <span className="font-mono">
                                {p.name.includes('Share') ? `${p.value?.toFixed(1)}¢` : `$${p.value?.toFixed(2)}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend />
                  <ReferenceLine yAxisId="delta" y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                  {/* Trigger threshold lines */}
                  {config && (
                    <>
                      <ReferenceLine 
                        yAxisId="delta"
                        y={config.min_delta_usd} 
                        stroke={COLORS.trigger} 
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        label={{ value: `+$${config.min_delta_usd} UP trigger`, position: 'right', fill: COLORS.trigger, fontSize: 10 }}
                      />
                      <ReferenceLine 
                        yAxisId="delta"
                        y={-config.min_delta_usd} 
                        stroke={COLORS.trigger} 
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        label={{ value: `-$${config.min_delta_usd} DOWN trigger`, position: 'right', fill: COLORS.trigger, fontSize: 10 }}
                      />
                    </>
                  )}
                  {/* Share price reference lines */}
                  {clobPrices?.upAsk && (
                    <ReferenceLine 
                      yAxisId="share"
                      y={clobPrices.upAsk * 100} 
                      stroke={COLORS.positive} 
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                  )}
                  {clobPrices?.downAsk && (
                    <ReferenceLine 
                      yAxisId="share"
                      y={clobPrices.downAsk * 100} 
                      stroke={COLORS.negative} 
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                  )}
                  {/* Delta bars */}
                  <Bar 
                    yAxisId="delta"
                    dataKey="binanceDelta" 
                    fill={COLORS.binance}
                    name="Binance Δ"
                    isAnimationActive={false}
                    opacity={0.8}
                  />
                  <Bar 
                    yAxisId="delta"
                    dataKey="chainlinkDelta" 
                    fill={COLORS.chainlink}
                    name="Chainlink Δ"
                    isAnimationActive={false}
                    opacity={0.8}
                  />
                  {/* Share price lines */}
                  <Line 
                    yAxisId="share"
                    type="monotone" 
                    dataKey="upSharePrice" 
                    stroke={COLORS.positive}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="UP Share"
                    isAnimationActive={false}
                  />
                  <Line 
                    yAxisId="share"
                    type="monotone" 
                    dataKey="downSharePrice" 
                    stroke={COLORS.negative}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="DOWN Share"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            
            {/* Trigger explanation */}
            <div className="mt-3 p-3 bg-muted/50 rounded-lg text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span style={{ color: COLORS.trigger }}>━━</span>
                <span>Trigger threshold: ±${config?.min_delta_usd || '?'}</span>
                <span className="text-muted-foreground">|</span>
                <span style={{ color: COLORS.positive }}>━</span>
                <span>UP: {clobPrices?.upAsk ? `${(clobPrices.upAsk * 100).toFixed(1)}¢` : '—'}</span>
                <span style={{ color: COLORS.negative }}>━</span>
                <span>DOWN: {clobPrices?.downAsk ? `${(clobPrices.downAsk * 100).toFixed(1)}¢` : '—'}</span>
              </div>
              <div className="text-muted-foreground">
                <AlertTriangle className="h-3 w-3 inline mr-1" />
                Trigger = Binance delta ≥ threshold. Als share price buiten {config ? `${(config.min_share_price * 100).toFixed(0)}-${(config.max_share_price * 100).toFixed(0)}¢` : '?'} range, wordt trade overgeslagen.
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
