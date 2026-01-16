import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw, Database, BookOpen, BarChart3, Zap, Activity } from 'lucide-react';
import { WindowsList, SignalAnalysisTable } from '@/components/chainlink';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  SignalQualityTable, 
  EdgeSpreadScatterPlot,
  SpotLeadPnLChart,
  TakerZscorePnLChart,
  StrategyExplainerCard,
  MetricExplainerCard,
  BucketExplainerTable
} from '@/components/signalQuality';
import {
  MomentumConfidenceCard,
  DeltaWinMatrix,
  DirectionAnalysisCard,
  PricePathChart,
  RecommendationsPanel
} from '@/components/momentum';
import { 
  useSignalQualityStats, 
  useBucketAggregations,
  usePopulateSignalQuality 
} from '@/hooks/useSignalQualityAnalysis';
import { useMomentumAnalysis } from '@/hooks/useMomentumAnalysis';
import { toast } from 'sonner';

export default function BetsHistory() {
  const queryClient = useQueryClient();
  const [selectedAsset, setSelectedAsset] = useState<string>('all');
  
  const { stats, signals, isLoading } = useSignalQualityStats({ asset: selectedAsset });
  const { aggregations } = useBucketAggregations(selectedAsset);
  const populateMutation = usePopulateSignalQuality();
  
  // New momentum analysis hook
  const { 
    data: momentumData, 
    isLoading: momentumLoading 
  } = useMomentumAnalysis(selectedAsset);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['chainlink-windows'] });
    queryClient.invalidateQueries({ queryKey: ['signal-analysis'] });
    queryClient.invalidateQueries({ queryKey: ['signal-quality-analysis'] });
    queryClient.invalidateQueries({ queryKey: ['momentum-analysis'] });
    toast.success('Data wordt ververst...');
  };

  const handlePopulate = () => {
    populateMutation.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(`${result.processed} signalen geanalyseerd (${result.fromV29} van v29, ${result.fromV29Response} van v29-response)`);
      },
      onError: (error) => {
        toast.error(`Fout bij analyseren: ${error.message}`);
      }
    });
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
            <div>
              <h1 className="text-xl font-bold">Signal Quality & Edge Truth</h1>
              <p className="text-xs text-muted-foreground">Analyseer je trading strategie prestaties</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Select value={selectedAsset} onValueChange={setSelectedAsset}>
              <SelectTrigger className="w-[100px]">
                <SelectValue placeholder="Asset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle</SelectItem>
                <SelectItem value="BTC">BTC</SelectItem>
                <SelectItem value="ETH">ETH</SelectItem>
                <SelectItem value="SOL">SOL</SelectItem>
                <SelectItem value="XRP">XRP</SelectItem>
              </SelectContent>
            </Select>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handlePopulate}
              disabled={populateMutation.isPending}
            >
              <Database className="h-4 w-4 mr-2" />
              {populateMutation.isPending ? 'Bezig...' : 'Analyseer'}
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Ververs
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        <Tabs defaultValue="momentum" className="space-y-4">
          <TabsList className="flex-wrap">
            <TabsTrigger value="momentum" className="gap-2">
              <Zap className="h-4 w-4" />
              Momentum Dynamics
            </TabsTrigger>
            <TabsTrigger value="overview" className="gap-2">
              <BookOpen className="h-4 w-4" />
              Overzicht & Advies
            </TabsTrigger>
            <TabsTrigger value="metrics" className="gap-2">
              <BarChart3 className="h-4 w-4" />
              Metrics Uitleg
            </TabsTrigger>
            <TabsTrigger value="signals">Signaal Tabel</TabsTrigger>
            <TabsTrigger value="charts">Grafieken</TabsTrigger>
            <TabsTrigger value="windows">Price Windows</TabsTrigger>
          </TabsList>
          
          {/* NEW: Momentum Dynamics Tab */}
          <TabsContent value="momentum" className="space-y-6">
            {/* Data source info */}
            <div className="text-sm text-muted-foreground bg-muted/30 p-3 rounded-lg">
              <strong>Data:</strong> v29_signals_response tabel | 
              <strong className="ml-2">Signalen:</strong> {momentumData?.totalSignals || 0} totaal, {momentumData?.signalsWithPath || 0} met price path |
              <strong className="ml-2">Delta:</strong> binance_price - strike_price
            </div>
            
            {/* Confidence score - prominent */}
            <MomentumConfidenceCard 
              confidence={momentumData?.confidence || { score: 0, label: 'VERMIJDEN', reasons: [] }} 
              isLoading={momentumLoading} 
            />
            
            {/* Two column layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Delta-Win Matrix */}
              <DeltaWinMatrix 
                bucketStats={momentumData?.bucketStats || []} 
                isLoading={momentumLoading} 
              />
              
              {/* Direction Analysis */}
              <DirectionAnalysisCard 
                directionStats={momentumData?.directionStats || []} 
                isLoading={momentumLoading} 
              />
            </div>
            
            {/* Price Path Chart */}
            <PricePathChart 
              signals={momentumData?.signals || []} 
              isLoading={momentumLoading} 
            />
            
            {/* Recommendations */}
            <RecommendationsPanel 
              recommendations={momentumData?.recommendations || []} 
              isLoading={momentumLoading} 
            />
          </TabsContent>
          
          <TabsContent value="overview" className="space-y-6">
            {/* Strategy health and recommendations */}
            <StrategyExplainerCard stats={stats} aggregations={aggregations} />
            
            {/* Bucket table with explanations */}
            <BucketExplainerTable aggregations={aggregations} isLoading={isLoading} />
          </TabsContent>
          
          <TabsContent value="metrics" className="space-y-6">
            {/* Detailed metric explanations */}
            <MetricExplainerCard stats={stats} isLoading={isLoading} />
            
            {/* Bucket table */}
            <BucketExplainerTable aggregations={aggregations} isLoading={isLoading} />
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