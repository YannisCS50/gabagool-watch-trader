import { CheckCircle2, AlertTriangle, XCircle, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useSubgraphReconciliation, useBotWallet, ReconciliationEvent } from '@/hooks/useSubgraphData';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';

const severityConfig = {
  OK: { icon: CheckCircle2, color: 'text-green-500 border-green-500/30', bg: 'bg-green-500/10' },
  DRIFT: { icon: AlertTriangle, color: 'text-yellow-500 border-yellow-500/30', bg: 'bg-yellow-500/10' },
  UNKNOWN: { icon: XCircle, color: 'text-red-500 border-red-500/30', bg: 'bg-red-500/10' },
};

export function SubgraphReconciliationPanel() {
  const { data: wallet } = useBotWallet();
  const { data: events, isLoading } = useSubgraphReconciliation(wallet ?? undefined);

  const handleExportCSV = () => {
    if (!events || events.length === 0) return;

    const headers = [
      'timestamp',
      'market_id',
      'subgraph_up',
      'subgraph_down',
      'local_up',
      'local_down',
      'delta_up',
      'delta_down',
      'severity',
      'status'
    ];

    const rows = events.map(e => [
      e.timestamp,
      e.market_id ?? '',
      e.subgraph_shares_up ?? '',
      e.subgraph_shares_down ?? '',
      e.local_shares_up ?? '',
      e.local_shares_down ?? '',
      e.delta_shares_up ?? '',
      e.delta_shares_down ?? '',
      e.severity,
      e.status
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="text-lg">Reconciliation Status</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32" />
        </CardContent>
      </Card>
    );
  }

  const driftEvents = events?.filter(e => e.severity === 'DRIFT') ?? [];
  const unknownEvents = events?.filter(e => e.severity === 'UNKNOWN') ?? [];
  const okEvents = events?.filter(e => e.severity === 'OK') ?? [];

  const getStatusBanner = () => {
    if (unknownEvents.length > 0) {
      return {
        icon: XCircle,
        color: 'text-red-500',
        bg: 'bg-red-500/10 border-red-500/30',
        message: `${unknownEvents.length} unknown positions - subgraph may be stale`,
      };
    }
    if (driftEvents.length > 0) {
      return {
        icon: AlertTriangle,
        color: 'text-yellow-500',
        bg: 'bg-yellow-500/10 border-yellow-500/30',
        message: `${driftEvents.length} position drift(s) detected`,
      };
    }
    return {
      icon: CheckCircle2,
      color: 'text-green-500',
      bg: 'bg-green-500/10 border-green-500/30',
      message: 'All positions reconciled - no drift',
    };
  };

  const banner = getStatusBanner();
  const BannerIcon = banner.icon;

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Reconciliation Status</CardTitle>
            <CardDescription className="text-xs mt-1">
              Comparing subgraph positions vs local state
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={!events || events.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Status Banner */}
        <div className={`flex items-center gap-3 p-3 rounded-lg border ${banner.bg} mb-4`}>
          <BannerIcon className={`h-5 w-5 ${banner.color}`} />
          <span className={`font-medium ${banner.color}`}>{banner.message}</span>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-green-500">{okEvents.length}</div>
            <div className="text-xs text-muted-foreground">OK</div>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-yellow-500">{driftEvents.length}</div>
            <div className="text-xs text-muted-foreground">Drift</div>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold text-red-500">{unknownEvents.length}</div>
            <div className="text-xs text-muted-foreground">Unknown</div>
          </div>
        </div>

        {/* Drift Events Table */}
        {(driftEvents.length > 0 || unknownEvents.length > 0) && (
          <div className="border-t border-border/50 pt-4">
            <div className="text-sm font-medium mb-3">Issues</div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border/50">
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs">Market</TableHead>
                    <TableHead className="text-xs text-right">Subgraph ↑</TableHead>
                    <TableHead className="text-xs text-right">Subgraph ↓</TableHead>
                    <TableHead className="text-xs text-right">Delta ↑</TableHead>
                    <TableHead className="text-xs text-right">Delta ↓</TableHead>
                    <TableHead className="text-xs">Severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...driftEvents, ...unknownEvents].slice(0, 10).map((event) => {
                    const config = severityConfig[event.severity];
                    const Icon = config.icon;
                    return (
                      <TableRow key={event.id} className="hover:bg-muted/50 border-border/30">
                        <TableCell className="py-2 text-xs text-muted-foreground">
                          {format(new Date(event.timestamp), 'MMM d, HH:mm')}
                        </TableCell>
                        <TableCell className="py-2 text-xs">
                          {event.market_id?.slice(0, 12) ?? '—'}...
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {event.subgraph_shares_up?.toFixed(2) ?? '—'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {event.subgraph_shares_down?.toFixed(2) ?? '—'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {event.delta_shares_up !== null ? (
                            <span className={event.delta_shares_up !== 0 ? 'text-yellow-500' : ''}>
                              {event.delta_shares_up > 0 ? '+' : ''}{event.delta_shares_up.toFixed(2)}
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="py-2 text-right font-mono text-xs">
                          {event.delta_shares_down !== null ? (
                            <span className={event.delta_shares_down !== 0 ? 'text-yellow-500' : ''}>
                              {event.delta_shares_down > 0 ? '+' : ''}{event.delta_shares_down.toFixed(2)}
                            </span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="py-2">
                          <Badge variant="outline" className={`text-xs ${config.color}`}>
                            <Icon className="h-3 w-3 mr-1" />
                            {event.severity}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
