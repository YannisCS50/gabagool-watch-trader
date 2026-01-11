import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDistanceToNow } from 'date-fns';
import { nl } from 'date-fns/locale';

import { useShadowDashboard } from '@/hooks/useShadowDashboard';
import { EngineStatusPanel } from '@/components/v27/shadow/EngineStatusPanel';
import { LiveMarketMonitor } from '@/components/v27/shadow/LiveMarketMonitor';
import { AdverseSelectionPanel } from '@/components/v27/shadow/AdverseSelectionPanel';
import { CausalityTracker } from '@/components/v27/shadow/CausalityTracker';
import { SignalLogTable } from '@/components/v27/shadow/SignalLogTable';
import { HypotheticalExecutionPanel } from '@/components/v27/shadow/HypotheticalExecutionPanel';
import { PostSignalTrackingPanel } from '@/components/v27/shadow/PostSignalTrackingPanel';
import { HedgeSimulationPanel } from '@/components/v27/shadow/HedgeSimulationPanel';
import { EquityCurveChart } from '@/components/v27/shadow/EquityCurveChart';
import { ExportDataButton } from '@/components/v27/shadow/ExportDataButton';
import { CounterfactualAnalysisPanel } from '@/components/v27/shadow/CounterfactualAnalysis';

export default function V27Dashboard() {
  const navigate = useNavigate();
  const { data, loading, refetch, rawEvaluations, rawTrackings } = useShadowDashboard(1000);
  const [activeTab, setActiveTab] = useState<string>('overview');

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              V27 Shadow Trading Dashboard
              <Badge variant="outline" className="text-amber-500 border-amber-500">
                <Eye className="h-3 w-3 mr-1" />
                Shadow Mode
              </Badge>
            </h1>
            <p className="text-muted-foreground text-sm">
              $3000 starting budget • FIFO accounting • Full data collection
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {data.engineStatus.isOnline ? (
            <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
              <Wifi className="h-3 w-3 mr-1" />
              Online
            </Badge>
          ) : (
            <Badge variant="destructive">
              <WifiOff className="h-3 w-3 mr-1" />
              Offline
            </Badge>
          )}
          {data.engineStatus.lastHeartbeat && (
            <span className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(data.engineStatus.lastHeartbeat), { addSuffix: true, locale: nl })}
            </span>
          )}
          
          <ExportDataButton data={data} rawEvaluations={rawEvaluations} rawTrackings={rawTrackings} />
          
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Engine Status */}
      <div className="mb-6">
        <EngineStatusPanel status={data.engineStatus} />
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4 flex-wrap">
          <TabsTrigger value="overview">Markets & Signals</TabsTrigger>
          <TabsTrigger value="adverse">Adverse Selection</TabsTrigger>
          <TabsTrigger value="causality">Causality</TabsTrigger>
          <TabsTrigger value="execution">Execution Sim</TabsTrigger>
          <TabsTrigger value="tracking">Post-Signal</TabsTrigger>
          <TabsTrigger value="hedge">Hedge Sim</TabsTrigger>
          <TabsTrigger value="pnl">PnL & Equity</TabsTrigger>
          <TabsTrigger value="counterfactual">Counterfactual</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <LiveMarketMonitor />
          <SignalLogTable signals={data.signalLogs} />
        </TabsContent>

        <TabsContent value="adverse">
          <AdverseSelectionPanel 
            metrics={data.adverseSelection}
            blockedTrades={[]}
            totalBlocked={data.stats.blockedSignals}
          />
        </TabsContent>

        <TabsContent value="causality">
          <CausalityTracker 
            events={data.causalityEvents}
            latencyToleranceMs={200}
          />
        </TabsContent>

        <TabsContent value="execution">
          <HypotheticalExecutionPanel executions={data.hypotheticalExecutions} />
        </TabsContent>

        <TabsContent value="tracking">
          <PostSignalTrackingPanel trackings={data.postSignalTracking} />
        </TabsContent>

        <TabsContent value="hedge">
          <HedgeSimulationPanel simulations={data.hedgeSimulations} />
        </TabsContent>

        <TabsContent value="pnl">
          <div>
            <EquityCurveChart 
              data={data.equityCurve}
              startingEquity={data.stats.startingEquity}
              currentEquity={data.stats.currentEquity}
              realizedPnl={data.stats.realizedPnl}
              unrealizedPnl={data.stats.unrealizedPnl}
              maxDrawdown={data.stats.maxDrawdown}
              winCount={data.stats.winCount}
              lossCount={data.stats.lossCount}
              winRate={data.stats.winRate}
            />
          </div>
        </TabsContent>

        <TabsContent value="counterfactual">
          <div>
            <CounterfactualAnalysisPanel counterfactuals={data.counterfactuals} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
