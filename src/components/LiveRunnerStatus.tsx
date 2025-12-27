import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { formatUsdcFromBaseUnits } from '@/lib/utils';
import { Activity, DollarSign, TrendingUp, TrendingDown, Clock, Cpu, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface RunnerHeartbeat {
  runner_id: string;
  status: string;
  last_heartbeat: string;
  balance: number | null;
  markets_count: number | null;
  positions_count: number | null;
  trades_count: number | null;
  version: string | null;
}

interface LiveTrade {
  id: string;
  market_slug: string;
  asset: string;
  outcome: string;
  shares: number;
  price: number;
  total: number;
  created_at: string;
  status: string | null;
}

interface Position {
  market_slug: string;
  asset: string;
  upShares: number;
  downShares: number;
  upInvested: number;
  downInvested: number;
  combinedEntry: number;
  potentialProfit: number;
}

export function LiveRunnerStatus() {
  const [heartbeat, setHeartbeat] = useState<RunnerHeartbeat | null>(null);
  const [recentTrades, setRecentTrades] = useState<LiveTrade[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingOrders, setPendingOrders] = useState(0);

  const fetchData = async () => {
    // Fetch runner heartbeat
    const { data: hbData } = await supabase
      .from('runner_heartbeats')
      .select('*')
      .eq('runner_type', 'local')
      .order('last_heartbeat', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (hbData) {
      setHeartbeat(hbData as RunnerHeartbeat);
    }

    // Fetch recent live trades (last 24h)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: tradesData } = await supabase
      .from('live_trades')
      .select('*')
      .gte('created_at', yesterday)
      .order('created_at', { ascending: false })
      .limit(50);

    if (tradesData) {
      setRecentTrades(tradesData as LiveTrade[]);

      // Calculate positions from trades
      const posMap = new Map<string, Position>();
      tradesData.forEach((t: LiveTrade) => {
        if (!posMap.has(t.market_slug)) {
          posMap.set(t.market_slug, {
            market_slug: t.market_slug,
            asset: t.asset,
            upShares: 0,
            downShares: 0,
            upInvested: 0,
            downInvested: 0,
            combinedEntry: 0,
            potentialProfit: 0,
          });
        }
        const pos = posMap.get(t.market_slug)!;
        if (t.outcome === 'UP') {
          pos.upShares += t.shares;
          pos.upInvested += t.total;
        } else {
          pos.downShares += t.shares;
          pos.downInvested += t.total;
        }
      });

      // Calculate combined entry and potential profit
      posMap.forEach(pos => {
        if (pos.upShares > 0 && pos.downShares > 0) {
          const avgUp = pos.upInvested / pos.upShares;
          const avgDown = pos.downInvested / pos.downShares;
          pos.combinedEntry = avgUp + avgDown;
          const minShares = Math.min(pos.upShares, pos.downShares);
          pos.potentialProfit = minShares - (pos.upInvested + pos.downInvested);
        }
      });

      setPositions(Array.from(posMap.values()).filter(p => p.upShares > 0 || p.downShares > 0));
    }

    // Count pending orders
    const { count } = await supabase
      .from('order_queue')
      .select('*', { count: 'exact', head: true })
      .in('status', ['pending', 'processing']);

    setPendingOrders(count || 0);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchData();

    // Set up realtime subscription
    const channel = supabase
      .channel('runner-status-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'runner_heartbeats' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_trades' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_queue' }, fetchData)
      .subscribe();

    // Refresh every 10 seconds
    const interval = setInterval(fetchData, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const isOnline = heartbeat && 
    new Date(heartbeat.last_heartbeat).getTime() > Date.now() - 60000;

  const totalInvested = positions.reduce((sum, p) => sum + p.upInvested + p.downInvested, 0);
  const totalPotentialProfit = positions.reduce((sum, p) => sum + p.potentialProfit, 0);

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-6 flex items-center justify-center">
          <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50 bg-gradient-to-br from-card to-card/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-primary" />
            Live Runner Status
          </div>
          <Badge 
            variant={isOnline ? 'default' : 'destructive'} 
            className={isOnline ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : ''}
          >
            {isOnline ? (
              <>
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Online
              </>
            ) : (
              <>
                <AlertCircle className="w-3 h-3 mr-1" />
                Offline
              </>
            )}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-background/50 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DollarSign className="w-3 h-3" />
              Balance
            </div>
            <div className="text-lg font-mono font-semibold">
              {formatUsdcFromBaseUnits(heartbeat?.balance)}
            </div>
          </div>
          <div className="bg-background/50 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Activity className="w-3 h-3" />
              Positions
            </div>
            <div className="text-lg font-mono font-semibold">
              {positions.length}
            </div>
          </div>
          <div className="bg-background/50 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendingUp className="w-3 h-3" />
              Trades (24h)
            </div>
            <div className="text-lg font-mono font-semibold">
              {recentTrades.length}
            </div>
          </div>
          <div className="bg-background/50 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              Pending
            </div>
            <div className="text-lg font-mono font-semibold">
              {pendingOrders}
            </div>
          </div>
        </div>

        {/* Invested & Profit Summary */}
        {positions.length > 0 && (
          <div className="bg-background/50 rounded-lg p-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total Invested</span>
              <span className="font-mono">${totalInvested.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Est. Profit (if hedged)</span>
              <span className={`font-mono ${totalPotentialProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalPotentialProfit >= 0 ? '+' : ''}${totalPotentialProfit.toFixed(2)}
              </span>
            </div>
          </div>
        )}

        {/* Open Positions */}
        {positions.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Open Positions
            </div>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {positions.map(pos => (
                <div key={pos.market_slug} className="bg-background/50 rounded-lg p-2 text-xs">
                  <div className="flex justify-between items-center mb-1">
                    <Badge variant="outline" className="text-[10px]">{pos.asset}</Badge>
                    <span className="text-muted-foreground font-mono">
                      {pos.market_slug.slice(-20)}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-muted-foreground">
                    <div>
                      <TrendingUp className="w-3 h-3 inline mr-1 text-emerald-400" />
                      {pos.upShares.toFixed(0)} @ ${pos.upShares > 0 ? (pos.upInvested / pos.upShares).toFixed(2) : '0'}
                    </div>
                    <div>
                      <TrendingDown className="w-3 h-3 inline mr-1 text-red-400" />
                      {pos.downShares.toFixed(0)} @ ${pos.downShares > 0 ? (pos.downInvested / pos.downShares).toFixed(2) : '0'}
                    </div>
                    <div className="text-right">
                      <span className={pos.potentialProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {pos.potentialProfit >= 0 ? '+' : ''}${pos.potentialProfit.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Last Heartbeat */}
        {heartbeat && (
          <div className="text-xs text-muted-foreground text-center pt-2 border-t border-border/50">
            Last seen: {formatDistanceToNow(new Date(heartbeat.last_heartbeat))} ago
            {heartbeat.version && <span className="ml-2">• v{heartbeat.version}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
