import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Shield, TrendingUp, TrendingDown, Waves, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AdverseMetrics {
  window: string;
  takerVolume: number;
  takerVolumePercentile: number;
  buyImbalance: number;
  depthDepletionRate: number;
  spreadWideningRate: number;
  toxicityScore: number;
}

interface BlockedTrade {
  timestamp: number;
  reason: 'FLOW_SPIKE' | 'DEPTH_VACUUM' | 'SPREAD_BLOWOUT' | 'UNKNOWN';
  asset: string;
}

interface AdverseSelectionPanelProps {
  metrics: {
    '1s': AdverseMetrics;
    '5s': AdverseMetrics;
    '10s': AdverseMetrics;
  };
  blockedTrades: BlockedTrade[];
  totalBlocked: number;
}

const BLOCK_REASON_LABELS: Record<string, { label: string; color: string }> = {
  FLOW_SPIKE: { label: 'Flow Spike', color: 'text-red-400' },
  DEPTH_VACUUM: { label: 'Depth Vacuum', color: 'text-orange-400' },
  SPREAD_BLOWOUT: { label: 'Spread Blowout', color: 'text-amber-400' },
  UNKNOWN: { label: 'Unknown', color: 'text-muted-foreground' },
};

export function AdverseSelectionPanel({ metrics, blockedTrades, totalBlocked }: AdverseSelectionPanelProps) {
  const windows = ['1s', '5s', '10s'] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Shield className="h-5 w-5 text-amber-400" />
          Adverse Selection Panel
          {totalBlocked > 0 && (
            <Badge variant="destructive" className="ml-2">
              {totalBlocked} blocked
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Rolling window analysis: 1s / 5s / 10s
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Metrics Grid */}
        <div className="grid grid-cols-3 gap-4">
          {windows.map((w) => {
            const m = metrics[w];
            const toxicityColor = m.toxicityScore < 0.3 ? 'text-green-400' : 
                                  m.toxicityScore < 0.6 ? 'text-amber-400' : 'text-red-400';
            
            return (
              <div key={w} className="p-4 rounded-lg bg-muted/30 space-y-3">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="font-mono">{w}</Badge>
                  <span className={cn("text-lg font-bold", toxicityColor)}>
                    {(m.toxicityScore * 100).toFixed(0)}%
                  </span>
                </div>
                
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Taker Vol:</span>
                    <span className="font-mono">{m.takerVolume.toFixed(0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Vol P%ile:</span>
                    <span className={cn(
                      "font-mono",
                      m.takerVolumePercentile > 90 ? "text-red-400" : "text-muted-foreground"
                    )}>
                      P{m.takerVolumePercentile.toFixed(0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Buy Imbal:</span>
                    <span className={cn(
                      "font-mono",
                      Math.abs(m.buyImbalance) > 0.3 ? "text-amber-400" : "text-muted-foreground"
                    )}>
                      {m.buyImbalance >= 0 ? '+' : ''}{(m.buyImbalance * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Depth Depl:</span>
                    <span className={cn(
                      "font-mono",
                      m.depthDepletionRate > 0.5 ? "text-red-400" : "text-muted-foreground"
                    )}>
                      {(m.depthDepletionRate * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Spread Δ:</span>
                    <span className={cn(
                      "font-mono",
                      m.spreadWideningRate > 0.2 ? "text-amber-400" : "text-muted-foreground"
                    )}>
                      {m.spreadWideningRate >= 0 ? '+' : ''}{(m.spreadWideningRate * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                
                <Progress 
                  value={m.toxicityScore * 100} 
                  className={cn(
                    "h-2",
                    m.toxicityScore > 0.6 && "[&>div]:bg-red-500",
                    m.toxicityScore > 0.3 && m.toxicityScore <= 0.6 && "[&>div]:bg-amber-500"
                  )}
                />
              </div>
            );
          })}
        </div>

        {/* Block Reason Breakdown */}
        {blockedTrades.length > 0 && (
          <div className="pt-4 border-t">
            <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              Recent Blocks
            </h4>
            <div className="space-y-2">
              {blockedTrades.slice(0, 5).map((bt, i) => (
                <div key={i} className="flex items-center justify-between text-sm p-2 rounded bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{bt.asset}</Badge>
                    <span className={BLOCK_REASON_LABELS[bt.reason]?.color || 'text-muted-foreground'}>
                      {BLOCK_REASON_LABELS[bt.reason]?.label || bt.reason}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(bt.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
