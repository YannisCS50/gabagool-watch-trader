import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, TrendingDown, Activity, Zap } from 'lucide-react';
import type { V30Stats } from '@/hooks/useV30Data';

interface Props {
  stats: V30Stats;
}

export function V30StatsCards({ stats }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
