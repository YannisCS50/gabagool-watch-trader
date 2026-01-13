import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, TrendingUp, TrendingDown, DollarSign, Zap, Clock, 
  Activity, Wifi, WifiOff, RefreshCw, Target, Settings2, BarChart3,
  Bell, FileText, ShoppingCart, ArrowUpDown
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import { V29ConfigEditor } from '@/components/v29/V29ConfigEditor';
import { V29LogViewer } from '@/components/v29/V29LogViewer';
import { LatencyTracker } from '@/components/v27/LatencyTracker';
import { PriceLatencyChart } from '@/components/v27/PriceLatencyChart';
import { RealtimePriceMonitor } from '@/components/RealtimePriceMonitor';
import { TimeRangeFilter, filterDataByTime, DEFAULT_TIME_FILTER, type TimeFilterType } from '@/components/v27/shadow/TimeRangeFilter';

interface V29Signal {
  id: string;
  created_at: string;
  run_id: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  signal_ts: number;
  binance_price: number;
  delta_usd: number;
  share_price: number;
  market_slug: string | null;
  strike_price: number | null;
  status: string;
  entry_price: number | null;
  exit_price: number | null;
  fill_ts: number | null;
  sell_ts: number | null;
  net_pnl: number | null;
  shares: number | null;
  exit_reason: string | null;
}

interface OrderQueueItem {
  id: string;
  created_at: string;
  status: string;
  market_slug: string;
  asset: string;
  outcome: string;
  price: number;
  shares: number;
  order_type: string;
  reasoning: string | null;
  intent_type: string | null;
  executed_at: string | null;
  avg_fill_price: number | null;
  error_message: string | null;
  correlation_id: string | null;
}

interface FillLog {
  id: string;
  ts: number;
  iso: string;
  market_id: string;
  asset: string;
  side: string;
  fill_qty: number;
  fill_price: number;
  fill_notional: number;
  intent: string;
  seconds_remaining: number;
  spot_price: number | null;
  strike_price: number | null;
  delta: number | null;
  hedge_lag_ms: number | null;
  correlation_id: string | null;
}

interface RunnerHeartbeat {
  id: string;
  created_at: string;
  runner_id: string;
  status: string;
  balance: number | null;
  markets_count: number;
  positions_count: number;
  version: string | null;
}

interface Stats {
  totalSignals: number;
  filled: number;
  sold: number;
  expired: number;
  failed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgFillLatency: number;
  medianFillLatency: number;
  fastestFill: number;
  avgDelta: number;
}

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;

