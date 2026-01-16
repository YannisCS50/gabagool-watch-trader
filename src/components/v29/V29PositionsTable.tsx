import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { V29Position } from '@/hooks/useV29Data';
import { Shield, Clock, TrendingUp, TrendingDown } from 'lucide-react';

interface Props {
  positions: V29Position[];
}

export function V29PositionsTable({ positions }: Props) {
  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleTimeString('nl-NL', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const unpairedPositions = positions.filter(p => !p.is_fully_hedged);
  const pairedPositions = positions.filter(p => p.is_fully_hedged);

  return (
    <div className="space-y-4">
      {/* Unpaired Positions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4 text-orange-500" />
            Unpaired Positions
            <Badge variant="outline" className="ml-2">{unpairedPositions.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {unpairedPositions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No unpaired positions</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Asset</TableHead>
                  <TableHead className="w-20">Side</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unpairedPositions.slice(0, 20).map((pos) => {
                  const ageMs = Date.now() - new Date(pos.created_at).getTime();
                  const ageSec = Math.floor(ageMs / 1000);
                  const isUp = pos.side === 'UP';
                  
                  return (
                    <TableRow key={pos.id}>
                      <TableCell className="font-medium">{pos.asset}</TableCell>
                      <TableCell>
                        <Badge variant={isUp ? 'default' : 'secondary'} className="text-xs">
                          {isUp ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                          {pos.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{pos.total_shares}</TableCell>
                      <TableCell className="text-right font-mono">${pos.total_cost.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Paired Positions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-green-500" />
            Hedged Positions (Profit Locked)
            <Badge variant="outline" className="ml-2">{pairedPositions.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pairedPositions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No hedged positions yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Asset</TableHead>
                  <TableHead className="w-20">Side</TableHead>
                  <TableHead className="text-right">Shares</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Hedge</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairedPositions.slice(0, 20).map((pos) => {
                  const isUp = pos.side === 'UP';
                  
                  return (
                    <TableRow key={pos.id}>
                      <TableCell className="font-medium">{pos.asset}</TableCell>
                      <TableCell>
                        <Badge variant={isUp ? 'default' : 'secondary'} className="text-xs">
                          {isUp ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                          {pos.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{pos.total_shares}</TableCell>
                      <TableCell className="text-right font-mono">${pos.total_cost.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-green-500">${pos.hedge_cost.toFixed(2)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
