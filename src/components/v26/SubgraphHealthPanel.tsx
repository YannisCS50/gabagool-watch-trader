import { useState } from 'react';
import { 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Database, 
  Wifi, 
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Info
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useSubgraphHealth, SubgraphHealthReport, EndpointHealth } from '@/hooks/useSubgraphHealth';
import { useSubgraphSync } from '@/hooks/useSubgraphData';
import { formatDistanceToNow } from 'date-fns';

function EndpointStatus({ name, health }: { name: string; health: EndpointHealth }) {
  const getStatusIcon = () => {
    if (health.probeResult === 'success' && health.lastSyncOk) {
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    }
    if (health.probeResult === 'failed' || !health.lastSyncOk) {
      return <XCircle className="h-4 w-4 text-red-500" />;
    }
    return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
  };

  return (
    <div className="flex items-start justify-between p-3 bg-muted/30 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          {getStatusIcon()}
          <span className="font-medium text-sm capitalize">{name}</span>
          <Badge variant="outline" className="text-xs">
            {health.probeResult === 'success' ? 'OK' : health.probeResult === 'failed' ? 'Failed' : 'Unknown'}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground mt-1 font-mono truncate max-w-[300px]">
          {health.endpoint}
        </div>
        {health.lastSyncAt && (
          <div className="text-xs text-muted-foreground mt-1">
            Last sync: {formatDistanceToNow(new Date(health.lastSyncAt), { addSuffix: true })}
          </div>
        )}
        {health.lastErrorMessage && (
          <div className="text-xs text-red-400 mt-1 truncate max-w-[300px]">
            Error: {health.lastErrorMessage}
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="text-sm font-mono">{health.lastResponseRowCount}</div>
        <div className="text-xs text-muted-foreground">rows</div>
      </div>
    </div>
  );
}

function DbCountRow({ table, count }: { table: string; count: number }) {
  const isError = count === -1;
  const isEmpty = count === 0;
  
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs font-mono text-muted-foreground">{table}</span>
      <Badge 
        variant={isError ? 'destructive' : isEmpty ? 'secondary' : 'outline'}
        className="text-xs"
      >
        {isError ? 'Error' : count.toLocaleString()}
      </Badge>
    </div>
  );
}

export function SubgraphHealthPanel() {
  const { data: health, isLoading, error, refetch } = useSubgraphHealth();
  const syncMutation = useSubgraphSync();
  const [isExpanded, setIsExpanded] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const handleSync = async () => {
    try {
      setSyncResult(null);
      const result = await syncMutation.mutateAsync();
      setSyncResult(`✓ Synced ${result?.fills_ingested ?? 0} fills, ${result?.positions_ingested ?? 0} positions`);
      refetch();
    } catch (err) {
      setSyncResult(`✗ Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  };

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading health status...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !health) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Health Check Failed</AlertTitle>
        <AlertDescription>
          {error instanceof Error ? error.message : 'Could not fetch health status'}
        </AlertDescription>
      </Alert>
    );
  }

  const hasIssues = health.diagnostics.walletMissing || 
    health.diagnostics.syncFailing || 
    health.diagnostics.noDataIngested ||
    health.diagnostics.rlsBlocking;

  const getOverallStatus = () => {
    if (health.diagnostics.walletMissing || health.diagnostics.rlsBlocking) {
      return { icon: XCircle, color: 'text-red-500', label: 'Critical', variant: 'destructive' as const };
    }
    if (health.diagnostics.syncFailing || health.diagnostics.noDataIngested) {
      return { icon: AlertTriangle, color: 'text-yellow-500', label: 'Warning', variant: 'secondary' as const };
    }
    if (health.diagnostics.syncNeverRun) {
      return { icon: Info, color: 'text-blue-500', label: 'Not Started', variant: 'outline' as const };
    }
    return { icon: CheckCircle2, color: 'text-green-500', label: 'Healthy', variant: 'outline' as const };
  };

  const status = getOverallStatus();
  const StatusIcon = status.icon;

  return (
    <Card className="border-border/50">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base font-medium">Subgraph Health</CardTitle>
              <Badge variant={status.variant} className={`${status.color}`}>
                <StatusIcon className="h-3 w-3 mr-1" />
                {status.label}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSync}
                disabled={syncMutation.isPending || health.diagnostics.walletMissing}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                Sync Now
              </Button>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-0">
          {/* Sync result message */}
          {syncResult && (
            <div className={`text-xs mb-3 p-2 rounded ${syncResult.startsWith('✓') ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
              {syncResult}
            </div>
          )}

          {/* Quick stats row */}
          <div className="grid grid-cols-4 gap-3 text-center">
            <div>
              <div className="text-lg font-bold">{health.dbCounts.subgraph_fills}</div>
              <div className="text-xs text-muted-foreground">Fills</div>
            </div>
            <div>
              <div className="text-lg font-bold">{health.dbCounts.subgraph_positions}</div>
              <div className="text-xs text-muted-foreground">Positions</div>
            </div>
            <div>
              <div className="text-lg font-bold">{health.dbCounts.subgraph_pnl_markets}</div>
              <div className="text-xs text-muted-foreground">Markets</div>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1">
                <Wifi className={`h-4 w-4 ${health.endpoints.activity.probeResult === 'success' ? 'text-green-500' : 'text-red-500'}`} />
              </div>
              <div className="text-xs text-muted-foreground">API</div>
            </div>
          </div>

          {/* Recommendations alert */}
          {hasIssues && health.recommendations.length > 0 && (
            <Alert className="mt-3" variant={health.diagnostics.walletMissing ? 'destructive' : 'default'}>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                {health.recommendations[0]}
              </AlertDescription>
            </Alert>
          )}

          <CollapsibleContent className="mt-4 space-y-4">
            {/* Wallet info */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="text-xs font-medium mb-2">Wallet Configuration</div>
              {health.wallet.configured ? (
                <div className="text-xs font-mono text-muted-foreground break-all">
                  {health.wallet.address}
                </div>
              ) : (
                <div className="text-xs text-red-400">
                  No wallet configured in bot_config
                </div>
              )}
            </div>

            {/* Endpoint statuses */}
            <div className="space-y-2">
              <div className="text-xs font-medium">API Endpoints</div>
              <EndpointStatus name="Activity (Fills)" health={health.endpoints.activity} />
              <EndpointStatus name="Positions" health={health.endpoints.positions} />
            </div>

            {/* DB counts */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="text-xs font-medium mb-2">Database Tables</div>
              <DbCountRow table="subgraph_fills" count={health.dbCounts.subgraph_fills} />
              <DbCountRow table="subgraph_positions" count={health.dbCounts.subgraph_positions} />
              <DbCountRow table="subgraph_pnl_markets" count={health.dbCounts.subgraph_pnl_markets} />
              <DbCountRow table="subgraph_sync_state" count={health.dbCounts.subgraph_sync_state} />
            </div>

            {/* All recommendations */}
            {health.recommendations.length > 0 && (
              <div className="p-3 bg-yellow-500/10 rounded-lg">
                <div className="text-xs font-medium text-yellow-500 mb-2">Recommendations</div>
                <ul className="text-xs text-muted-foreground space-y-1">
                  {health.recommendations.map((rec, i) => (
                    <li key={i}>• {rec}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Diagnostics flags */}
            <div className="flex flex-wrap gap-2">
              {Object.entries(health.diagnostics).map(([key, value]) => (
                <Badge 
                  key={key} 
                  variant={value ? 'destructive' : 'outline'}
                  className="text-xs"
                >
                  {key.replace(/([A-Z])/g, ' $1').trim()}: {value ? 'Yes' : 'No'}
                </Badge>
              ))}
            </div>
          </CollapsibleContent>
        </CardContent>
      </Collapsible>
    </Card>
  );
}
