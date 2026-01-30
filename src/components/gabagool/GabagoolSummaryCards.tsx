import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, DollarSign, BarChart3, Clock, Target } from 'lucide-react';

interface SummaryProps {
  summary: {
    totalTrades: number;
    totalVolume: number;
    upVolume: number;
    downVolume: number;
    avgUpPrice: number;
    avgDownPrice: number;
    combinedEntry: number;
    upPct: number;
    is15mPct: number;
  };
  isLoading?: boolean;
}

export function GabagoolSummaryCards({ summary, isLoading }: SummaryProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <Card key={i}>
            <CardContent className="pt-4">
              <div className="h-8 bg-muted animate-pulse rounded mb-2" />
              <div className="h-4 bg-muted animate-pulse rounded w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const combinedEntryColor = summary.combinedEntry < 0.95 
    ? 'text-green-500' 
    : summary.combinedEntry < 1.0 
      ? 'text-yellow-500' 
      : 'text-red-500';

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="text-2xl font-bold">{summary.totalTrades.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">Totaal Trades</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="text-2xl font-bold">${(summary.totalVolume / 1000).toFixed(0)}K</div>
          <div className="text-xs text-muted-foreground">Totaal Volume</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <Target className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className={`text-2xl font-bold ${combinedEntryColor}`}>
            {(summary.combinedEntry * 100).toFixed(1)}¢
          </div>
          <div className="text-xs text-muted-foreground">Combined Entry</div>
          <Badge 
            variant="outline" 
            className={`text-xs mt-1 ${
              summary.combinedEntry < 0.95 
                ? 'bg-green-500/10 text-green-500' 
                : summary.combinedEntry < 1.0 
                  ? 'bg-yellow-500/10 text-yellow-500' 
                  : 'bg-red-500/10 text-red-500'
            }`}
          >
            {summary.combinedEntry < 0.95 ? 'Winstgevend' : summary.combinedEntry < 1.0 ? 'Break-even' : 'Verlies'}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-4 w-4 text-green-500" />
          </div>
          <div className="text-2xl font-bold">{(summary.avgUpPrice * 100).toFixed(1)}¢</div>
          <div className="text-xs text-muted-foreground">Gem. UP Prijs</div>
          <div className="text-xs text-green-500 mt-1">
            ${(summary.upVolume / 1000).toFixed(0)}K volume
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="h-4 w-4 text-red-500" />
          </div>
          <div className="text-2xl font-bold">{(summary.avgDownPrice * 100).toFixed(1)}¢</div>
          <div className="text-xs text-muted-foreground">Gem. DOWN Prijs</div>
          <div className="text-xs text-red-500 mt-1">
            ${(summary.downVolume / 1000).toFixed(0)}K volume
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="text-2xl font-bold">{summary.is15mPct.toFixed(0)}%</div>
          <div className="text-xs text-muted-foreground">15-min markten</div>
          <Badge variant="outline" className="text-xs mt-1">
            {summary.is15mPct > 70 ? 'Quick turnaround' : 'Mixed'}
          </Badge>
        </CardContent>
      </Card>
    </div>
  );
}
