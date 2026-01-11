import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

import { useShadowDashboard } from '@/hooks/useShadowDashboard';
import { useShadowPositions } from '@/hooks/useShadowPositions';
import { EngineStatusPanel } from '@/components/v27/shadow/EngineStatusPanel';
import { LiveMarketMonitor } from '@/components/v27/shadow/LiveMarketMonitor';
import { AdverseSelectionPanel } from '@/components/v27/shadow/AdverseSelectionPanel';
import { CausalityTracker } from '@/components/v27/shadow/CausalityTracker';
import { SignalLogTable } from '@/components/v27/shadow/SignalLogTable';
import { HypotheticalExecutionPanel } from '@/components/v27/shadow/HypotheticalExecutionPanel';
import { PostSignalTrackingPanel } from '@/components/v27/shadow/PostSignalTrackingPanel';
import { HedgeSimulationPanel } from '@/components/v27/shadow/HedgeSimulationPanel';
import { ExportDataButton } from '@/components/v27/shadow/ExportDataButton';
import { CounterfactualAnalysisPanel } from '@/components/v27/shadow/CounterfactualAnalysis';
import { ShadowPositionTable } from '@/components/v27/shadow/ShadowPositionTable';
import { ShadowDailyPnLTable } from '@/components/v27/shadow/ShadowDailyPnLTable';
import { ShadowHedgeAnalysis } from '@/components/v27/shadow/ShadowHedgeAnalysis';
import { ShadowEquityCurve } from '@/components/v27/shadow/ShadowEquityCurve';
import { ShadowCounterfactualPanel } from '@/components/v27/shadow/ShadowCounterfactualPanel';
import { ShadowExportButton } from '@/components/v27/shadow/ShadowExportButton';

export default function V27Dashboard() {
  const navigate = useNavigate();
  const { data, loading, refetch, rawEvaluations, rawTrackings } = useShadowDashboard(1000);
  const positionsData = useShadowPositions(500);
  const [activeTab, setActiveTab] = useState<string>('overview');

  return (
    <div className="min-h-screen bg-background p-3 sm:p-4 md:p-6">
      {/* Header - Mobile Optimized */}
      <div className="flex flex-col gap-3 mb-4 sm:mb-6">
        {/* Top row: Back + Title */}
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" className="shrink-0 mt-0.5" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg sm:text-xl md:text-2xl font-bold">
                V27 Shadow Trading
              </h1>
              <Badge variant="outline" className="text-amber-500 border-amber-500 text-xs shrink-0">
                <Eye className="h-3 w-3 mr-1" />
                Shadow
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs sm:text-sm mt-0.5 hidden sm:block">
              $3000 starting budget • FIFO accounting
            </p>
          </div>
        </div>
        
        {/* Action row: Status + Buttons */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {data.engineStatus.isOnline ? (
              <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-xs">
                <Wifi className="h-3 w-3 mr-1" />
                Online
              </Badge>
            ) : (
              <Badge variant="destructive" className="text-xs">
                <WifiOff className="h-3 w-3 mr-1" />
                Offline
              </Badge>
            )}
            {data.engineStatus.lastHeartbeat && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {formatDistanceToNow(new Date(data.engineStatus.lastHeartbeat), { addSuffix: true, locale: nl })}
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <ShadowExportButton
              positions={positionsData.positions}
              executions={positionsData.executions}
              dailyPnl={positionsData.dailyPnl}
              accounting={positionsData.accounting}
              hedgeAttempts={positionsData.hedgeAttempts}
              evaluations={rawEvaluations}
              stats={positionsData.stats}
            />
            <ExportDataButton data={data} rawEvaluations={rawEvaluations} rawTrackings={rawTrackings} />
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={loading} className="h-8">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline ml-1">Refresh</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Engine Status - Collapsible on Mobile */}
      <div className="mb-4 sm:mb-6">
        <EngineStatusPanel status={data.engineStatus} />
      </div>

      {/* Main Content Tabs - Horizontal Scroll on Mobile */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <ScrollArea className="w-full whitespace-nowrap pb-2">
          <TabsList className="inline-flex w-max gap-1 p-1">
            <TabsTrigger value="overview" className="text-xs sm:text-sm px-2 sm:px-3">
              Markets
            </TabsTrigger>
            <TabsTrigger value="adverse" className="text-xs sm:text-sm px-2 sm:px-3">
              Adverse
            </TabsTrigger>
            <TabsTrigger value="causality" className="text-xs sm:text-sm px-2 sm:px-3">
              Causality
            </TabsTrigger>
            <TabsTrigger value="execution" className="text-xs sm:text-sm px-2 sm:px-3">
              Execution
            </TabsTrigger>
            <TabsTrigger value="tracking" className="text-xs sm:text-sm px-2 sm:px-3">
              Post-Signal
            </TabsTrigger>
            <TabsTrigger value="hedge" className="text-xs sm:text-sm px-2 sm:px-3">
              Hedge
            </TabsTrigger>
            <TabsTrigger value="pnl" className="text-xs sm:text-sm px-2 sm:px-3">
              PnL
            </TabsTrigger>
            <TabsTrigger value="positions" className="text-xs sm:text-sm px-2 sm:px-3">
              Positions
            </TabsTrigger>
            <TabsTrigger value="counterfactual" className="text-xs sm:text-sm px-2 sm:px-3">
              Counter
            </TabsTrigger>
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <TabsContent value="overview" className="space-y-4 sm:space-y-6 mt-4">
          <LiveMarketMonitor />
          <SignalLogTable signals={data.signalLogs} />
        </TabsContent>

        <TabsContent value="adverse" className="mt-4">
          <AdverseSelectionPanel 
            metrics={data.adverseSelection}
            blockedTrades={[]}
            totalBlocked={data.stats.blockedSignals}
          />
        </TabsContent>

        <TabsContent value="causality" className="mt-4">
          <CausalityTracker 
            events={data.causalityEvents}
            latencyToleranceMs={200}
          />
        </TabsContent>

        <TabsContent value="execution" className="mt-4">
          <HypotheticalExecutionPanel executions={data.hypotheticalExecutions} />
        </TabsContent>

        <TabsContent value="tracking" className="mt-4">
          <PostSignalTrackingPanel trackings={data.postSignalTracking} />
        </TabsContent>

        <TabsContent value="hedge" className="mt-4">
          <HedgeSimulationPanel simulations={data.hedgeSimulations} />
        </TabsContent>

        <TabsContent value="pnl" className="mt-4 space-y-4">
          <ShadowEquityCurve
            data={positionsData.equityCurve}
            startingEquity={positionsData.stats.startingEquity}
            currentEquity={positionsData.stats.currentEquity}
            realizedPnl={positionsData.stats.realizedPnl}
            unrealizedPnl={positionsData.stats.unrealizedPnl}
            maxDrawdown={positionsData.stats.maxDrawdown}
            winCount={positionsData.stats.wins}
            lossCount={positionsData.stats.losses}
            winRate={positionsData.stats.winRate}
          />
          <ShadowDailyPnLTable dailyPnl={positionsData.dailyPnl} />
        </TabsContent>

        <TabsContent value="positions" className="mt-4 space-y-4">
          <ShadowPositionTable positions={positionsData.positions} />
          <ShadowHedgeAnalysis analysis={positionsData.hedgeAnalysis} />
        </TabsContent>

        <TabsContent value="counterfactual" className="mt-4">
          <ShadowCounterfactualPanel positions={positionsData.positions} evaluations={rawEvaluations} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
