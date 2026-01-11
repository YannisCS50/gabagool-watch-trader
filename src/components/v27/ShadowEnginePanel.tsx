import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { 
  Eye, Zap, Shield, TrendingUp, TrendingDown, Activity, 
  CheckCircle2, XCircle, AlertTriangle, Target, Clock
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';
import type { ShadowEvaluation, SignalTracking, ShadowStats } from '@/hooks/useShadowEngineData';

interface ShadowEnginePanelProps {
  evaluations: ShadowEvaluation[];
  trackings: SignalTracking[];
  stats: ShadowStats;
}

export function ShadowEnginePanel({ evaluations, trackings, stats }: ShadowEnginePanelProps) {
  const signalQuality = stats.signalsDetected > 0 
    ? (stats.cleanSignals / stats.signalsDetected * 100) 
    : 0;
    
  const correctionRate5s = stats.trackingsCompleted > 0
    ? (stats.mispricingsResolved5s / stats.trackingsCompleted * 100)
    : 0;
    
  const adverseRate5s = stats.trackingsCompleted > 0
    ? (stats.adverseSelection5s / stats.trackingsCompleted * 100)
    : 0;
    
  const profitPotential = stats.trackingsCompleted > 0
    ? (stats.wouldHaveProfited / stats.trackingsCompleted * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Shadow Mode Banner */}
      <Card className="border-amber-500/50 bg-amber-500/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Eye className="h-5 w-5 text-amber-500" />
            Shadow Engine Active
          </CardTitle>
          <CardDescription>
            Continuous evaluation • No real orders • Full data collection
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Primary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Evaluations */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Activity className="h-4 w-4" />
              Evaluations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalEvaluations.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              {evaluations.length > 0 && (
                <>Last: {formatDistanceToNow(new Date(evaluations[0].created_at), { addSuffix: true, locale: nl })}</>
              )}
            </p>
          </CardContent>
        </Card>

        {/* Signal Quality */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Zap className="h-4 w-4" />
              Signal Quality
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${signalQuality >= 50 ? 'text-green-500' : 'text-amber-500'}`}>
              {signalQuality.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.cleanSignals}/{stats.signalsDetected} clean
            </p>
          </CardContent>
        </Card>

        {/* Adverse Blocks */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Shield className="h-4 w-4" />
              Toxic Filtered
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-500">{stats.toxicSkips}</div>
            <p className="text-xs text-muted-foreground">
              Adverse selection blocks
            </p>
          </CardContent>
        </Card>

        {/* Entry Signals */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-1">
              <Target className="h-4 w-4" />
              Entry Signals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">{stats.entrySignals}</div>
            <p className="text-xs text-muted-foreground">
              Would have traded
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Signal Tracking Outcomes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Post-Signal Tracking</CardTitle>
          <CardDescription>
            {stats.trackingsCompleted} signals tracked • Outcomes at 5s, 10s, 15s
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {/* Correction Rate */}
            <div className="text-center p-4 rounded-lg bg-muted/30">
              <div className={`text-xl font-bold ${correctionRate5s >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                {correctionRate5s.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">Corrected @ 5s</p>
              <Progress value={correctionRate5s} className="mt-2 h-1" />
            </div>
            
            {/* Adverse Selection Rate */}
            <div className="text-center p-4 rounded-lg bg-muted/30">
              <div className={`text-xl font-bold ${adverseRate5s <= 30 ? 'text-green-500' : 'text-red-500'}`}>
                {adverseRate5s.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">Adverse @ 5s</p>
              <Progress value={adverseRate5s} className="mt-2 h-1" />
            </div>
            
            {/* Signal Correctness */}
            <div className="text-center p-4 rounded-lg bg-muted/30">
              <div className="text-xl font-bold text-primary">
                {stats.signalsCorrect}/{stats.trackingsCompleted}
              </div>
              <p className="text-xs text-muted-foreground">Signals Correct</p>
            </div>
            
            {/* Profit Potential */}
            <div className="text-center p-4 rounded-lg bg-muted/30">
              <div className={`text-xl font-bold ${profitPotential >= 50 ? 'text-green-500' : 'text-amber-500'}`}>
                {profitPotential.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">Would Profit</p>
              <Progress value={profitPotential} className="mt-2 h-1" />
            </div>
          </div>

          {/* Hedge Analysis */}
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium mb-3">Hedge Simulations</h4>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Simulated:</span>
                <span className="ml-2 font-medium">{stats.hedgesSimulated}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Would Execute:</span>
                <span className="ml-2 font-medium text-green-500">{stats.hedgesWouldExecute}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Avg CPP:</span>
                <span className={`ml-2 font-medium ${stats.avgSimulatedCpp < 1 ? 'text-green-500' : 'text-red-500'}`}>
                  {stats.avgSimulatedCpp > 0 ? stats.avgSimulatedCpp.toFixed(3) : '-'}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Evaluations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent Evaluations</CardTitle>
          <CardDescription>Last {Math.min(50, evaluations.length)} evaluations</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Asset</TableHead>
                  <TableHead>Spot</TableHead>
                  <TableHead>Mispricing</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evaluations.slice(0, 50).map((eval_) => (
                  <TableRow key={eval_.id} className="text-sm">
                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(eval_.created_at), 'HH:mm:ss')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{eval_.asset}</Badge>
                    </TableCell>
                    <TableCell className="font-mono">
                      ${Number(eval_.spot_price).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      {eval_.mispricing_side ? (
                        <div className="flex items-center gap-1">
                          <Badge variant={eval_.mispricing_side === 'UP' ? 'default' : 'secondary'}>
                            {eval_.mispricing_side}
                          </Badge>
                          <span className="text-xs">
                            {(Number(eval_.mispricing_magnitude) * 100).toFixed(2)}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {eval_.action === 'ENTRY' && (
                        <Badge className="bg-green-500">ENTRY</Badge>
                      )}
                      {eval_.action === 'SKIP_TOXIC' && (
                        <Badge variant="destructive">TOXIC</Badge>
                      )}
                      {eval_.action === 'SKIP_FILTER' && (
                        <Badge variant="outline" className="text-amber-500">FILTER</Badge>
                      )}
                      {eval_.action === 'NONE' && (
                        <span className="text-muted-foreground text-xs">NONE</span>
                      )}
                      {!['ENTRY', 'SKIP_TOXIC', 'SKIP_FILTER', 'NONE'].includes(eval_.action) && (
                        <Badge variant="outline">{eval_.action}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[150px] truncate">
                      {eval_.skip_reason || eval_.adverse_reason || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Recent Signal Trackings */}
      {trackings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Signal Tracking History</CardTitle>
            <CardDescription>Post-signal price evolution</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[300px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Resolved @5s</TableHead>
                    <TableHead>Adverse @5s</TableHead>
                    <TableHead>CPP</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trackings.slice(0, 30).map((t) => (
                    <TableRow key={t.id} className="text-sm">
                      <TableCell className="text-xs text-muted-foreground">
                        {format(t.signal_ts, 'HH:mm:ss')}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{t.asset}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.signal_side === 'UP' ? 'default' : 'secondary'}>
                          {t.signal_side}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {t.mispricing_resolved_5s === true ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : t.mispricing_resolved_5s === false ? (
                          <XCircle className="h-4 w-4 text-red-500" />
                        ) : (
                          <Clock className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        {t.adverse_selection_5s === true ? (
                          <AlertTriangle className="h-4 w-4 text-amber-500" />
                        ) : t.adverse_selection_5s === false ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono">
                        {t.simulated_cpp !== null ? (
                          <span className={t.simulated_cpp < 1 ? 'text-green-500' : 'text-red-500'}>
                            {t.simulated_cpp.toFixed(3)}
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        {t.would_have_profited === true ? (
                          <Badge className="bg-green-500">PROFIT</Badge>
                        ) : t.would_have_profited === false ? (
                          <Badge variant="destructive">LOSS</Badge>
                        ) : t.completed ? (
                          <Badge variant="outline">N/A</Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-500">PENDING</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Breakdown by Asset */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Asset Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(stats.byAsset).map(([asset, data]) => (
              <div key={asset} className="p-3 rounded-lg bg-muted/30 text-center">
                <div className="font-medium">{asset}</div>
                <div className="text-2xl font-bold">{data.total}</div>
                <div className="text-xs text-muted-foreground">
                  {data.signals} signals • {data.entries} entries
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
