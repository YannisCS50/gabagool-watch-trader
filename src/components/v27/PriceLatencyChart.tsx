import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ComposedChart, Bar } from 'recharts';
import { Activity, Settings, Zap } from 'lucide-react';
import { usePriceLatencyComparison, Asset } from '@/hooks/usePriceLatencyComparison';
import { usePaperTradingConfig } from '@/hooks/usePaperTraderData';

const ASSETS: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

const COLORS = {
  binance: '#F0B90B',
  chainlink: '#375BD2',
  positive: '#3FB950',
  negative: '#F85149',
  trigger: '#8B5CF6',
};

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
    + '.' + String(ts % 1000).padStart(3, '0');
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

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });

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

  // Combine chart data for dual-line chart
  const combinedChartData = useMemo(() => {
    const merged = [...chartData.binanceData, ...chartData.chainlinkData]
      .sort((a, b) => a.time - b.time)
      .reduce((acc, point) => {
        const existing = acc.find((p: any) => Math.abs(p.time - point.time) < 50);
        if (existing) {
          existing[point.source] = point.price;
        } else {
          acc.push({ time: point.time, [point.source]: point.price });
        }
        return acc;
      }, [] as any[]);
    
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="deltas">
            <div className="h-[280px]">
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
                  {/* Trigger threshold lines */}
                  {config && (
                    <>
                      <ReferenceLine 
                        y={config.min_delta_usd} 
                        stroke={COLORS.trigger} 
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        label={{ value: `+$${config.min_delta_usd} trigger`, position: 'right', fill: COLORS.trigger, fontSize: 10 }}
                      />
                      <ReferenceLine 
                        y={-config.min_delta_usd} 
                        stroke={COLORS.trigger} 
                        strokeWidth={2}
                        strokeDasharray="5 3"
                        label={{ value: `-$${config.min_delta_usd} trigger`, position: 'right', fill: COLORS.trigger, fontSize: 10 }}
                      />
                    </>
                  )}
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
              <span style={{ color: COLORS.trigger }}>■</span> Paarse lijnen = trigger threshold (±${config?.min_delta_usd || '?'}). 
              Moves boven/onder triggeren trades.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
