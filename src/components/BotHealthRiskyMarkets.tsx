import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { RiskyMarket } from '@/lib/botHealthMetrics';
import { format } from 'date-fns';

interface BotHealthRiskyMarketsProps {
  markets: RiskyMarket[];
}

export function BotHealthRiskyMarkets({ markets }: BotHealthRiskyMarketsProps) {
  const getSkewColor = (skew: number) => {
    if (skew > 85) return 'text-red-400';
    if (skew > 70) return 'text-yellow-400';
    return 'text-muted-foreground';
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case 'PAIRING':
        return <Badge className="bg-blue-500/20 text-blue-400">Pairing</Badge>;
      case 'UNWIND_ONLY':
        return <Badge className="bg-purple-500/20 text-purple-400">Unwind</Badge>;
      case 'ONE_SIDED':
        return <Badge className="bg-yellow-500/20 text-yellow-400">Eenzijdig</Badge>;
      default:
        return <Badge variant="outline">{state}</Badge>;
    }
  };

  if (markets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Top 10 Risky Markets (last 60 min)</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            Geen risicovolle markten gevonden
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Top 10 Risky Markets (last 60 min)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market ID</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">UP</TableHead>
                <TableHead className="text-right">DOWN</TableHead>
                <TableHead className="text-right">Skew%</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {markets.map((market, idx) => (
                <TableRow key={idx}>
                  <TableCell className="font-mono text-xs">
                    {market.marketId.slice(0, 12)}...
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{market.asset}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {format(market.windowStart, 'HH:mm')} - {format(market.windowEnd, 'HH:mm')}
                  </TableCell>
                  <TableCell className="text-right font-mono">{market.upShares}</TableCell>
                  <TableCell className="text-right font-mono">{market.downShares}</TableCell>
                  <TableCell className={`text-right font-mono ${getSkewColor(market.skewPct)}`}>
                    {market.skewPct.toFixed(1)}%
                  </TableCell>
                  <TableCell>{getStateBadge(market.state)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                    {market.notes || '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
