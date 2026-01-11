import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Timer, ArrowRight, CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface CausalityEvent {
  signalId: string;
  spotEventTs: number;
  polyEventTs: number;
  eventLagMs: number;
  directionAgreement: boolean;
  spotLeadingConfidence: number;
  polyLeadingConfidence: number;
  verdict: 'SPOT_LEADS' | 'POLY_LEADS' | 'AMBIGUOUS';
}

interface CausalityTrackerProps {
  events: CausalityEvent[];
  latencyToleranceMs: number;
}

const VERDICT_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  SPOT_LEADS: { color: 'text-green-400', icon: <CheckCircle2 className="h-4 w-4" />, label: 'Spot Leads' },
  POLY_LEADS: { color: 'text-red-400', icon: <XCircle className="h-4 w-4" />, label: 'Poly Leads' },
  AMBIGUOUS: { color: 'text-amber-400', icon: <HelpCircle className="h-4 w-4" />, label: 'Ambiguous' },
};

export function CausalityTracker({ events, latencyToleranceMs }: CausalityTrackerProps) {
  const spotLeading = events.filter((e) => e.verdict === 'SPOT_LEADS').length;
  const polyLeading = events.filter((e) => e.verdict === 'POLY_LEADS').length;
  const ambiguous = events.filter((e) => e.verdict === 'AMBIGUOUS').length;
  const total = events.length;
  
  const spotLeadingPct = total > 0 ? (spotLeading / total) * 100 : 0;
  const avgLagMs = events.length > 0 
    ? events.reduce((sum, e) => sum + e.eventLagMs, 0) / events.length 
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Timer className="h-5 w-5 text-primary" />
          Causality Tracker
        </CardTitle>
        <CardDescription>
          Latency tolerance: {latencyToleranceMs}ms | {total} events analyzed
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-4">
          <div className="p-3 rounded-lg bg-green-500/10 text-center">
            <div className="text-2xl font-bold text-green-400">{spotLeading}</div>
            <p className="text-xs text-muted-foreground">Spot Leads</p>
          </div>
          <div className="p-3 rounded-lg bg-red-500/10 text-center">
            <div className="text-2xl font-bold text-red-400">{polyLeading}</div>
            <p className="text-xs text-muted-foreground">Poly Leads</p>
          </div>
          <div className="p-3 rounded-lg bg-amber-500/10 text-center">
            <div className="text-2xl font-bold text-amber-400">{ambiguous}</div>
            <p className="text-xs text-muted-foreground">Ambiguous</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{avgLagMs.toFixed(0)}ms</div>
            <p className="text-xs text-muted-foreground">Avg Lag</p>
          </div>
        </div>

        {/* Spot Leading Confidence */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Spot Leading Confidence</span>
            <span className={cn(
              "font-bold",
              spotLeadingPct >= 70 ? "text-green-400" : spotLeadingPct >= 50 ? "text-amber-400" : "text-red-400"
            )}>
              {spotLeadingPct.toFixed(1)}%
            </span>
          </div>
          <Progress value={spotLeadingPct} className="h-3" />
        </div>

        {/* Events Table */}
        {events.length > 0 && (
          <ScrollArea className="h-[250px]">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Signal</TableHead>
                  <TableHead>Spot Ts</TableHead>
                  <TableHead>Poly Ts</TableHead>
                  <TableHead className="text-right">Lag</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Verdict</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.slice(0, 50).map((e) => {
                  const config = VERDICT_CONFIG[e.verdict];
                  return (
                    <TableRow key={e.signalId}>
                      <TableCell className="font-mono text-xs">
                        {e.signalId.slice(0, 8)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(e.spotEventTs, 'HH:mm:ss.SSS')}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(e.polyEventTs, 'HH:mm:ss.SSS')}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        <span className={cn(
                          e.eventLagMs > latencyToleranceMs ? "text-red-400" : "text-green-400"
                        )}>
                          {e.eventLagMs.toFixed(0)}ms
                        </span>
                      </TableCell>
                      <TableCell>
                        {e.directionAgreement ? (
                          <Badge className="bg-green-500/20 text-green-400 text-xs">Agree</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Disagree</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className={cn("flex items-center gap-1", config.color)}>
                          {config.icon}
                          <span className="text-xs">{config.label}</span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