export default function V29Dashboard() {
  const navigate = useNavigate();
  const [signals, setSignals] = useState<V29Signal[]>([]);
  const [orders, setOrders] = useState<OrderQueueItem[]>([]);
  const [fills, setFills] = useState<FillLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [timeFilter, setTimeFilter] = useState<TimeFilterType>(DEFAULT_TIME_FILTER);
  const [activeTab, setActiveTab] = useState('signals');
  const [recentNotifications, setRecentNotifications] = useState<string[]>([]);
  const [runnerStatus, setRunnerStatus] = useState<{
    isOnline: boolean;
    lastHeartbeat: string | null;
    balance: number | null;
    marketsCount: number;
    positionsCount: number;
    version: string | null;
  }>({ isOnline: false, lastHeartbeat: null, balance: null, marketsCount: 0, positionsCount: 0, version: null });

  const fetchData = async () => {
    setLoading(signals.length === 0);

    const [signalsRes, ordersRes, fillsRes, heartbeatRes] = await Promise.all([
      supabase
        .from('v29_signals')
        .select('*')
        .order('signal_ts', { ascending: false })
        .limit(500),
      supabase
        .from('order_queue')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('fill_logs')
        .select('*')
        .order('ts', { ascending: false })
        .limit(300),
      supabase
        .from('runner_heartbeats')
        .select('*')
        .ilike('runner_id', 'v29%')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    if (signalsRes.data) setSignals(signalsRes.data as unknown as V29Signal[]);
    if (ordersRes.data) setOrders(ordersRes.data as OrderQueueItem[]);
    if (fillsRes.data) setFills(fillsRes.data as FillLog[]);

    if (heartbeatRes.data && heartbeatRes.data.length > 0) {
      const hb = heartbeatRes.data[0] as RunnerHeartbeat;
      const lastBeat = new Date(hb.created_at);
      const isOnline = Date.now() - lastBeat.getTime() < 60000;
      setRunnerStatus({
        isOnline,
        lastHeartbeat: hb.created_at,
        balance: hb.balance,
        marketsCount: hb.markets_count,
        positionsCount: hb.positions_count,
        version: hb.version,
      });
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to realtime signals
  useEffect(() => {
    const channel = supabase
      .channel('v29-signals-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'v29_signals' },
        (payload) => {
          const sig = payload.new as V29Signal;
          const notification = `[${format(new Date(sig.signal_ts), 'HH:mm:ss')}] ${sig.asset} ${sig.direction} @ ${(sig.share_price * 100).toFixed(1)}¢ (Δ$${sig.delta_usd?.toFixed(0) ?? '?'})`;
          setRecentNotifications(prev => [notification, ...prev].slice(0, 30));
          setSignals(prev => [sig, ...prev].slice(0, 500));
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'v29_signals' },
        (payload) => {
          const sig = payload.new as V29Signal;
          setSignals(prev => prev.map(s => s.id === sig.id ? sig : s));
          if (sig.status === 'sold' && sig.net_pnl !== null) {
            const notification = `[${format(new Date(), 'HH:mm:ss')}] ✅ SOLD ${sig.asset} ${sig.direction} | P&L: $${sig.net_pnl.toFixed(3)} (${sig.exit_reason || 'exit'})`;
            setRecentNotifications(prev => [notification, ...prev].slice(0, 30));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Filter by time and asset
  const filteredSignals = useMemo(() => {
    let filtered = signals;
    if (assetFilter !== 'ALL') {
      filtered = filtered.filter(s => s.asset === assetFilter);
    }
    const withTs = filtered.map(s => ({ ...s, ts: s.signal_ts }));
    return filterDataByTime(withTs, timeFilter);
  }, [signals, assetFilter, timeFilter]);

  const filteredOrders = useMemo(() => {
    let filtered = orders;
    if (assetFilter !== 'ALL') {
      filtered = filtered.filter(o => o.asset === assetFilter);
    }
    return filterDataByTime(filtered, timeFilter);
  }, [orders, assetFilter, timeFilter]);

  const filteredFills = useMemo(() => {
    let filtered = fills;
    if (assetFilter !== 'ALL') {
      filtered = filtered.filter(f => f.asset === assetFilter);
    }
    return filterDataByTime(filtered, timeFilter);
  }, [fills, assetFilter, timeFilter]);

  // Calculate stats
  const stats = useMemo((): Stats => {
    const filled = filteredSignals.filter(s => s.fill_ts !== null);
    const sold = filteredSignals.filter(s => s.status === 'sold');
    const expired = filteredSignals.filter(s => s.status === 'expired' || s.exit_reason === 'TIMEOUT');
    const failed = filteredSignals.filter(s => s.status === 'failed');
    const wins = sold.filter(s => (s.net_pnl ?? 0) > 0);
    const losses = sold.filter(s => (s.net_pnl ?? 0) <= 0);
    
    const totalPnl = sold.reduce((sum, s) => sum + (s.net_pnl ?? 0), 0);
    const avgPnl = sold.length > 0 ? totalPnl / sold.length : 0;
    
    const fillLatencies = filled
      .filter(s => s.fill_ts && s.signal_ts)
      .map(s => (s.fill_ts! - s.signal_ts));
    
    const avgFillLatency = fillLatencies.length > 0 
      ? fillLatencies.reduce((a, b) => a + b, 0) / fillLatencies.length 
      : 0;
    
    const sortedLatencies = [...fillLatencies].sort((a, b) => a - b);
    const medianFillLatency = sortedLatencies.length > 0 
      ? sortedLatencies[Math.floor(sortedLatencies.length / 2)] 
      : 0;
    
    const fastestFill = fillLatencies.length > 0 ? Math.min(...fillLatencies) : 0;
    
    const deltas = filteredSignals
      .filter(s => s.delta_usd !== null)
      .map(s => Math.abs(s.delta_usd!));
    const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

    return {
      totalSignals: filteredSignals.length,
      filled: filled.length,
      sold: sold.length,
      expired: expired.length,
      failed: failed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: sold.length > 0 ? (wins.length / sold.length) * 100 : 0,
      totalPnl,
      avgPnl,
      avgFillLatency,
      medianFillLatency,
      fastestFill,
      avgDelta,
    };
  }, [filteredSignals]);

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sold':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">SOLD</Badge>;
      case 'filled':
      case 'open':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">OPEN</Badge>;
      case 'expired':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">EXPIRED</Badge>;
      case 'pending':
        return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">PENDING</Badge>;
      case 'failed':
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">FAILED</Badge>;
      case 'executed':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">EXECUTED</Badge>;
      case 'queued':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">QUEUED</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getIntentBadge = (intent: string | null) => {
    if (!intent) return null;
    switch (intent.toUpperCase()) {
      case 'ENTRY':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">ENTRY</Badge>;
      case 'HEDGE':
        return <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">HEDGE</Badge>;
      case 'EXIT':
        return <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">EXIT</Badge>;
      case 'TP':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">TP</Badge>;
      case 'SL':
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">SL</Badge>;
      case 'TIMEOUT':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">TIMEOUT</Badge>;
      default:
        return <Badge variant="outline">{intent}</Badge>;
    }
  };

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 mb-4 sm:mb-6">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" className="shrink-0 mt-0.5" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg sm:text-xl md:text-2xl font-bold">
                V29 Simple Live Runner
              </h1>
              <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs shrink-0">
                <Zap className="h-3 w-3 mr-1" />
                LIVE
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs sm:text-sm mt-0.5 hidden sm:block">
              Tick-to-tick delta • Realtime orderbook • TP/SL exits
            </p>
          </div>
        </div>

        {/* Action row */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {runnerStatus.isOnline ? (
              <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                <Wifi className="h-3 w-3 mr-1" />
                Online
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs">
                <WifiOff className="h-3 w-3 mr-1" />
                Offline
              </Badge>
            )}
            {runnerStatus.balance !== null && (
              <Badge variant="secondary" className="text-xs">
                ${runnerStatus.balance.toFixed(2)}
              </Badge>
            )}
            {runnerStatus.positionsCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {runnerStatus.positionsCount} pos
              </Badge>
            )}
            {runnerStatus.version && (
              <Badge variant="outline" className="text-xs">
                {runnerStatus.version}
              </Badge>
            )}
            {runnerStatus.lastHeartbeat && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {formatDistanceToNow(new Date(runnerStatus.lastHeartbeat), { addSuffix: true, locale: nl })}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <TimeRangeFilter value={timeFilter} onChange={setTimeFilter} />
            <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="h-8">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline ml-1">Refresh</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Asset Filter */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {ASSETS.map(asset => (
          <Button
            key={asset}
            variant={assetFilter === asset ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAssetFilter(asset)}
            className="h-8"
          >
            {asset}
          </Button>
        ))}
      </div>

      {/* Stats Summary Bar */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary" className="font-normal">
          {stats.totalSignals} signalen
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {stats.filled} filled / {stats.sold} sold
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {stats.wins}W / {stats.losses}L ({stats.winRate.toFixed(0)}%)
        </Badge>
        <Badge variant={stats.totalPnl >= 0 ? "default" : "destructive"} className="font-normal">
          {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} P&L
        </Badge>
        <Badge variant="outline" className="font-normal">
          {formatMs(stats.medianFillLatency)} latency
        </Badge>
      </div>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Target className="h-3 w-3" /> Signalen
          </div>
          <div className="text-xl font-bold">{stats.totalSignals}</div>
          <p className="text-xs text-muted-foreground">{stats.filled} filled</p>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <BarChart3 className="h-3 w-3" /> Win Rate
          </div>
          <div className="text-xl font-bold text-green-500">{stats.winRate.toFixed(1)}%</div>
          <p className="text-xs text-muted-foreground">{stats.wins}W / {stats.losses}L</p>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <DollarSign className="h-3 w-3" /> Net P&L
          </div>
          <div className={`text-xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            ${stats.totalPnl.toFixed(2)}
          </div>
          <p className="text-xs text-muted-foreground">Avg: ${stats.avgPnl.toFixed(3)}</p>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Zap className="h-3 w-3" /> Fill Latency
          </div>
          <div className="text-xl font-bold">{formatMs(stats.medianFillLatency)}</div>
          <p className="text-xs text-muted-foreground">Best: {formatMs(stats.fastestFill)}</p>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Activity className="h-3 w-3" /> Avg Delta
          </div>
          <div className="text-xl font-bold">${stats.avgDelta.toFixed(0)}</div>
          <p className="text-xs text-muted-foreground">Binance vs Strike</p>
        </Card>

        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Clock className="h-3 w-3" /> Status
          </div>
          <div className="text-xl font-bold">{stats.sold}</div>
          <p className="text-xs text-muted-foreground">{stats.expired} exp / {stats.failed} fail</p>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <ScrollArea className="w-full whitespace-nowrap pb-2">
          <TabsList className="inline-flex w-max gap-1 p-1">
            <TabsTrigger value="realtime" className="text-xs sm:text-sm px-2 sm:px-3 bg-yellow-500/20 text-yellow-400">
              <Zap className="h-3 w-3 mr-1" />
              Live
            </TabsTrigger>
            <TabsTrigger value="signals" className="text-xs sm:text-sm px-2 sm:px-3">
              <TrendingUp className="h-3 w-3 mr-1" />
              Signals
            </TabsTrigger>
            <TabsTrigger value="orders" className="text-xs sm:text-sm px-2 sm:px-3">
              <ShoppingCart className="h-3 w-3 mr-1" />
              Orders
            </TabsTrigger>
            <TabsTrigger value="fills" className="text-xs sm:text-sm px-2 sm:px-3">
              <ArrowUpDown className="h-3 w-3 mr-1" />
              Fills
            </TabsTrigger>
            <TabsTrigger value="latency" className="text-xs sm:text-sm px-2 sm:px-3">
              <Activity className="h-3 w-3 mr-1" />
              Latency
            </TabsTrigger>
            <TabsTrigger value="notifications" className="text-xs sm:text-sm px-2 sm:px-3">
              <Bell className="h-3 w-3 mr-1" />
              Alerts
            </TabsTrigger>
            <TabsTrigger value="logs" className="text-xs sm:text-sm px-2 sm:px-3 bg-green-500/20 text-green-400">
              <FileText className="h-3 w-3 mr-1" />
              Logs
            </TabsTrigger>
            <TabsTrigger value="config" className="text-xs sm:text-sm px-2 sm:px-3 bg-purple-500/20 text-purple-400">
              <Settings2 className="h-3 w-3 mr-1" />
              Config
            </TabsTrigger>
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        {/* Live Tab - Real-time prices */}
        <TabsContent value="realtime" className="space-y-4 mt-4">
          <RealtimePriceMonitor />
        </TabsContent>

        {/* Signals Tab */}
        <TabsContent value="signals" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">V29 Signals & Trades ({filteredSignals.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Dir</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Exit</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Exit Reason</TableHead>
                      <TableHead>P&L</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSignals.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                          Nog geen V29 signals. Start de runner om te beginnen.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSignals.map((signal) => {
                        const fillLatency = signal.fill_ts && signal.signal_ts 
                          ? signal.fill_ts - signal.signal_ts 
                          : null;
                        
                        return (
                          <TableRow key={signal.id}>
                            <TableCell className="text-xs">
                              {format(new Date(signal.signal_ts), 'HH:mm:ss')}
                              <br />
                              <span className="text-muted-foreground">
                                {formatDistanceToNow(new Date(signal.signal_ts), { addSuffix: true, locale: nl })}
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{signal.asset}</Badge>
                            </TableCell>
                            <TableCell>
                              <Badge className={signal.direction === 'UP' 
                                ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                                : 'bg-red-500/20 text-red-400 border-red-500/30'
                              }>
                                {signal.direction === 'UP' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                                {signal.direction}
                              </Badge>
                            </TableCell>
                            <TableCell className={signal.delta_usd > 0 ? 'text-green-400' : 'text-red-400'}>
                              ${signal.delta_usd?.toFixed(0) ?? '-'}
                            </TableCell>
                            <TableCell>{signal.entry_price ? `${(signal.entry_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                            <TableCell>{signal.exit_price ? `${(signal.exit_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                            <TableCell>{signal.shares?.toFixed(2) ?? '-'}</TableCell>
                            <TableCell className={fillLatency && fillLatency < 500 ? 'text-green-400' : ''}>
                              {fillLatency ? formatMs(fillLatency) : '-'}
                            </TableCell>
                            <TableCell>
                              {getIntentBadge(signal.exit_reason)}
                            </TableCell>
                            <TableCell className={`font-medium ${(signal.net_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {signal.net_pnl !== null ? `$${signal.net_pnl.toFixed(3)}` : '-'}
                            </TableCell>
                            <TableCell>{getStatusBadge(signal.status)}</TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Orders Tab */}
        <TabsContent value="orders" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Order Queue ({filteredOrders.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Intent</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Fill Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="max-w-[200px]">Reasoning</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className="text-xs">
                          {format(new Date(order.created_at), 'HH:mm:ss')}
                          <br />
                          <span className="text-muted-foreground">
                            {formatDistanceToNow(new Date(order.created_at), { addSuffix: true, locale: nl })}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{order.asset}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={order.outcome === 'UP' 
                            ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                            : 'bg-red-500/20 text-red-400 border-red-500/30'
                          }>
                            {order.outcome}
                          </Badge>
                        </TableCell>
                        <TableCell>{getIntentBadge(order.intent_type)}</TableCell>
                        <TableCell>{(order.price * 100).toFixed(1)}¢</TableCell>
                        <TableCell>{order.shares.toFixed(2)}</TableCell>
                        <TableCell>
                          {order.avg_fill_price ? `${(order.avg_fill_price * 100).toFixed(1)}¢` : '-'}
                        </TableCell>
                        <TableCell>{getStatusBadge(order.status)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate" title={order.reasoning || undefined}>
                          {order.reasoning || order.error_message || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Fills Tab */}
        <TabsContent value="fills" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Fill Logs ({filteredFills.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[100px]">Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Intent</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Notional</TableHead>
                      <TableHead>Spot</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Hedge Lag</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredFills.map((fill) => (
                      <TableRow key={fill.id}>
                        <TableCell className="text-xs">
                          {format(new Date(fill.ts), 'HH:mm:ss')}
                          <br />
                          <span className="text-muted-foreground">{fill.seconds_remaining}s left</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{fill.asset}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={fill.side === 'BUY' 
                            ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                            : 'bg-red-500/20 text-red-400 border-red-500/30'
                          }>
                            {fill.side}
                          </Badge>
                        </TableCell>
                        <TableCell>{getIntentBadge(fill.intent)}</TableCell>
                        <TableCell>{fill.fill_qty.toFixed(2)}</TableCell>
                        <TableCell>{(fill.fill_price * 100).toFixed(1)}¢</TableCell>
                        <TableCell>${fill.fill_notional.toFixed(2)}</TableCell>
                        <TableCell>{fill.spot_price ? `$${fill.spot_price.toFixed(0)}` : '-'}</TableCell>
                        <TableCell className={fill.delta && fill.delta > 0 ? 'text-green-400' : 'text-red-400'}>
                          {fill.delta ? `$${fill.delta.toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell>{fill.hedge_lag_ms ? `${fill.hedge_lag_ms}ms` : '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Latency Tab */}
        <TabsContent value="latency" className="mt-4 space-y-6">
          <LatencyTracker />
          <PriceLatencyChart />
          
          {/* Fill Latency Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>Fill Latency Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {['< 200ms', '200-500ms', '500ms-1s', '1-2s', '> 2s'].map((bucket, i) => {
                  const ranges = [[0, 200], [200, 500], [500, 1000], [1000, 2000], [2000, Infinity]];
                  const [min, max] = ranges[i];
                  const count = filteredSignals.filter(s => {
                    if (!s.fill_ts || !s.signal_ts) return false;
                    const latency = s.fill_ts - s.signal_ts;
                    return latency >= min && latency < max;
                  }).length;
                  const total = filteredSignals.filter(s => s.fill_ts).length;
                  const pct = total > 0 ? (count / total) * 100 : 0;
                  
                  return (
                    <div key={bucket} className="flex items-center gap-3">
                      <span className="text-sm w-24">{bucket}</span>
                      <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
                        <div 
                          className={`h-full transition-all ${i < 2 ? 'bg-green-500' : i < 3 ? 'bg-yellow-500' : 'bg-red-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-sm w-20 text-right">{count} ({pct.toFixed(0)}%)</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications Tab */}
        <TabsContent value="notifications" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Trade Alerts ({recentNotifications.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px] font-mono text-xs">
                {recentNotifications.length === 0 ? (
                  <p className="text-muted-foreground">Wachten op live trades...</p>
                ) : (
                  recentNotifications.map((notification, i) => (
                    <div key={i} className={`py-2 border-b border-border/50 ${notification.includes('✅') ? 'text-green-400' : ''}`}>
                      {notification}
                    </div>
                  ))
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs" className="mt-4">
          <V29LogViewer />
        </TabsContent>

        {/* Config Tab */}
        <TabsContent value="config" className="mt-4">
          <V29ConfigEditor />
        </TabsContent>
      </Tabs>
    </div>
  );
}
