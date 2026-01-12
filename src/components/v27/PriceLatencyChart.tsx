import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ComposedChart, Bar } from 'recharts';
import { RefreshCw, Activity, Play, Square, Wifi, WifiOff, TrendingUp, TrendingDown, Zap, Settings } from 'lucide-react';
import { useArbitrageSimulator, type ArbitrageSignal } from '@/hooks/useArbitrageSimulator';
import { Asset } from '@/hooks/usePriceLatencyComparison';

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

function SignalStatusBadge({ status }: { status: ArbitrageSignal['status'] }) {
  switch (status) {
    case 'pending':
      return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-400">Pending</Badge>;
    case 'filled':
      return <Badge variant="secondary" className="bg-blue-500/20 text-blue-400">Filled</Badge>;
    case 'sold':
      return <Badge variant="secondary" className="bg-green-500/20 text-green-400">Sold</Badge>;
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>;
    case 'expired':
      return <Badge variant="secondary">Expired</Badge>;
  }
}

export function PriceLatencyChart() {
  const {
    config,
    updateConfig,
    signals,
    clearSignals,
    simulatorStats,
    placeTestTrade,
    selectedAsset,
    binancePrice,
    chainlinkPrice,
    binanceLastUpdate,
    chainlinkLastUpdate,
    connectionStatus,
    binanceWsStatus,
    chainlinkWsStatus,
    connect,
    disconnect,
    resetSession,
    setSelectedAsset,
    eventLog,
    stats,
    getChartData,
    getLatencyHistogram,
    lastError,
  } = useArbitrageSimulator();

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });
  const [showSettings, setShowSettings] = useState(false);

  // Update chart data at high frequency (50ms) for real-time feel
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
    }, 50);
    return () => clearInterval(interval);
  }, [getChartData]);

  // Combine chart data for dual-line chart with ms precision
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

  // Group signals by asset for per-market overview
  const signalsByMarket = useMemo(() => {
    const grouped: Record<Asset, {
      total: number;
      filled: number;
      sold: number;
      failed: number;
      totalPnl: number;
      winCount: number;
      signals: ArbitrageSignal[];
    }> = {
      BTC: { total: 0, filled: 0, sold: 0, failed: 0, totalPnl: 0, winCount: 0, signals: [] },
      ETH: { total: 0, filled: 0, sold: 0, failed: 0, totalPnl: 0, winCount: 0, signals: [] },
      SOL: { total: 0, filled: 0, sold: 0, failed: 0, totalPnl: 0, winCount: 0, signals: [] },
      XRP: { total: 0, filled: 0, sold: 0, failed: 0, totalPnl: 0, winCount: 0, signals: [] },
    };

    for (const signal of signals) {
      const market = grouped[signal.asset];
      market.total++;
      market.signals.push(signal);
      
      if (signal.status === 'filled' || signal.status === 'sold') market.filled++;
      if (signal.status === 'sold') {
        market.sold++;
        market.totalPnl += signal.pnl || 0;
        if ((signal.pnl || 0) > 0) market.winCount++;
      }
      if (signal.status === 'failed') market.failed++;
    }

    return grouped;
  }, [signals]);

  return (
    <Card className="col-span-full">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-yellow-400" />
              Arbitrage Simulator
            </CardTitle>
            <CardDescription>
              Live WebSocket + Paper Trading Simulator (50ms resolution)
            </CardDescription>
            {lastError && (
              <p className="text-xs text-destructive mt-1">{lastError}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Simulator toggle */}
            <div className="flex items-center gap-2 mr-4">
              <Switch 
                id="simulator-enabled"
                checked={config.enabled} 
                onCheckedChange={(checked) => updateConfig({ enabled: checked })}
              />
              <Label htmlFor="simulator-enabled" className="text-sm">
                {config.enabled ? 'Trading' : 'Paused'}
              </Label>
            </div>

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

            {/* Controls */}
            <Button variant="ghost" size="sm" onClick={() => setShowSettings(!showSettings)}>
              <Settings className="h-4 w-4" />
            </Button>
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
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="mt-4 p-4 bg-muted rounded-lg grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <Label className="text-xs">Min Delta ($)</Label>
              <Input 
                type="number" 
                value={config.minDeltaUsd} 
                onChange={(e) => updateConfig({ minDeltaUsd: parseFloat(e.target.value) || 10 })}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Share Range (cents)</Label>
              <div className="flex gap-1">
                <Input 
                  type="number" 
                  value={config.minSharePrice * 100} 
                  onChange={(e) => updateConfig({ minSharePrice: (parseFloat(e.target.value) || 35) / 100 })}
                  className="h-8 w-16"
                />
                <span className="self-center">-</span>
                <Input 
                  type="number" 
                  value={config.maxSharePrice * 100} 
                  onChange={(e) => updateConfig({ maxSharePrice: (parseFloat(e.target.value) || 65) / 100 })}
                  className="h-8 w-16"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Hold Time (sec)</Label>
              <Input 
                type="number" 
                value={config.holdTimeMs / 1000} 
                onChange={(e) => updateConfig({ holdTimeMs: (parseFloat(e.target.value) || 15) * 1000 })}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-xs">Max Fill (ms)</Label>
              <Input 
                type="number" 
                value={config.maxFillTimeMs} 
                onChange={(e) => updateConfig({ maxFillTimeMs: parseInt(e.target.value) || 1000 })}
                className="h-8"
              />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {/* Simulator Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
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
            <div className="text-xs text-muted-foreground">Signals</div>
            <div className="text-lg font-mono font-bold">{simulatorStats.totalSignals}</div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Filled/Sold</div>
            <div className="text-lg font-mono font-bold">{simulatorStats.filled}/{simulatorStats.sold}</div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Win Rate</div>
            <div className={`text-lg font-mono font-bold ${simulatorStats.winRate >= 0.5 ? 'text-green-500' : 'text-red-500'}`}>
              {(simulatorStats.winRate * 100).toFixed(0)}%
            </div>
          </div>
          <div className="bg-muted rounded-lg p-3">
            <div className="text-xs text-muted-foreground">Total PnL</div>
            <div className={`text-lg font-mono font-bold ${simulatorStats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {simulatorStats.totalPnl >= 0 ? '+' : ''}${simulatorStats.totalPnl.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Charts */}
        <Tabs defaultValue="prices" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="prices">Live Prices</TabsTrigger>
            <TabsTrigger value="deltas">Price Deltas</TabsTrigger>
            <TabsTrigger value="signals">Trade Log</TabsTrigger>
          </TabsList>

          <TabsContent value="prices">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedChartData}>
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
                </LineChart>
              </ResponsiveContainer>
            </div>
          </TabsContent>

          <TabsContent value="deltas">
            <div className="h-[300px]">
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
                  <ReferenceLine y={config.minDeltaUsd} stroke={COLORS.positive} strokeDasharray="3 3" label="Trigger" />
                  <ReferenceLine y={-config.minDeltaUsd} stroke={COLORS.negative} strokeDasharray="3 3" />
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
              Groene/rode lijnen = trigger threshold (${config.minDeltaUsd}). Moves boven threshold triggeren trades.
            </p>
          </TabsContent>

          <TabsContent value="signals">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-muted-foreground">{signals.length} signals logged</span>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => placeTestTrade(selectedAsset, 'UP')}
                  className="text-green-500 border-green-500/50 hover:bg-green-500/10"
                >
                  <TrendingUp className="h-3 w-3 mr-1" />
                  Test UP
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => placeTestTrade(selectedAsset, 'DOWN')}
                  className="text-red-500 border-red-500/50 hover:bg-red-500/10"
                >
                  <TrendingDown className="h-3 w-3 mr-1" />
                  Test DOWN
                </Button>
                <Button variant="ghost" size="sm" onClick={clearSignals}>Clear</Button>
              </div>
            </div>
            <div className="h-[300px] overflow-auto font-mono text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left py-1 px-2">Time</th>
                    <th className="text-left py-1 px-2">Asset</th>
                    <th className="text-left py-1 px-2">Dir</th>
                    <th className="text-right py-1 px-2">Delta</th>
                    <th className="text-center py-1 px-2">Status</th>
                    <th className="text-right py-1 px-2">PnL</th>
                    <th className="text-left py-1 px-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.slice(0, 50).map((s) => (
                    <tr key={s.id} className="border-b border-muted/50 hover:bg-muted/30">
                      <td className="py-1 px-2">{formatTimestamp(s.timestamp)}</td>
                      <td className="py-1 px-2">{s.asset}</td>
                      <td className="py-1 px-2">
                        {s.direction === 'UP' 
                          ? <TrendingUp className="h-3 w-3 text-green-500" />
                          : <TrendingDown className="h-3 w-3 text-red-500" />
                        }
                      </td>
                      <td className={`py-1 px-2 text-right ${s.binanceDelta > 0 ? 'text-green-500' : 'text-red-500'}`}>
                        ${Math.abs(s.binanceDelta).toFixed(2)}
                      </td>
                      <td className="py-1 px-2 text-center">
                        <SignalStatusBadge status={s.status} />
                      </td>
                      <td className={`py-1 px-2 text-right ${(s.pnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {s.pnl !== undefined ? `$${s.pnl.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-1 px-2 text-muted-foreground truncate max-w-[200px]">
                        {s.notes}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {signals.length === 0 && (
                <div className="text-center text-muted-foreground py-8">
                  Wacht op prijsbewegingen &gt; ${config.minDeltaUsd}...
                </div>
              )}
            </div>

            {/* Per-market overview */}
            <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
              {ASSETS.map(asset => {
                const market = signalsByMarket[asset];
                const winRate = market.sold > 0 ? (market.winCount / market.sold) * 100 : 0;
                
                return (
                  <div key={asset} className="border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold">{asset}</span>
                      <Badge variant={market.total > 0 ? 'default' : 'secondary'}>
                        {market.total} trades
                      </Badge>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-1 text-xs">
                      <div className="text-muted-foreground">Filled:</div>
                      <div className="text-right font-mono">{market.filled}</div>
                      
                      <div className="text-muted-foreground">Sold:</div>
                      <div className="text-right font-mono">{market.sold}</div>
                      
                      <div className="text-muted-foreground">Failed:</div>
                      <div className="text-right font-mono text-destructive">{market.failed}</div>
                      
                      <div className="text-muted-foreground">Win Rate:</div>
                      <div className={`text-right font-mono ${winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                        {winRate.toFixed(0)}%
                      </div>
                      
                      <div className="text-muted-foreground font-semibold">PnL:</div>
                      <div className={`text-right font-mono font-bold ${market.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {market.totalPnl >= 0 ? '+' : ''}${market.totalPnl.toFixed(2)}
                      </div>
                    </div>

                    {/* Last 3 trades for this market */}
                    {market.signals.length > 0 && (
                      <div className="mt-2 pt-2 border-t text-xs space-y-1">
                        <div className="text-muted-foreground mb-1">Recent:</div>
                        {market.signals.slice(0, 3).map(s => (
                          <div key={s.id} className="flex items-center justify-between">
                            <span className={s.direction === 'UP' ? 'text-green-400' : 'text-red-400'}>
                              {s.direction}
                            </span>
                            <SignalStatusBadge status={s.status} />
                            <span className={`font-mono ${(s.pnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                              {s.pnl !== undefined ? `$${s.pnl.toFixed(2)}` : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
