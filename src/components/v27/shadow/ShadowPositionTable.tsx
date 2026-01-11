import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Briefcase, TrendingUp, TrendingDown, Clock, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import type { ShadowPosition } from '@/hooks/useShadowPositions';

interface ShadowPositionTableProps {
  positions: ShadowPosition[];
}

export function ShadowPositionTable({ positions }: ShadowPositionTableProps) {
  const [filter, setFilter] = useState<string>('all');
  const [assetFilter, setAssetFilter] = useState<string>('all');

  const assets = [...new Set(positions.map((p) => p.asset))];

  const filtered = positions.filter((p) => {
    if (filter !== 'all' && p.resolution !== filter) return false;
    if (assetFilter !== 'all' && p.asset !== assetFilter) return false;
    return true;
  });

  const getResolutionBadge = (resolution: string) => {
    switch (resolution) {
      case 'PAIRED_HEDGED':
        return (
          <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
            <CheckCircle className="h-3 w-3 mr-1" />
            Hedged
          </Badge>
        );
      case 'EXPIRED_ONE_SIDED':
        return (
          <Badge variant="destructive" className="text-xs">
            <XCircle className="h-3 w-3 mr-1" />
            Expired
          </Badge>
        );
      case 'EMERGENCY_EXITED':
        return (
          <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Emergency
          </Badge>
        );
      case 'NO_FILL':
        return (
          <Badge variant="outline" className="text-muted-foreground text-xs">
            No Fill
          </Badge>
        );
      default:
        return (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">
            <Clock className="h-3 w-3 mr-1" />
            Open
          </Badge>
        );
    }
  };

  const formatDuration = (entryTs: number, exitTs: number | null) => {
    if (!exitTs) return '-';
    const ms = exitTs - entryTs;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Briefcase className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          Shadow Positions
          <Badge variant="outline" className="ml-1 text-xs">{filtered.length}</Badge>
        </CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={assetFilter} onValueChange={setAssetFilter}>
            <SelectTrigger className="h-8 w-[80px] text-xs">
              <SelectValue placeholder="Asset" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {assets.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-8 w-[100px] text-xs">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="OPEN">Open</SelectItem>
              <SelectItem value="PAIRED_HEDGED">Hedged</SelectItem>
              <SelectItem value="EXPIRED_ONE_SIDED">Expired</SelectItem>
              <SelectItem value="EMERGENCY_EXITED">Emergency</SelectItem>
              <SelectItem value="NO_FILL">No Fill</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {/* Mobile Card View */}
        <div className="block lg:hidden">
          <ScrollArea className="h-[400px]">
            <div className="space-y-2 p-3">
              {filtered.length === 0 && (
                <div className="text-center text-muted-foreground py-8 text-sm">
                  No positions found
                </div>
              )}
              {filtered.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "p-3 rounded-lg border",
                    (p.net_pnl || 0) > 0 && "bg-green-500/5 border-green-500/20",
                    (p.net_pnl || 0) < 0 && "bg-red-500/5 border-red-500/20",
                    (p.net_pnl || 0) === 0 && "bg-muted/20"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono font-bold text-xs">
                        {p.asset}
                      </Badge>
                      <Badge
                        className={cn(
                          "text-xs",
                          p.side === 'UP' ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                        )}
                      >
                        {p.side}
                      </Badge>
                    </div>
                    {getResolutionBadge(p.resolution)}
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                    <div>
                      <span className="text-muted-foreground">Entry: </span>
                      <span className="font-mono">{(p.entry_price * 100).toFixed(1)}¢</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Hedge: </span>
                      <span className="font-mono">
                        {p.hedge_price ? `${(p.hedge_price * 100).toFixed(1)}¢` : '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Size: </span>
                      <span className="font-mono">${p.size_usd.toFixed(0)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Duration: </span>
                      <span className="font-mono">
                        {formatDuration(p.entry_timestamp, p.resolution_timestamp)}
                      </span>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-between pt-2 border-t border-border/50">
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(p.entry_iso), { addSuffix: true })}
                    </span>
                    <div className="flex items-center gap-1">
                      {(p.net_pnl || 0) >= 0 ? (
                        <TrendingUp className="h-3 w-3 text-green-400" />
                      ) : (
                        <TrendingDown className="h-3 w-3 text-red-400" />
                      )}
                      <span
                        className={cn(
                          "font-mono font-bold text-sm",
                          (p.net_pnl || 0) >= 0 ? "text-green-400" : "text-red-400"
                        )}
                      >
                        {(p.net_pnl || 0) >= 0 ? '+' : ''}${(p.net_pnl || 0).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[500px] hidden lg:block">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="w-[60px]">Asset</TableHead>
                <TableHead className="w-[50px]">Side</TableHead>
                <TableHead>Entry Time</TableHead>
                <TableHead className="text-right">Entry ¢</TableHead>
                <TableHead>Hedge Time</TableHead>
                <TableHead className="text-right">Hedge ¢</TableHead>
                <TableHead className="text-right">CPP</TableHead>
                <TableHead className="w-[90px]">Resolution</TableHead>
                <TableHead className="text-right">PnL</TableHead>
                <TableHead className="text-right">Fees</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                    No positions found
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((p) => (
                <TableRow
                  key={p.id}
                  className={cn(
                    (p.net_pnl || 0) > 0 && "bg-green-500/5",
                    (p.net_pnl || 0) < 0 && "bg-red-500/5"
                  )}
                >
                  <TableCell>
                    <Badge variant="outline" className="font-mono font-bold text-xs">
                      {p.asset}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={cn(
                        "text-xs",
                        p.side === 'UP' ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      )}
                    >
                      {p.side}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(p.entry_iso).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {(p.entry_price * 100).toFixed(1)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {p.hedge_iso ? new Date(p.hedge_iso).toLocaleTimeString() : '-'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.hedge_price ? (p.hedge_price * 100).toFixed(1) : '-'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.combined_price_paid ? (p.combined_price_paid * 100).toFixed(1) : '-'}
                  </TableCell>
                  <TableCell>{getResolutionBadge(p.resolution)}</TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "font-mono font-bold",
                        (p.net_pnl || 0) >= 0 ? "text-green-400" : "text-red-400"
                      )}
                    >
                      {(p.net_pnl || 0) >= 0 ? '+' : ''}${(p.net_pnl || 0).toFixed(2)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground font-mono">
                    ${p.fees.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right text-xs font-mono">
                    {formatDuration(p.entry_timestamp, p.resolution_timestamp)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
                    {p.resolution_reason || '-'}
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
