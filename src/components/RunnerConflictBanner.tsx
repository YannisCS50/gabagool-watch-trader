import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Server, Clock } from 'lucide-react';
import { useRunnerLease } from '@/hooks/useRunnerLease';
import { formatDistanceToNow } from 'date-fns';

export function RunnerConflictBanner() {
  const { hasConflict, activeRunners, leaseHolder, leaseExpires, leaseExpired, isLoading } = useRunnerLease();

  if (isLoading) return null;

  // No conflict, don't show anything
  if (!hasConflict) return null;

  return (
    <Alert variant="destructive" className="mb-6 border-2">
      <AlertTriangle className="h-5 w-5" />
      <AlertTitle className="text-lg font-bold flex items-center gap-2">
        ⚠️ RUNNER CONFLICT DETECTED
        <Badge variant="destructive" className="animate-pulse">
          {activeRunners.length} RUNNERS ACTIVE
        </Badge>
      </AlertTitle>
      <AlertDescription className="mt-3 space-y-3">
        <p className="text-sm">
          <strong>Meerdere runners zijn actief!</strong> Dit kan dubbele/conflicterende trades veroorzaken.
          Alleen de runner met de lease mag traden - stop de andere runners.
        </p>

        <div className="grid gap-2 mt-4">
          <p className="text-xs font-medium uppercase text-muted-foreground">Actieve Runners:</p>
          {activeRunners.map((runner) => (
            <div
              key={runner.runner_id}
              className={`flex items-center justify-between p-2 rounded text-sm ${
                runner.runner_id === leaseHolder
                  ? 'bg-green-500/10 border border-green-500/30'
                  : 'bg-destructive/10 border border-destructive/30'
              }`}
            >
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4" />
                <span className="font-mono">{runner.runner_id}</span>
                {runner.version && (
                  <Badge variant="outline" className="text-xs">
                    v{runner.version}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatDistanceToNow(new Date(runner.last_heartbeat), { addSuffix: true })}
                {runner.runner_id === leaseHolder && (
                  <Badge variant="default" className="ml-2 bg-green-600">
                    LEASE HOLDER
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>

        {leaseHolder && leaseExpires && (
          <div className="mt-3 p-2 bg-muted/50 rounded text-xs">
            <strong>Lease:</strong> {leaseHolder} tot{' '}
            {leaseExpires.toLocaleTimeString('nl-NL')}
            {leaseExpired && (
              <Badge variant="secondary" className="ml-2">
                EXPIRED
              </Badge>
            )}
          </div>
        )}

        <div className="mt-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm">
          <strong>Oplossing:</strong>
          <ol className="list-decimal list-inside mt-1 space-y-1">
            <li>Stop alle runners behalve één (Ctrl+C of kill het proces)</li>
            <li>Wacht ~60 seconden tot de lease vrijkomt</li>
            <li>Start de runner die je wilt gebruiken (met nieuwste versie)</li>
          </ol>
        </div>
      </AlertDescription>
    </Alert>
  );
}
