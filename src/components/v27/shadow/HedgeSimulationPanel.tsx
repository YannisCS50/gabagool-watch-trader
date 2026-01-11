import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Shield, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HedgeSimulation } from '@/hooks/useShadowDashboard';

interface HedgeSimulationPanelProps {
  simulations: HedgeSimulation[];
  maxEmergencySpread?: number;
}

export function HedgeSimulationPanel({ simulations, maxEmergencySpread = 0.05 }: HedgeSimulationPanelProps) {
  const total = simulations.length;
  const wouldExecute = simulations.filter((s) => s.combinedCpp < 1).length;
  const emergencyUsed = simulations.filter((s) => s.emergencyUsed).length;
  const avgCpp = total > 0 
    ? simulations.reduce((sum, s) => sum + s.combinedCpp, 0) / total 
    : 0;
  const successRate = total > 0 ? (wouldExecute / total) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          Hedge Simulation
        </CardTitle>
        <CardDescription>
          Simulated at +5s, +10s, +15s, emergency (&lt;90s remaining)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-4">
          <div className="p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{total}</div>
            <p className="text-xs text-muted-foreground">Simulated</p>
          </div>
          <div className="p-4 rounded-lg bg-green-500/10 text-center">
            <div className="text-2xl font-bold text-green-400">{wouldExecute}</div>
            <p className="text-xs text-muted-foreground">Would Execute</p>
          </div>
          <div className={cn(
            "p-4 rounded-lg text-center",
            avgCpp < 1 ? "bg-green-500/10" : "bg-red-500/10"
          )}>
            <div className={cn(
              "text-2xl font-bold",
              avgCpp < 1 ? "text-green-400" : "text-red-400"
            )}>
              {avgCpp.toFixed(3)}
            </div>
            <p className="text-xs text-muted-foreground">Avg CPP</p>
          </div>
          <div className="p-4 rounded-lg bg-amber-500/10 text-center">
            <div className="text-2xl font-bold text-amber-400">{emergencyUsed}</div>
            <p className="text-xs text-muted-foreground">Emergency Used</p>
          </div>
        </div>

        {/* Success Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Hedge Success Rate (CPP &lt; 1)</span>
            <span className={cn(
              "font-bold",
              successRate >= 70 ? "text-green-400" : successRate >= 50 ? "text-amber-400" : "text-red-400"
            )}>
              {successRate.toFixed(1)}%
            </span>
          </div>
          <Progress value={successRate} className="h-3" />
        </div>

        {/* Simulations Table */}
        <ScrollArea className="h-[300px]">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Signal</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">@10s Price</TableHead>
                <TableHead className="text-right">@10s Spread</TableHead>
                <TableHead className="text-right">CPP</TableHead>
                <TableHead>Emergency</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {simulations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    No hedge simulations yet
                  </TableCell>
                </TableRow>
              )}
              {simulations.slice(0, 50).map((s) => (
                <TableRow key={s.signalId}>
                  <TableCell className="font-mono text-xs">
                    {s.signalId.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {s.hedgeSide === 'UP' ? (
                      <Badge className="bg-green-500/20 text-green-400 text-xs">
                        <TrendingUp className="h-3 w-3 mr-1" />
                        UP
                      </Badge>
                    ) : (
                      <Badge className="bg-red-500/20 text-red-400 text-xs">
                        <TrendingDown className="h-3 w-3 mr-1" />
                        DOWN
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {s.at10s ? `$${s.at10s.price.toFixed(3)}` : '-'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {s.at10s ? `${(s.at10s.spread * 100).toFixed(1)}%` : '-'}
                  </TableCell>
                  <TableCell className={cn(
                    "text-right font-mono text-sm font-bold",
                    s.combinedCpp < 1 ? "text-green-400" : "text-red-400"
                  )}>
                    {s.combinedCpp.toFixed(3)}
                  </TableCell>
                  <TableCell>
                    {s.emergencyUsed ? (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        Yes
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        No
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.combinedCpp < 1 ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-red-400" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
