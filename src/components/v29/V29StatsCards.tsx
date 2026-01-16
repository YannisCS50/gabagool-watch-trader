import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Target, Clock, DollarSign } from 'lucide-react';
import { V29Stats } from '@/hooks/useV29Data';

interface Props {
  stats: V29Stats;
  lastUpdate: Date;
  isConnected: boolean;
}

export function V29StatsCards({ stats, lastUpdate, isConnected }: Props) {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('nl-NL', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Total Signals</p>
              <p className="text-2xl font-bold">{stats.totalSignals}</p>
            </div>
            <TrendingUp className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.buyCount} filled
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Unpaired</p>
              <p className="text-2xl font-bold text-orange-500">{stats.unpairedPositions}</p>
            </div>
            <Target className="h-8 w-8 text-orange-500/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            waiting for hedge
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Hedged</p>
              <p className="text-2xl font-bold text-green-500">{stats.pairedPositions}</p>
            </div>
            <Target className="h-8 w-8 text-green-500/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            profit locked
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Total P&L</p>
              <p className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                ${stats.totalPnl.toFixed(2)}
              </p>
            </div>
            <DollarSign className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {isConnected ? `Updated ${formatTime(lastUpdate)}` : 'Connecting...'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
