import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { 
  Zap, CheckCircle2, XCircle, Search, Filter, TrendingUp, TrendingDown 
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { SignalLog } from '@/hooks/useShadowDashboard';

interface SignalLogTableProps {
  signals: SignalLog[];
}

export function SignalLogTable({ signals }: SignalLogTableProps) {
  const [filter, setFilter] = useState('');
  const [showPassedOnly, setShowPassedOnly] = useState(false);

  const filteredSignals = signals.filter((s) => {
    if (showPassedOnly && !s.passedFilters) return false;
    if (filter && !s.asset.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  const passedCount = signals.filter((s) => s.passedFilters).length;
  const failedCount = signals.length - passedCount;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Signal Log
          <Badge variant="outline" className="ml-2">{signals.length} total</Badge>
        </CardTitle>
        <CardDescription>
          Every detected signal, including skipped ones
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by asset..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant={showPassedOnly ? "default" : "outline"}
            size="sm"
            onClick={() => setShowPassedOnly(!showPassedOnly)}
          >
            <Filter className="h-4 w-4 mr-1" />
            Passed Only
          </Button>
          <div className="flex items-center gap-3 text-sm ml-auto">
            <span className="text-green-400 flex items-center gap-1">
              <CheckCircle2 className="h-4 w-4" />
              {passedCount}
            </span>
            <span className="text-red-400 flex items-center gap-1">
              <XCircle className="h-4 w-4" />
              {failedCount}
            </span>
          </div>
        </div>

        {/* Table */}
        <ScrollArea className="h-[400px]">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[80px]">Time</TableHead>
                <TableHead className="w-[70px]">Asset</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Delta</TableHead>
                <TableHead className="text-right">Mispricing</TableHead>
                <TableHead className="text-right">Threshold</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Failed Filters</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSignals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No signals found
                  </TableCell>
                </TableRow>
              )}
              {filteredSignals.map((s) => (
                <TableRow 
                  key={s.id}
                  className={cn(
                    s.passedFilters ? "bg-green-500/5" : "bg-muted/20"
                  )}
                >
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {format(new Date(s.iso), 'HH:mm:ss')}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">{s.asset}</Badge>
                  </TableCell>
                  <TableCell>
                    {s.side === 'UP' ? (
                      <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                        <TrendingUp className="h-3 w-3 mr-1" />
                        UP
                      </Badge>
                    ) : s.side === 'DOWN' ? (
                      <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                        <TrendingDown className="h-3 w-3 mr-1" />
                        DOWN
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {(s.delta * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {(s.mispricing * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-muted-foreground">
                    {(s.threshold * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(
                      "text-xs",
                      s.engineState === 'HOT' && "border-red-500/50 text-red-400",
                      s.engineState === 'WARM' && "border-amber-500/50 text-amber-400",
                      s.engineState === 'COLD' && "border-blue-500/50 text-blue-400"
                    )}>
                      {s.engineState}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {s.passedFilters ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {s.failedFilters.length > 0 ? s.failedFilters.join(', ') : '-'}
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
