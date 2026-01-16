import { StrategyBucket } from '@/hooks/useStrategyDiscovery';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface Props {
  buckets: StrategyBucket[];
}

export function OpportunityHeatmap({ buckets }: Props) {
  // Create 2D heatmap: Share Price vs Delta
  const sharePriceBuckets = ['< 0.20', '0.20-0.30', '0.30-0.40', '0.40-0.50', '0.50-0.60', '0.60-0.70', '0.70-0.80', '> 0.80'];
  const deltaBuckets = ['-$100+', '-$50-100', '-$25-50', '-$10-25', '-$0-10', '+$0-10', '+$10-25', '+$25-50', '+$50-100', '+$100+'];
  
  // Build lookup
  const lookup = new Map<string, StrategyBucket>();
  for (const b of buckets) {
    const key = `${b.sharePriceBucket}|${b.deltaBucket}`;
    // Keep bucket with most samples if duplicates
    const existing = lookup.get(key);
    if (!existing || b.sampleCount > existing.sampleCount) {
      lookup.set(key, b);
    }
  }
  
  const getColor = (bucket: StrategyBucket | undefined): string => {
    if (!bucket || bucket.sampleCount < 3) return 'bg-muted/30';
    
    const wr = bucket.winRate;
    if (wr >= 65) return 'bg-green-600 text-white';
    if (wr >= 55) return 'bg-green-400 text-black';
    if (wr >= 50) return 'bg-yellow-400 text-black';
    if (wr >= 45) return 'bg-orange-400 text-black';
    return 'bg-red-500 text-white';
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Opportunity Heatmap</CardTitle>
        <CardDescription>
          Win rate per combinatie van share price en delta. Groen = hoge win rate, rood = lage win rate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <div className="min-w-[800px]">
            {/* Header row */}
            <div className="flex">
              <div className="w-24 shrink-0 p-2 font-medium text-xs text-muted-foreground">
                Share ↓ / Delta →
              </div>
              {deltaBuckets.map(d => (
                <div key={d} className="flex-1 p-1 text-center text-xs font-medium truncate" title={d}>
                  {d}
                </div>
              ))}
            </div>
            
            {/* Data rows */}
            {sharePriceBuckets.map(sp => (
              <div key={sp} className="flex">
                <div className="w-24 shrink-0 p-2 text-xs font-medium">
                  {sp}
                </div>
                {deltaBuckets.map(d => {
                  const key = `${sp}|${d}`;
                  const bucket = lookup.get(key);
                  return (
                    <div
                      key={d}
                      className={cn(
                        'flex-1 p-1 text-center text-xs font-medium rounded-sm m-0.5 cursor-default transition-transform hover:scale-105',
                        getColor(bucket),
                      )}
                      title={bucket 
                        ? `Win: ${bucket.winRate.toFixed(0)}%, n=${bucket.sampleCount}, z=${bucket.zScore.toFixed(2)}`
                        : 'Geen data'
                      }
                    >
                      {bucket && bucket.sampleCount >= 3 ? (
                        <>
                          {bucket.winRate.toFixed(0)}%
                          {bucket.isSignificant && <span className="ml-0.5">★</span>}
                        </>
                      ) : '-'}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        
        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 text-xs">
          <span className="text-muted-foreground">Legend:</span>
          <span className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-green-600" /> &gt;65%
          </span>
          <span className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-green-400" /> 55-65%
          </span>
          <span className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-yellow-400" /> 50-55%
          </span>
          <span className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-orange-400" /> 45-50%
          </span>
          <span className="flex items-center gap-1">
            <div className="w-4 h-4 rounded bg-red-500" /> &lt;45%
          </span>
          <span className="ml-2 text-yellow-500">★ = significant</span>
        </div>
      </CardContent>
    </Card>
  );
}
