import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Calendar, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShadowDailyPnL } from '@/hooks/useShadowPositions';

interface ShadowDailyPnLTableProps {
  dailyPnl: ShadowDailyPnL[];
}

export function ShadowDailyPnLTable({ dailyPnl }: ShadowDailyPnLTableProps) {
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <Card>
      <CardHeader className="pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Calendar className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          Daily P&L
          <Badge variant="outline" className="ml-1 text-xs">{dailyPnl.length} days</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {/* Mobile Card View */}
        <div className="block md:hidden">
          <ScrollArea className="h-[350px]">
            <div className="space-y-2 p-3">
              {dailyPnl.length === 0 && (
                <div className="text-center text-muted-foreground py-8 text-sm">
                  No daily data yet
                </div>
              )}
              {dailyPnl.map((d) => (
                <div
                  key={d.id}
                  className={cn(
                    "p-3 rounded-lg border",
                    d.total_pnl > 0 && "bg-green-500/5 border-green-500/20",
                    d.total_pnl < 0 && "bg-red-500/5 border-red-500/20",
                    d.total_pnl === 0 && "bg-muted/20"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">{formatDate(d.date)}</span>
                    <div className="flex items-center gap-1">
                      {d.total_pnl >= 0 ? (
                        <TrendingUp className="h-3 w-3 text-green-400" />
                      ) : (
                        <TrendingDown className="h-3 w-3 text-red-400" />
                      )}
                      <span
                        className={cn(
                          "font-mono font-bold text-sm",
                          d.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                        )}
                      >
                        {d.total_pnl >= 0 ? '+' : ''}${d.total_pnl.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Trades: </span>
                      <span className="font-mono">{d.trades}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Wins: </span>
                      <span className="font-mono text-green-400">{d.wins}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Loss: </span>
                      <span className="font-mono text-red-400">{d.losses}</span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50 text-xs">
                    <span className="text-muted-foreground">Cumulative:</span>
                    <span
                      className={cn(
                        "font-mono font-bold",
                        d.cumulative_pnl >= 0 ? "text-green-400" : "text-red-400"
                      )}
                    >
                      {d.cumulative_pnl >= 0 ? '+' : ''}${d.cumulative_pnl.toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[400px] hidden md:block">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="text-right">Wins</TableHead>
                <TableHead className="text-right">Losses</TableHead>
                <TableHead className="text-right">Win Rate</TableHead>
                <TableHead className="text-right">Daily PnL</TableHead>
                <TableHead className="text-right">Cumulative</TableHead>
                <TableHead className="text-right">Fees</TableHead>
                <TableHead className="text-right">Max DD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyPnl.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No daily data yet
                  </TableCell>
                </TableRow>
              )}
              {dailyPnl.map((d) => (
                <TableRow
                  key={d.id}
                  className={cn(
                    d.total_pnl > 0 && "bg-green-500/5",
                    d.total_pnl < 0 && "bg-red-500/5"
                  )}
                >
                  <TableCell className="font-medium">{formatDate(d.date)}</TableCell>
                  <TableCell className="text-right font-mono">{d.trades}</TableCell>
                  <TableCell className="text-right font-mono text-green-400">{d.wins}</TableCell>
                  <TableCell className="text-right font-mono text-red-400">{d.losses}</TableCell>
                  <TableCell className="text-right font-mono">
                    {d.win_rate ? `${(d.win_rate * 100).toFixed(0)}%` : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "font-mono font-bold",
                        d.total_pnl >= 0 ? "text-green-400" : "text-red-400"
                      )}
                    >
                      {d.total_pnl >= 0 ? '+' : ''}${d.total_pnl.toFixed(2)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "font-mono",
                        d.cumulative_pnl >= 0 ? "text-green-400" : "text-red-400"
                      )}
                    >
                      {d.cumulative_pnl >= 0 ? '+' : ''}${d.cumulative_pnl.toFixed(2)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground font-mono">
                    ${d.total_fees?.toFixed(2) || '0.00'}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono text-red-400">
                    {d.max_drawdown ? `${d.max_drawdown.toFixed(1)}%` : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
