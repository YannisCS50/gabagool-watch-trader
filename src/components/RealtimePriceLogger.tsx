import { useRealtimePriceLogs } from '@/hooks/useRealtimePriceLogs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, Database, Zap, Server, TrendingUp, Activity, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { useMemo } from 'react';

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

  // Calculate analytics from logs
  const analytics = useMemo(() => {
    if (logs.length === 0) return null;

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

    return {
      bySource,
      byAsset,
      latencyBySource,
      latestPrices,
      priceDeltas,
      totalLogs: logs.length,
    };
  }, [logs]);

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

  return (
    <div className="space-y-4">
      {/* Status Banner */}
      <Card className="bg-[#161B22] border-[#30363D]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-[#E6EDF3]">
            <span className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-green-400" />
              WebSocket Price Analytics
            </span>
            <div className="flex items-center gap-2">
              <Badge variant="default" className="bg-green-600">
                <Server className="h-3 w-3 mr-1" /> Runner Active
              </Badge>
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
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="text-red-400 text-sm mb-4 p-2 bg-red-900/20 rounded">{error}</div>
          )}

          {/* Key Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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

      {/* Source Distribution */}
      {analytics && (
        <Card className="bg-[#161B22] border-[#30363D]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[#E6EDF3]">Source Distribution (in view)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {Object.entries(analytics.bySource).map(([source, sourceLogs]) => (
                <div key={source} className="bg-[#21262D] rounded-lg px-4 py-2 flex items-center gap-2">
                  <span className="text-sm capitalize text-[#E6EDF3]">{source}</span>
                  <Badge variant="secondary">{sourceLogs.length}</Badge>
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
          <ScrollArea className="h-[400px]">
            <div className="space-y-1">
              {logs.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  <p>No logs yet.</p>
                  <p className="text-xs mt-2">Start runner with: <code className="bg-[#21262D] px-2 py-1 rounded">FEATURE_PRICE_LOGGER=true npm start</code></p>
                </div>
              ) : (
                logs.map((log) => {
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
