import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { V29Signal } from '@/hooks/useV29Data';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface Props {
  signals: V29Signal[];
  assets: string[];
}

export function V29LiveStatus({ signals, assets }: Props) {
  // Get latest signal per asset
  const latestByAsset = assets.reduce((acc, asset) => {
    const latest = signals.find(s => s.asset === asset);
    if (latest) acc[asset] = latest;
    return acc;
  }, {} as Record<string, V29Signal>);

  const formatPrice = (price: number) => {
    if (!price) return '-';
    if (price >= 1000) return `$${(price / 1000).toFixed(1)}k`;
    return `$${price.toFixed(2)}`;
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('nl-NL', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Live Market Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {assets.map(asset => {
            const signal = latestByAsset[asset];
            const isUp = signal?.direction === 'UP';
            
            return (
              <div key={asset} className="p-3 bg-muted/30 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold">{asset}</span>
                  {signal ? (
                    <Badge variant={isUp ? 'default' : 'secondary'} className="text-xs">
                      {isUp ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                      {signal.direction}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">No data</Badge>
                  )}
                </div>
                
                {signal && (
                  <>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Binance</span>
                        <p className="font-mono">{formatPrice(signal.binance_price)}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Strike</span>
                        <p className="font-mono">{formatPrice(signal.strike_price)}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-muted-foreground">Share</span>
                        <p className="font-mono">{((signal.share_price || 0) * 100).toFixed(1)}¢</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Δ</span>
                        <p className={`font-mono ${(signal.delta_usd || 0) > 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {(signal.delta_usd || 0) > 0 ? '+' : ''}{(signal.delta_usd || 0).toFixed(1)}
                        </p>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTime(signal.created_at)}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
