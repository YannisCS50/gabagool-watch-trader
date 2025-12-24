import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { Activity, Server, Clock, TrendingUp, Wallet, RefreshCw } from 'lucide-react';

interface RunnerHeartbeat {
  id: string;
  runner_id: string;
  runner_type: string;
  last_heartbeat: string;
  status: string;
  markets_count: number;
  positions_count: number;
  trades_count: number;
  balance: number;
  ip_address: string | null;
  version: string;
}

export function RunnerStatus() {
  const [runners, setRunners] = useState<RunnerHeartbeat[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchRunners = async () => {
    const { data } = await supabase
      .from('runner_heartbeats' as any)
      .select('*')
      .order('last_heartbeat', { ascending: false });
    
    if (data) {
      setRunners(data as unknown as RunnerHeartbeat[]);
    }
    setIsLoading(false);
  };

  useEffect(() => {
    fetchRunners();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('runner-heartbeats')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'runner_heartbeats' },
        () => fetchRunners()
      )
      .subscribe();

    // Refresh every 10 seconds to update "ago" times
    const interval = setInterval(fetchRunners, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const getTimeSince = (timestamp: string): { text: string; isStale: boolean } => {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    // Consider stale if > 30 seconds
    const isStale = diffSec > 30;

    if (diffSec < 10) return { text: 'Just now', isStale };
    if (diffSec < 60) return { text: `${diffSec}s ago`, isStale };
    if (diffMin < 60) return { text: `${diffMin}m ago`, isStale };
    return { text: `${diffHour}h ago`, isStale };
  };

  const getStatusColor = (runner: RunnerHeartbeat): string => {
    const { isStale } = getTimeSince(runner.last_heartbeat);
    if (isStale) return 'bg-destructive/20 text-destructive';
    if (runner.status === 'active') return 'bg-green-500/20 text-green-400';
    return 'bg-yellow-500/20 text-yellow-400';
  };

  const getStatusText = (runner: RunnerHeartbeat): string => {
    const { isStale } = getTimeSince(runner.last_heartbeat);
    if (isStale) return 'Offline';
    return runner.status === 'active' ? 'Online' : runner.status;
  };

  if (isLoading) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="h-4 w-4" />
            Local Runner Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Loading...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (runners.length === 0) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Server className="h-4 w-4" />
            Local Runner Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <p className="text-muted-foreground text-sm">No runner connected</p>
            <p className="text-xs text-muted-foreground mt-1">
              Start the local runner with <code className="bg-muted px-1 rounded">npm start</code>
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Server className="h-4 w-4" />
          Local Runner Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {runners.map((runner) => {
          const { text: timeAgo, isStale } = getTimeSince(runner.last_heartbeat);
          
          return (
            <div key={runner.id} className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isStale ? 'bg-destructive' : 'bg-green-500 animate-pulse'}`} />
                  <span className="font-medium text-sm">{runner.runner_id}</span>
                  <Badge variant="outline" className="text-xs">
                    v{runner.version}
                  </Badge>
                </div>
                <Badge className={getStatusColor(runner)}>
                  {getStatusText(runner)}
                </Badge>
              </div>
              
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{timeAgo}</span>
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  <span>{runner.markets_count} markets</span>
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <TrendingUp className="h-3 w-3" />
                  <span>{runner.trades_count} trades</span>
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Wallet className="h-3 w-3" />
                  <span>${runner.balance?.toFixed(2) || '0.00'}</span>
                </div>
              </div>

              {runner.ip_address && (
                <div className="text-xs text-muted-foreground">
                  IP: {runner.ip_address}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
