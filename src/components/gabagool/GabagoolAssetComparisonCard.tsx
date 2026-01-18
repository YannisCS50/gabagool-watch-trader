import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Coins, TrendingUp, TrendingDown } from 'lucide-react';
import { AssetBreakdown } from '@/hooks/useGabagoolDeltaAnalysis';

interface Props {
  data: AssetBreakdown[];
  isLoading?: boolean;
}

export function GabagoolAssetComparisonCard({ data, isLoading }: Props) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Asset Vergelijking
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  const totalVolume = data.reduce((sum, d) => sum + d.upVolume + d.downVolume, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5" />
          Asset Vergelijking: BTC vs ETH
        </CardTitle>
        <CardDescription>Presteert Gabagool beter op BTC of ETH?</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {data.map((asset) => {
            const volume = asset.upVolume + asset.downVolume;
            const pct = (volume / totalVolume) * 100;
            const combinedEntryColor = asset.combinedEntry < 0.95 
              ? 'text-green-500' 
              : asset.combinedEntry < 1.0 
                ? 'text-yellow-500' 
                : 'text-red-500';

            return (
              <div key={asset.asset} className="p-4 rounded-lg bg-muted/30 border">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-bold">{asset.asset}</span>
                    <Badge variant="outline">{pct.toFixed(0)}% van volume</Badge>
                  </div>
                  <div className={`text-lg font-bold ${combinedEntryColor}`}>
                    {(asset.combinedEntry * 100).toFixed(1)}¢ entry
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-green-500" />
                    <div>
                      <div className="text-muted-foreground">UP</div>
                      <div className="font-medium">
                        {asset.upTrades.toLocaleString()} trades @ {(asset.avgUpPrice * 100).toFixed(1)}¢
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ${(asset.upVolume / 1000).toFixed(0)}K volume
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <TrendingDown className="h-4 w-4 text-red-500" />
                    <div>
                      <div className="text-muted-foreground">DOWN</div>
                      <div className="font-medium">
                        {asset.downTrades.toLocaleString()} trades @ {(asset.avgDownPrice * 100).toFixed(1)}¢
                      </div>
                      <div className="text-xs text-muted-foreground">
                        ${(asset.downVolume / 1000).toFixed(0)}K volume
                      </div>
                    </div>
                  </div>
                </div>

                {/* Progress bar showing volume split */}
                <div className="mt-3">
                  <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                    <div 
                      className="bg-green-500" 
                      style={{ width: `${(asset.upVolume / volume) * 100}%` }}
                    />
                    <div 
                      className="bg-red-500" 
                      style={{ width: `${(asset.downVolume / volume) * 100}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>UP {((asset.upVolume / volume) * 100).toFixed(0)}%</span>
                    <span>DOWN {((asset.downVolume / volume) * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
          <strong>Analyse:</strong> Gabagool handhaaft vrijwel identieke combined entries voor BTC en ETH, 
          wat suggereert dat de strategie asset-agnostisch is en puur op spread-arbitrage focust.
        </div>
      </CardContent>
    </Card>
  );
}
