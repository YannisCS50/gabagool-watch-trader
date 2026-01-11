import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { Clock, TrendingUp, TrendingDown, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PostSignalTracking } from '@/hooks/useShadowDashboard';

interface PostSignalTrackingPanelProps {
  trackings: PostSignalTracking[];
}

export function PostSignalTrackingPanel({ trackings }: PostSignalTrackingPanelProps) {
  const resolved = trackings.filter((t) => t.mispricingResolved).length;
  const total = trackings.length;
  const resolutionRate = total > 0 ? (resolved / total) * 100 : 0;
  
  const avgResolutionTime = trackings
    .filter((t) => t.resolutionTimeSeconds !== null)
    .reduce((sum, t) => sum + (t.resolutionTimeSeconds || 0), 0) / (resolved || 1);

  // Count resolutions by time bucket
  const at5s = trackings.filter((t) => t.at5s !== null).length;
  const at10s = trackings.filter((t) => t.at10s !== null).length;
  const at15s = trackings.filter((t) => t.at15s !== null).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          Post-Signal Price Tracking
        </CardTitle>
        <CardDescription>
          Track at +1s, +5s, +10s, +15s, +30s
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-4">
          <div className="p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{total}</div>
            <p className="text-xs text-muted-foreground">Tracked</p>
          </div>
          <div className="p-4 rounded-lg bg-green-500/10 text-center">
            <div className="text-2xl font-bold text-green-400">{resolved}</div>
            <p className="text-xs text-muted-foreground">Resolved</p>
          </div>
          <div className="p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{resolutionRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">Resolution Rate</p>
          </div>
          <div className="p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-2xl font-bold">{avgResolutionTime.toFixed(1)}s</div>
            <p className="text-xs text-muted-foreground">Avg Resolution</p>
          </div>
        </div>

        {/* Resolution by Time */}
        <div className="grid grid-cols-3 gap-4">
          <div className="p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">@5s</span>
              <Badge variant="outline">{at5s}</Badge>
            </div>
            <Progress value={total > 0 ? (at5s / total) * 100 : 0} className="h-2" />
          </div>
          <div className="p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">@10s</span>
              <Badge variant="outline">{at10s}</Badge>
            </div>
            <Progress value={total > 0 ? (at10s / total) * 100 : 0} className="h-2" />
          </div>
          <div className="p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">@15s</span>
              <Badge variant="outline">{at15s}</Badge>
            </div>
            <Progress value={total > 0 ? (at15s / total) * 100 : 0} className="h-2" />
          </div>
        </div>

        {/* Tracking Table */}
        <ScrollArea className="h-[300px]">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Signal</TableHead>
                <TableHead className="text-center">@5s</TableHead>
                <TableHead className="text-center">@10s</TableHead>
                <TableHead className="text-center">@15s</TableHead>
                <TableHead className="text-center">Resolved</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trackings.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No tracking data yet
                  </TableCell>
                </TableRow>
              )}
              {trackings.slice(0, 50).map((t) => (
                <TableRow key={t.signalId}>
                  <TableCell className="font-mono text-xs">
                    {t.signalId.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-center">
                    {t.at5s !== null ? (
                      <div className="flex flex-col items-center gap-1">
                        <span className={cn(
                          "text-xs font-mono",
                          t.at5s.favorable > 0 ? "text-green-400" : "text-red-400"
                        )}>
                          {t.at5s.favorable > 0 ? '+' : ''}{t.at5s.favorable.toFixed(2)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {t.at10s !== null ? (
                      <span className={cn(
                        "text-xs font-mono",
                        t.at10s.favorable > 0 ? "text-green-400" : "text-red-400"
                      )}>
                        {t.at10s.favorable > 0 ? '+' : ''}{t.at10s.favorable.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {t.at15s !== null ? (
                      <span className={cn(
                        "text-xs font-mono",
                        t.at15s.favorable > 0 ? "text-green-400" : "text-red-400"
                      )}>
                        {t.at15s.favorable > 0 ? '+' : ''}{t.at15s.favorable.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {t.mispricingResolved ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400 mx-auto" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400 mx-auto" />
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {t.resolutionTimeSeconds !== null ? `${t.resolutionTimeSeconds}s` : '-'}
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
