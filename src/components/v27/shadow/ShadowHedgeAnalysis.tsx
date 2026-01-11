import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Shield, Clock, AlertTriangle, XCircle, CheckCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HedgeAnalysisStats } from '@/hooks/useShadowPositions';

interface ShadowHedgeAnalysisProps {
  analysis: HedgeAnalysisStats;
}

export function ShadowHedgeAnalysis({ analysis }: ShadowHedgeAnalysisProps) {
  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <Card>
      <CardHeader className="pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Shield className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          Hedge Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="p-3 rounded-lg bg-muted/30 border">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="h-4 w-4 text-green-400" />
              <span className="text-xs text-muted-foreground">Success Rate</span>
            </div>
            <div className="text-xl sm:text-2xl font-bold text-green-400">
              {(analysis.hedgeSuccessRate * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {analysis.hedgedSuccessfully} / {analysis.totalPositions}
            </div>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-blue-400" />
              <span className="text-xs text-muted-foreground">Avg Latency</span>
            </div>
            <div className="text-xl sm:text-2xl font-bold text-foreground">
              {formatLatency(analysis.avgHedgeLatencyMs)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Entry → Hedge
            </div>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-4 w-4 text-orange-400" />
              <span className="text-xs text-muted-foreground">Emergency</span>
            </div>
            <div className="text-xl sm:text-2xl font-bold text-orange-400">
              {(analysis.emergencyHedgeRate * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {analysis.emergencyHedgeCount} positions
            </div>
          </div>

          <div className="p-3 rounded-lg bg-muted/30 border">
            <div className="flex items-center gap-2 mb-1">
              <XCircle className="h-4 w-4 text-red-400" />
              <span className="text-xs text-muted-foreground">Unhedged</span>
            </div>
            <div className="text-xl sm:text-2xl font-bold text-red-400">
              {(analysis.unhedgedExpiryRate * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {analysis.unhedgedExpiryCount} expired
            </div>
          </div>
        </div>

        {/* Latency Distribution */}
        <div>
          <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Hedge Latency Distribution
          </h4>
          <div className="space-y-2">
            {analysis.hedgeLatencyDistribution.map((bucket) => {
              const total = analysis.hedgeLatencyDistribution.reduce((s, b) => s + b.count, 0);
              const pct = total > 0 ? (bucket.count / total) * 100 : 0;
              
              return (
                <div key={bucket.bucket} className="flex items-center gap-3">
                  <div className="w-14 text-xs text-muted-foreground font-mono">
                    {bucket.bucket}
                  </div>
                  <div className="flex-1">
                    <Progress 
                      value={pct} 
                      className="h-2"
                    />
                  </div>
                  <div className="w-16 text-right">
                    <span className="text-xs font-mono">{bucket.count}</span>
                    <span className="text-xs text-muted-foreground ml-1">
                      ({pct.toFixed(0)}%)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Outcome Breakdown */}
        <div>
          <h4 className="text-sm font-medium mb-3">Position Outcomes</h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="p-2 rounded bg-green-500/10 border border-green-500/20 text-center">
              <div className="text-lg font-bold text-green-400">{analysis.hedgedSuccessfully}</div>
              <div className="text-xs text-muted-foreground">Paired/Hedged</div>
            </div>
            <div className="p-2 rounded bg-orange-500/10 border border-orange-500/20 text-center">
              <div className="text-lg font-bold text-orange-400">{analysis.emergencyHedgeCount}</div>
              <div className="text-xs text-muted-foreground">Emergency Exit</div>
            </div>
            <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-center">
              <div className="text-lg font-bold text-red-400">{analysis.unhedgedExpiryCount}</div>
              <div className="text-xs text-muted-foreground">Expired 1-Sided</div>
            </div>
            <div className="p-2 rounded bg-muted/30 border text-center">
              <div className="text-lg font-bold text-muted-foreground">
                {analysis.totalPositions - analysis.hedgedSuccessfully - analysis.emergencyHedgeCount - analysis.unhedgedExpiryCount}
              </div>
              <div className="text-xs text-muted-foreground">No Fill</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
