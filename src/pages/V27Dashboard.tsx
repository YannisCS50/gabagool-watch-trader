import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, TrendingUp, TrendingDown, Activity, Target, Percent,
  Zap, BarChart3, Shield, AlertTriangle, CheckCircle2, XCircle,
  Wifi, WifiOff, Eye, EyeOff, RefreshCw
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useV27Data } from '@/hooks/useV27Data';
import { format, formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

export default function V27Dashboard() {
  const navigate = useNavigate();
  const { entries, signals, stats, loading, runnerStatus, refetch } = useV27Data();
  const [activeTab, setActiveTab] = useState<'overview' | 'signals' | 'entries'>('overview');

  const formatCurrency = (value: number) => {
    const prefix = value >= 0 ? '+$' : '-$';
    return `${prefix}${Math.abs(value).toFixed(2)}`;
  };

  const formatPercent = (value: number) => {
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
  };

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              V27 Delta Mispricing
              {runnerStatus.shadowMode && (
                <Badge variant="outline" className="text-amber-500 border-amber-500">
                  <Eye className="h-3 w-3 mr-1" />
                  Shadow Mode
                </Badge>
              )}
            </h1>
            <p className="text-muted-foreground text-sm">
              Trade mispricing, not spread
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Runner Status */}
          <div className="flex items-center gap-2">
            {runnerStatus.isOnline ? (
              <Badge variant="default" className="bg-green-500">
                <Wifi className="h-3 w-3 mr-1" />
                Online
              </Badge>
            ) : (
              <Badge variant="destructive">
                <WifiOff className="h-3 w-3 mr-1" />
                Offline
              </Badge>
            )}
            {runnerStatus.lastHeartbeat && (
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(runnerStatus.lastHeartbeat), { addSuffix: true, locale: nl })}
              </span>
            )}
          </div>
          
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        {/* Signal Quality */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Zap className="h-4 w-4" />
              Signal Quality
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.signalQuality.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.validSignals}/{stats.totalSignals} valid
            </p>
          </CardContent>
        </Card>

        {/* Adverse Selection Blocks */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Shield className="h-4 w-4" />
              Adverse Blocks
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-500">
              {stats.adverseBlocks}
            </div>
            <p className="text-xs text-muted-foreground">
              Toxic flow filtered
            </p>
          </CardContent>
        </Card>

        {/* Fill Rate */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Target className="h-4 w-4" />
              Fill Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.fillRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.filledEntries}/{stats.totalEntries} filled
            </p>
          </CardContent>
        </Card>

        {/* Corrections */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Activity className="h-4 w-4" />
              Corrections
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-500">
              {stats.correctionsCompleted}
            </div>
            <p className="text-xs text-muted-foreground">
              Avg {stats.avgCorrectionPct.toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        {/* Win Rate */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              <Percent className="h-4 w-4" />
              Win Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.winRate >= 50 ? 'text-green-500' : 'text-red-500'}`}>
              {stats.winRate.toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.wins}W / {stats.losses}L
            </p>
          </CardContent>
        </Card>

        {/* Net PnL */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1">
              {stats.netPnl >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              Net PnL
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${stats.netPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
              {formatCurrency(stats.netPnl)}
            </div>
            <p className="text-xs text-muted-foreground">
              ROI: {formatPercent(stats.roi)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Secondary Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card className="bg-muted/30">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Open Positions</span>
              <Badge variant="outline">{stats.openPositions}</Badge>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-muted/30">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Hedges Triggered</span>
              <Badge variant="outline" className="text-amber-500">{stats.hedgesTriggered}</Badge>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-muted/30">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Emergency Hedges</span>
              <Badge variant="outline" className="text-red-500">{stats.emergencyHedges}</Badge>
            </div>
          </CardContent>
        </Card>
        
        <Card className="bg-muted/30">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Gross PnL</span>
              <span className={stats.grossPnl >= 0 ? 'text-green-500' : 'text-red-500'}>
                {formatCurrency(stats.grossPnl)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="signals">Signals ({signals.length})</TabsTrigger>
          <TabsTrigger value="entries">Entries ({entries.length})</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Recent Signals */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Recent Signals</CardTitle>
                <CardDescription>Mispricing detections</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {signals.slice(0, 5).map((signal) => (
                    <div key={signal.id} className="flex items-center justify-between p-2 rounded bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Badge variant={signal.signal_side === 'UP' ? 'default' : 'secondary'}>
                          {signal.asset} {signal.signal_side}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          Δ{(signal.mispricing * 100).toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {signal.action_taken ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(signal.created_at), 'HH:mm:ss')}
                        </span>
                      </div>
                    </div>
                  ))}
                  {signals.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No signals yet
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Open Positions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Open Positions</CardTitle>
                <CardDescription>Active entries awaiting correction</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {entries.filter(e => e.status === 'open').slice(0, 5).map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between p-2 rounded bg-muted/30">
                      <div className="flex items-center gap-2">
                        <Badge variant={entry.side === 'UP' ? 'default' : 'secondary'}>
                          {entry.asset} {entry.side}
                        </Badge>
                        <span className="text-sm">
                          {entry.filled_shares.toFixed(1)} @ ${entry.avg_fill_price?.toFixed(3) || entry.entry_price.toFixed(3)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {entry.peak_correction !== null && (
                          <span className="text-xs text-green-500">
                            +{(entry.peak_correction * 100).toFixed(1)}%
                          </span>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {entry.order_status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                  {entries.filter(e => e.status === 'open').length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No open positions
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Signals Tab */}
        <TabsContent value="signals">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Mispricing</TableHead>
                    <TableHead>Threshold</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((signal) => (
                    <TableRow key={signal.id}>
                      <TableCell className="text-sm">
                        {format(new Date(signal.created_at), 'dd-MM HH:mm:ss')}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{signal.asset}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={signal.signal_side === 'UP' ? 'default' : 'secondary'}>
                          {signal.signal_side}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">
                        {(signal.mispricing * 100).toFixed(3)}%
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {(signal.threshold * 100).toFixed(3)}%
                      </TableCell>
                      <TableCell>
                        {signal.confidence !== null ? `${(signal.confidence * 100).toFixed(0)}%` : '-'}
                      </TableCell>
                      <TableCell>
                        {signal.action_taken ? (
                          <Badge className="bg-green-500">Entry</Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">Skip</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Entries Tab */}
        <TabsContent value="entries">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Shares</TableHead>
                    <TableHead>Entry Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Correction</TableHead>
                    <TableHead>Hedge</TableHead>
                    <TableHead>PnL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-sm">
                        {format(new Date(entry.created_at), 'dd-MM HH:mm')}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{entry.asset}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={entry.side === 'UP' ? 'default' : 'secondary'}>
                          {entry.side}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono">
                        {entry.filled_shares.toFixed(1)}
                      </TableCell>
                      <TableCell className="font-mono">
                        ${entry.avg_fill_price?.toFixed(3) || entry.entry_price.toFixed(3)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={
                          entry.status === 'open' ? 'default' :
                          entry.status === 'corrected' ? 'secondary' :
                          entry.status === 'hedged' ? 'outline' :
                          'destructive'
                        }>
                          {entry.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {entry.peak_correction !== null ? (
                          <span className="text-green-500">
                            +{(entry.peak_correction * 100).toFixed(1)}%
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        {entry.hedge_triggered ? (
                          <Badge variant="outline" className="text-amber-500">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Hedged
                          </Badge>
                        ) : '-'}
                      </TableCell>
                      <TableCell className={`font-mono ${
                        entry.pnl === null ? '' :
                        entry.pnl >= 0 ? 'text-green-500' : 'text-red-500'
                      }`}>
                        {entry.pnl !== null ? formatCurrency(entry.pnl) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
