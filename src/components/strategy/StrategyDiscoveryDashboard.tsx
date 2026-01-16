import { useState } from 'react';
import { useStrategyDiscovery, StrategyBucket } from '@/hooks/useStrategyDiscovery';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, TrendingUp, TrendingDown, AlertTriangle, Clock, DollarSign, Activity } from 'lucide-react';
import { StrategyBucketTable } from './StrategyBucketTable';
import { DelayAnalysisCard } from './DelayAnalysisCard';
import { OpportunityHeatmap } from './OpportunityHeatmap';
import { PathDependenceChart } from './PathDependenceChart';

export function StrategyDiscoveryDashboard() {
  const [asset, setAsset] = useState('BTC');
  const [hoursBack, setHoursBack] = useState(24);
  
  const { data, isLoading, error, refetch } = useStrategyDiscovery(asset, hoursBack);
  
  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-6">
          <p className="text-destructive">Error loading strategy analysis: {String(error)}</p>
        </CardContent>
      </Card>
    );
  }
  
  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold">Strategy Discovery</h2>
          <p className="text-muted-foreground">Vind statistisch significante kansen op basis van path-dependent analyse</p>
        </div>
        
        <div className="flex items-center gap-3">
          <Select value={asset} onValueChange={setAsset}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BTC">BTC</SelectItem>
              <SelectItem value="ETH">ETH</SelectItem>
              <SelectItem value="SOL">SOL</SelectItem>
              <SelectItem value="XRP">XRP</SelectItem>
            </SelectContent>
          </Select>
          
          <Select value={String(hoursBack)} onValueChange={(v) => setHoursBack(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="6">6 uur</SelectItem>
              <SelectItem value="12">12 uur</SelectItem>
              <SelectItem value="24">24 uur</SelectItem>
              <SelectItem value="48">48 uur</SelectItem>
              <SelectItem value="168">1 week</SelectItem>
            </SelectContent>
          </Select>
          
          <Button variant="outline" size="icon" onClick={() => refetch()}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Markten geanalyseerd</p>
                    <p className="text-2xl font-bold">{data.totalWindows}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-green-500" />
                  <div>
                    <p className="text-sm text-muted-foreground">Overall Win Rate</p>
                    <p className="text-2xl font-bold">{data.overallWinRate.toFixed(1)}%</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-blue-500" />
                  <div>
                    <p className="text-sm text-muted-foreground">Significante buckets</p>
                    <p className="text-2xl font-bold">{data.buckets.filter(b => b.isSignificant).length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-orange-500" />
                  <div>
                    <p className="text-sm text-muted-foreground">Gem. Delay</p>
                    <p className="text-2xl font-bold">{data.delayStats[0]?.avgDelayMs.toFixed(0) || 0}ms</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          
          {/* Recommendations */}
          {data.recommendations.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                  Aanbevelingen
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {data.recommendations.map((rec, i) => (
                    <li key={i} className="text-sm">{rec}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          
          {/* Best Opportunities */}
          {data.bestOpportunities.length > 0 && (
            <Card className="border-green-500/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-green-600">
                  <TrendingUp className="h-5 w-5" />
                  Beste Kansen (Statistisch Significant)
                </CardTitle>
                <CardDescription>
                  Deze combinaties hebben bewezen hoge win rates met voldoende samples
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StrategyBucketTable buckets={data.bestOpportunities} />
              </CardContent>
            </Card>
          )}
          
          {/* Worst to Avoid */}
          {data.worstOpportunities.length > 0 && (
            <Card className="border-red-500/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-600">
                  <TrendingDown className="h-5 w-5" />
                  Te Vermijden (Statistisch Significant)
                </CardTitle>
                <CardDescription>
                  Deze combinaties hebben significant lage win rates - vermijd trades in deze condities
                </CardDescription>
              </CardHeader>
              <CardContent>
                <StrategyBucketTable buckets={data.worstOpportunities} />
              </CardContent>
            </Card>
          )}
          
          {/* Heatmap */}
          <OpportunityHeatmap buckets={data.buckets} />
          
          {/* All Buckets */}
          <Card>
            <CardHeader>
              <CardTitle>Alle Buckets</CardTitle>
              <CardDescription>
                Volledige analyse per combinatie van factoren. ★ = statistisch significant (z-score ≥ 1.96, n ≥ 10)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StrategyBucketTable buckets={data.buckets} showAll />
            </CardContent>
          </Card>
          
          {/* Delay Analysis */}
          <DelayAnalysisCard stats={data.delayStats} />
        </>
      ) : null}
    </div>
  );
}
