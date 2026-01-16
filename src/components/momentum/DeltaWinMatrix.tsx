import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { DeltaBucketStats } from '@/hooks/useMomentumAnalysis';
import { 
  TrendingUp, 
  TrendingDown, 
  HelpCircle,
  CheckCircle,
  XCircle,
  AlertTriangle
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DeltaWinMatrixProps {
  bucketStats: DeltaBucketStats[];
  isLoading?: boolean;
}

export function DeltaWinMatrix({ bucketStats, isLoading }: DeltaWinMatrixProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-12 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const getWinRateColor = (rate: number) => {
    if (rate >= 70) return 'text-green-500';
    if (rate >= 55) return 'text-blue-500';
    if (rate >= 45) return 'text-yellow-500';
    return 'text-red-500';
  };

  const getVerdict = (bucket: DeltaBucketStats) => {
    if (bucket.count < 5) {
      return { icon: AlertTriangle, text: 'Te weinig data', color: 'text-muted-foreground' };
    }
    if (bucket.winRate >= 70) {
      return { icon: CheckCircle, text: 'Agressief kopen', color: 'text-green-500' };
    }
    if (bucket.winRate >= 55) {
      return { icon: TrendingUp, text: 'Normaal traden', color: 'text-blue-500' };
    }
    if (bucket.winRate >= 45) {
      return { icon: AlertTriangle, text: 'Voorzichtig', color: 'text-yellow-500' };
    }
    return { icon: XCircle, text: 'Vermijden', color: 'text-red-500' };
  };

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <CardTitle>Delta-Win Matrix</CardTitle>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <p className="text-xs">
                  <strong>Delta</strong> = Binance prijs - Strike prijs<br/>
                  <strong>Win Rate</strong> = % trades met positieve PnL<br/>
                  <strong>Persistence</strong> = % waar prijs in onze richting beweegt<br/>
                  <strong>Favorable</strong> = % waar prijs na 5s in goede richting staat
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Prestaties per delta bucket - grotere delta = stickier momentum
          </p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Delta Bucket</TableHead>
                <TableHead className="text-center">Aantal</TableHead>
                <TableHead className="text-center">Win Rate</TableHead>
                <TableHead className="text-center">Persistence</TableHead>
                <TableHead className="text-center">Gem. PnL</TableHead>
                <TableHead>Advies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bucketStats.map((bucket) => {
                const verdict = getVerdict(bucket);
                const VerdictIcon = verdict.icon;
                
                return (
                  <TableRow key={bucket.bucket}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono">
                        {bucket.bucket}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      {bucket.count}
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <span className={`font-bold ${getWinRateColor(bucket.winRate)}`}>
                          {bucket.winRate.toFixed(0)}%
                        </span>
                        <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                          <div 
                            className={`h-full ${bucket.winRate >= 50 ? 'bg-green-500' : 'bg-red-500'}`}
                            style={{ width: `${bucket.winRate}%` }}
                          />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className={bucket.avgPersistence >= 50 ? 'text-green-500' : 'text-red-500'}>
                        {bucket.avgPersistence.toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className={bucket.avgPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                        {bucket.avgPnl >= 0 ? '+' : ''}{bucket.avgPnl.toFixed(3)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className={`flex items-center gap-1 ${verdict.color}`}>
                        <VerdictIcon className="h-4 w-4" />
                        <span className="text-sm">{verdict.text}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
