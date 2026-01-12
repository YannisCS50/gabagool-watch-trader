import { useEffect, useState, useMemo, useRef } from 'react';
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
  polymarket: '#8B5CF6', // Purple for Polymarket share price
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
    // Polymarket CLOB prices
    polymarketPrices,
    polymarketLoading,
    polymarketError,
    getSharePrice,
  } = useArbitrageSimulator();

  const [chartData, setChartData] = useState<{ binanceData: any[]; chainlinkData: any[] }>({ binanceData: [], chainlinkData: [] });
  const [showSettings, setShowSettings] = useState(false);
  
  // Track Polymarket share price history
  const shareHistoryRef = useRef<{ time: number; upAsk: number | null; downAsk: number | null }[]>([]);
  
  // Update share price history when polymarket prices change
  useEffect(() => {
    const marketInfo = polymarketPrices[selectedAsset];
    if (marketInfo) {
      const now = Date.now();
      const lastEntry = shareHistoryRef.current[shareHistoryRef.current.length - 1];
      
      // Only add if price changed or 500ms passed
      if (!lastEntry || 
          now - lastEntry.time > 500 || 
          lastEntry.upAsk !== marketInfo.upBestAsk ||
          lastEntry.downAsk !== marketInfo.downBestAsk) {
        shareHistoryRef.current.push({
          time: now,
          upAsk: marketInfo.upBestAsk,
          downAsk: marketInfo.downBestAsk,
        });
        // Keep last 600 entries
        if (shareHistoryRef.current.length > 600) {
          shareHistoryRef.current = shareHistoryRef.current.slice(-600);
        }
      }
    }
  }, [polymarketPrices, selectedAsset]);

  // Update chart data at high frequency (50ms) for real-time feel
  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(getChartData());
    }, 50);
    return () => clearInterval(interval);
  }, [getChartData]);

  // Combine chart data for dual-line chart with ms precision + share prices
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
    
    // Merge in share price history
    for (const sharePoint of shareHistoryRef.current) {
      const existing = merged.find((p: any) => Math.abs(p.time - sharePoint.time) < 100);
      if (existing) {
        existing.sharePriceCents = sharePoint.upAsk !== null ? sharePoint.upAsk * 100 : null;
      } else {
        merged.push({
          time: sharePoint.time,
          sharePriceCents: sharePoint.upAsk !== null ? sharePoint.upAsk * 100 : null,
        });
      }
    }
    
    // Sort and forward-fill share prices for smoother line
    merged.sort((a, b) => a.time - b.time);
    let lastShare: number | null = null;
    for (const point of merged) {
      if (point.sharePriceCents !== undefined && point.sharePriceCents !== null) {
        lastShare = point.sharePriceCents;
      } else if (lastShare !== null) {
        point.sharePriceCents = lastShare;
      }
    }
    
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
              <Badge 
                variant="outline"
                className={`text-xs ${polymarketPrices[selectedAsset] ? 'border-purple-500 text-purple-500' : 'border-muted'}`}
                title={polymarketError || (polymarketLoading ? 'Loading...' : 'CLOB prices')}
              >
                <div className={`w-2 h-2 rounded-full mr-1 ${polymarketPrices[selectedAsset] ? 'bg-purple-500 animate-pulse' : polymarketLoading ? 'bg-purple-300 animate-pulse' : 'bg-muted'}`} />
                CLOB
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
              <Label className="text-xs">TP (¢)</Label>
              <div className="flex gap-1 items-center">
                <Input 
                  type="number" 
                  value={config.takeProfitCents} 
                  onChange={(e) => updateConfig({ takeProfitCents: parseFloat(e.target.value) || 3 })}
                  className="h-8 w-14"
                  disabled={!config.takeProfitEnabled}
                />
                <input 
                  type="checkbox" 
                  checked={config.takeProfitEnabled} 
                  onChange={(e) => updateConfig({ takeProfitEnabled: e.target.checked })}
                  className="h-4 w-4"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">SL (¢)</Label>
              <div className="flex gap-1 items-center">
                <Input 
                  type="number" 
                  value={config.stopLossCents} 
                  onChange={(e) => updateConfig({ stopLossCents: parseFloat(e.target.value) || 3 })}
                  className="h-8 w-14"
                  disabled={!config.stopLossEnabled}
                />
                <input 
                  type="checkbox" 
                  checked={config.stopLossEnabled} 
                  onChange={(e) => updateConfig({ stopLossEnabled: e.target.checked })}
                  className="h-4 w-4"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Timeout (s)</Label>
              <Input 
                type="number" 
                value={config.holdTimeMs / 1000} 
                onChange={(e) => updateConfig({ holdTimeMs: (parseFloat(e.target.value) || 15) * 1000 })}
                className="h-8 w-16"
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
            <div className="h-[350px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={combinedChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis 
                    dataKey="time" 
                    tick={{ fontSize: 9 }}
                    tickFormatter={(t) => new Date(t).toLocaleTimeString('en-US', { hour12: false, minute: '2-digit', second: '2-digit' })}
                    interval="preserveStartEnd"
                  />
                  {/* Left Y-axis for spot prices (USD) */}
                  <YAxis 
                    yAxisId="spot"
                    domain={['auto', 'auto']}
                    tickFormatter={(v) => `$${v.toLocaleString()}`}
                    tick={{ fontSize: 10 }}
                    orientation="left"
                  />
                  {/* Right Y-axis for share prices (cents) */}
                  <YAxis 
                    yAxisId="share"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}¢`}
                    tick={{ fontSize: 10, fill: COLORS.polymarket }}
                    orientation="right"
                  />
                  <Tooltip 
                    labelFormatter={(t) => formatTimestamp(t as number)}
                    formatter={(v: number, name: string) => {
                      if (name === 'Share Price') return [`${v?.toFixed(1)}¢`, name];
                      return [`$${v?.toLocaleString()}`, name === 'binance' ? 'Binance' : 'Chainlink'];
                    }}
                  />
                  <Legend />
                  {/* Spot price lines */}
                  <Line 
                    yAxisId="spot"
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
                    yAxisId="spot"
                    type="stepAfter" 
                    dataKey="chainlink" 
                    stroke={COLORS.chainlink}
                    dot={false} 
                    strokeWidth={2}
                    connectNulls
                    name="Chainlink"
                    isAnimationActive={false}
                  />
                  {/* Share price line */}
                  <Line 
                    yAxisId="share"
                    type="stepAfter" 
                    dataKey="sharePriceCents" 
                    stroke={COLORS.polymarket}
                    dot={false} 
                    strokeWidth={2}
                    strokeDasharray="5 2"
                    connectNulls
                    name="Share Price"
                    isAnimationActive={false}
                  />
                  {/* Reference lines for share price bounds */}
                  <ReferenceLine 
                    yAxisId="share" 
                    y={config.minSharePrice * 100} 
                    stroke={COLORS.polymarket} 
                    strokeDasharray="3 3" 
                    strokeOpacity={0.5}
                  />
                  <ReferenceLine 
                    yAxisId="share" 
                    y={config.maxSharePrice * 100} 
                    stroke={COLORS.polymarket} 
                    strokeDasharray="3 3" 
                    strokeOpacity={0.5}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground mt-1 text-center">
              <span style={{ color: COLORS.polymarket }}>■</span> Share price (¢, rechter as) | 
              Stippellijnen = trading bounds ({(config.minSharePrice*100).toFixed(0)}-{(config.maxSharePrice*100).toFixed(0)}¢)
            </p>

            {/* Active Market Title */}
            {(() => {
              const marketInfo = polymarketPrices[selectedAsset];
              if (!marketInfo) return null;
              
              const endTime = new Date(marketInfo.eventEndTime);
              const now = new Date();
              const diffMs = endTime.getTime() - now.getTime();
              const diffMin = Math.floor(diffMs / 60000);
              const diffSec = Math.floor((diffMs % 60000) / 1000);
              const isExpired = diffMs <= 0;
              
              return (
                <div className="mt-3 p-3 bg-muted/50 rounded-lg border">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">
                        {selectedAsset} • {marketInfo.strikePrice ? `Strike $${marketInfo.strikePrice.toLocaleString()}` : 'Loading...'}
                      </p>
                      <p className="text-xs text-muted-foreground truncate max-w-[300px]">
                        {marketInfo.marketSlug}
                      </p>
                    </div>
                    <div className="text-right">
                      <Badge variant={isExpired ? 'destructive' : 'secondary'} className="font-mono">
                        {isExpired 
                          ? 'Expired' 
                          : `${diffMin}m ${diffSec}s`
                        }
                      </Badge>
                      <p className="text-xs text-muted-foreground mt-1">
                        Eindigt: {endTime.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Market Cards under Live Prices */}
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              {ASSETS.map(asset => {
                const marketInfo = polymarketPrices[asset];
                const upAsk = marketInfo?.upBestAsk;
                const downAsk = marketInfo?.downBestAsk;
                const inBounds = upAsk && upAsk >= config.minSharePrice && upAsk <= config.maxSharePrice;
                const combinedAsk = upAsk && downAsk ? upAsk + downAsk : null;
                
                return (
                  <div key={asset} className={`border rounded-lg p-3 ${asset === selectedAsset ? 'border-primary bg-primary/5' : ''}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-lg">{asset}</span>
                      {marketInfo?.strikePrice && (
                        <Badge variant="outline" className="text-xs border-purple-500/50 text-purple-400">
                          ${marketInfo.strikePrice.toLocaleString()}
                        </Badge>
                      )}
                    </div>
                    
                    {marketInfo ? (
                      <>
                        <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                          <div>
                            <span className="text-muted-foreground">UP</span>
                            <div className="font-mono text-green-500 font-semibold">
                              {upAsk ? `${(upAsk * 100).toFixed(1)}¢` : '—'}
                            </div>
                          </div>
                          <div>
                            <span className="text-muted-foreground">DOWN</span>
                            <div className="font-mono text-red-500 font-semibold">
                              {downAsk ? `${(downAsk * 100).toFixed(1)}¢` : '—'}
                            </div>
                          </div>
                        </div>
                        <div className="text-xs flex justify-between border-t pt-2">
                          <span className="text-muted-foreground">Combined</span>
                          <span className={`font-mono font-bold ${combinedAsk && combinedAsk < 1 ? 'text-green-500' : 'text-muted-foreground'}`}>
                            {combinedAsk ? `${(combinedAsk * 100).toFixed(1)}¢` : '—'}
                          </span>
                        </div>
                        <div className="text-xs flex justify-between">
                          <span className="text-muted-foreground">Tradeable</span>
                          <span className={inBounds ? 'text-green-500' : 'text-orange-400'}>
                            {inBounds ? '✓ In bounds' : `✗ Outside ${(config.minSharePrice*100).toFixed(0)}-${(config.maxSharePrice*100).toFixed(0)}¢`}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-muted-foreground">No market data</div>
                    )}
                  </div>
                );
              })}
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
            <div className="overflow-auto font-mono text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b">
                    <th className="text-left py-1 px-2">Time</th>
                    <th className="text-left py-1 px-2">Asset</th>
                    <th className="text-left py-1 px-2">Dir</th>
                    <th className="text-right py-1 px-2">Share ¢</th>
                    <th className="text-center py-1 px-2">Type</th>
                    <th className="text-right py-1 px-2">Entry $</th>
                    <th className="text-right py-1 px-2">Exit $</th>
                    <th className="text-right py-1 px-2">Fees</th>
                    <th className="text-center py-1 px-2">Status</th>
                    <th className="text-right py-1 px-2">Gross</th>
                    <th className="text-right py-1 px-2">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.slice(0, 50).map((s) => (
                    <tr key={s.id} className="border-b border-muted/50 hover:bg-muted/30">
                      <td className="py-1 px-2">{formatTimestamp(s.timestamp)}</td>
                      <td className="py-1 px-2 font-bold">{s.asset}</td>
                      <td className="py-1 px-2">
                        {s.direction === 'UP' 
                          ? <span className="text-green-500 flex items-center gap-1"><TrendingUp className="h-3 w-3" /> UP</span>
                          : <span className="text-red-500 flex items-center gap-1"><TrendingDown className="h-3 w-3" /> DN</span>
                        }
                      </td>
                      <td className="py-1 px-2 text-right text-purple-400 font-mono">
                        {s.sharePrice ? `${(s.sharePrice * 100).toFixed(1)}¢` : '—'}
                      </td>
                      <td className="py-1 px-2 text-center">
                        {s.orderType ? (
                          <Badge variant="outline" className={s.orderType === 'maker' ? 'border-blue-500 text-blue-500' : 'border-orange-500 text-orange-500'}>
                            {s.orderType}
                          </Badge>
                        ) : '—'}
                      </td>
                      <td className="py-1 px-2 text-right text-yellow-500">
                        {s.entryPrice ? `$${s.entryPrice.toFixed(3)}` : '—'}
                      </td>
                      <td className="py-1 px-2 text-right text-cyan-500">
                        {s.exitPrice ? `$${s.exitPrice.toFixed(3)}` : '—'}
                      </td>
                      <td className={`py-1 px-2 text-right ${(s.totalFees || 0) > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                        {s.totalFees !== undefined ? `$${s.totalFees.toFixed(3)}` : '—'}
                      </td>
                      <td className="py-1 px-2 text-center">
                        <SignalStatusBadge status={s.status} />
                      </td>
                      <td className={`py-1 px-2 text-right ${(s.grossPnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {s.grossPnl !== undefined ? `$${s.grossPnl.toFixed(2)}` : '—'}
                      </td>
                      <td className={`py-1 px-2 text-right font-bold ${(s.netPnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {s.netPnl !== undefined ? `$${s.netPnl.toFixed(2)}` : '—'}
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

            {/* Per-market overview - Enhanced cards */}
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              {ASSETS.map(asset => {
                const market = signalsByMarket[asset];
                const winRate = market.sold > 0 ? (market.winCount / market.sold) * 100 : 0;
                const marketInfo = polymarketPrices[asset];
                const lastSignal = market.signals[0];
                const avgEntry = market.signals.filter(s => s.entryPrice).length > 0
                  ? market.signals.filter(s => s.entryPrice).reduce((sum, s) => sum + (s.entryPrice || 0), 0) / market.signals.filter(s => s.entryPrice).length
                  : null;
                const avgExit = market.signals.filter(s => s.exitPrice).length > 0
                  ? market.signals.filter(s => s.exitPrice).reduce((sum, s) => sum + (s.exitPrice || 0), 0) / market.signals.filter(s => s.exitPrice).length
                  : null;
                const totalFees = market.signals.reduce((sum, s) => sum + (s.totalFees || 0), 0);
                const grossPnl = market.signals.reduce((sum, s) => sum + (s.grossPnl || 0), 0);
                
                return (
                  <div key={asset} className="border rounded-lg p-4 bg-card hover:border-primary/50 transition-colors">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-bold">{asset}</span>
                        {marketInfo && (
                          <Badge variant="outline" className="text-xs border-purple-500/50 text-purple-400">
                            ${marketInfo.strikePrice?.toLocaleString() || '?'}
                          </Badge>
                        )}
                      </div>
                      <Badge variant={market.total > 0 ? 'default' : 'secondary'}>
                        {market.total} trades
                      </Badge>
                    </div>

                    {/* Live CLOB Prices */}
                    {marketInfo && (
                      <div className="grid grid-cols-2 gap-2 mb-3 p-2 bg-muted/50 rounded">
                        <div>
                          <div className="text-xs text-muted-foreground">UP Ask</div>
                          <div className="font-mono text-green-500 font-semibold">
                            {marketInfo.upBestAsk ? `${(marketInfo.upBestAsk * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">DOWN Ask</div>
                          <div className="font-mono text-red-500 font-semibold">
                            {marketInfo.downBestAsk ? `${(marketInfo.downBestAsk * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">UP Bid</div>
                          <div className="font-mono text-green-400/70">
                            {marketInfo.upBestBid ? `${(marketInfo.upBestBid * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground">DOWN Bid</div>
                          <div className="font-mono text-red-400/70">
                            {marketInfo.downBestBid ? `${(marketInfo.downBestBid * 100).toFixed(1)}¢` : '—'}
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Trade Stats */}
                    <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                      <div className="text-center p-2 bg-muted/30 rounded">
                        <div className="text-muted-foreground">Filled</div>
                        <div className="font-mono font-bold text-blue-400">{market.filled}</div>
                      </div>
                      <div className="text-center p-2 bg-muted/30 rounded">
                        <div className="text-muted-foreground">Sold</div>
                        <div className="font-mono font-bold text-green-400">{market.sold}</div>
                      </div>
                      <div className="text-center p-2 bg-muted/30 rounded">
                        <div className="text-muted-foreground">Failed</div>
                        <div className="font-mono font-bold text-destructive">{market.failed}</div>
                      </div>
                    </div>

                    {/* Performance Metrics */}
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Win Rate</span>
                        <span className={`font-mono font-bold ${winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                          {winRate.toFixed(0)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Avg Entry</span>
                        <span className="font-mono text-yellow-500">
                          {avgEntry ? `${(avgEntry * 100).toFixed(1)}¢` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Avg Exit</span>
                        <span className="font-mono text-cyan-500">
                          {avgExit ? `${(avgExit * 100).toFixed(1)}¢` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Total Fees</span>
                        <span className="font-mono text-orange-400">
                          ${totalFees.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between border-t pt-1.5 mt-1.5">
                        <span className="text-muted-foreground">Gross PnL</span>
                        <span className={`font-mono ${grossPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {grossPnl >= 0 ? '+' : ''}${grossPnl.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="font-semibold">Net PnL</span>
                        <span className={`font-mono font-bold ${market.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {market.totalPnl >= 0 ? '+' : ''}${market.totalPnl.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {/* Recent Trades */}
                    {market.signals.length > 0 && (
                      <div className="mt-3 pt-3 border-t text-xs">
                        <div className="text-muted-foreground mb-2 font-medium">Recent Trades</div>
                        <div className="space-y-1.5">
                          {market.signals.slice(0, 4).map(s => (
                            <div key={s.id} className="flex items-center gap-2 p-1.5 bg-muted/20 rounded">
                              <span className={`font-bold ${s.direction === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                                {s.direction === 'UP' ? '▲' : '▼'}
                              </span>
                              <div className="flex-1 flex items-center gap-1">
                                <span className="text-muted-foreground">
                                  {s.entryPrice ? `${(s.entryPrice * 100).toFixed(1)}¢` : '—'}
                                </span>
                                <span className="text-muted-foreground">→</span>
                                <span className={s.exitPrice && s.entryPrice && s.exitPrice > s.entryPrice ? 'text-green-400' : 'text-red-400'}>
                                  {s.exitPrice ? `${(s.exitPrice * 100).toFixed(1)}¢` : '—'}
                                </span>
                              </div>
                              <SignalStatusBadge status={s.status} />
                              <span className={`font-mono font-bold min-w-[50px] text-right ${(s.pnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                {s.pnl !== undefined ? `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}` : '—'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Market Link */}
                    {lastSignal?.marketSlug && (
                      <div className="mt-3 pt-2 border-t">
                        <a 
                          href={`https://polymarket.com/event/${lastSignal.marketSlug}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-1"
                        >
                          🔗 View on Polymarket
                        </a>
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
