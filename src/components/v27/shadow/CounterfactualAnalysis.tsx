import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';
import { FlaskConical, TrendingUp, TrendingDown, Scale, ArrowLeftRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CounterfactualAnalysis {
  signalId: string;
  tradedVsSkipped: { traded: number; skipped: number };
  makerVsTaker: { maker: number; taker: number };
  earlyVsLateHedge: { early: number; late: number };
  noHedge: number;
}

interface CounterfactualAnalysisPanelProps {
  counterfactuals: CounterfactualAnalysis[];
}

export function CounterfactualAnalysisPanel({ counterfactuals }: CounterfactualAnalysisPanelProps) {
  // Calculate aggregate stats
  const aggregated = counterfactuals.reduce(
    (acc, cf) => ({
      tradedPnl: acc.tradedPnl + cf.tradedVsSkipped.traded,
      skippedPnl: acc.skippedPnl + cf.tradedVsSkipped.skipped,
      makerPnl: acc.makerPnl + cf.makerVsTaker.maker,
      takerPnl: acc.takerPnl + cf.makerVsTaker.taker,
      earlyHedgePnl: acc.earlyHedgePnl + cf.earlyVsLateHedge.early,
      lateHedgePnl: acc.lateHedgePnl + cf.earlyVsLateHedge.late,
      noHedgePnl: acc.noHedgePnl + cf.noHedge,
    }),
    {
      tradedPnl: 0,
      skippedPnl: 0,
      makerPnl: 0,
      takerPnl: 0,
      earlyHedgePnl: 0,
      lateHedgePnl: 0,
      noHedgePnl: 0,
    }
  );

  const chartData = [
    {
      name: 'Trade Decision',
      Traded: aggregated.tradedPnl,
      Skipped: aggregated.skippedPnl,
    },
    {
      name: 'Execution',
      Maker: aggregated.makerPnl,
      Taker: aggregated.takerPnl,
    },
    {
      name: 'Hedge Timing',
      Early: aggregated.earlyHedgePnl,
      Late: aggregated.lateHedgePnl,
    },
  ];

  const tradedBetter = aggregated.tradedPnl > aggregated.skippedPnl;
  const makerBetter = aggregated.makerPnl > aggregated.takerPnl;
  const earlyBetter = aggregated.earlyHedgePnl > aggregated.lateHedgePnl;
  const hedgeBetter = Math.max(aggregated.earlyHedgePnl, aggregated.lateHedgePnl) > aggregated.noHedgePnl;

  const formatPnl = (value: number) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-primary" />
          Counterfactual Analysis
        </CardTitle>
        <CardDescription>
          Compare outcomes across different decision paths | {counterfactuals.length} signals analyzed
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Key Insights */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className={cn(
            "p-4 rounded-lg border",
            tradedBetter ? "border-green-500/30 bg-green-500/10" : "border-red-500/30 bg-red-500/10"
          )}>
            <div className="flex items-center gap-2 mb-2">
              <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Trade Decision</span>
            </div>
            <div className="flex items-center gap-2">
              {tradedBetter ? (
                <TrendingUp className="h-5 w-5 text-green-400" />
              ) : (
                <TrendingDown className="h-5 w-5 text-red-400" />
              )}
              <span className={cn("text-lg font-bold", tradedBetter ? "text-green-400" : "text-red-400")}>
                {tradedBetter ? 'Trade' : 'Skip'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Δ {formatPnl(aggregated.tradedPnl - aggregated.skippedPnl)}
            </p>
          </div>

          <div className={cn(
            "p-4 rounded-lg border",
            makerBetter ? "border-green-500/30 bg-green-500/10" : "border-amber-500/30 bg-amber-500/10"
          )}>
            <div className="flex items-center gap-2 mb-2">
              <Scale className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Execution</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("text-lg font-bold", makerBetter ? "text-green-400" : "text-amber-400")}>
                {makerBetter ? 'Maker' : 'Taker'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Δ {formatPnl(aggregated.makerPnl - aggregated.takerPnl)}
            </p>
          </div>

          <div className={cn(
            "p-4 rounded-lg border",
            earlyBetter ? "border-green-500/30 bg-green-500/10" : "border-amber-500/30 bg-amber-500/10"
          )}>
            <div className="flex items-center gap-2 mb-2">
              <Scale className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Hedge Timing</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("text-lg font-bold", earlyBetter ? "text-green-400" : "text-amber-400")}>
                {earlyBetter ? 'Early' : 'Late'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Δ {formatPnl(aggregated.earlyHedgePnl - aggregated.lateHedgePnl)}
            </p>
          </div>

          <div className={cn(
            "p-4 rounded-lg border",
            hedgeBetter ? "border-green-500/30 bg-green-500/10" : "border-red-500/30 bg-red-500/10"
          )}>
            <div className="flex items-center gap-2 mb-2">
              <Scale className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Hedge vs No-Hedge</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={cn("text-lg font-bold", hedgeBetter ? "text-green-400" : "text-red-400")}>
                {hedgeBetter ? 'Hedge' : 'No Hedge'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              No-hedge: {formatPnl(aggregated.noHedgePnl)}
            </p>
          </div>
        </div>

        {/* Summary Bar Chart */}
        {counterfactuals.length > 0 && (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ left: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tickFormatter={(v) => `$${v}`} stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis type="category" dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                  }}
                  formatter={(value: number) => [formatPnl(value), '']}
                />
                <Legend />
                <Bar dataKey="Traded" fill="hsl(var(--primary))" name="Traded" />
                <Bar dataKey="Skipped" fill="hsl(var(--muted-foreground))" name="Skipped" />
                <Bar dataKey="Maker" fill="hsl(142, 71%, 45%)" name="Maker" />
                <Bar dataKey="Taker" fill="hsl(38, 92%, 50%)" name="Taker" />
                <Bar dataKey="Early" fill="hsl(217, 91%, 60%)" name="Early" />
                <Bar dataKey="Late" fill="hsl(280, 67%, 55%)" name="Late" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Signal-level Table */}
        {counterfactuals.length > 0 && (
          <ScrollArea className="h-[250px]">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Signal</TableHead>
                  <TableHead className="text-right">If Traded</TableHead>
                  <TableHead className="text-right">If Skipped</TableHead>
                  <TableHead className="text-right">Maker</TableHead>
                  <TableHead className="text-right">Taker</TableHead>
                  <TableHead className="text-right">Early Hedge</TableHead>
                  <TableHead className="text-right">Late Hedge</TableHead>
                  <TableHead className="text-right">No Hedge</TableHead>
                  <TableHead>Best Path</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counterfactuals.slice(0, 50).map((cf) => {
                  const allPaths = [
                    { name: 'Trade+Maker+Early', value: cf.tradedVsSkipped.traded + cf.makerVsTaker.maker + cf.earlyVsLateHedge.early },
                    { name: 'Trade+Maker+Late', value: cf.tradedVsSkipped.traded + cf.makerVsTaker.maker + cf.earlyVsLateHedge.late },
                    { name: 'Trade+Taker+Early', value: cf.tradedVsSkipped.traded + cf.makerVsTaker.taker + cf.earlyVsLateHedge.early },
                    { name: 'Trade+Taker+Late', value: cf.tradedVsSkipped.traded + cf.makerVsTaker.taker + cf.earlyVsLateHedge.late },
                    { name: 'Skip', value: cf.tradedVsSkipped.skipped },
                  ];
                  const best = allPaths.reduce((a, b) => (a.value > b.value ? a : b));

                  return (
                    <TableRow key={cf.signalId}>
                      <TableCell className="font-mono text-xs">{cf.signalId.slice(0, 8)}</TableCell>
                      <TableCell className={cn("text-right font-mono", cf.tradedVsSkipped.traded >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.tradedVsSkipped.traded)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.tradedVsSkipped.skipped >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.tradedVsSkipped.skipped)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.makerVsTaker.maker >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.makerVsTaker.maker)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.makerVsTaker.taker >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.makerVsTaker.taker)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.earlyVsLateHedge.early >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.earlyVsLateHedge.early)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.earlyVsLateHedge.late >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.earlyVsLateHedge.late)}
                      </TableCell>
                      <TableCell className={cn("text-right font-mono", cf.noHedge >= 0 ? "text-green-400" : "text-red-400")}>
                        {formatPnl(cf.noHedge)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {best.name}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}

        {counterfactuals.length === 0 && (
          <div className="flex items-center justify-center h-[200px] text-muted-foreground">
            No counterfactual data available yet. Waiting for signals...
          </div>
        )}
      </CardContent>
    </Card>
  );
}
