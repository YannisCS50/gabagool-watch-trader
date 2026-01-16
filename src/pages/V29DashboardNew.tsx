import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useV29Data } from '@/hooks/useV29Data';
import {
  V29ConfigEditorNew,
  V29StatsCards,
  V29LiveStatus,
  V29PositionsTable,
  V29PairingExplainer,
} from '@/components/v29';

export default function V29DashboardNew() {
  const { 
    config, 
    signals, 
    positions, 
    stats, 
    loading, 
    error, 
    isConnected, 
    lastUpdate, 
    updateConfig, 
    refetch 
  } = useV29Data();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading V29 data...</div>
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
              <h1 className="text-xl font-bold">V29 Pair-Instead-of-Sell</h1>
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

        {/* Stats Overview */}
        <V29StatsCards stats={stats} lastUpdate={lastUpdate} isConnected={isConnected} />

        {/* Live Status Grid */}
        <V29LiveStatus signals={signals} assets={config.assets} />

        {/* Pairing Explainer */}
        <V29PairingExplainer />

        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Wider */}
          <div className="lg:col-span-2 space-y-6">
            {/* Config Editor */}
            <V29ConfigEditorNew config={config} onUpdate={updateConfig} />
          </div>

          {/* Right Column - Positions */}
          <div className="space-y-6">
            <V29PositionsTable positions={positions} />
          </div>
        </div>
      </main>
    </div>
  );
}
