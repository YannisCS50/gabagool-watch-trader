import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, TrendingUp, TrendingDown, DollarSign, Zap, Clock, 
  Activity, Wifi, WifiOff, RefreshCw, Target, BarChart3
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

interface V28Signal {
  id: string;
  created_at: string;
  run_id: string;
  asset: string;
  direction: 'UP' | 'DOWN';
  signal_ts: number;
  binance_price: number;
  binance_delta: number;
  chainlink_price: number | null;
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
  is_live: boolean;
  binance_chainlink_delta: number | null;
  binance_chainlink_latency_ms: number | null;
}

interface RunnerHeartbeat {
  id: string;
  created_at: string;
  runner_id: string;
  status: string;
  balance: number | null;
  markets_count: number;
  positions_count: number;
}

interface Stats {
  totalSignals: number;
  liveSignals: number;
  filled: number;
  sold: number;
  expired: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgFillLatency: number;
  medianFillLatency: number;
  fastestFill: number;
  avgBinanceChainlinkDelta: number;
}

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;

export default function V28Dashboard() {
  const navigate = useNavigate();
  const [signals, setSignals] = useState<V28Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [runnerStatus, setRunnerStatus] = useState<{
    isOnline: boolean;
    lastHeartbeat: string | null;
    balance: number | null;
    marketsCount: number;
    positionsCount: number;
  }>({ isOnline: false, lastHeartbeat: null, balance: null, marketsCount: 0, positionsCount: 0 });
  const [recentLogs, setRecentLogs] = useState<string[]>([]);

  // Fetch signals from paper_signals table
  const fetchData = async () => {
    setLoading(signals.length === 0);

    const { data, error } = await supabase
      .from('paper_signals')
      .select('*')
      .eq('is_live', true)
      .order('signal_ts', { ascending: false })
      .limit(200);

    if (data && !error) {
      setSignals(data as V28Signal[]);
    }

    // Fetch runner heartbeat
    const { data: heartbeatData } = await supabase
      .from('runner_heartbeats')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    if (heartbeatData && heartbeatData.length > 0) {
      const hb = heartbeatData[0] as RunnerHeartbeat;
      const lastBeat = new Date(hb.created_at);
      const isOnline = Date.now() - lastBeat.getTime() < 60000; // 60 sec timeout
      setRunnerStatus({
        isOnline,
        lastHeartbeat: hb.created_at,
        balance: hb.balance,
        marketsCount: hb.markets_count,
        positionsCount: hb.positions_count,
      });
    }

    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  // Subscribe to realtime bot events for logs
  useEffect(() => {
    const channel = supabase
      .channel('v28-bot-events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bot_events' },
        (payload) => {
          const event = payload.new as { event_type: string; data: any; ts: number };
          const logLine = `[${new Date(event.ts).toLocaleTimeString()}] ${event.event_type}: ${JSON.stringify(event.data).slice(0, 100)}`;
          setRecentLogs(prev => [logLine, ...prev].slice(0, 50));
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  // Calculate stats
  const stats = useMemo((): Stats => {
    const filtered = assetFilter === 'ALL' ? signals : signals.filter(s => s.asset === assetFilter);
    
    const filled = filtered.filter(s => s.fill_ts !== null);
    const sold = filtered.filter(s => s.status === 'sold');
    const expired = filtered.filter(s => s.status === 'expired');
    const wins = sold.filter(s => (s.net_pnl ?? 0) > 0);
    const losses = sold.filter(s => (s.net_pnl ?? 0) <= 0);
    
    const totalPnl = sold.reduce((sum, s) => sum + (s.net_pnl ?? 0), 0);
    const avgPnl = sold.length > 0 ? totalPnl / sold.length : 0;
    
    // Fill latency stats
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
    
    // Binance-Chainlink delta
    const deltas = filtered
      .filter(s => s.binance_chainlink_delta !== null)
      .map(s => Math.abs(s.binance_chainlink_delta!));
    const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

    return {
      totalSignals: filtered.length,
      liveSignals: filtered.filter(s => s.is_live).length,
      filled: filled.length,
      sold: sold.length,
      expired: expired.length,
      wins: wins.length,
      losses: losses.length,
      winRate: sold.length > 0 ? (wins.length / sold.length) * 100 : 0,
      totalPnl,
      avgPnl,
      avgFillLatency,
      medianFillLatency,
      fastestFill,
      avgBinanceChainlinkDelta: avgDelta,
    };
  }, [signals, assetFilter]);

  const filteredSignals = useMemo(() => {
    return assetFilter === 'ALL' ? signals : signals.filter(s => s.asset === assetFilter);
  }, [signals, assetFilter]);

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sold':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">SOLD</Badge>;
      case 'filled':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">OPEN</Badge>;
      case 'expired':
        return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">EXPIRED</Badge>;
      case 'pending':
        return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">PENDING</Badge>;
      case 'failed':
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">FAILED</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              V28 Live Dashboard
              <Zap className="h-5 w-5 text-yellow-500" />
            </h1>
            <p className="text-muted-foreground text-sm">Binance Delta Arbitrage</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Runner Status */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border">
            {runnerStatus.isOnline ? (
              <Wifi className="h-4 w-4 text-green-500" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-500" />
            )}
            <span className={`text-sm font-medium ${runnerStatus.isOnline ? 'text-green-500' : 'text-red-500'}`}>
              {runnerStatus.isOnline ? 'LIVE' : 'OFFLINE'}
            </span>
            {runnerStatus.balance !== null && (
              <span className="text-sm text-muted-foreground ml-2">
                ${runnerStatus.balance.toFixed(2)}
              </span>
            )}
          </div>
          
          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Asset Filter */}
      <div className="flex gap-2 mb-6">
        {ASSETS.map(asset => (
          <Button
            key={asset}
            variant={assetFilter === asset ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAssetFilter(asset)}
          >
            {asset}
          </Button>
        ))}
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Target className="h-4 w-4" /> Signalen
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSignals}</div>
            <p className="text-xs text-muted-foreground">{stats.filled} filled</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <BarChart3 className="h-4 w-4" /> Win Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{stats.winRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">{stats.wins}W / {stats.losses}L</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" /> Net P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              ${stats.totalPnl.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">Avg: ${stats.avgPnl.toFixed(2)}/trade</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Zap className="h-4 w-4" /> Fill Latency
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatMs(stats.medianFillLatency)}</div>
            <p className="text-xs text-muted-foreground">Best: {formatMs(stats.fastestFill)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Activity className="h-4 w-4" /> Binance Δ
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${stats.avgBinanceChainlinkDelta.toFixed(0)}</div>
            <p className="text-xs text-muted-foreground">vs Chainlink avg</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Clock className="h-4 w-4" /> Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.sold}</div>
            <p className="text-xs text-muted-foreground">{stats.expired} expired</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="trades" className="space-y-4">
        <TabsList>
          <TabsTrigger value="trades">Trades</TabsTrigger>
          <TabsTrigger value="latency">Latency</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        {/* Trades Tab */}
        <TabsContent value="trades">
          <Card>
            <CardHeader>
              <CardTitle>Recent Signals & Trades</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Binance Δ</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Exit</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Fill Latency</TableHead>
                      <TableHead>P&L</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSignals.map((signal) => {
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
                          <TableCell className={signal.binance_delta > 0 ? 'text-green-400' : 'text-red-400'}>
                            ${signal.binance_delta?.toFixed(2) ?? '-'}
                          </TableCell>
                          <TableCell>{signal.entry_price ? `${(signal.entry_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                          <TableCell>{signal.exit_price ? `${(signal.exit_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                          <TableCell>{signal.shares?.toFixed(2) ?? '-'}</TableCell>
                          <TableCell className={fillLatency && fillLatency < 500 ? 'text-green-400' : ''}>
                            {fillLatency ? formatMs(fillLatency) : '-'}
                          </TableCell>
                          <TableCell className={`font-medium ${(signal.net_pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {signal.net_pnl !== null ? `$${signal.net_pnl.toFixed(2)}` : '-'}
                          </TableCell>
                          <TableCell>{getStatusBadge(signal.status)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Latency Tab */}
        <TabsContent value="latency">
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Fill Latency Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {['< 200ms', '200-500ms', '500ms-1s', '1-2s', '> 2s'].map((bucket, i) => {
                    const ranges = [[0, 200], [200, 500], [500, 1000], [1000, 2000], [2000, Infinity]];
                    const [min, max] = ranges[i];
                    const count = signals.filter(s => {
                      if (!s.fill_ts || !s.signal_ts) return false;
                      const latency = s.fill_ts - s.signal_ts;
                      return latency >= min && latency < max;
                    }).length;
                    const pct = signals.filter(s => s.fill_ts).length > 0 
                      ? (count / signals.filter(s => s.fill_ts).length) * 100 
                      : 0;
                    
                    return (
                      <div key={bucket} className="flex items-center gap-3">
                        <span className="text-sm w-20">{bucket}</span>
                        <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
                          <div 
                            className="h-full bg-primary transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-sm w-16 text-right">{count} ({pct.toFixed(0)}%)</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Binance-Chainlink Gap</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gemiddeld verschil</span>
                    <span className="font-bold">${stats.avgBinanceChainlinkDelta.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Geschatte latency</span>
                    <span className="font-bold">~{(stats.avgBinanceChainlinkDelta / 10).toFixed(1)}s</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Chainlink aggregeert prijzen van meerdere exchanges en update on-chain bij 0.5% deviation.
                    Dit verschil is geen pure latency, maar een combinatie van aggregatie en update-frequentie.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Logs Tab */}
        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>Real-time Bot Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[400px] font-mono text-xs">
                {recentLogs.length === 0 ? (
                  <p className="text-muted-foreground">Wachten op bot events...</p>
                ) : (
                  recentLogs.map((log, i) => (
                    <div key={i} className="py-1 border-b border-border/50">
                      {log}
                    </div>
                  ))
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
