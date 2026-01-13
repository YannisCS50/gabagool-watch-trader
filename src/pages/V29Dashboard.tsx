import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, TrendingUp, TrendingDown, DollarSign, Zap, Clock, 
  Activity, Wifi, WifiOff, RefreshCw, Target, Settings2
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
import { V29ConfigEditor } from '@/components/v29/V29ConfigEditor';

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

const ASSETS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'] as const;

export default function V29Dashboard() {
  const navigate = useNavigate();
  const [signals, setSignals] = useState<V29Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [assetFilter, setAssetFilter] = useState<typeof ASSETS[number]>('ALL');
  const [activeTab, setActiveTab] = useState('signals');
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

    const [signalsRes, heartbeatRes] = await Promise.all([
      supabase
        .from('v29_signals')
        .select('*')
        .order('signal_ts', { ascending: false })
        .limit(200),
      supabase
        .from('runner_heartbeats')
        .select('*')
        .ilike('runner_id', 'v29%')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    if (signalsRes.data) setSignals(signalsRes.data as unknown as V29Signal[]);

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
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to realtime signals
  useEffect(() => {
    const channel = supabase
      .channel('v29-signals-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'v29_signals' },
        () => fetchData()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const filteredSignals = useMemo(() => {
    if (assetFilter === 'ALL') return signals;
    return signals.filter(s => s.asset === assetFilter);
  }, [signals, assetFilter]);

  const stats = useMemo(() => {
    const sold = filteredSignals.filter(s => s.status === 'sold');
    const wins = sold.filter(s => (s.net_pnl ?? 0) > 0);
    const totalPnl = sold.reduce((sum, s) => sum + (s.net_pnl ?? 0), 0);
    
    return {
      total: filteredSignals.length,
      open: filteredSignals.filter(s => s.status === 'filled' || s.status === 'open').length,
      sold: sold.length,
      wins: wins.length,
      losses: sold.length - wins.length,
      winRate: sold.length > 0 ? (wins.length / sold.length) * 100 : 0,
      totalPnl,
    };
  }, [filteredSignals]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'sold':
        return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">SOLD</Badge>;
      case 'filled':
      case 'open':
        return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">OPEN</Badge>;
      case 'pending':
        return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">PENDING</Badge>;
      case 'failed':
        return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">FAILED</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
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

        {/* Status row */}
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

          <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="h-8">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline ml-1">Refresh</span>
          </Button>
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

      {/* Stats Summary */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary" className="font-normal">
          {stats.total} signalen
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {stats.open} open / {stats.sold} sold
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {stats.wins}W / {stats.losses}L ({stats.winRate.toFixed(0)}%)
        </Badge>
        <Badge variant={stats.totalPnl >= 0 ? "default" : "destructive"} className="font-normal">
          {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} P&L
        </Badge>
      </div>

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="signals" className="gap-2">
            <Activity className="h-4 w-4" />
            Signals
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-2">
            <Settings2 className="h-4 w-4" />
            Config
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signals">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4" />
                V29 Signals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tijd</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Dir</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Exit</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredSignals.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                          Nog geen V29 signals. Start de runner om te beginnen.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSignals.map(signal => (
                        <TableRow key={signal.id}>
                          <TableCell className="text-xs">
                            {format(new Date(signal.signal_ts), 'HH:mm:ss')}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{signal.asset}</Badge>
                          </TableCell>
                          <TableCell>
                            {signal.direction === 'UP' ? (
                              <Badge className="bg-green-500/20 text-green-400">
                                <TrendingUp className="h-3 w-3 mr-1" />
                                UP
                              </Badge>
                            ) : (
                              <Badge className="bg-red-500/20 text-red-400">
                                <TrendingDown className="h-3 w-3 mr-1" />
                                DOWN
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            ${signal.delta_usd?.toFixed(2) ?? '-'}
                          </TableCell>
                          <TableCell className="text-xs">
                            {signal.entry_price ? `${(signal.entry_price * 100).toFixed(1)}¢` : '-'}
                          </TableCell>
                          <TableCell className="text-xs">
                            {signal.exit_price ? `${(signal.exit_price * 100).toFixed(1)}¢` : '-'}
                            {signal.exit_reason && (
                              <span className="text-muted-foreground ml-1">({signal.exit_reason})</span>
                            )}
                          </TableCell>
                          <TableCell>{getStatusBadge(signal.status)}</TableCell>
                          <TableCell className="text-right">
                            {signal.net_pnl !== null ? (
                              <span className={signal.net_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                                {signal.net_pnl >= 0 ? '+' : ''}${signal.net_pnl.toFixed(3)}
                              </span>
                            ) : '-'}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config">
          <V29ConfigEditor />
        </TabsContent>
      </Tabs>
    </div>
  );
}
