import { useSignalAnalysis, useSignalAnalysisByBucket, SignalAnalysis, BucketAnalysis } from '@/hooks/useSignalAnalysis';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useState } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

export function SignalAnalysisTable() {
  const [asset, setAsset] = useState<string>('all');
  const [viewMode, setViewMode] = useState<string>('overall');
  
  const { data: overallData, isLoading: overallLoading, error: overallError } = useSignalAnalysis(asset);
  const { data: bucketData, isLoading: bucketLoading, error: bucketError } = useSignalAnalysisByBucket(asset);

  const isLoading = viewMode === 'overall' ? overallLoading : bucketLoading;
  const error = viewMode === 'overall' ? overallError : bucketError;

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

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4 items-center">
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

        <Tabs value={viewMode} onValueChange={setViewMode}>
          <TabsList>
            <TabsTrigger value="overall">Overall</TabsTrigger>
            <TabsTrigger value="by-bucket">By Time Remaining</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {viewMode === 'overall' && overallData && (
        <div className="space-y-6">
          <DirectionTable analysis={overallData.up} />
          <DirectionTable analysis={overallData.down} />
        </div>
      )}

      {viewMode === 'by-bucket' && bucketData && (
        <BucketAccordion buckets={bucketData} />
      )}
    </div>
  );
}

function BucketAccordion({ buckets }: { buckets: BucketAnalysis[] }) {
  return (
    <Accordion type="multiple" defaultValue={buckets.map(b => b.bucket_label)} className="space-y-4">
      {buckets.map((bucket) => (
        <AccordionItem key={bucket.bucket_label} value={bucket.bucket_label} className="border rounded-lg">
          <AccordionTrigger className="px-4 hover:no-underline">
            <div className="flex items-center gap-3">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="font-semibold">{bucket.bucket_label} remaining</span>
              <span className="text-sm text-muted-foreground">
                ({bucket.up.total_signals + bucket.down.total_signals} signals)
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4 space-y-4">
            <DirectionTable analysis={bucket.up} compact />
            <DirectionTable analysis={bucket.down} compact />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function DirectionTable({ analysis, compact = false }: { analysis: SignalAnalysis; compact?: boolean }) {
  if (!analysis) return null;
  
  const isUp = analysis.direction === 'UP';
  const Icon = isUp ? TrendingUp : TrendingDown;
  const color = isUp ? 'text-green-500' : 'text-red-500';
  const bgColor = isUp ? 'bg-green-500/10' : 'bg-red-500/10';

  return (
    <Card className={compact ? 'shadow-sm' : ''}>
      <CardHeader className={`${bgColor} ${compact ? 'py-3' : ''}`}>
        <CardTitle className={`flex items-center gap-2 ${color} ${compact ? 'text-base' : ''}`}>
          <Icon className={compact ? 'h-4 w-4' : 'h-5 w-5'} />
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
