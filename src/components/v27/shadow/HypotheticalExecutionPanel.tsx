import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Zap, ArrowUpRight, ArrowDownRight, Clock, Target, Crosshair } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

export interface HypotheticalExecution {
  signalId: string;
  marketId: string;
  asset: string;
  side: 'UP' | 'DOWN';
  entryPriceMaker: number;
  entryPriceTaker: number;
  wouldCrossSpread: boolean;
  estimatedFillProbability: number;
  estimatedTimeToFillMs: number;
  hypotheticalFillTs: number | null;
  makerTaker: 'MAKER' | 'TAKER';
  entrySlippageCents: number;
  timestamp: number;
}

interface HypotheticalExecutionPanelProps {
  executions: HypotheticalExecution[];
}

export function HypotheticalExecutionPanel({ executions }: HypotheticalExecutionPanelProps) {
  const makerCount = executions.filter((e) => e.makerTaker === 'MAKER').length;
  const takerCount = executions.filter((e) => e.makerTaker === 'TAKER').length;
  const crossSpreadCount = executions.filter((e) => e.wouldCrossSpread).length;
  
  const avgFillProb = executions.length > 0
    ? executions.reduce((sum, e) => sum + e.estimatedFillProbability, 0) / executions.length
    : 0;
  
  const avgSlippage = executions.length > 0
    ? executions.reduce((sum, e) => sum + e.entrySlippageCents, 0) / executions.length
    : 0;

  const avgTimeToFill = executions.length > 0
    ? executions.reduce((sum, e) => sum + e.estimatedTimeToFillMs, 0) / executions.length
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Hypothetical Execution Simulation
        </CardTitle>
        <CardDescription>
          Simulated order execution for signals that passed filters | No real orders sent
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div className="p-3 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{executions.length}</div>
            <p className="text-xs text-muted-foreground">Total Signals</p>
          </div>
          <div className="p-3 rounded-lg bg-green-500/10 text-center">
            <div className="text-2xl font-bold text-green-400">{makerCount}</div>
            <p className="text-xs text-muted-foreground">Maker Fills</p>
          </div>
          <div className="p-3 rounded-lg bg-amber-500/10 text-center">
            <div className="text-2xl font-bold text-amber-400">{takerCount}</div>
            <p className="text-xs text-muted-foreground">Taker Fills</p>
          </div>
          <div className="p-3 rounded-lg bg-red-500/10 text-center">
            <div className="text-2xl font-bold text-red-400">{crossSpreadCount}</div>
            <p className="text-xs text-muted-foreground">Cross Spread</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{avgSlippage.toFixed(1)}¢</div>
            <p className="text-xs text-muted-foreground">Avg Slippage</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{(avgTimeToFill / 1000).toFixed(1)}s</div>
            <p className="text-xs text-muted-foreground">Avg Time to Fill</p>
          </div>
        </div>

        {/* Fill Probability Gauge */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Target className="h-4 w-4" />
              Average Fill Probability
            </span>
            <span className={cn(
              "font-bold",
              avgFillProb >= 80 ? "text-green-400" : avgFillProb >= 50 ? "text-amber-400" : "text-red-400"
            )}>
              {avgFillProb.toFixed(1)}%
            </span>
          </div>
          <Progress value={avgFillProb} className="h-3" />
        </div>

        {/* Maker vs Taker Distribution */}
        {executions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Maker / Taker Ratio</span>
              <span className="font-mono">
                {makerCount} / {takerCount}
              </span>
            </div>
            <div className="flex h-3 rounded-full overflow-hidden">
              <div
                className="bg-green-500 transition-all"
                style={{ width: `${(makerCount / executions.length) * 100}%` }}
              />
              <div
                className="bg-amber-500 transition-all"
                style={{ width: `${(takerCount / executions.length) * 100}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span className="text-green-400">Maker: {((makerCount / executions.length) * 100).toFixed(0)}%</span>
              <span className="text-amber-400">Taker: {((takerCount / executions.length) * 100).toFixed(0)}%</span>
            </div>
          </div>
        )}

        {/* Executions Table */}
        {executions.length > 0 ? (
          <ScrollArea className="h-[300px]">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Signal</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Maker Price</TableHead>
                  <TableHead className="text-right">Taker Price</TableHead>
                  <TableHead>Cross?</TableHead>
                  <TableHead className="text-right">Fill Prob</TableHead>
                  <TableHead className="text-right">Est. Time</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Slippage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.slice(0, 100).map((exec) => (
                  <TableRow key={exec.signalId}>
                    <TableCell className="font-mono text-xs">
                      {exec.signalId.slice(0, 8)}
                    </TableCell>
                    <TableCell className="font-medium">{exec.asset}</TableCell>
                    <TableCell>
                      {exec.side === 'UP' ? (
                        <Badge className="bg-green-500/20 text-green-400 text-xs">
                          <ArrowUpRight className="h-3 w-3 mr-1" />
                          UP
                        </Badge>
                      ) : (
                        <Badge className="bg-red-500/20 text-red-400 text-xs">
                          <ArrowDownRight className="h-3 w-3 mr-1" />
                          DOWN
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-green-400">
                      ${exec.entryPriceMaker.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-amber-400">
                      ${exec.entryPriceTaker.toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {exec.wouldCrossSpread ? (
                        <Badge variant="destructive" className="text-xs">Yes</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs">No</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={cn(
                        "font-mono",
                        exec.estimatedFillProbability >= 80 ? "text-green-400" :
                        exec.estimatedFillProbability >= 50 ? "text-amber-400" : "text-red-400"
                      )}>
                        {exec.estimatedFillProbability.toFixed(0)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {(exec.estimatedTimeToFillMs / 1000).toFixed(1)}s
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline" 
                        className={cn(
                          "text-xs",
                          exec.makerTaker === 'MAKER' ? "border-green-500 text-green-400" : "border-amber-500 text-amber-400"
                        )}
                      >
                        {exec.makerTaker}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn(
                      "text-right font-mono",
                      exec.entrySlippageCents > 2 ? "text-red-400" : "text-muted-foreground"
                    )}>
                      {exec.entrySlippageCents.toFixed(1)}¢
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-[200px] text-muted-foreground">
            <Crosshair className="h-12 w-12 mb-3 opacity-50" />
            <p>No hypothetical executions yet</p>
            <p className="text-xs">Waiting for signals that pass all filters...</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
