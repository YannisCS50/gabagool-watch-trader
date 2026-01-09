import { useState } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, Clock, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useSubgraphSyncState, useSubgraphSync, useBotWallet } from '@/hooks/useSubgraphData';
import { formatDistanceToNow } from 'date-fns';

export function SubgraphSyncStatus() {
  const { data: wallet } = useBotWallet();
  const { data: syncState, isLoading } = useSubgraphSyncState(wallet ?? undefined);
  const syncMutation = useSubgraphSync();
  const [lastSyncResult, setLastSyncResult] = useState<string | null>(null);

  const handleSync = async () => {
    try {
      const result = await syncMutation.mutateAsync();
      setLastSyncResult(`Synced ${result?.fills_ingested ?? 0} fills, ${result?.positions_ingested ?? 0} positions`);
    } catch (error) {
      setLastSyncResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const latestSync = syncState?.[0];
  const lastSyncTime = latestSync?.last_sync_at;
  const recordsSynced = latestSync?.records_synced ?? 0;
  const errorsCount = latestSync?.errors_count ?? 0;

  const getSyncStatus = () => {
    if (!lastSyncTime) return { icon: XCircle, color: 'text-muted-foreground', label: 'Never synced' };
    
    const syncAge = Date.now() - new Date(lastSyncTime).getTime();
    const minutesAgo = syncAge / 60000;

    if (errorsCount > 0) {
      return { icon: AlertTriangle, color: 'text-yellow-500', label: 'Sync errors' };
    }
    if (minutesAgo < 5) {
      return { icon: CheckCircle2, color: 'text-green-500', label: 'Fresh' };
    }
    if (minutesAgo < 30) {
      return { icon: Clock, color: 'text-yellow-500', label: 'Stale' };
    }
    return { icon: XCircle, color: 'text-red-500', label: 'Outdated' };
  };

  const status = getSyncStatus();
  const StatusIcon = status.icon;

  return (
    <Card className="border-border/50">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">Subgraph Data</span>
                <Badge variant="outline" className={`text-xs ${status.color}`}>
                  <StatusIcon className="h-3 w-3 mr-1" />
                  {status.label}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {lastSyncTime ? (
                  <>
                    Last sync: {formatDistanceToNow(new Date(lastSyncTime), { addSuffix: true })}
                    {recordsSynced > 0 && ` • ${recordsSynced} records`}
                  </>
                ) : (
                  'No sync data available'
                )}
              </div>
              {lastSyncResult && (
                <div className="text-xs text-muted-foreground mt-1">{lastSyncResult}</div>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncMutation.isPending || isLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            Sync Now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
