import { useState, useMemo } from 'react';
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
import { TimeRangeFilter, filterDataByTime, DEFAULT_TIME_FILTER, type TimeFilterType } from '@/components/v27/shadow/TimeRangeFilter';
import { PriceLatencyChart } from '@/components/v27/PriceLatencyChart';
import PaperTraderDashboard from '@/components/v27/PaperTraderDashboard';
import type { ShadowDailyPnL } from '@/hooks/useShadowPositions';

export default function V27Dashboard() {
  const navigate = useNavigate();
  const { data, loading, refetch, rawEvaluations, rawTrackings } = useShadowDashboard(1000);
  const positionsData = useShadowPositions(500);
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [timeFilter, setTimeFilter] = useState<TimeFilterType>(DEFAULT_TIME_FILTER);

  // Filter all data based on time selection
  const filteredData = useMemo(() => {
    return {
      signalLogs: filterDataByTime(data.signalLogs, timeFilter),
      causalityEvents: filterDataByTime(data.causalityEvents, timeFilter) as typeof data.causalityEvents,
      hypotheticalExecutions: filterDataByTime(data.hypotheticalExecutions, timeFilter) as typeof data.hypotheticalExecutions,
      postSignalTracking: data.postSignalTracking, // No timestamp field, keep as is
      hedgeSimulations: filterDataByTime(data.hedgeSimulations, timeFilter) as typeof data.hedgeSimulations,
    };
  }, [data, timeFilter]);

  // ===========================================
  // SHADOW P/L AGGREGATION (from shadow data, not executed trades)
  // ===========================================
  // v27 is a SHADOW system - it does NOT place real trades.
  // P/L must be computed from:
  // - shadowTrades (hypothetical entries)
  // - v27_signal_tracking (outcomes)
  // - shadowAccountState (equity snapshots)
  // When shadow_positions table is empty, we derive from useShadowDashboard data.
  
  const hasShadowPositionData = positionsData.positions.length > 0;
  
  // Build daily PnL from shadow data when DB tables are empty
  const derivedDailyPnl = useMemo((): ShadowDailyPnL[] => {
    if (hasShadowPositionData) return positionsData.dailyPnl;
    
    // Aggregate from shadowTrades + trackings
    const byDate: Record<string, { 
      trades: number; 
      wins: number; 
      losses: number; 
      pnl: number;
      fees: number;
    }> = {};
    
    data.shadowTrades.forEach((trade) => {
      if (!trade.filled) return;
      const date = new Date(trade.entryTimestamp).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };
      byDate[date].trades++;
      byDate[date].fees += Math.abs(trade.feeAssumptionUsd);
    });
    
    // Use tracking data for win/loss determination
    rawTrackings.forEach((t: any) => {
      const date = new Date(t.signal_ts).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };
      
      if (t.would_have_profited === true) {
        byDate[date].wins++;
        byDate[date].pnl += 1.25; // ~5% on $25 trade
      } else if (t.would_have_profited === false) {
        byDate[date].losses++;
        byDate[date].pnl -= 0.75; // ~3% loss on $25 trade
      }
    });
    
    let cumulative = 0;
    const days = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayData]) => {
        cumulative += dayData.pnl;
        return {
          id: date,
          date,
          realized_pnl: dayData.pnl,
          unrealized_pnl: 0,
          total_pnl: dayData.pnl,
          cumulative_pnl: cumulative,
          trades: dayData.trades,
          wins: dayData.wins,
          losses: dayData.losses,
          paired_hedged: 0,
          expired_one_sided: 0,
          emergency_exited: 0,
          no_fill: 0,
          total_fees: dayData.fees,
          win_rate: dayData.wins + dayData.losses > 0 ? dayData.wins / (dayData.wins + dayData.losses) : 0,
          avg_win: dayData.wins > 0 ? dayData.pnl / dayData.wins : 0,
          avg_loss: 0,
          profit_factor: 0,
          starting_equity: 3000,
          ending_equity: 3000 + cumulative,
          max_drawdown: 0,
        };
      })
      .reverse(); // Most recent first
    
    return days;
  }, [hasShadowPositionData, positionsData.dailyPnl, data.shadowTrades, rawTrackings]);
  
  // Build equity curve from shadow data when DB tables are empty
  const derivedEquityCurve = useMemo(() => {
    if (hasShadowPositionData && positionsData.equityCurve.length > 0) {
      return positionsData.equityCurve;
    }
    
    // Use shadowDashboard's computed equity curve and add iso field
    return data.equityCurve.map((e) => ({
      ...e,
      iso: new Date(e.timestamp).toISOString(),
    }));
  }, [hasShadowPositionData, positionsData.equityCurve, data.equityCurve]);
  
  // Aggregate stats from shadow data
  const aggregatedStats = useMemo(() => {
    // Prefer actual position data if available
    if (hasShadowPositionData) {
      return positionsData.stats;
    }
    
    // Otherwise use shadowDashboard's derived stats
    return {
      startingEquity: data.stats.startingEquity,
      currentEquity: data.stats.currentEquity,
      realizedPnl: data.stats.realizedPnl,
      unrealizedPnl: data.stats.unrealizedPnl,
      totalFees: data.stats.totalFees,
      wins: data.stats.winCount,
      losses: data.stats.lossCount,
      winRate: data.stats.winRate,
      maxDrawdown: data.stats.maxDrawdown * 100, // Convert to percentage
      allTimeHigh: data.stats.currentEquity,
      totalTrades: data.stats.entrySignals,
      totalPositions: data.stats.entrySignals,
      openPositions: 0,
      pnlByAsset: data.pnlByCategory.byAsset,
      pnlByResolution: {},
    };
  }, [hasShadowPositionData, positionsData.stats, data.stats, data.pnlByCategory]);

  const filteredPositionsData = useMemo(() => {
    const positions = filterDataByTime(positionsData.positions, timeFilter);
    const executions = filterDataByTime(positionsData.executions, timeFilter);
    const dailyPnl = filterDataByTime(derivedDailyPnl, timeFilter);
    const accounting = filterDataByTime(positionsData.accounting, timeFilter);
    const hedgeAttempts = filterDataByTime(positionsData.hedgeAttempts, timeFilter);

    // Recalculate stats based on filtered data
    // When no position data, use aggregated shadow stats
    let wins: number, losses: number, realizedPnl: number;
    
    if (positions.length > 0) {
      wins = positions.filter(p => (p.net_pnl || 0) > 0).length;
      losses = positions.filter(p => (p.net_pnl || 0) < 0).length;
      realizedPnl = positions.reduce((sum, p) => sum + (p.net_pnl || 0), 0);
    } else {
      // Use shadow-derived stats
      wins = aggregatedStats.wins;
      losses = aggregatedStats.losses;
      realizedPnl = aggregatedStats.realizedPnl;
    }
    
    return {
      positions,
      executions,
      dailyPnl,
      accounting,
      hedgeAttempts,
      equityCurve: derivedEquityCurve,
      hedgeAnalysis: positionsData.hedgeAnalysis,
      stats: {
        ...aggregatedStats,
        wins,
        losses,
        winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : aggregatedStats.winRate,
        realizedPnl,
        totalPositions: positions.length > 0 ? positions.length : aggregatedStats.totalPositions,
      },
    };
  }, [positionsData, derivedDailyPnl, derivedEquityCurve, aggregatedStats, timeFilter]);

  const filteredEvaluations = useMemo(() => {
    return filterDataByTime(rawEvaluations, timeFilter);
  }, [rawEvaluations, timeFilter]);

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
              $3000 starting budget • FIFO accounting • Market cycle: 15 min
            </p>
          </div>
        </div>
        
        {/* Action row: Status + Time Filter + Buttons */}
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
            {/* Time Range Filter */}
            <TimeRangeFilter value={timeFilter} onChange={setTimeFilter} />
            
            <ShadowExportButton
              positions={filteredPositionsData.positions}
              executions={filteredPositionsData.executions}
              dailyPnl={filteredPositionsData.dailyPnl}
              accounting={filteredPositionsData.accounting}
              hedgeAttempts={filteredPositionsData.hedgeAttempts}
              evaluations={filteredEvaluations}
              stats={filteredPositionsData.stats}
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

      {/* Stats Summary Bar - Shows shadow data even when position tables are empty */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary" className="font-normal">
          {filteredPositionsData.stats.totalPositions > 0 
            ? `${filteredPositionsData.stats.totalPositions} posities`
            : `${data.stats.entrySignals} shadow trades`}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {filteredData.signalLogs.length} signals
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {filteredPositionsData.stats.wins}W / {filteredPositionsData.stats.losses}L
        </Badge>
        <Badge variant={filteredPositionsData.stats.realizedPnl >= 0 ? "default" : "destructive"} className="font-normal">
          {filteredPositionsData.stats.realizedPnl >= 0 ? '+' : ''}${filteredPositionsData.stats.realizedPnl.toFixed(2)} PnL
        </Badge>
        {filteredPositionsData.stats.maxDrawdown > 0 && (
          <Badge variant="outline" className="text-red-400 border-red-400/50 font-normal">
            -{filteredPositionsData.stats.maxDrawdown.toFixed(1)}% DD
          </Badge>
        )}
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
            <TabsTrigger value="latency" className="text-xs sm:text-sm px-2 sm:px-3">
              Latency
            </TabsTrigger>
            <TabsTrigger value="counterfactual" className="text-xs sm:text-sm px-2 sm:px-3">
              Counter
            </TabsTrigger>
            <TabsTrigger value="paper" className="text-xs sm:text-sm px-2 sm:px-3 bg-orange-500/20 text-orange-400">
              Paper
            </TabsTrigger>
          </TabsList>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <TabsContent value="overview" className="space-y-4 sm:space-y-6 mt-4">
          <LiveMarketMonitor />
          <SignalLogTable signals={filteredData.signalLogs} />
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
            events={filteredData.causalityEvents}
            latencyToleranceMs={200}
          />
        </TabsContent>

        <TabsContent value="execution" className="mt-4">
          <HypotheticalExecutionPanel executions={filteredData.hypotheticalExecutions} />
        </TabsContent>

        <TabsContent value="tracking" className="mt-4">
          <PostSignalTrackingPanel trackings={filteredData.postSignalTracking} />
        </TabsContent>

        <TabsContent value="hedge" className="mt-4">
          <HedgeSimulationPanel simulations={filteredData.hedgeSimulations} />
        </TabsContent>

        <TabsContent value="pnl" className="mt-4 space-y-4">
          <ShadowEquityCurve
            data={filteredPositionsData.equityCurve}
            startingEquity={filteredPositionsData.stats.startingEquity}
            currentEquity={filteredPositionsData.stats.currentEquity}
            realizedPnl={filteredPositionsData.stats.realizedPnl}
            unrealizedPnl={filteredPositionsData.stats.unrealizedPnl}
            maxDrawdown={filteredPositionsData.stats.maxDrawdown}
            winCount={filteredPositionsData.stats.wins}
            lossCount={filteredPositionsData.stats.losses}
            winRate={filteredPositionsData.stats.winRate / 100}
          />
          <ShadowDailyPnLTable dailyPnl={filteredPositionsData.dailyPnl} />
        </TabsContent>

        <TabsContent value="positions" className="mt-4 space-y-4">
          <ShadowPositionTable positions={filteredPositionsData.positions} />
          <ShadowHedgeAnalysis analysis={filteredPositionsData.hedgeAnalysis} />
        </TabsContent>

        <TabsContent value="latency" className="mt-4">
          <PriceLatencyChart />
        </TabsContent>

        <TabsContent value="counterfactual" className="mt-4">
          <ShadowCounterfactualPanel positions={filteredPositionsData.positions} evaluations={filteredEvaluations} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
