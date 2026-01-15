import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { V30Tick } from '@/hooks/useV30Data';

interface Props {
  ticks: V30Tick[];
  assets: string[];
}

export function V30LiveStatus({ ticks, assets }: Props) {
  // Get latest tick per asset
  const latestByAsset = assets.reduce((acc, asset) => {
    const latest = ticks.find(t => t.asset === asset);
    if (latest) acc[asset] = latest;
    return acc;
  }, {} as Record<string, V30Tick>);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {assets.map(asset => {
        const tick = latestByAsset[asset];
        
        if (!tick) {
          return (
            <Card key={asset} className="opacity-50">
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center justify-between">
                  {asset}
                  <Badge variant="outline">No data</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Waiting for ticks...</p>
              </CardContent>
            </Card>
          );
        }

        const secRemaining = tick.seconds_remaining ?? 0;
        const isExpiring = secRemaining < 60;
        const fairP = tick.fair_p_up ?? 0.5;
        const edgeUp = (tick.edge_up ?? 0) * 100;
        const edgeDown = (tick.edge_down ?? 0) * 100;
        const theta = (tick.theta_current ?? 0) * 100;

        return (
          <Card key={asset} className={isExpiring ? 'border-destructive' : ''}>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center justify-between">
                {asset}
                <Badge variant={secRemaining > 300 ? 'default' : secRemaining > 60 ? 'secondary' : 'destructive'}>
                  {Math.floor(secRemaining / 60)}:{String(Math.floor(secRemaining % 60)).padStart(2, '0')}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Prices */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Binance:</span>
                  <span className="ml-1 font-mono">${tick.c_price?.toFixed(0) ?? '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Strike:</span>
                  <span className="ml-1 font-mono">${tick.strike_price?.toFixed(0) ?? '-'}</span>
                </div>
              </div>

              {/* Fair Value */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Fair P(UP):</span>
                <span className="font-mono text-sm">
                  {(fairP * 100).toFixed(1)}%
                </span>
              </div>

              {/* Edges */}
              <div className="grid grid-cols-2 gap-2">
                <div className={`p-2 rounded text-center ${edgeUp < -theta ? 'bg-green-500/20 text-green-400' : 'bg-muted'}`}>
                  <div className="text-xs text-muted-foreground">Edge UP</div>
                  <div className="font-mono text-sm">{edgeUp.toFixed(1)}%</div>
                </div>
                <div className={`p-2 rounded text-center ${edgeDown < -theta ? 'bg-red-500/20 text-red-400' : 'bg-muted'}`}>
                  <div className="text-xs text-muted-foreground">Edge DOWN</div>
                  <div className="font-mono text-sm">{edgeDown.toFixed(1)}%</div>
                </div>
              </div>

              {/* Threshold */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Threshold θ:</span>
                <span className="font-mono">{theta.toFixed(1)}%</span>
              </div>

              {/* Inventory */}
              <div className="border-t pt-2">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Inventory:</span>
                  <span className={`font-mono ${tick.inventory_net > 0 ? 'text-green-400' : tick.inventory_net < 0 ? 'text-red-400' : ''}`}>
                    {tick.inventory_net > 0 ? '+' : ''}{tick.inventory_net}
                  </span>
                </div>
                <div className="flex gap-2 text-xs">
                  <Badge variant="outline" className="text-green-400">↑ {tick.inventory_up}</Badge>
                  <Badge variant="outline" className="text-red-400">↓ {tick.inventory_down}</Badge>
                </div>
              </div>

              {/* Last Action */}
              {tick.action_taken && tick.action_taken !== 'none' && (
                <Badge className="w-full justify-center" variant={
                  tick.action_taken.includes('buy_up') ? 'default' :
                  tick.action_taken.includes('buy_down') ? 'destructive' :
                  'secondary'
                }>
                  {tick.action_taken.replace('_', ' ').toUpperCase()}
                </Badge>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
