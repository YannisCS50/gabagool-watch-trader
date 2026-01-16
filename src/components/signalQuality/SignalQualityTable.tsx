import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SignalQualityAnalysis } from '@/types/signalQuality';
import { AlertTriangle, CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { format } from 'date-fns';

interface SignalQualityTableProps {
  signals: SignalQualityAnalysis[];
  isLoading?: boolean;
}

export function SignalQualityTable({ signals, isLoading }: SignalQualityTableProps) {
  const [sortField, setSortField] = useState<keyof SignalQualityAnalysis>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showOnlyTradeable, setShowOnlyTradeable] = useState<string>('all');
  
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-12 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  
  const filteredSignals = signals.filter(s => {
    if (showOnlyTradeable === 'tradeable') return s.should_trade;
    if (showOnlyTradeable === 'skip') return !s.should_trade;
    return true;
  });
  
  const sortedSignals = [...filteredSignals].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (aVal === null || aVal === undefined) return 1;
    if (bVal === null || bVal === undefined) return -1;
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    return sortDir === 'asc' 
      ? String(aVal).localeCompare(String(bVal))
      : String(bVal).localeCompare(String(aVal));
  });
  
  const toggleSort = (field: keyof SignalQualityAnalysis) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };
  
  const SortIcon = ({ field }: { field: keyof SignalQualityAnalysis }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />;
  };
  
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Signal Analysis Table</CardTitle>
          <Select value={showOnlyTradeable} onValueChange={setShowOnlyTradeable}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter signals" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Signals</SelectItem>
              <SelectItem value="tradeable">Should Trade = TRUE</SelectItem>
              <SelectItem value="skip">Should Trade = FALSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('created_at')}
                >
                  <div className="flex items-center gap-1">
                    Time <SortIcon field="created_at" />
                  </div>
                </TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Dir</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('delta_usd')}
                >
                  <div className="flex items-center gap-1">
                    Delta <SortIcon field="delta_usd" />
                  </div>
                </TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('effective_spread_sell')}
                >
                  <div className="flex items-center gap-1">
                    Spread <SortIcon field="effective_spread_sell" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('edge_after_spread_7s')}
                >
                  <div className="flex items-center gap-1">
                    Edge@7s <SortIcon field="edge_after_spread_7s" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('spot_lead_ms')}
                >
                  <div className="flex items-center gap-1">
                    Lead <SortIcon field="spot_lead_ms" />
                  </div>
                </TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead 
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => toggleSort('actual_pnl')}
                >
                  <div className="flex items-center gap-1">
                    PnL <SortIcon field="actual_pnl" />
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedSignals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                    No signals found
                  </TableCell>
                </TableRow>
              ) : (
                sortedSignals.slice(0, 100).map((signal) => (
                  <TableRow 
                    key={signal.id}
                    className={signal.is_false_edge ? 'bg-amber-500/5' : ''}
                  >
                    <TableCell className="text-xs font-mono">
                      {format(new Date(signal.created_at), 'HH:mm:ss')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{signal.asset}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={signal.direction === 'UP' ? 'default' : 'secondary'}>
                        {signal.direction}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      ${Math.abs(signal.delta_usd).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {signal.delta_bucket}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {((signal.effective_spread_sell ?? 0) * 100).toFixed(1)}¢
                    </TableCell>
                    <TableCell>
                      <span className={`font-mono text-sm ${
                        (signal.edge_after_spread_7s ?? 0) > 0 
                          ? 'text-green-500' 
                          : 'text-red-500'
                      }`}>
                        {((signal.edge_after_spread_7s ?? 0) * 100).toFixed(2)}¢
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant={
                          signal.spot_lead_bucket === '>800ms' ? 'default' :
                          signal.spot_lead_bucket === '300-800ms' ? 'secondary' :
                          'outline'
                        }
                        className="text-xs"
                      >
                        {signal.spot_lead_ms ?? 0}ms
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {(signal.bucket_confidence ?? 0) < 0.6 ? (
                        <Badge variant="outline" className="text-amber-500 border-amber-500/50">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          LOW
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {((signal.bucket_confidence ?? 0) * 100).toFixed(0)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {signal.is_false_edge ? (
                        <Badge variant="outline" className="text-amber-500 border-amber-500">
                          FALSE EDGE
                        </Badge>
                      ) : signal.should_trade ? (
                        <Badge variant="default" className="bg-green-500">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          TRADE
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <XCircle className="h-3 w-3 mr-1" />
                          SKIP
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {signal.actual_pnl !== null ? (
                        <span className={`font-mono font-medium ${
                          signal.actual_pnl > 0 ? 'text-green-500' : 'text-red-500'
                        }`}>
                          {signal.actual_pnl > 0 ? '+' : ''}{(signal.actual_pnl * 100).toFixed(2)}¢
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        {sortedSignals.length > 100 && (
          <div className="mt-4 text-center text-sm text-muted-foreground">
            Showing 100 of {sortedSignals.length} signals
          </div>
        )}
      </CardContent>
    </Card>
  );
}
