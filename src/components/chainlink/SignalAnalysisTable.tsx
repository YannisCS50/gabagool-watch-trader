import { useSignalAnalysis, SignalAnalysis, SecondStats } from '@/hooks/useSignalAnalysis';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const isUp = analysis.direction === 'UP';
  const Icon = isUp ? TrendingUp : TrendingDown;
  const color = isUp ? 'text-green-500' : 'text-red-500';
  const bgColor = isUp ? 'bg-green-500/10' : 'bg-red-500/10';

  return (
    <Card>
      <CardHeader className={bgColor}>
        <CardTitle className={`flex items-center gap-2 ${color}`}>
          <Icon className="h-5 w-5" />
          {analysis.direction} Signals ({analysis.total_signals.toLocaleString()} signals)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Time After</TableHead>
              <TableHead className="text-right">Samples</TableHead>
              <TableHead className="text-right">Avg Price Δ%</TableHead>
              <TableHead className="text-right">Med Price Δ%</TableHead>
              <TableHead className="text-right">Avg Share Δ%</TableHead>
              <TableHead className="text-right">Med Share Δ%</TableHead>
              <TableHead className="text-right">Hit Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analysis.stats_by_second.map((stat) => (
              <TableRow key={stat.seconds_after}>
                <TableCell className="font-mono">{stat.seconds_after}s</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {stat.sample_count.toLocaleString()}
                </TableCell>
                <TableCell className={`text-right font-mono ${getColorClass(stat.avg_price_change_pct, isUp)}`}>
                  {formatPct(stat.avg_price_change_pct)}
                </TableCell>
                <TableCell className={`text-right font-mono ${getColorClass(stat.median_price_change_pct, isUp)}`}>
                  {formatPct(stat.median_price_change_pct)}
                </TableCell>
                <TableCell className={`text-right font-mono ${getColorClass(stat.avg_share_price_change_pct, isUp)}`}>
                  {formatPct(stat.avg_share_price_change_pct)}
                </TableCell>
                <TableCell className={`text-right font-mono ${getColorClass(stat.median_share_price_change_pct, isUp)}`}>
                  {formatPct(stat.median_share_price_change_pct)}
                </TableCell>
                <TableCell className={`text-right font-mono ${stat.positive_rate > 50 ? 'text-green-500' : 'text-red-500'}`}>
                  {stat.positive_rate.toFixed(1)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(4)}%`;
}

function getColorClass(value: number, isUp: boolean): string {
  if (isUp) {
    return value > 0 ? 'text-green-500' : 'text-red-500';
  } else {
    return value < 0 ? 'text-green-500' : 'text-red-500';
  }
}
