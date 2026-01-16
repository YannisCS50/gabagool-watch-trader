import { useSignalAnalysis, SignalAnalysis } from '@/hooks/useSignalAnalysis';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState } from 'react';

export function SignalAnalysisTable() {
  const [asset, setAsset] = useState<string>('all');
  const { data, isLoading, error } = useSignalAnalysis(asset);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-destructive/20 text-destructive rounded-lg">
        Error: {(error as Error).message}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Filter */}
      <Select value={asset} onValueChange={setAsset}>
        <SelectTrigger className="w-32">
          <SelectValue placeholder="Asset" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Assets</SelectItem>
          <SelectItem value="BTC">BTC</SelectItem>
          <SelectItem value="ETH">ETH</SelectItem>
          <SelectItem value="SOL">SOL</SelectItem>
          <SelectItem value="XRP">XRP</SelectItem>
        </SelectContent>
      </Select>

      {/* UP Signals Table */}
      <DirectionTable analysis={data.up} />

      {/* DOWN Signals Table */}
      <DirectionTable analysis={data.down} />
    </div>
  );
}

function DirectionTable({ analysis }: { analysis: SignalAnalysis }) {
  if (!analysis) return null;
  
  const isUp = analysis.direction === 'UP';
  const Icon = isUp ? TrendingUp : TrendingDown;
  const color = isUp ? 'text-green-500' : 'text-red-500';
  const bgColor = isUp ? 'bg-green-500/10' : 'bg-red-500/10';

  return (
    <Card>
      <CardHeader className={bgColor}>
        <CardTitle className={`flex items-center gap-2 ${color}`}>
          <Icon className="h-5 w-5" />
          {analysis.direction} Signals
        </CardTitle>
        <CardDescription>
          {(analysis.total_signals ?? 0).toLocaleString()} signals • 
          Avg trigger size: ${(analysis.avg_signal_size ?? 0).toFixed(2)}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead rowSpan={2} className="w-20 border-r align-middle">Time</TableHead>
              <TableHead rowSpan={2} className="text-right border-r align-middle w-20">N</TableHead>
              <TableHead colSpan={3} className="text-center border-b border-r">
                Price Change (Chainlink)
              </TableHead>
              <TableHead colSpan={3} className="text-center border-b">
                Share Price Change
              </TableHead>
            </TableRow>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-right text-xs">Avg %</TableHead>
              <TableHead className="text-right text-xs text-green-500">↑ %</TableHead>
              <TableHead className="text-right text-xs text-red-500 border-r">↓ %</TableHead>
              <TableHead className="text-right text-xs">Avg ¢</TableHead>
              <TableHead className="text-right text-xs text-green-500">↑ %</TableHead>
              <TableHead className="text-right text-xs text-red-500">↓ %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analysis.stats_by_second.map((stat) => (
              <TableRow key={stat.seconds_after}>
                <TableCell className="font-mono font-bold border-r">{stat.seconds_after}s</TableCell>
                <TableCell className="text-right text-muted-foreground border-r text-xs">
                  {stat.sample_count.toLocaleString()}
                </TableCell>
                
                {/* Price changes */}
                <TableCell className={`text-right font-mono ${getPriceColor(stat.avg_price_change_pct, isUp)}`}>
                  {formatPct(stat.avg_price_change_pct)}
                </TableCell>
                <TableCell className="text-right font-mono text-green-500">
                  {(stat.up_tick_pct ?? 0).toFixed(1)}%
                </TableCell>
                <TableCell className="text-right font-mono text-red-500 border-r">
                  {(stat.down_tick_pct ?? 0).toFixed(1)}%
                </TableCell>
                
                {/* Share price changes */}
                <TableCell className={`text-right font-mono ${getShareColor(stat.avg_share_change_cents, isUp)}`}>
                  {formatCents(stat.avg_share_change_cents)}
                </TableCell>
                <TableCell className="text-right font-mono text-green-500">
                  {(stat.up_share_pct ?? 0).toFixed(1)}%
                </TableCell>
                <TableCell className="text-right font-mono text-red-500">
                  {(stat.down_share_pct ?? 0).toFixed(1)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatPct(value: number | undefined): string {
  if (value == null) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)}%`;
}

function formatCents(value: number | undefined): string {
  if (value == null) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}¢`;
}

function getPriceColor(value: number, isUp: boolean): string {
  // For UP signals, positive price change is good (green)
  // For DOWN signals, negative price change is good (green)
  if (isUp) {
    return value > 0 ? 'text-green-500' : value < 0 ? 'text-red-500' : '';
  } else {
    return value < 0 ? 'text-green-500' : value > 0 ? 'text-red-500' : '';
  }
}

function getShareColor(value: number, isUp: boolean): string {
  // For UP signals, positive share change is good (we bought UP shares, want them to go up)
  // For DOWN signals, positive share change is good (we bought DOWN shares, want them to go up)
  return value > 0 ? 'text-green-500' : value < 0 ? 'text-red-500' : '';
}
