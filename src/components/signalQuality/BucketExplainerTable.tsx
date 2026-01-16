import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { BucketAggregation } from '@/types/signalQuality';
import { 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  TrendingUp, 
  TrendingDown,
  HelpCircle,
  Zap
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface BucketExplainerTableProps {
  aggregations: BucketAggregation[];
  isLoading?: boolean;
}

export function BucketExplainerTable({ aggregations, isLoading }: BucketExplainerTableProps) {
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
  
  if (aggregations.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Geen bucket data beschikbaar. Klik op "Populate" om te analyseren.
        </CardContent>
      </Card>
    );
  }
  
  // Find best and worst buckets
  const validBuckets = aggregations.filter(b => !b.isLowSample);
  const bestBucket = validBuckets.reduce((a, b) => a.winRate > b.winRate ? a : b, validBuckets[0]);
  const worstBucket = validBuckets.reduce((a, b) => a.winRate < b.winRate ? a : b, validBuckets[0]);
  
  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Prestaties per Delta Bucket</CardTitle>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <div className="font-medium mb-1">Wat zijn Delta Buckets?</div>
                <p className="text-xs">
                  Delta buckets groeperen signalen op basis van hoe groot de prijsafwijking was. 
                  Bijvoorbeeld: d0-20 = kleine afwijkingen ($0-$20), d50-100 = grote afwijkingen ($50-$100).
                  Grotere afwijkingen hebben vaak meer edge maar komen minder vaak voor.
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
          
        <div className="text-sm text-muted-foreground mt-2 space-y-1">
            <p>
              Deze tabel toont hoe goed elke "delta bucket" presteert. 
              De <span className="text-foreground font-medium">delta</span> is het verschil tussen de 
              live spot prijs (Binance/Chainlink) en de strike prijs van de markt.
            </p>
            <p>
              <span className="text-green-500">●</span> Groen = winstgevend bucket | 
              <span className="text-red-500 ml-2">●</span> Rood = verliezend bucket | 
              <span className="text-muted-foreground ml-2">●</span> Grijs = te weinig data
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {/* Quick insights */}
          {validBuckets.length >= 2 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
                <div className="flex items-center gap-2 text-green-500 font-medium mb-1">
                  <TrendingUp className="h-4 w-4" />
                  Beste Bucket: {bestBucket?.bucket}
                </div>
                <div className="text-sm text-muted-foreground">
                  Win rate: {bestBucket?.winRate.toFixed(0)}% | Edge: {bestBucket?.avgEdge.toFixed(2)}¢ | 
                  {bestBucket?.count} trades
                </div>
              </div>
              
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <div className="flex items-center gap-2 text-red-500 font-medium mb-1">
                  <TrendingDown className="h-4 w-4" />
                  Slechtste Bucket: {worstBucket?.bucket}
                </div>
                <div className="text-sm text-muted-foreground">
                  Win rate: {worstBucket?.winRate.toFixed(0)}% | Edge: {worstBucket?.avgEdge.toFixed(2)}¢ | 
                  {worstBucket?.count} trades
                </div>
              </div>
            </div>
          )}
          
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <div className="flex items-center gap-1">
                    Delta Bucket
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        De prijsafwijking range in dollars. Voorbeeld: d20-50 betekent $20-$50 afwijking.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    Aantal
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        Hoeveel signalen in deze bucket vallen. Minimaal 30 nodig voor betrouwbare stats.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    Gem. Edge
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        Gemiddelde winst per share in centen, na aftrek van spread kosten.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    Win Rate
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <HelpCircle className="h-3 w-3 text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent>
                        Percentage van trades die winst maakten. Boven 50% is winstgevend.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead>Oordeel</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aggregations.map((bucket) => {
                const verdict = getVerdict(bucket);
                
                return (
                  <TableRow 
                    key={bucket.bucket}
                    className={bucket.isLowSample ? 'opacity-50' : ''}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge 
                          variant={bucket.winRate >= 50 && !bucket.isLowSample ? 'default' : 'outline'}
                          className={bucket.winRate >= 50 && !bucket.isLowSample ? 'bg-green-500' : ''}
                        >
                          {bucket.bucket}
                        </Badge>
                        {bucket.isLowSample && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="h-4 w-4 text-amber-500" />
                            </TooltipTrigger>
                            <TooltipContent>
                              Minder dan 30 samples - data is onbetrouwbaar
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono">{bucket.count.toLocaleString()}</span>
                      {bucket.count < 30 && (
                        <span className="text-amber-500 text-xs ml-1">(min 30)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`font-mono font-medium ${
                        bucket.avgEdge > 0 ? 'text-green-500' : 'text-red-500'
                      }`}>
                        {bucket.avgEdge >= 0 ? '+' : ''}{bucket.avgEdge.toFixed(2)}¢
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Progress 
                          value={bucket.winRate} 
                          className={`w-20 h-2 ${bucket.winRate >= 50 ? '[&>div]:bg-green-500' : '[&>div]:bg-red-500'}`}
                        />
                        <span className={`font-mono text-sm font-medium ${
                          bucket.winRate >= 50 ? 'text-green-500' : 'text-red-500'
                        }`}>
                          {bucket.winRate.toFixed(0)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {verdict.icon}
                        <span className={`text-sm ${verdict.color}`}>{verdict.text}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          
          {/* Legend / explanation */}
          <div className="mt-6 p-4 rounded-lg bg-muted/50">
            <div className="font-medium mb-2">📊 Hoe deze tabel te lezen</div>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>
                <span className="text-green-500 font-medium">✓ Traden</span> - Win rate ≥55% en positieve edge. Dit zijn je beste buckets.
              </li>
              <li>
                <span className="text-amber-500 font-medium">⚠ Voorzichtig</span> - Win rate 45-55%. Breakeven of licht winstgevend.
              </li>
              <li>
                <span className="text-red-500 font-medium">✕ Vermijden</span> - Win rate &lt;45%. Je verliest geld in deze buckets.
              </li>
              <li>
                <span className="text-muted-foreground font-medium">? Onbekend</span> - Te weinig data om te beoordelen. Wacht op meer samples.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

function getVerdict(bucket: BucketAggregation): { icon: React.ReactNode; text: string; color: string } {
  if (bucket.isLowSample) {
    return {
      icon: <HelpCircle className="h-4 w-4 text-muted-foreground" />,
      text: 'Te weinig data',
      color: 'text-muted-foreground'
    };
  }
  
  if (bucket.winRate >= 55 && bucket.avgEdge > 0) {
    return {
      icon: <CheckCircle className="h-4 w-4 text-green-500" />,
      text: 'Traden!',
      color: 'text-green-500'
    };
  }
  
  if (bucket.winRate >= 50 && bucket.avgEdge > 0) {
    return {
      icon: <TrendingUp className="h-4 w-4 text-green-500" />,
      text: 'OK',
      color: 'text-green-500'
    };
  }
  
  if (bucket.winRate >= 45) {
    return {
      icon: <AlertTriangle className="h-4 w-4 text-amber-500" />,
      text: 'Voorzichtig',
      color: 'text-amber-500'
    };
  }
  
  return {
    icon: <XCircle className="h-4 w-4 text-red-500" />,
    text: 'Vermijden!',
    color: 'text-red-500'
  };
}
