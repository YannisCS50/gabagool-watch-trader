import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw, Database } from 'lucide-react';
import { WindowsList, SignalAnalysisTable } from '@/components/chainlink';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  SignalQualityStatsCards, 
  SignalQualityTable, 
  BucketAnalysisTable,
  EdgeSpreadScatterPlot,
  SpotLeadPnLChart,
  TakerZscorePnLChart 
} from '@/components/signalQuality';
import { 
  useSignalQualityStats, 
  useBucketAggregations,
  usePopulateSignalQuality 
} from '@/hooks/useSignalQualityAnalysis';

export default function BetsHistory() {
  const queryClient = useQueryClient();
  const [selectedAsset, setSelectedAsset] = useState<string>('all');
  
  const { stats, signals, isLoading } = useSignalQualityStats({ asset: selectedAsset });
  const { aggregations } = useBucketAggregations(selectedAsset);
  const populateMutation = usePopulateSignalQuality();

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['chainlink-windows'] });
    queryClient.invalidateQueries({ queryKey: ['signal-analysis'] });
    queryClient.invalidateQueries({ queryKey: ['signal-quality-analysis'] });
  };

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
            <h1 className="text-xl font-bold">Signal Quality & Edge Truth</h1>
          </div>
          <div className="flex items-center gap-2">
            <Select value={selectedAsset} onValueChange={setSelectedAsset}>
              <SelectTrigger className="w-[100px]">
                <SelectValue placeholder="Asset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => populateMutation.mutate()}
              disabled={populateMutation.isPending}
            >
              <Database className="h-4 w-4 mr-2" />
              Populate
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        <Tabs defaultValue="edge-truth" className="space-y-4">
          <TabsList>
            <TabsTrigger value="edge-truth">Edge Truth</TabsTrigger>
            <TabsTrigger value="signals">Signal Table</TabsTrigger>
            <TabsTrigger value="charts">Visualizations</TabsTrigger>
            <TabsTrigger value="windows">Price Windows</TabsTrigger>
          </TabsList>
          
          <TabsContent value="edge-truth" className="space-y-6">
            <SignalQualityStatsCards stats={stats} isLoading={isLoading} />
            <BucketAnalysisTable aggregations={aggregations} isLoading={isLoading} />
          </TabsContent>
          
          <TabsContent value="signals">
            <SignalQualityTable signals={signals || []} isLoading={isLoading} />
          </TabsContent>
          
          <TabsContent value="charts" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <EdgeSpreadScatterPlot signals={signals || []} isLoading={isLoading} />
              <SpotLeadPnLChart signals={signals || []} isLoading={isLoading} />
            </div>
            <TakerZscorePnLChart signals={signals || []} isLoading={isLoading} />
          </TabsContent>
          
          <TabsContent value="windows">
            <WindowsList />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
