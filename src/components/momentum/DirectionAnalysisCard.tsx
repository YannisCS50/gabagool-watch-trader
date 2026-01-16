import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DirectionStats } from '@/hooks/useMomentumAnalysis';
import { ArrowUp, ArrowDown, TrendingUp, AlertTriangle } from 'lucide-react';

interface DirectionAnalysisCardProps {
  directionStats: DirectionStats[];
  isLoading?: boolean;
}

export function DirectionAnalysisCard({ directionStats, isLoading }: DirectionAnalysisCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse grid grid-cols-2 gap-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-24 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const upSmall = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'small');
  const upLarge = directionStats.find(d => d.direction === 'UP' && d.deltaSize === 'large');
  const downSmall = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'small');
  const downLarge = directionStats.find(d => d.direction === 'DOWN' && d.deltaSize === 'large');

  const renderCell = (stats: DirectionStats | undefined, label: string) => {
    if (!stats || stats.count === 0) {
      return (
        <div className="p-4 rounded-lg border bg-muted/30">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="text-lg text-muted-foreground">Geen data</div>
        </div>
      );
    }

    const isGood = stats.winRate >= 60;
    const isPoor = stats.winRate < 45;

    return (
      <div className={`p-4 rounded-lg border ${
        isGood ? 'bg-green-500/10 border-green-500/30' : 
        isPoor ? 'bg-red-500/10 border-red-500/30' : 
        'bg-muted/30'
      }`}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {stats.direction === 'UP' 
              ? <ArrowUp className="h-4 w-4 text-green-500" />
              : <ArrowDown className="h-4 w-4 text-red-500" />
            }
            <span className="text-sm font-medium">{label}</span>
          </div>
          <Badge variant="outline" className="text-xs">
            {stats.count} trades
          </Badge>
        </div>
        
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Win Rate</div>
            <div className={`font-bold ${isGood ? 'text-green-500' : isPoor ? 'text-red-500' : ''}`}>
              {stats.winRate.toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Persistence</div>
            <div className={stats.persistence >= 50 ? 'text-green-500' : 'text-red-500'}>
              {stats.persistence.toFixed(0)}%
            </div>
          </div>
        </div>

        {/* Insight */}
        <div className="mt-2 text-xs text-muted-foreground">
          {isGood && stats.persistence >= 60 && (
            <span className="text-green-500 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Robuust - counter-ticks negeren
            </span>
          )}
          {isPoor && (
            <span className="text-red-500 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Fragiel - voorzichtig
            </span>
          )}
          {!isGood && !isPoor && (
            <span>Gemiddeld - selectief traden</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          UP vs DOWN Analyse
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Vergelijk prestaties per richting en delta grootte
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {/* Headers */}
          <div className="text-center text-sm font-medium text-muted-foreground pb-2">
            Kleine Delta (&lt;$12)
          </div>
          <div className="text-center text-sm font-medium text-muted-foreground pb-2">
            Grote Delta (≥$12)
          </div>
          
          {/* UP row */}
          {renderCell(upSmall, 'UP Small')}
          {renderCell(upLarge, 'UP Large')}
          
          {/* DOWN row */}
          {renderCell(downSmall, 'DOWN Small')}
          {renderCell(downLarge, 'DOWN Large')}
        </div>

        {/* Key insight */}
        {upLarge && downLarge && (
          <div className="mt-4 p-3 rounded-lg bg-background border">
            <h4 className="text-sm font-medium mb-1">🎯 Key Insight</h4>
            <p className="text-sm text-muted-foreground">
              {upLarge.winRate > downLarge.winRate + 15 
                ? `UP-signalen presteren ${(upLarge.winRate - downLarge.winRate).toFixed(0)}% beter bij grote delta. Overweeg DOWN te skippen of voorzichtiger te traden.`
                : upLarge.winRate > downLarge.winRate
                ? `UP heeft een lichte edge over DOWN bij grote delta.`
                : `DOWN presteert vergelijkbaar of beter dan UP - beide richting kunnen getradet worden.`
              }
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
