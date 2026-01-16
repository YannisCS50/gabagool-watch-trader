import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { V29RSignal } from '@/hooks/useV29ResponseData';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Props {
  signals: V29RSignal[];
}

export function V29RSignalsTable({ signals }: Props) {
  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const getExitReasonBadge = (reason: string | null) => {
    if (!reason) return null;
    const colors: Record<string, string> = {
      'TARGET_REACHED': 'bg-green-500/20 text-green-500',
      'REPRICING_EXHAUSTION': 'bg-blue-500/20 text-blue-500',
      'ADVERSE_SELECTION': 'bg-red-500/20 text-red-500',
      'HARD_TIME_STOP': 'bg-orange-500/20 text-orange-500',
    };
    return <Badge variant="outline" className={colors[reason] || ''}>{reason.replace(/_/g, ' ')}</Badge>;
  };

  const calcHoldTime = (signal: V29RSignal) => {
    if (signal.signal_ts && signal.exit_ts) {
      return (signal.exit_ts - signal.signal_ts) / 1000;
    }
    return null;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Recent Signals</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[500px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Dir</TableHead>
                <TableHead>Δ</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead>Hold</TableHead>
                <TableHead>P&L</TableHead>
                <TableHead>Exit Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signals.slice(0, 100).map((signal) => {
                const holdTime = calcHoldTime(signal);
                return (
                  <TableRow key={signal.id} className={signal.status === 'skipped' ? 'opacity-50' : ''}>
                    <TableCell className="font-mono text-xs">{formatTime(signal.created_at)}</TableCell>
                    <TableCell className="font-bold">{signal.asset}</TableCell>
                    <TableCell>
                      {signal.direction === 'UP' ? <TrendingUp className="h-4 w-4 text-green-500" /> : <TrendingDown className="h-4 w-4 text-red-500" />}
                    </TableCell>
                    <TableCell className="font-mono">${(signal.binance_delta || 0).toFixed(2)}</TableCell>
                    <TableCell className="font-mono">{signal.entry_price ? `${(signal.entry_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                    <TableCell className="font-mono">{signal.exit_price ? `${(signal.exit_price * 100).toFixed(1)}¢` : '-'}</TableCell>
                    <TableCell className="font-mono">{holdTime ? `${holdTime.toFixed(1)}s` : '-'}</TableCell>
                    <TableCell className={`font-mono ${(signal.net_pnl || 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {signal.net_pnl != null ? `$${signal.net_pnl.toFixed(3)}` : '-'}
                    </TableCell>
                    <TableCell>
                      {signal.skip_reason ? <span className="text-xs text-muted-foreground">{signal.skip_reason}</span> : getExitReasonBadge(signal.exit_reason)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
