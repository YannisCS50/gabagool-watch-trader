import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GitCompare, TrendingUp, TrendingDown, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShadowPosition } from '@/hooks/useShadowPositions';

interface ShadowCounterfactualPanelProps {
  positions: ShadowPosition[];
  evaluations: any[];
}

export function ShadowCounterfactualPanel({ positions, evaluations }: ShadowCounterfactualPanelProps) {
  const analysis = useMemo(() => {
    // Signal-only analysis: what if we just looked at signals without execution?
    const entrySignals = evaluations.filter((e) => e.action === 'ENTRY' || e.signal_valid);
    const skippedSignals = evaluations.filter((e) => e.action === 'SKIP' && !e.signal_valid);

    // How many signals were correct (mispricing resolved in our favor)?
    const correctSignals = evaluations.filter((e) => {
      // Use tracking data if available
      return e.signal_was_correct || e.would_have_profited;
    }).length;

    // Execution analysis
    const executedPositions = positions.filter((p) => p.resolution !== 'NO_FILL' && p.resolution !== 'OPEN');
    const profitableExecutions = executedPositions.filter((p) => (p.net_pnl || 0) > 0);
    const losingExecutions = executedPositions.filter((p) => (p.net_pnl || 0) < 0);

    // Good signals that failed due to execution
    const goodSignalsFailedExecution = positions.filter((p) => {
      // Signal was correct (mispricing in our favor) but we lost due to execution
      return p.mispricing_at_entry > 0.02 && (p.net_pnl || 0) < 0;
    }).length;

    // Bad signals saved by hedging
    const badSignalsSavedByHedge = positions.filter((p) => {
      // Small mispricing but we still profited due to good hedge
      return p.mispricing_at_entry < 0.02 && (p.net_pnl || 0) > 0 && p.paired;
    }).length;

    // Total PnL comparison
    const signalOnlyPnl = evaluations
      .filter((e) => e.would_have_profited)
      .reduce((sum, e) => sum + (e.simulated_cpp ? (1 - e.simulated_cpp) * 50 : 0.5), 0);

    const executedPnl = positions.reduce((sum, p) => sum + (p.net_pnl || 0), 0);

    // Maker vs Taker analysis
    const makerFills = positions.filter((p) => p.entry_fill_type === 'MAKER');
    const takerFills = positions.filter((p) => p.entry_fill_type === 'TAKER');
    const makerPnl = makerFills.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
    const takerPnl = takerFills.reduce((sum, p) => sum + (p.net_pnl || 0), 0);

    // Early vs Late hedge analysis
    const earlyHedges = positions.filter((p) => p.hedge_latency_ms && p.hedge_latency_ms < 10000);
    const lateHedges = positions.filter((p) => p.hedge_latency_ms && p.hedge_latency_ms >= 10000);
    const earlyHedgePnl = earlyHedges.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
    const lateHedgePnl = lateHedges.reduce((sum, p) => sum + (p.net_pnl || 0), 0);

    return {
      signalOnlyPnl,
      executedPnl,
      signalSuccessRate: entrySignals.length > 0 ? correctSignals / entrySignals.length : 0,
      executionSuccessRate: executedPositions.length > 0 ? profitableExecutions.length / executedPositions.length : 0,
      goodSignalsFailedExecution,
      badSignalsSavedByHedge,
      totalSignals: entrySignals.length,
      totalExecuted: executedPositions.length,
      makerStats: {
        count: makerFills.length,
        pnl: makerPnl,
        avgPnl: makerFills.length > 0 ? makerPnl / makerFills.length : 0,
      },
      takerStats: {
        count: takerFills.length,
        pnl: takerPnl,
        avgPnl: takerFills.length > 0 ? takerPnl / takerFills.length : 0,
      },
      earlyHedgeStats: {
        count: earlyHedges.length,
        pnl: earlyHedgePnl,
        avgPnl: earlyHedges.length > 0 ? earlyHedgePnl / earlyHedges.length : 0,
      },
      lateHedgeStats: {
        count: lateHedges.length,
        pnl: lateHedgePnl,
        avgPnl: lateHedges.length > 0 ? lateHedgePnl / lateHedges.length : 0,
      },
    };
  }, [positions, evaluations]);

  return (
    <Card>
      <CardHeader className="pb-3 px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <GitCompare className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          Counterfactual Analysis
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Signal vs Execution Comparison */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-lg bg-muted/30 border">
            <h4 className="text-sm font-medium text-muted-foreground mb-3">Signal-Only Estimate</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Theoretical PnL:</span>
                <span className={cn(
                  "font-mono font-bold",
                  analysis.signalOnlyPnl >= 0 ? "text-green-400" : "text-red-400"
                )}>
                  {analysis.signalOnlyPnl >= 0 ? '+' : ''}${analysis.signalOnlyPnl.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Success Rate:</span>
                <span className="font-mono">{(analysis.signalSuccessRate * 100).toFixed(1)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total Signals:</span>
                <span className="font-mono">{analysis.totalSignals}</span>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-lg bg-muted/30 border">
            <h4 className="text-sm font-medium text-muted-foreground mb-3">Actual Execution</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Realized PnL:</span>
                <span className={cn(
                  "font-mono font-bold",
                  analysis.executedPnl >= 0 ? "text-green-400" : "text-red-400"
                )}>
                  {analysis.executedPnl >= 0 ? '+' : ''}${analysis.executedPnl.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Success Rate:</span>
                <span className="font-mono">{(analysis.executionSuccessRate * 100).toFixed(1)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total Executed:</span>
                <span className="font-mono">{analysis.totalExecuted}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Slippage Analysis */}
        <div className="p-4 rounded-lg bg-muted/20 border">
          <h4 className="text-sm font-medium mb-3">Execution Quality Analysis</h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-400" />
              <div>
                <div className="text-sm font-medium">{analysis.goodSignalsFailedExecution}</div>
                <div className="text-xs text-muted-foreground">Good signals, bad execution</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-400" />
              <div>
                <div className="text-sm font-medium">{analysis.badSignalsSavedByHedge}</div>
                <div className="text-xs text-muted-foreground">Weak signals saved by hedge</div>
              </div>
            </div>
          </div>
        </div>

        {/* Maker vs Taker */}
        <div>
          <h4 className="text-sm font-medium mb-3">Maker vs Taker Performance</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-blue-400">MAKER</span>
                <Badge variant="outline" className="text-xs">{analysis.makerStats.count}</Badge>
              </div>
              <div className={cn(
                "text-lg font-bold font-mono",
                analysis.makerStats.pnl >= 0 ? "text-green-400" : "text-red-400"
              )}>
                {analysis.makerStats.pnl >= 0 ? '+' : ''}${analysis.makerStats.pnl.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">
                Avg: ${analysis.makerStats.avgPnl.toFixed(2)}/trade
              </div>
            </div>
            <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-purple-400">TAKER</span>
                <Badge variant="outline" className="text-xs">{analysis.takerStats.count}</Badge>
              </div>
              <div className={cn(
                "text-lg font-bold font-mono",
                analysis.takerStats.pnl >= 0 ? "text-green-400" : "text-red-400"
              )}>
                {analysis.takerStats.pnl >= 0 ? '+' : ''}${analysis.takerStats.pnl.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">
                Avg: ${analysis.takerStats.avgPnl.toFixed(2)}/trade
              </div>
            </div>
          </div>
        </div>

        {/* Early vs Late Hedge */}
        <div>
          <h4 className="text-sm font-medium mb-3">Hedge Timing Impact</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-green-400">EARLY (&lt;10s)</span>
                <Badge variant="outline" className="text-xs">{analysis.earlyHedgeStats.count}</Badge>
              </div>
              <div className={cn(
                "text-lg font-bold font-mono",
                analysis.earlyHedgeStats.pnl >= 0 ? "text-green-400" : "text-red-400"
              )}>
                {analysis.earlyHedgeStats.pnl >= 0 ? '+' : ''}${analysis.earlyHedgeStats.pnl.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">
                Avg: ${analysis.earlyHedgeStats.avgPnl.toFixed(2)}/trade
              </div>
            </div>
            <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-orange-400">LATE (≥10s)</span>
                <Badge variant="outline" className="text-xs">{analysis.lateHedgeStats.count}</Badge>
              </div>
              <div className={cn(
                "text-lg font-bold font-mono",
                analysis.lateHedgeStats.pnl >= 0 ? "text-green-400" : "text-red-400"
              )}>
                {analysis.lateHedgeStats.pnl >= 0 ? '+' : ''}${analysis.lateHedgeStats.pnl.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">
                Avg: ${analysis.lateHedgeStats.avgPnl.toFixed(2)}/trade
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
