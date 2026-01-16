import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, RefreshCw, Download } from 'lucide-react';
import { useV29ResponseData } from '@/hooks/useV29ResponseData';
import { V29RStatsCards, V29RSignalsTable, V29RExitDistribution, V29RRepricingChart, V29RConfigPanel } from '@/components/v29r';

export default function V29ResponseDashboard() {
  const { config, signals, stats, loading, error, isConnected, lastUpdate, updateConfig, refetch } = useV29ResponseData();

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
            <Link to="/"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-2" />Back</Button></Link>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">V29-Response</h1>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
              <Badge variant={config.enabled ? 'default' : 'secondary'}>{config.enabled ? 'Active' : 'Disabled'}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleExportCSV}><Download className="h-4 w-4 mr-2" />CSV</Button>
            <Button variant="outline" size="sm" onClick={() => refetch()}><RefreshCw className="h-4 w-4 mr-2" />Refresh</Button>
          </div>
        </div>
      </header>
      <main className="container mx-auto px-4 py-6 space-y-6">
        {error && <div className="p-4 bg-destructive/20 text-destructive rounded-lg">{error}</div>}
        <V29RStatsCards stats={stats} lastUpdate={lastUpdate} isConnected={isConnected} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <V29RRepricingChart signals={signals} />
          <V29RExitDistribution stats={stats} />
        </div>
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
