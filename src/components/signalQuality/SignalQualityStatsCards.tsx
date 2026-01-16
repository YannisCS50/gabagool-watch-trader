import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SignalQualityStats } from '@/types/signalQuality';
import { AlertTriangle, CheckCircle, TrendingUp, TrendingDown, Target, XCircle } from 'lucide-react';

interface SignalQualityStatsCardsProps {
  stats: SignalQualityStats | null;
  isLoading?: boolean;
}

export function SignalQualityStatsCards({ stats, isLoading }: SignalQualityStatsCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <Card key={i} className="animate-pulse">
            <CardHeader className="pb-2">
              <div className="h-4 bg-muted rounded w-1/2" />
            </CardHeader>
            <CardContent>
              <div className="h-8 bg-muted rounded w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  
  if (!stats) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-8 text-center text-muted-foreground">
          No signal quality data available. Run the populate action to analyze signals.
        </CardContent>
      </Card>
    );
  }
  
  return (
    <div className="space-y-4">
      {/* Primary metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Target className="h-4 w-4" />
              Total Signals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSignals}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Positive Edge
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.pctPositiveEdge.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              {stats.signalsWithPositiveEdge} of {stats.totalSignals}
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Avg Edge (7s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.avgEdgeAfterSpread > 0 ? 'text-green-500' : 'text-red-500'}`}>
              {(stats.avgEdgeAfterSpread * 100).toFixed(2)}¢
            </div>
            <div className="text-xs text-muted-foreground">
              After spread cost
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              False Edges
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-500">
              {stats.falseEdgePct.toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              {stats.falseEdgeCount} signals looked good but weren't
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Should trade analysis */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="border-green-500/30 bg-green-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              SHOULD TRADE = TRUE
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-3xl font-bold text-green-500">
                  {stats.winRateWhenShouldTrade.toFixed(1)}%
                </div>
                <div className="text-sm text-muted-foreground">Win Rate</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-medium">{stats.shouldTradeCount}</div>
                <div className="text-xs text-muted-foreground">signals</div>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card className="border-red-500/30 bg-red-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              SHOULD TRADE = FALSE
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-3xl font-bold text-red-500">
                  {stats.winRateWhenShouldNotTrade.toFixed(1)}%
                </div>
                <div className="text-sm text-muted-foreground">Win Rate (when ignored)</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-medium">{stats.shouldNotTradeCount}</div>
                <div className="text-xs text-muted-foreground">signals</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Confidence warnings */}
      {stats.lowConfidencePct > 20 && (
        <Card className="border-amber-500/50 bg-amber-500/10">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <div>
                <div className="font-medium text-amber-500">LOW SAMPLE SIZE WARNING</div>
                <div className="text-sm text-muted-foreground">
                  {stats.lowConfidencePct.toFixed(0)}% of signals ({stats.lowConfidenceCount}) have 
                  bucket_confidence &lt; 0.6. Metrics may be statistically unreliable.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
