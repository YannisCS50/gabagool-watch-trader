import { forwardRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { V30Position, V30Config } from '@/hooks/useV30Data';

interface Props {
  positions: V30Position[];
  config: V30Config;
}

export const V30InventoryPanel = forwardRef<HTMLDivElement, Props>(({ positions, config }, ref) => {
  // Group positions by asset
  const byAsset = config.assets.reduce((acc, asset) => {
    const assetPositions = positions.filter(p => p.asset === asset);
    const up = assetPositions.filter(p => p.direction === 'UP').reduce((sum, p) => sum + p.shares, 0);
    const down = assetPositions.filter(p => p.direction === 'DOWN').reduce((sum, p) => sum + p.shares, 0);
    acc[asset] = { up, down, net: up - down };
    return acc;
  }, {} as Record<string, { up: number; down: number; net: number }>);

  const totalUp = Object.values(byAsset).reduce((sum, a) => sum + a.up, 0);
  const totalDown = Object.values(byAsset).reduce((sum, a) => sum + a.down, 0);
  const totalNet = totalUp - totalDown;
  const totalCost = positions.reduce((sum, p) => sum + p.total_cost, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Inventory
          <Badge variant={Math.abs(totalNet) > config.i_max_base * 0.8 ? 'destructive' : 'outline'}>
            Net: {totalNet > 0 ? '+' : ''}{totalNet}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Total Stats */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-green-400">{totalUp}</div>
            <div className="text-xs text-muted-foreground">UP Shares</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-400">{totalDown}</div>
            <div className="text-xs text-muted-foreground">DOWN Shares</div>
          </div>
          <div>
            <div className="text-2xl font-bold">${totalCost.toFixed(2)}</div>
            <div className="text-xs text-muted-foreground">Total Cost</div>
          </div>
        </div>

        {/* Per-Asset Breakdown */}
        <div className="space-y-3 pt-2 border-t">
          {config.assets.map(asset => {
            const data = byAsset[asset] || { up: 0, down: 0, net: 0 };
            const maxShares = Math.max(data.up, data.down, 1);
            const iMaxUsage = Math.abs(data.net) / config.i_max_base;
            
            return (
              <div key={asset} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{asset}</span>
                  <span className={`font-mono ${data.net > 0 ? 'text-green-400' : data.net < 0 ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {data.net > 0 ? '+' : ''}{data.net}
                  </span>
                </div>
                
                {/* Visual bar */}
                <div className="flex gap-1 h-4">
                  <div 
                    className="bg-green-500/50 rounded-l" 
                    style={{ width: `${(data.up / maxShares) * 50}%` }}
                  />
                  <div 
                    className="bg-red-500/50 rounded-r" 
                    style={{ width: `${(data.down / maxShares) * 50}%` }}
                  />
                </div>
                
                {/* I_max usage */}
                <div className="flex items-center gap-2">
                  <Progress 
                    value={iMaxUsage * 100} 
                    className="h-1.5" 
                  />
                  <span className="text-xs text-muted-foreground w-12">
                    {(iMaxUsage * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Position List */}
        {positions.length > 0 && (
          <div className="pt-2 border-t">
            <div className="text-sm font-medium mb-2">Open Positions ({positions.length})</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {positions.slice(0, 10).map(pos => (
                <div key={pos.id} className="flex items-center justify-between text-xs p-1.5 bg-muted rounded">
                  <div className="flex items-center gap-2">
                    <Badge variant={pos.direction === 'UP' ? 'default' : 'destructive'} className="text-[10px] px-1">
                      {pos.direction}
                    </Badge>
                    <span>{pos.asset}</span>
                  </div>
                  <div className="text-right">
                    <span className="font-mono">{pos.shares} sh</span>
                    <span className="text-muted-foreground ml-2">@ {(pos.avg_entry_price * 100).toFixed(1)}¢</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

V30InventoryPanel.displayName = 'V30InventoryPanel';
