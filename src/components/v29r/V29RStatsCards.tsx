import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Target, Clock, DollarSign, XCircle, CheckCircle } from 'lucide-react';
import { V29RStats } from '@/hooks/useV29ResponseData';

interface Props {
  stats: V29RStats;
  lastUpdate: Date;
  isConnected: boolean;
}

export function V29RStatsCards({ stats, lastUpdate, isConnected }: Props) {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('nl-NL', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
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
            {stats.filledSignals} filled / {stats.skippedSignals} skipped
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Win Rate</p>
              <p className={`text-2xl font-bold ${stats.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                {stats.winRate.toFixed(1)}%
              </p>
            </div>
            <Target className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            on {stats.filledSignals} trades
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
            ${stats.avgPnlPerTrade.toFixed(3)}/trade
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Avg Hold</p>
              <p className="text-2xl font-bold">
                {(stats.avgHoldTimeMs / 1000).toFixed(1)}s
              </p>
            </div>
            <Clock className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            response-based exits
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Target Exits</p>
              <p className="text-2xl font-bold text-green-500">
                {stats.exitReasonDistribution['TARGET_REACHED'] || 0}
              </p>
            </div>
            <CheckCircle className="h-8 w-8 text-green-500/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            profit target hit
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Time Stops</p>
              <p className="text-2xl font-bold text-orange-500">
                {stats.exitReasonDistribution['HARD_TIME_STOP'] || 0}
              </p>
            </div>
            <XCircle className="h-8 w-8 text-orange-500/50" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {isConnected ? `Updated ${formatTime(lastUpdate)}` : 'Connecting...'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
