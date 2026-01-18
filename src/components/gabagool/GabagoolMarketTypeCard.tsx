import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, Zap } from 'lucide-react';
import { MarketTypeStats } from '@/hooks/useGabagoolDeltaAnalysis';

interface Props {
  data: MarketTypeStats[];
  isLoading?: boolean;
}

export function GabagoolMarketTypeCard({ data, isLoading }: Props) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Market Type Analyse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-48 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  const market15m = data.find(d => d.type === '15-minute');
  const market1hr = data.find(d => d.type === '1-hour');

  if (!market15m || !market1hr) return null;

  const total15m = market15m.upTrades + market15m.downTrades;
  const total1hr = market1hr.upTrades + market1hr.downTrades;
  const totalAll = total15m + total1hr;

  const vol15m = market15m.upVolume + market15m.downVolume;
  const vol1hr = market1hr.upVolume + market1hr.downVolume;

  const combined15m = market15m.avgUpPrice + market15m.avgDownPrice;
  const combined1hr = market1hr.avgUpPrice + market1hr.avgDownPrice;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          15-Minute vs 1-Hour Markten
        </CardTitle>
        <CardDescription>Welk markttype presteert beter?</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {/* 15-minute */}
          <div className="p-4 rounded-lg bg-muted/30 border border-primary/20">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-5 w-5 text-yellow-500" />
              <span className="font-bold">15-Minute</span>
              <Badge variant="outline" className="ml-auto">
                {((total15m / totalAll) * 100).toFixed(0)}%
              </Badge>
            </div>
            
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Trades</span>
                <span className="font-medium">{total15m.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Volume</span>
                <span className="font-medium">${(vol15m / 1000).toFixed(0)}K</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gem. UP prijs</span>
                <span className="font-medium text-green-500">{(market15m.avgUpPrice * 100).toFixed(1)}¢</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gem. DOWN prijs</span>
                <span className="font-medium text-red-500">{(market15m.avgDownPrice * 100).toFixed(1)}¢</span>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <span className="text-muted-foreground font-semibold">Combined Entry</span>
                <span className={`font-bold ${combined15m < 0.95 ? 'text-green-500' : combined15m < 1.0 ? 'text-yellow-500' : 'text-red-500'}`}>
                  {(combined15m * 100).toFixed(1)}¢
                </span>
              </div>
            </div>
          </div>

          {/* 1-hour */}
          <div className="p-4 rounded-lg bg-muted/30 border">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-5 w-5 text-blue-500" />
              <span className="font-bold">1-Hour</span>
              <Badge variant="outline" className="ml-auto">
                {((total1hr / totalAll) * 100).toFixed(0)}%
              </Badge>
            </div>
            
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Trades</span>
                <span className="font-medium">{total1hr.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Volume</span>
                <span className="font-medium">${(vol1hr / 1000).toFixed(0)}K</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gem. UP prijs</span>
                <span className="font-medium text-green-500">{(market1hr.avgUpPrice * 100).toFixed(1)}¢</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gem. DOWN prijs</span>
                <span className="font-medium text-red-500">{(market1hr.avgDownPrice * 100).toFixed(1)}¢</span>
              </div>
              <div className="flex justify-between pt-2 border-t">
                <span className="text-muted-foreground font-semibold">Combined Entry</span>
                <span className={`font-bold ${combined1hr < 0.95 ? 'text-green-500' : combined1hr < 1.0 ? 'text-yellow-500' : 'text-red-500'}`}>
                  {(combined1hr * 100).toFixed(1)}¢
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
          <strong>Conclusie:</strong> 15-minute markten hebben een iets lagere combined entry 
          ({(combined15m * 100).toFixed(1)}¢ vs {(combined1hr * 100).toFixed(1)}¢), wat suggereert dat 
          de snellere markten marginaal betere arbitrage kansen bieden.
        </div>
      </CardContent>
    </Card>
  );
}
