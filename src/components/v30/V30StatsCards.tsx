import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Activity, Zap, Clock } from 'lucide-react';
import type { V30Stats } from '@/hooks/useV30Data';
import { formatDistanceToNow } from 'date-fns';

interface Props {
  stats: V30Stats;
  lastUpdate?: number;
  isConnected?: boolean;
}

export function V30StatsCards({ stats, lastUpdate, isConnected }: Props) {
  const [now, setNow] = useState(Date.now());
  
  // Update every second for "last update" display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const lastTickAge = stats.lastTickTs ? Math.floor((now - stats.lastTickTs) / 1000) : null;
  const isLive = lastTickAge !== null && lastTickAge < 10;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {/* Connection Status */}
      <Card className={isLive ? 'border-green-500/50' : 'border-yellow-500/50'}>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
            <span className="text-sm text-muted-foreground">Status</span>
          </div>
          <div className={`text-lg font-bold mt-1 ${isLive ? 'text-green-400' : 'text-yellow-400'}`}>
            {isLive ? 'LIVE' : 'STALE'}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {lastTickAge !== null ? `${lastTickAge}s ago` : 'No data'}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-400" />
            <span className="text-sm text-muted-foreground">Buys UP</span>
          </div>
          <div className="text-2xl font-bold mt-1">{stats.buysUp}</div>
          <div className="text-xs text-muted-foreground">
            Avg edge: {(stats.avgEdgeUp * 100).toFixed(2)}%
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-red-400" />
            <span className="text-sm text-muted-foreground">Buys DOWN</span>
          </div>
          <div className="text-2xl font-bold mt-1">{stats.buysDown}</div>
          <div className="text-xs text-muted-foreground">
            Avg edge: {(stats.avgEdgeDown * 100).toFixed(2)}%
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-yellow-400" />
            <span className="text-sm text-muted-foreground">Force Counters</span>
          </div>
          <div className="text-2xl font-bold mt-1">{stats.forceCounters}</div>
          <div className="text-xs text-muted-foreground">
            Inventory balancing
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-400" />
            <span className="text-sm text-muted-foreground">Ticks Logged</span>
          </div>
          <div className="text-2xl font-bold mt-1">{stats.totalTicks}</div>
          <div className="text-xs text-muted-foreground">
            {stats.aggressiveExits} aggressive exits
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
