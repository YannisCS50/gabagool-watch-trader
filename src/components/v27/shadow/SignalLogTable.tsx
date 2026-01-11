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
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter by asset..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3 w-full sm:w-auto">
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
        </div>

        {/* Mobile Card View */}
        <div className="block md:hidden space-y-3 max-h-[400px] overflow-y-auto">
          {filteredSignals.length === 0 && (
            <div className="text-center text-muted-foreground py-8">
              No signals found
            </div>
          )}
          {filteredSignals.map((s) => (
            <div
              key={s.id}
              className={cn(
                "p-3 rounded-lg border",
                s.passedFilters ? "bg-green-500/5 border-green-500/20" : "bg-muted/20 border-border"
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono">{s.asset}</Badge>
                  {s.side === 'UP' ? (
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                      <TrendingUp className="h-3 w-3 mr-1" />
                      UP
                    </Badge>
                  ) : s.side === 'DOWN' ? (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">
                      <TrendingDown className="h-3 w-3 mr-1" />
                      DOWN
                    </Badge>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {s.passedFilters ? (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400" />
                  )}
                  <span className="text-xs text-muted-foreground font-mono">
                    {format(new Date(s.iso), 'HH:mm:ss')}
                  </span>
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground block">Delta</span>
                  <span className="font-mono">{(s.delta * 100).toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Mispricing</span>
                  <span className="font-mono">{(s.mispricing * 100).toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">Threshold</span>
                  <span className="font-mono">{(s.threshold * 100).toFixed(2)}%</span>
                </div>
              </div>
              
              {s.failedFilters.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border">
                  <span className="text-xs text-red-400">
                    Failed: {s.failedFilters.join(', ')}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[400px] hidden md:block">
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
