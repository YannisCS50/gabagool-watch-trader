import { useV30Data } from '@/hooks/useV30Data';
import {
  V30LiveStatus,
  V30InventoryPanel,
  V30EdgeHistogram,
  V30ConfigEditor,
  V30TradeLog,
  V30StatsCards,
  V30LogViewer,
  V30FairValueExplainer,
  V30BetPnLTable,
} from '@/components/v30';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function V30Dashboard() {
  const { config, ticks, positions, stats, loading, error, isConnected, lastUpdate, updateConfig, refetch } = useV30Data();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading V30 data...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">V30 Market-Maker</h1>
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
              <Badge variant={config.enabled ? 'default' : 'secondary'}>
                {config.enabled ? 'Active' : 'Disabled'}
              </Badge>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6 space-y-6">
        {error && (
          <div className="p-4 bg-destructive/20 text-destructive rounded-lg">
            {error}
          </div>
        )}

        {/* Stats Overview with live status */}
        <V30StatsCards stats={stats} lastUpdate={lastUpdate} isConnected={isConnected} />

        {/* Live Status Grid */}
        <V30LiveStatus ticks={ticks} assets={config.assets} />

        {/* Bet P/L Table */}
        <V30BetPnLTable />

        {/* Log Viewer - Full Width */}
        <V30LogViewer />

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Wider */}
          <div className="lg:col-span-2 space-y-6">
            {/* Fair Value Explainer */}
            <V30FairValueExplainer />

            {/* Config Editor */}
            <V30ConfigEditor config={config} onUpdate={updateConfig} />

            {/* Edge Histogram */}
            <V30EdgeHistogram ticks={ticks} />

            {/* Trade Log */}
            <V30TradeLog ticks={ticks} />
          </div>

          {/* Right Column - Inventory */}
          <div>
            <V30InventoryPanel positions={positions} config={config} />
          </div>
        </div>
      </main>
    </div>
  );
}
