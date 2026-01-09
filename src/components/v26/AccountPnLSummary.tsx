import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAccountPnlSummary, useIngestState } from '@/hooks/useDailyPnl';
import { Loader2, TrendingUp, TrendingDown, Calendar, Activity, CheckCircle, XCircle, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';

interface AccountPnLSummaryProps {
  wallet: string;
}

export function AccountPnLSummary({ wallet }: AccountPnLSummaryProps) {
  const { data: summary, isLoading: summaryLoading } = useAccountPnlSummary(wallet);
  const { data: ingestState, isLoading: stateLoading } = useIngestState(wallet);

  const isLoading = summaryLoading || stateLoading;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-[200px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card>
        <CardContent className="text-center text-muted-foreground py-8">
          No account data. Run the reducer to ingest history.
        </CardContent>
      </Card>
    );
  }

  const totalPnl = summary.total_realized_pnl || 0;
  const isPositive = totalPnl >= 0;

  return (
    <div className="space-y-4">
      {/* Main PnL Card */}
      <Card className={`border-2 ${isPositive ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total Lifetime PnL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className={`text-4xl font-bold flex items-center gap-2 ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
            {isPositive ? <TrendingUp className="h-8 w-8" /> : <TrendingDown className="h-8 w-8" />}
            ${Math.abs(totalPnl).toFixed(2)}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Based on {summary.total_trades || 0} trades across {summary.total_markets || 0} markets
          </p>
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Activity className="h-3 w-3" />
              Total Volume
            </div>
            <div className="text-lg font-semibold">
              ${(summary.total_volume || 0).toFixed(2)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              Claimed Markets
            </div>
            <div className="text-lg font-semibold text-green-500">
              {summary.claimed_markets || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <XCircle className="h-3 w-3 text-red-500" />
              Lost Markets
            </div>
            <div className="text-lg font-semibold text-red-500">
              {summary.lost_markets || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Clock className="h-3 w-3 text-blue-500" />
              Open Markets
            </div>
            <div className="text-lg font-semibold text-blue-500">
              {summary.open_markets || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Ingest Status */}
      {ingestState && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Historical Data Coverage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">First Trade:</span>
                <div className="font-medium">
                  {ingestState.oldest_event_ts 
                    ? format(new Date(ingestState.oldest_event_ts), 'MMM d, yyyy')
                    : '-'}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Last Trade:</span>
                <div className="font-medium">
                  {ingestState.newest_event_ts 
                    ? format(new Date(ingestState.newest_event_ts), 'MMM d, yyyy')
                    : '-'}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Events Ingested:</span>
                <div className="font-medium">{ingestState.total_events_ingested || 0}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Status:</span>
                <div>
                  {ingestState.is_complete ? (
                    <Badge variant="outline" className="bg-green-500/10 text-green-500 border-green-500/20">
                      Complete
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                      Partial
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            {ingestState.last_sync_at && (
              <p className="text-xs text-muted-foreground mt-3">
                Last synced: {format(new Date(ingestState.last_sync_at), 'MMM d, yyyy HH:mm')}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
