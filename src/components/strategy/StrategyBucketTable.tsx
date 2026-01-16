import { StrategyBucket } from '@/hooks/useStrategyDiscovery';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Props {
  buckets: StrategyBucket[];
  showAll?: boolean;
}

export function StrategyBucketTable({ buckets, showAll = false }: Props) {
  const displayBuckets = showAll ? buckets : buckets.slice(0, 10);
  
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Share Price</TableHead>
            <TableHead>Delta</TableHead>
            <TableHead>Time Left</TableHead>
            <TableHead>Volatility</TableHead>
            <TableHead className="text-right">Win Rate</TableHead>
            <TableHead className="text-right">Avg PnL</TableHead>
            <TableHead className="text-right">Counter-ticks</TableHead>
            <TableHead className="text-right">Max Adverse</TableHead>
            <TableHead className="text-right">Samples</TableHead>
            <TableHead className="text-right">Z-Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayBuckets.map((bucket, i) => (
            <TableRow 
              key={i} 
              className={cn(
                bucket.isSignificant && bucket.winRate > 55 && 'bg-green-500/5',
                bucket.isSignificant && bucket.winRate < 45 && 'bg-red-500/5',
              )}
            >
              <TableCell>
                <Badge variant="outline">{bucket.sharePriceBucket}</Badge>
              </TableCell>
              <TableCell>
                <Badge 
                  variant="outline" 
                  className={cn(
                    bucket.deltaBucket.startsWith('+') && 'border-green-500 text-green-600',
                    bucket.deltaBucket.startsWith('-') && 'border-red-500 text-red-600',
                  )}
                >
                  {bucket.deltaBucket}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{bucket.timeRemainingBucket}</Badge>
              </TableCell>
              <TableCell>
                <Badge 
                  variant="secondary"
                  className={cn(
                    bucket.volatilityBucket === 'low' && 'bg-blue-500/10 text-blue-600',
                    bucket.volatilityBucket === 'medium' && 'bg-yellow-500/10 text-yellow-600',
                    bucket.volatilityBucket === 'high' && 'bg-red-500/10 text-red-600',
                  )}
                >
                  {bucket.volatilityBucket}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <span className={cn(
                  'font-medium',
                  bucket.winRate > 55 && 'text-green-600',
                  bucket.winRate < 45 && 'text-red-600',
                )}>
                  {bucket.winRate.toFixed(1)}%
                </span>
              </TableCell>
              <TableCell className="text-right">
                <span className={cn(
                  bucket.avgPnl > 0 && 'text-green-600',
                  bucket.avgPnl < 0 && 'text-red-600',
                )}>
                  {bucket.avgPnl > 0 ? '+' : ''}{(bucket.avgPnl * 100).toFixed(1)}¢
                </span>
              </TableCell>
              <TableCell className="text-right">
                {bucket.avgCounterTicks.toFixed(1)}
              </TableCell>
              <TableCell className="text-right">
                {(bucket.avgMaxAdverse * 100).toFixed(1)}¢
              </TableCell>
              <TableCell className="text-right">
                {bucket.sampleCount}
                {bucket.isSignificant && <span className="ml-1 text-yellow-500">★</span>}
              </TableCell>
              <TableCell className="text-right">
                <span className={cn(
                  'font-mono text-xs',
                  Math.abs(bucket.zScore) >= 1.96 && 'font-bold',
                )}>
                  {bucket.zScore > 0 ? '+' : ''}{bucket.zScore.toFixed(2)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      
      {!showAll && buckets.length > 10 && (
        <p className="text-sm text-muted-foreground mt-2 text-center">
          Toont {displayBuckets.length} van {buckets.length} buckets
        </p>
      )}
    </div>
  );
}
