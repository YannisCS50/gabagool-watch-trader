import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshCw, Download, Activity, Clock, TrendingUp, Zap, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useV29ResponseData } from '@/hooks/useV29ResponseData';
import { V29RStatsCards, V29RSignalsTable, V29RExitDistribution, V29RRepricingChart, V29RConfigPanel, V29RLogViewer } from '@/components/v29r';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

export default function V29ResponseDashboard() {
  const { config, signals, stats, loading, error, isConnected, lastUpdate, updateConfig, refetch } = useV29ResponseData();

  // Calculate runner status and last bet time
  const lastSignal = signals.length > 0 ? signals[0] : null;
  const lastBetTime = lastSignal?.created_at ? new Date(lastSignal.created_at) : null;
  const timeSinceLastBet = lastBetTime ? formatDistanceToNow(lastBetTime, { addSuffix: true, locale: nl }) : 'Geen bets';
  
  // Runner is considered "active" if we've seen a signal in last 10 minutes
  const runnerIsActive = lastBetTime && (Date.now() - lastBetTime.getTime()) < 10 * 60 * 1000;
  const runnerStatus = config.enabled 
    ? (runnerIsActive ? 'running' : 'idle') 
    : 'disabled';

  const handleExportCSV = () => {
    const headers = ['time', 'asset', 'direction', 'binance_delta', 'entry', 'exit', 'net_pnl', 'exit_reason', 'status'];
    const rows = signals.map(s => [
      s.created_at, s.asset, s.direction, s.binance_delta, s.entry_price, s.exit_price, s.net_pnl, s.exit_reason || s.skip_reason, s.status
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `v29-response-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (loading) return <div className="min-h-screen bg-background flex items-center justify-center"><div className="text-muted-foreground">Loading...</div></div>;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold">🤖 Gabagool Trader</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/old-dashboard"><Button variant="ghost" size="sm">Old Dashboard</Button></Link>
            <Button variant="outline" size="sm" onClick={handleExportCSV}><Download className="h-4 w-4 mr-2" />CSV</Button>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="h-4 w-4 mr-2" />Refresh</Button>
          </div>
        </div>
      </header>
      
      <main className="container mx-auto px-4 py-6 space-y-6">
        {error && <div className="p-4 bg-destructive/20 text-destructive rounded-lg">{error}</div>}
        
        {/* Big Status Hero Card */}
        <Card className={`border-2 ${
          runnerStatus === 'running' ? 'border-green-500/50 bg-green-500/5' :
          runnerStatus === 'idle' ? 'border-yellow-500/50 bg-yellow-500/5' :
          'border-red-500/50 bg-red-500/5'
        }`}>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Runner Status */}
              <div className="flex items-center gap-4">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
                  runnerStatus === 'running' ? 'bg-green-500/20' :
                  runnerStatus === 'idle' ? 'bg-yellow-500/20' :
                  'bg-red-500/20'
                }`}>
                  {runnerStatus === 'running' ? (
                    <Activity className="w-8 h-8 text-green-500 animate-pulse" />
                  ) : runnerStatus === 'idle' ? (
                    <Clock className="w-8 h-8 text-yellow-500" />
                  ) : (
                    <AlertTriangle className="w-8 h-8 text-red-500" />
                  )}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Runner Status</p>
                  <p className={`text-2xl font-bold ${
                    runnerStatus === 'running' ? 'text-green-500' :
                    runnerStatus === 'idle' ? 'text-yellow-500' :
                    'text-red-500'
                  }`}>
                    {runnerStatus === 'running' ? 'Actief' :
                     runnerStatus === 'idle' ? 'Inactief' :
                     'Uitgeschakeld'}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500'}`} />
                    <span className="text-xs text-muted-foreground">
                      {isConnected ? 'Realtime verbonden' : 'Polling'}
                    </span>
                  </div>
                </div>
              </div>
              
              {/* Last Bet */}
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Zap className="w-8 h-8 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Laatste Bet</p>
                  <p className="text-2xl font-bold">{timeSinceLastBet}</p>
                  {lastBetTime && (
                    <p className="text-xs text-muted-foreground">
                      {lastBetTime.toLocaleTimeString('nl-NL')} - {lastSignal?.asset} {lastSignal?.direction}
                    </p>
                  )}
                </div>
              </div>
              
              {/* Today's P&L */}
              <div className="flex items-center gap-4">
                <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
                  stats.totalPnl >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'
                }`}>
                  <TrendingUp className={`w-8 h-8 ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`} />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">P&L (Filled)</p>
                  <p className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl.toFixed(2)} USDC
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {stats.totalSignals} signals • {stats.filledSignals} filled • {(stats.winRate * 100).toFixed(0)}% win
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <V29RStatsCards stats={stats} lastUpdate={lastUpdate} isConnected={isConnected} />
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <V29RRepricingChart signals={signals} />
          <V29RExitDistribution stats={stats} />
        </div>
        
        <V29RLogViewer />
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1"><V29RConfigPanel config={config} onUpdate={updateConfig} /></div>
          <div className="lg:col-span-2"><V29RSignalsTable signals={signals} /></div>
        </div>
        
        <div className="p-4 bg-muted/30 rounded-lg">
          <p className="font-medium">🚀 Run:</p>
          <code className="block bg-background p-3 rounded font-mono text-sm mt-2">cd local-runner && npm run v29r</code>
        </div>
      </main>
    </div>
  );
}
