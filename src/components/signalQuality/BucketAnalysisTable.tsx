import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { BucketAggregation } from '@/types/signalQuality';
import { AlertTriangle } from 'lucide-react';

interface BucketAnalysisTableProps {
  aggregations: BucketAggregation[];
  isLoading?: boolean;
}

export function BucketAnalysisTable({ aggregations, isLoading }: BucketAnalysisTableProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-10 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  
  if (aggregations.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No bucket data available
        </CardContent>
      </Card>
    );
  }
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Edge by Delta Bucket</CardTitle>
        <p className="text-sm text-muted-foreground">
          Aggregated edge metrics per delta bucket. Grey rows indicate low sample size (&lt;30).
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Delta Bucket</TableHead>
              <TableHead className="text-right">Samples</TableHead>
              <TableHead className="text-right">Avg Edge</TableHead>
              <TableHead className="text-right">Win Rate</TableHead>
              <TableHead className="text-right">Avg Lead</TableHead>
              <TableHead>Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {aggregations.map((bucket) => (
              <TableRow 
                key={bucket.bucket}
                className={bucket.isLowSample ? 'opacity-50' : ''}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{bucket.bucket}</Badge>
                    {bucket.isLowSample && (
                      <AlertTriangle className="h-3 w-3 text-amber-500" />
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {bucket.count}
                </TableCell>
                <TableCell className="text-right">
                  <span className={`font-mono ${
                    bucket.avgEdge > 0 ? 'text-green-500' : 'text-red-500'
                  }`}>
                    {(bucket.avgEdge * 100).toFixed(2)}¢
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Progress 
                      value={bucket.winRate} 
                      className="w-16 h-2"
                    />
                    <span className={`font-mono text-sm ${
                      bucket.winRate >= 50 ? 'text-green-500' : 'text-red-500'
                    }`}>
                      {bucket.winRate.toFixed(0)}%
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {bucket.avgSpotLead.toFixed(0)}ms
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Progress 
                      value={bucket.confidence * 100} 
                      className="w-16 h-2"
                    />
                    <span className="text-xs text-muted-foreground">
                      {(bucket.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
