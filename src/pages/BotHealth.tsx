import { useState } from 'react';
import { MainNav } from '@/components/MainNav';
import { MobileNav } from '@/components/MobileNav';
import { useBotHealthDataV2 as useBotHealthData, TimeRange } from '@/hooks/useBotHealthDataV2';
import { BotHealthStatusBadge } from '@/components/BotHealthStatusBadge';
import { BotHealthKeyNumbers } from '@/components/BotHealthKeyNumbers';
import { BotHealthCharts } from '@/components/BotHealthCharts';
import { BotHealthRiskyMarkets } from '@/components/BotHealthRiskyMarkets';
import { BotHealthBehavior } from '@/components/BotHealthBehavior';
import { BotHealthGlossary } from '@/components/BotHealthGlossary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Download, RefreshCw, Search, Activity } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';

const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP'];

export default function BotHealth() {
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [assetFilter, setAssetFilter] = useState<string>('');
  const [marketIdFilter, setMarketIdFilter] = useState('');
  
  const { metrics, isLoading, error, refetch, rawData } = useBotHealthData({
    timeRange,
    assetFilter: assetFilter || undefined,
    marketIdFilter: marketIdFilter || undefined,
  });

  const handleDownloadReport = () => {
    if (!metrics) return;
    
    const report = {
      generatedAt: new Date().toISOString(),
      timeRange,
      filters: { asset: assetFilter, marketId: marketIdFilter },
      metrics,
      rawCounts: {
        events: rawData.events.length,
        orders: rawData.orders.length,
        fills: rawData.fills.length,
        snapshots: rawData.snapshots.length,
      },
    };
    
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bot-health-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <TooltipProvider>
    <div className="min-h-screen bg-background">
      <MainNav />
      <MobileNav />
      
      <main className="container mx-auto px-4 py-6 md:py-8 pb-20 md:pb-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Activity className="w-8 h-8 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Bot Health Dashboard</h1>
              <p className="text-sm text-muted-foreground">
                Monitor bot stabiliteit en gedrag
              </p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => refetch()}
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleDownloadReport}
              disabled={!metrics}
            >
              <Download className="w-4 h-4 mr-2" />
              Download Report
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="pt-4">
            <div className="flex flex-wrap items-center gap-4">
              {/* Time Range */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Periode:</span>
                <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">1 uur</SelectItem>
                    <SelectItem value="6h">6 uur</SelectItem>
                    <SelectItem value="24h">24 uur</SelectItem>
                    <SelectItem value="7d">7 dagen</SelectItem>
                    <SelectItem value="30d">30 dagen</SelectItem>
                    <SelectItem value="all">Alles</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {/* Asset Filter */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Asset:</span>
                <Select value={assetFilter || "all"} onValueChange={(v) => setAssetFilter(v === "all" ? "" : v)}>
                  <SelectTrigger className="w-24">
                    <SelectValue placeholder="Alle" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alle</SelectItem>
                    {ASSETS.map(a => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* Market ID Search */}
              <div className="flex items-center gap-2 flex-1 min-w-48">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Zoek market ID..."
                  value={marketIdFilter}
                  onChange={(e) => setMarketIdFilter(e.target.value)}
                  className="max-w-xs"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error State */}
        {error && (
          <Card className="mb-6 border-red-500/50 bg-red-500/10">
            <CardContent className="pt-4">
              <p className="text-red-400">Error loading data: {error.message}</p>
            </CardContent>
          </Card>
        )}

        {/* Loading State */}
        {isLoading && !metrics && (
          <div className="space-y-6">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-48" />
              <Skeleton className="h-48" />
            </div>
          </div>
        )}

        {/* Dashboard Content */}
        {metrics && (
          <Tabs defaultValue="summary" className="space-y-6">
            <TabsList>
              <TabsTrigger value="summary">Samenvatting</TabsTrigger>
              <TabsTrigger value="stability">Stabiliteit & Risico</TabsTrigger>
              <TabsTrigger value="behavior">Gedrag</TabsTrigger>
              <TabsTrigger value="glossary">Uitleg</TabsTrigger>
            </TabsList>

            {/* A) Executive Summary */}
            <TabsContent value="summary" className="space-y-6">
              <BotHealthStatusBadge status={metrics.status} reasons={metrics.reasons} />
              <BotHealthKeyNumbers metrics={metrics} />
            </TabsContent>

            {/* B) Stability & Risk */}
            <TabsContent value="stability" className="space-y-6">
              <BotHealthCharts metrics={metrics} />
              <BotHealthRiskyMarkets markets={metrics.riskyMarkets} />
            </TabsContent>

            {/* C) Strategy Behavior */}
            <TabsContent value="behavior" className="space-y-6">
              <BotHealthBehavior metrics={metrics} />
            </TabsContent>

            {/* D) Glossary */}
            <TabsContent value="glossary" className="space-y-6">
              <BotHealthGlossary />
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
    </TooltipProvider>
  );
}
