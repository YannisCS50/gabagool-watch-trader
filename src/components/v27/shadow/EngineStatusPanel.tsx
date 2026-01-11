import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Activity, Wifi, WifiOff, Gauge, Clock, AlertTriangle, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import type { EngineStatus, EngineState } from '@/hooks/useShadowDashboard';

interface EngineStatusPanelProps {
  status: EngineStatus;
}

const STATE_CONFIG: Record<EngineState, { color: string; bg: string; label: string }> = {
  COLD: { color: 'text-blue-400', bg: 'bg-blue-500/20', label: 'Scanning 1s intervals' },
  WARM: { color: 'text-amber-400', bg: 'bg-amber-500/20', label: 'Near-signal 500ms' },
  HOT: { color: 'text-red-400', bg: 'bg-red-500/20', label: 'Hot signal 250ms' },
};

export function EngineStatusPanel({ status }: EngineStatusPanelProps) {
  const stateConfig = STATE_CONFIG[status.state];
  
  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Shadow Engine Status
          </div>
          <div className="flex items-center gap-2">
            {status.isOnline ? (
              <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                <Wifi className="h-3 w-3 mr-1" />
                Online
              </Badge>
            ) : (
              <Badge variant="destructive">
                <WifiOff className="h-3 w-3 mr-1" />
                Offline
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* Engine State */}
          <div className={`p-4 rounded-lg ${stateConfig.bg}`}>
            <div className="flex items-center gap-2 mb-2">
              <Zap className={`h-4 w-4 ${stateConfig.color}`} />
              <span className="text-sm font-medium">Engine State</span>
            </div>
            <div className={`text-2xl font-bold ${stateConfig.color}`}>
              {status.state}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {stateConfig.label}
            </p>
          </div>

          {/* Cadence */}
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-2">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Cadence</span>
            </div>
            <div className="text-2xl font-bold">
              {status.cadenceMs}ms
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {status.marketsScanned} markets scanned
            </p>
          </div>

          {/* WebSocket Latency */}
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">WS Latency</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Spot:</span>
                <span className={status.spotWsLatencyMs < 100 ? 'text-green-400' : 'text-amber-400'}>
                  {status.spotWsLatencyMs.toFixed(0)}ms
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Poly:</span>
                <span className={status.polyWsLatencyMs < 150 ? 'text-green-400' : 'text-amber-400'}>
                  {status.polyWsLatencyMs.toFixed(0)}ms
                </span>
              </div>
            </div>
          </div>

          {/* Last Event / Errors */}
          <div className="p-4 rounded-lg bg-muted/30">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Health</span>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Last event:</span>
                <span className={status.lastEventAgeMs < 5000 ? 'text-green-400' : 'text-amber-400'}>
                  {status.lastEventAgeMs < 1000 
                    ? `${status.lastEventAgeMs.toFixed(0)}ms ago`
                    : `${(status.lastEventAgeMs / 1000).toFixed(1)}s ago`
                  }
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Errors:</span>
                <span className={status.errorCount === 0 ? 'text-green-400' : 'text-red-400'}>
                  {status.errorCount}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Last Heartbeat */}
        {status.lastHeartbeat && (
          <div className="mt-4 pt-4 border-t flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Last heartbeat: {formatDistanceToNow(new Date(status.lastHeartbeat), { addSuffix: true, locale: nl })}
            </span>
            {status.version && (
              <Badge variant="outline" className="text-xs">
                {status.version}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
