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
      <CardHeader className="px-3 sm:px-6">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
          <span className="hidden sm:inline">Post-Signal Price Tracking</span>
          <span className="sm:hidden">Post-Signal</span>
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Track at +1s, +5s, +10s, +15s, +30s
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 sm:space-y-6 px-3 sm:px-6">
        {/* Summary Stats - 2x2 on mobile, 4 on desktop */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
          <div className="p-3 sm:p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-xl sm:text-2xl font-bold">{total}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Tracked</p>
          </div>
          <div className="p-3 sm:p-4 rounded-lg bg-green-500/10 text-center">
            <div className="text-xl sm:text-2xl font-bold text-green-400">{resolved}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Resolved</p>
          </div>
          <div className="p-3 sm:p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-xl sm:text-2xl font-bold">{resolutionRate.toFixed(1)}%</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Resolution</p>
          </div>
          <div className="p-3 sm:p-4 rounded-lg bg-muted/30 text-center">
            <div className="text-xl sm:text-2xl font-bold">{avgResolutionTime.toFixed(1)}s</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground">Avg Time</p>
          </div>
        </div>

        {/* Resolution by Time */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="p-2 sm:p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-1 sm:mb-2">
              <span className="text-xs sm:text-sm font-medium">@5s</span>
              <Badge variant="outline" className="text-[10px] sm:text-xs">{at5s}</Badge>
            </div>
            <Progress value={total > 0 ? (at5s / total) * 100 : 0} className="h-1.5 sm:h-2" />
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-1 sm:mb-2">
              <span className="text-xs sm:text-sm font-medium">@10s</span>
              <Badge variant="outline" className="text-[10px] sm:text-xs">{at10s}</Badge>
            </div>
            <Progress value={total > 0 ? (at10s / total) * 100 : 0} className="h-1.5 sm:h-2" />
          </div>
          <div className="p-2 sm:p-3 rounded-lg bg-muted/20">
            <div className="flex items-center justify-between mb-1 sm:mb-2">
              <span className="text-xs sm:text-sm font-medium">@15s</span>
              <Badge variant="outline" className="text-[10px] sm:text-xs">{at15s}</Badge>
            </div>
            <Progress value={total > 0 ? (at15s / total) * 100 : 0} className="h-1.5 sm:h-2" />
          </div>
        </div>

        {/* Mobile Card View */}
        <div className="block md:hidden">
          <ScrollArea className="h-[300px]">
            <div className="space-y-2">
              {trackings.length === 0 && (
                <div className="text-center text-muted-foreground py-8 text-sm">
                  No tracking data yet
                </div>
              )}
              {trackings.slice(0, 50).map((t) => (
                <div key={t.signalId} className="p-3 rounded-lg border bg-muted/10">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-xs">{t.signalId.slice(0, 8)}</span>
                    <div className="flex items-center gap-2">
                      {t.mispricingResolved ? (
                        <CheckCircle2 className="h-4 w-4 text-green-400" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                      {t.resolutionTimeSeconds !== null && (
                        <span className="font-mono text-xs">{t.resolutionTimeSeconds}s</span>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="text-center">
                      <span className="text-muted-foreground block">@5s</span>
                      {t.at5s !== null ? (
                        <span className={cn(
                          "font-mono",
                          t.at5s.favorable > 0 ? "text-green-400" : "text-red-400"
                        )}>
                          {t.at5s.favorable > 0 ? '+' : ''}{t.at5s.favorable.toFixed(1)}
                        </span>
                      ) : <span className="text-muted-foreground">-</span>}
                    </div>
                    <div className="text-center">
                      <span className="text-muted-foreground block">@10s</span>
                      {t.at10s !== null ? (
                        <span className={cn(
                          "font-mono",
                          t.at10s.favorable > 0 ? "text-green-400" : "text-red-400"
                        )}>
                          {t.at10s.favorable > 0 ? '+' : ''}{t.at10s.favorable.toFixed(1)}
                        </span>
                      ) : <span className="text-muted-foreground">-</span>}
                    </div>
                    <div className="text-center">
                      <span className="text-muted-foreground block">@15s</span>
                      {t.at15s !== null ? (
                        <span className={cn(
                          "font-mono",
                          t.at15s.favorable > 0 ? "text-green-400" : "text-red-400"
                        )}>
                          {t.at15s.favorable > 0 ? '+' : ''}{t.at15s.favorable.toFixed(1)}
                        </span>
                      ) : <span className="text-muted-foreground">-</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Desktop Table View */}
        <ScrollArea className="h-[300px] hidden md:block">
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
