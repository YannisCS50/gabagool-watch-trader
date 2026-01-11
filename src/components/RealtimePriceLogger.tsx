import { useRealtimePriceLogs } from '@/hooks/useRealtimePriceLogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Database, Zap, Server, TrendingUp, Activity, Clock, Wifi, WifiOff } from 'lucide-react';
import { format } from 'date-fns';
import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from 'recharts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface PriceLog {
  id: string;
  source: string;
  asset: string;
  price: number;
  raw_timestamp: number | null;
  received_at: string;
  created_at: string;
}

export function RealtimePriceLogger() {
  const {
    logs,
    status,
    isLoading,
    error,
    fetchRecentLogs,
  } = useRealtimePriceLogs();

  const [selectedAsset, setSelectedAsset] = useState<string>('BTC');

  // Calculate analytics from logs
  const analytics = useMemo(() => {
    if (logs.length === 0) return null;

    const now = Date.now();
    const tenSecondsAgo = now - 10_000;
    const oneMinuteAgo = now - 60_000;

    // Check WebSocket status (data received in last 10 seconds)
    const recentLogs = logs.filter(log => new Date(log.received_at).getTime() > tenSecondsAgo);
    const binanceOnline = recentLogs.some(log => log.source.includes('binance'));
    const polymarketOnline = recentLogs.some(log => log.source.includes('polymarket') || log.source.includes('chainlink'));

    // Group by source
    const bySource: Record<string, PriceLog[]> = {};
    const byAsset: Record<string, PriceLog[]> = {};
    
    logs.forEach((log) => {
      const sourceKey = log.source.includes('binance') ? 'binance' : 
                        log.source.includes('polymarket') ? 'polymarket' : 
                        log.source.includes('chainlink') ? 'chainlink' : log.source;
      if (!bySource[sourceKey]) bySource[sourceKey] = [];
      bySource[sourceKey].push(log);
      
      if (!byAsset[log.asset]) byAsset[log.asset] = [];
      byAsset[log.asset].push(log);
    });

    // Calculate latencies (time between raw_timestamp and received_at)
    const latencies: { source: string; asset: string; latencyMs: number }[] = [];
    logs.forEach((log) => {
      if (log.raw_timestamp) {
        const receivedAt = new Date(log.received_at).getTime();
        const latencyMs = receivedAt - log.raw_timestamp;
        if (latencyMs >= 0 && latencyMs < 10000) { // Filter outliers
          latencies.push({ source: log.source, asset: log.asset, latencyMs });
        }
      }
    });

    // Calculate average latency per source
    const latencyBySource: Record<string, { avg: number; min: number; max: number; count: number }> = {};
    latencies.forEach(({ source, latencyMs }) => {
      const sourceKey = source.includes('binance') ? 'binance' : 
                        source.includes('polymarket') ? 'polymarket' : 
                        source.includes('chainlink') ? 'chainlink' : source;
      if (!latencyBySource[sourceKey]) {
        latencyBySource[sourceKey] = { avg: 0, min: Infinity, max: 0, count: 0 };
      }
      latencyBySource[sourceKey].count++;
      latencyBySource[sourceKey].min = Math.min(latencyBySource[sourceKey].min, latencyMs);
      latencyBySource[sourceKey].max = Math.max(latencyBySource[sourceKey].max, latencyMs);
    });
    
    // Calculate averages
    Object.keys(latencyBySource).forEach((key) => {
      const sourceLogs = latencies.filter(l => {
        const sourceKey = l.source.includes('binance') ? 'binance' : 
                          l.source.includes('polymarket') ? 'polymarket' : 
                          l.source.includes('chainlink') ? 'chainlink' : l.source;
        return sourceKey === key;
      });
      latencyBySource[key].avg = sourceLogs.reduce((sum, l) => sum + l.latencyMs, 0) / sourceLogs.length;
    });

    // Get latest price per asset per source for comparison
    const latestPrices: Record<string, Record<string, { price: number; ts: number }>> = {};
    logs.forEach((log) => {
      const sourceKey = log.source.includes('binance') ? 'binance' : 
                        log.source.includes('polymarket') ? 'polymarket' : 
                        log.source.includes('chainlink') ? 'chainlink' : log.source;
      if (!latestPrices[log.asset]) latestPrices[log.asset] = {};
      if (!latestPrices[log.asset][sourceKey] || new Date(log.received_at).getTime() > latestPrices[log.asset][sourceKey].ts) {
        latestPrices[log.asset][sourceKey] = {
          price: log.price,
          ts: new Date(log.received_at).getTime(),
        };
      }
    });

    // Calculate price deltas between sources
    const priceDeltas: Record<string, { binanceVsPoly?: number; binanceVsChainlink?: number }> = {};
    Object.keys(latestPrices).forEach((asset) => {
      const prices = latestPrices[asset];
      priceDeltas[asset] = {};
      if (prices.binance && prices.polymarket) {
        priceDeltas[asset].binanceVsPoly = prices.binance.price - prices.polymarket.price;
      }
      if (prices.binance && prices.chainlink) {
        priceDeltas[asset].binanceVsChainlink = prices.binance.price - prices.chainlink.price;
      }
    });

    // Get last update time per source
    const lastUpdate: Record<string, Date | null> = {
      binance: null,
      polymarket: null,
      chainlink: null,
    };
    logs.forEach((log) => {
      const sourceKey = log.source.includes('binance') ? 'binance' : 
                        log.source.includes('polymarket') ? 'polymarket' : 
                        log.source.includes('chainlink') ? 'chainlink' : null;
      if (sourceKey) {
        const logTime = new Date(log.received_at);
        if (!lastUpdate[sourceKey] || logTime > lastUpdate[sourceKey]!) {
          lastUpdate[sourceKey] = logTime;
        }
      }
    });

    return {
      bySource,
      byAsset,
      latencyBySource,
      latestPrices,
      priceDeltas,
      totalLogs: logs.length,
      binanceOnline,
      polymarketOnline,
      lastUpdate,
      assets: Object.keys(byAsset),
    };
  }, [logs]);

  // Build chart data for selected asset (last minute)
  const chartData = useMemo(() => {
    if (!analytics || !selectedAsset) return [];

    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Filter logs for selected asset in last minute
    const assetLogs = logs.filter(log => 
      log.asset === selectedAsset && 
      new Date(log.received_at).getTime() > oneMinuteAgo
    );

    // Group by time bucket (500ms buckets for smooth chart)
    const buckets: Record<number, { binance?: number; polymarket?: number; chainlink?: number; time: number }> = {};
    
    assetLogs.forEach(log => {
      const ts = new Date(log.received_at).getTime();
      const bucket = Math.floor(ts / 500) * 500; // 500ms buckets
      
      if (!buckets[bucket]) {
        buckets[bucket] = { time: bucket };
      }
      
      const sourceKey = log.source.includes('binance') ? 'binance' : 
                        log.source.includes('polymarket') ? 'polymarket' : 
                        log.source.includes('chainlink') ? 'chainlink' : null;
      
      if (sourceKey) {
        buckets[bucket][sourceKey] = log.price;
      }
    });

    // Convert to array and sort by time
    const data = Object.values(buckets).sort((a, b) => a.time - b.time);

    // Forward-fill missing values for smoother chart
    let lastBinance: number | undefined;
    let lastPolymarket: number | undefined;
    let lastChainlink: number | undefined;
    
    data.forEach(point => {
      if (point.binance !== undefined) lastBinance = point.binance;
      else if (lastBinance !== undefined) point.binance = lastBinance;
      
      if (point.polymarket !== undefined) lastPolymarket = point.polymarket;
      else if (lastPolymarket !== undefined) point.polymarket = lastPolymarket;
      
      if (point.chainlink !== undefined) lastChainlink = point.chainlink;
      else if (lastChainlink !== undefined) point.chainlink = lastChainlink;
    });

    return data;
  }, [logs, selectedAsset, analytics]);

  const getSourceBadge = (source: string) => {
    if (source.includes('binance')) {
      return <Badge variant="outline" className="border-yellow-500 text-yellow-400 font-mono text-xs">BIN</Badge>;
    }
    if (source.includes('polymarket')) {
      return <Badge variant="outline" className="border-purple-500 text-purple-400 font-mono text-xs">PM</Badge>;
    }
    if (source.includes('chainlink')) {
      return <Badge variant="outline" className="border-blue-500 text-blue-400 font-mono text-xs">CL</Badge>;
    }
    return <Badge variant="outline" className="font-mono text-xs">{source.slice(0, 3).toUpperCase()}</Badge>;
  };

  const formatChartTime = (ts: number) => {
    return format(new Date(ts), 'HH:mm:ss');
  };

  return (
    <div className="space-y-4">
      {/* WebSocket Status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {analytics?.binanceOnline ? (
                  <Wifi className="h-6 w-6 text-green-400" />
                ) : (
                  <WifiOff className="h-6 w-6 text-red-400" />
                )}
                <div>
                  <div className="font-semibold text-[#E6EDF3]">Binance WebSocket</div>
                  <div className="text-xs text-muted-foreground">
                    wss://stream.binance.com
                  </div>
                </div>
              </div>
              <div className="text-right">
                <Badge className={analytics?.binanceOnline ? 'bg-green-600' : 'bg-red-600'}>
                  {analytics?.binanceOnline ? 'ONLINE' : 'OFFLINE'}
                </Badge>
                {analytics?.lastUpdate?.binance && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Last: {format(analytics.lastUpdate.binance, 'HH:mm:ss')}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-[#161B22] border-[#30363D]">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {analytics?.polymarketOnline ? (
                  <Wifi className="h-6 w-6 text-green-400" />
                ) : (
                  <WifiOff className="h-6 w-6 text-red-400" />
                )}
                <div>
                  <div className="font-semibold text-[#E6EDF3]">Polymarket WebSocket</div>
                  <div className="text-xs text-muted-foreground">
                    wss://ws-live-data.polymarket.com
                  </div>
                </div>
              </div>
              <div className="text-right">
                <Badge className={analytics?.polymarketOnline ? 'bg-green-600' : 'bg-red-600'}>
                  {analytics?.polymarketOnline ? 'ONLINE' : 'OFFLINE'}
                </Badge>
                {(analytics?.lastUpdate?.polymarket || analytics?.lastUpdate?.chainlink) && (
                  <div className="text-xs text-muted-foreground mt-1">
                    Last: {format(analytics.lastUpdate.polymarket || analytics.lastUpdate.chainlink!, 'HH:mm:ss')}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Price Comparison Chart */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base text-[#E6EDF3] flex items-center gap-2">
              <Activity className="h-4 w-4" /> Price Timeline (Last 60s)
            </CardTitle>
            <div className="flex items-center gap-2">
              <Select value={selectedAsset} onValueChange={setSelectedAsset}>
                <SelectTrigger className="w-24 h-8 bg-[#21262D] border-[#30363D] text-[#E6EDF3]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#21262D] border-[#30363D]">
                  {(analytics?.assets || ['BTC', 'ETH', 'SOL', 'XRP']).map(asset => (
                    <SelectItem key={asset} value={asset} className="text-[#E6EDF3]">{asset}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => fetchRecentLogs(500)}
                variant="outline"
                size="sm"
                disabled={isLoading}
                className="border-[#30363D] text-[#E6EDF3] hover:bg-[#21262D]"
              >
                <RefreshCw className={`h-3 w-3 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <XAxis 
                  dataKey="time" 
                  tickFormatter={formatChartTime}
                  stroke="#8B949E"
                  fontSize={10}
                  tickLine={false}
                />
                <YAxis 
                  domain={['auto', 'auto']}
                  stroke="#8B949E"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(value) => `$${value.toLocaleString()}`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#21262D', border: '1px solid #30363D', borderRadius: '8px' }}
                  labelStyle={{ color: '#E6EDF3' }}
                  labelFormatter={(label) => format(new Date(label), 'HH:mm:ss.SSS')}
                  formatter={(value: number, name: string) => [
                    `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    name.charAt(0).toUpperCase() + name.slice(1)
                  ]}
                />
                <Legend />
                <Line 
                  type="stepAfter" 
                  dataKey="binance" 
                  stroke="#F0B90B" 
                  strokeWidth={2} 
                  dot={false}
                  name="Binance"
                  connectNulls
                />
                <Line 
                  type="stepAfter" 
                  dataKey="polymarket" 
                  stroke="#8B5CF6" 
                  strokeWidth={2} 
                  dot={false}
                  name="Polymarket"
                  connectNulls
                />
                <Line 
                  type="stepAfter" 
                  dataKey="chainlink" 
                  stroke="#375BD2" 
                  strokeWidth={2} 
                  dot={false}
                  name="Chainlink"
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-muted-foreground">
              No data in last 60 seconds for {selectedAsset}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Key Metrics */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[#21262D] rounded-lg p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Database className="h-3 w-3" /> Total in DB
              </div>
              <div className="text-xl font-bold text-[#E6EDF3]">
                {status?.totalLogs.toLocaleString() ?? '—'}
              </div>
            </div>
            
            <div className="bg-[#21262D] rounded-lg p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" /> Last Hour
              </div>
              <div className="text-xl font-bold text-[#E6EDF3]">
                {status?.lastHourLogs.toLocaleString() ?? '—'}
              </div>
            </div>
            
            <div className="bg-[#21262D] rounded-lg p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> Logs/min
              </div>
              <div className="text-xl font-bold text-[#E6EDF3]">
                {status?.lastHourLogs ? Math.round(status.lastHourLogs / 60) : '—'}
              </div>
            </div>

            <div className="bg-[#21262D] rounded-lg p-3">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Zap className="h-3 w-3" /> In View
              </div>
              <div className="text-xl font-bold text-[#E6EDF3]">{logs.length}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Latency Analytics */}
      {analytics && Object.keys(analytics.latencyBySource).length > 0 && (
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[#E6EDF3] flex items-center gap-2">
              <Clock className="h-4 w-4" /> Latency per Source (ms)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {Object.entries(analytics.latencyBySource).map(([source, stats]) => (
                <div key={source} className="bg-[#21262D] rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-[#E6EDF3] capitalize">{source}</span>
                    <span className="text-xs text-muted-foreground">{stats.count} samples</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <div className="text-xs text-muted-foreground">Min</div>
                      <div className="text-sm font-mono text-green-400">{stats.min.toFixed(0)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Avg</div>
                      <div className="text-sm font-mono text-yellow-400">{stats.avg.toFixed(0)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Max</div>
                      <div className="text-sm font-mono text-red-400">{stats.max.toFixed(0)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Price Comparison */}
      {analytics && Object.keys(analytics.latestPrices).length > 0 && (
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[#E6EDF3] flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Latest Prices by Source
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {Object.entries(analytics.latestPrices).map(([asset, sources]) => (
                <div key={asset} className="bg-[#21262D] rounded-lg p-3">
                  <div className="text-sm font-bold text-[#E6EDF3] mb-2">{asset}</div>
                  <div className="space-y-1 text-xs font-mono">
                    {Object.entries(sources).map(([source, data]) => (
                      <div key={source} className="flex justify-between">
                        <span className="text-muted-foreground capitalize">{source}:</span>
                        <span className="text-[#E6EDF3]">${data.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                    {analytics.priceDeltas[asset]?.binanceVsPoly !== undefined && (
                      <div className="flex justify-between pt-1 border-t border-[#30363D]">
                        <span className="text-muted-foreground">Δ BIN-PM:</span>
                        <span className={analytics.priceDeltas[asset].binanceVsPoly! > 0 ? 'text-green-400' : 'text-red-400'}>
                          {analytics.priceDeltas[asset].binanceVsPoly! > 0 ? '+' : ''}
                          ${analytics.priceDeltas[asset].binanceVsPoly!.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Logs Table */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-[#E6EDF3]">Recent Logs ({logs.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[300px]">
            <div className="space-y-1">
              {logs.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  <p>No logs yet.</p>
                  <p className="text-xs mt-2">Start runner with: <code className="bg-[#21262D] px-2 py-1 rounded">FEATURE_PRICE_LOGGER=true npm start</code></p>
                </div>
              ) : (
                logs.slice(0, 100).map((log) => {
                  const receivedAt = new Date(log.received_at).getTime();
                  const latencyMs = log.raw_timestamp ? receivedAt - log.raw_timestamp : null;
                  
                  return (
                    <div
                      key={log.id}
                      className="flex items-center justify-between py-1.5 px-3 bg-[#21262D] rounded text-xs font-mono hover:bg-[#30363D] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {getSourceBadge(log.source)}
                        <span className="font-semibold w-10 text-[#E6EDF3]">{log.asset}</span>
                        <span className="text-[#E6EDF3] w-28 text-right">
                          ${log.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                        {latencyMs !== null && latencyMs >= 0 && latencyMs < 10000 && (
                          <span className={`w-16 text-right ${latencyMs < 100 ? 'text-green-400' : latencyMs < 500 ? 'text-yellow-400' : 'text-red-400'}`}>
                            {latencyMs.toFixed(0)}ms
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground">
                        {format(new Date(log.received_at), 'HH:mm:ss.SSS')}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
