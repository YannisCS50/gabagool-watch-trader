import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { Download, FileJson, FileSpreadsheet, Loader2, ListFilter } from 'lucide-react';
import { toast } from 'sonner';
import type { ShadowDashboardData } from '@/hooks/useShadowDashboard';

interface ExportDataButtonProps {
  data: ShadowDashboardData;
  rawEvaluations: any[];
  rawTrackings: any[];
}

type SampleSize = 'all' | 10 | 25 | 50 | 100;

export function ExportDataButton({ data, rawEvaluations, rawTrackings }: ExportDataButtonProps) {
  const [exporting, setExporting] = useState(false);

  const downloadFile = (content: string, filename: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sliceData = <T,>(arr: T[], size: SampleSize): T[] => {
    if (size === 'all') return arr;
    return arr.slice(-size); // Take last N items (most recent)
  };

  const getSizeLabel = (size: SampleSize) => size === 'all' ? 'Alles' : `Laatste ${size}`;

  // ============================================
  // FULL JSON EXPORT (All Data Structures)
  // ============================================
  const exportAllJSON = async (size: SampleSize = 'all') => {
    setExporting(true);
    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        sampleSize: size,
        exportVersion: '2.0', // Indicates complete export format
        config: {
          startingBudget: data.stats.startingEquity,
          accountingMode: 'FIFO',
          tickSize: 0.01,
        },
        engineStatus: data.engineStatus,
        stats: data.stats,
        
        // Raw data
        rawEvaluations: sliceData(rawEvaluations, size),
        rawTrackings: sliceData(rawTrackings, size),
        
        // Signals (all, including skipped)
        signalLogs: sliceData(data.signalLogs, size),
        
        // Shadow Trades (hypothetical execution objects)
        shadowTrades: sliceData(data.shadowTrades, size),
        
        // Post-signal price paths
        postSignalPaths: sliceData(data.postSignalPaths, size),
        postSignalTracking: sliceData(data.postSignalTracking, size),
        
        // Hedge simulations
        shadowHedges: sliceData(data.shadowHedges, size),
        hedgeSimulations: sliceData(data.hedgeSimulations, size),
        
        // Account state over time
        shadowAccountState: sliceData(data.shadowAccountState, size),
        equityCurve: sliceData(data.equityCurve, size),
        
        // Causality
        causalityTraces: sliceData(data.causalityTraces, size),
        causalityEvents: sliceData(data.causalityEvents, size),
        
        // Execution assumptions
        executionAssumptions: sliceData(data.executionAssumptions, size),
        hypotheticalExecutions: sliceData(data.hypotheticalExecutions, size),
        
        // Analysis
        counterfactuals: sliceData(data.counterfactuals, size),
        pnlByCategory: data.pnlByCategory,
      };

      const json = JSON.stringify(exportData, null, 2);
      const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
      downloadFile(json, `shadow-complete-export-${sizeLabel}-${Date.now()}.json`, 'application/json');
      toast.success(`Geëxporteerd: ${getSizeLabel(size)} (volledige dataset)`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Export mislukt');
    } finally {
      setExporting(false);
    }
  };

  // ============================================
  // CSV EXPORTS
  // ============================================
  const exportSignalsCSV = (size: SampleSize = 'all') => {
    const headers = [
      'id', 'timestamp', 'market_id', 'asset', 'side', 'delta', 'mispricing', 'threshold',
      'engine_state', 'passed_filters', 'failed_filters'
    ];
    
    const signals = sliceData(data.signalLogs, size);
    const rows = signals.map((s) => [
      s.id,
      s.iso,
      s.marketId,
      s.asset,
      s.side || '',
      s.delta.toFixed(6),
      s.mispricing.toFixed(6),
      s.threshold.toFixed(6),
      s.engineState,
      s.passedFilters ? 'true' : 'false',
      s.failedFilters.join(';'),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `signals-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} signals`);
  };

  const exportShadowTradesCSV = (size: SampleSize = 'all') => {
    const headers = [
      'trade_id', 'signal_id', 'market_id', 'asset', 'side', 'entry_timestamp',
      'entry_price_maker', 'entry_price_taker', 'assumed_execution_type',
      'assumed_fill_probability', 'assumed_fill_latency_ms', 'assumed_fill_price',
      'trade_size_usd', 'trade_size_shares', 'fee_assumption_usd', 'filled', 'fill_assumption_reason'
    ];
    
    const trades = sliceData(data.shadowTrades, size);
    const rows = trades.map((t) => [
      t.tradeId,
      t.signalId,
      t.marketId,
      t.asset,
      t.side,
      t.entryTimestamp,
      t.entryPriceMaker.toFixed(6),
      t.entryPriceTaker.toFixed(6),
      t.assumedExecutionType,
      t.assumedFillProbability.toFixed(4),
      t.assumedFillLatencyMs.toFixed(0),
      t.assumedFillPrice.toFixed(6),
      t.tradeSizeUsd.toFixed(2),
      t.tradeSizeShares.toFixed(4),
      t.feeAssumptionUsd.toFixed(4),
      t.filled ? 'true' : 'false',
      `"${t.fillAssumptionReason}"`,
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `shadow-trades-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} shadow trades`);
  };

  const exportPostSignalPathsCSV = (size: SampleSize = 'all') => {
    const headers = [
      'signal_id', 'market_id', 'signal_side',
      't1s_spot', 't1s_up_mid', 't1s_down_mid', 't1s_delta',
      't5s_spot', 't5s_up_mid', 't5s_down_mid', 't5s_delta',
      't10s_spot', 't10s_up_mid', 't10s_down_mid', 't10s_delta',
      't15s_spot', 't15s_up_mid', 't15s_down_mid', 't15s_delta',
      't30s_spot', 't30s_up_mid', 't30s_down_mid', 't30s_delta',
      'max_favorable_move', 'max_adverse_move', 'mispricing_resolved', 'resolution_time_s'
    ];
    
    const paths = sliceData(data.postSignalPaths, size);
    const rows = paths.map((p) => {
      const fmt = (v: number | 'UNKNOWN') => v === 'UNKNOWN' ? 'UNKNOWN' : (v as number).toFixed(6);
      return [
        p.signalId,
        p.marketId,
        p.signalSide || '',
        fmt(p.timestamps.t1s?.spotPrice ?? 'UNKNOWN'),
        fmt(p.timestamps.t1s?.upMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t1s?.downMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t1s?.delta ?? 'UNKNOWN'),
        fmt(p.timestamps.t5s?.spotPrice ?? 'UNKNOWN'),
        fmt(p.timestamps.t5s?.upMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t5s?.downMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t5s?.delta ?? 'UNKNOWN'),
        fmt(p.timestamps.t10s?.spotPrice ?? 'UNKNOWN'),
        fmt(p.timestamps.t10s?.upMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t10s?.downMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t10s?.delta ?? 'UNKNOWN'),
        fmt(p.timestamps.t15s?.spotPrice ?? 'UNKNOWN'),
        fmt(p.timestamps.t15s?.upMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t15s?.downMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t15s?.delta ?? 'UNKNOWN'),
        fmt(p.timestamps.t30s?.spotPrice ?? 'UNKNOWN'),
        fmt(p.timestamps.t30s?.upMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t30s?.downMid ?? 'UNKNOWN'),
        fmt(p.timestamps.t30s?.delta ?? 'UNKNOWN'),
        p.maxFavorableMove.toFixed(6),
        p.maxAdverseMove.toFixed(6),
        p.mispricingResolved ? 'true' : 'false',
        p.resolutionTimeSeconds?.toString() || '',
      ];
    });

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `post-signal-paths-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} price paths`);
  };

  const exportShadowHedgesCSV = (size: SampleSize = 'all') => {
    const headers = [
      'trade_id', 'signal_id', 'hedge_attempts_count', 'emergency_hedge_used',
      'emergency_reason', 'final_hedge_outcome', 'combined_cpp',
      'first_attempt_ts', 'first_attempt_price', 'first_attempt_spread', 'first_attempt_cpp'
    ];
    
    const hedges = sliceData(data.shadowHedges, size);
    const rows = hedges.map((h) => {
      const firstAttempt = h.hedgeAttempts[0];
      return [
        h.tradeId,
        h.signalId,
        h.hedgeAttempts.length,
        h.emergencyHedgeUsed ? 'true' : 'false',
        h.emergencyReason || '',
        h.finalHedgeOutcome,
        h.combinedCpp.toFixed(4),
        firstAttempt?.timestamp || '',
        firstAttempt?.hedgePrice.toFixed(6) || '',
        firstAttempt?.spreadAtHedge.toFixed(6) || '',
        firstAttempt?.hedgeCpp.toFixed(4) || '',
      ];
    });

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `shadow-hedges-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} shadow hedges`);
  };

  const exportAccountStateCSV = (size: SampleSize = 'all') => {
    const headers = [
      'timestamp', 'equity', 'realized_pnl', 'unrealized_pnl',
      'open_trades_count', 'peak_equity', 'drawdown_pct'
    ];
    
    const states = sliceData(data.shadowAccountState, size);
    const rows = states.map((s) => [
      new Date(s.timestamp).toISOString(),
      s.equity.toFixed(2),
      s.realizedPnl.toFixed(2),
      s.unrealizedPnl.toFixed(2),
      s.openTradesCount,
      s.peakEquity.toFixed(2),
      s.drawdownPct.toFixed(6),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `shadow-account-state-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} account states`);
  };

  const exportCausalityTracesCSV = (size: SampleSize = 'all') => {
    const headers = [
      'signal_id', 'spot_event_timestamp', 'polymarket_event_timestamp',
      'latency_ms', 'tolerance_ms', 'spot_leads', 'poly_leads', 'causality_verdict'
    ];
    
    const traces = sliceData(data.causalityTraces, size);
    const rows = traces.map((t) => [
      t.signalId,
      t.spotEventTimestamp,
      t.polymarketEventTimestamp,
      t.latencyMs,
      t.toleranceMs,
      t.spotLeads ? 'true' : 'false',
      t.polyLeads ? 'true' : 'false',
      t.causalityVerdict,
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `causality-traces-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} causality traces`);
  };

  const exportExecutionAssumptionsCSV = (size: SampleSize = 'all') => {
    const headers = [
      'trade_id', 'signal_id', 'maker_fill_rate_estimate', 'taker_slippage_estimate',
      'spread_at_decision', 'depth_at_decision', 'adverse_selection_score_at_entry'
    ];
    
    const assumptions = sliceData(data.executionAssumptions, size);
    const rows = assumptions.map((a) => [
      a.tradeId,
      a.signalId,
      a.makerFillRateEstimate.toFixed(4),
      a.takerSlippageEstimate.toFixed(6),
      a.spreadAtDecision.toFixed(6),
      a.depthAtDecision === 'UNKNOWN' ? 'UNKNOWN' : (a.depthAtDecision as number).toFixed(2),
      a.adverseSelectionScoreAtEntry.toFixed(4),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `execution-assumptions-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} execution assumptions`);
  };

  const exportEquityCurveCSV = (size: SampleSize = 'all') => {
    const headers = ['timestamp', 'equity', 'realized_pnl', 'unrealized_pnl', 'fees', 'drawdown'];
    
    const curve = sliceData(data.equityCurve, size);
    const rows = curve.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.equity.toFixed(2),
      e.realizedPnl.toFixed(2),
      e.unrealizedPnl.toFixed(2),
      e.fees.toFixed(4),
      e.drawdown.toFixed(6),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `equity-curve-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} equity curve`);
  };

  const exportRawEvaluationsCSV = (size: SampleSize = 'all') => {
    if (rawEvaluations.length === 0) {
      toast.error('Geen evaluaties om te exporteren');
      return;
    }

    const evals = sliceData(rawEvaluations, size);
    const headers = Object.keys(evals[0]);
    const rows = evals.map((e) => 
      headers.map((h) => {
        const val = e[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      })
    );

    const csv = [headers.join(','), ...rows.map((r) => r.map(v => `"${v}"`).join(','))].join('\n');
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `raw-evaluations-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Geëxporteerd: ${getSizeLabel(size)} raw evaluations`);
  };

  const sampleSizes: SampleSize[] = [10, 25, 50, 100, 'all'];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-h-[80vh] overflow-y-auto">
        <DropdownMenuLabel>Complete Export</DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        {/* Full JSON Export */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileJson className="h-4 w-4 mr-2" />
            Alle Data (JSON)
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportAllJSON(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">CSV Tabellen</DropdownMenuLabel>
        
        {/* Shadow Trades */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Shadow Trades
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportShadowTradesCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Post-Signal Paths */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Price Paths
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportPostSignalPathsCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Shadow Hedges */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Shadow Hedges
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportShadowHedgesCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Account State */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Account State
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportAccountStateCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Causality Traces */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Causality Traces
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportCausalityTracesCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Execution Assumptions */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Execution Assumptions
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportExecutionAssumptionsCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">Overig</DropdownMenuLabel>
        
        {/* Signal Logs */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Signal Logs
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportSignalsCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Equity Curve */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Equity Curve
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportEquityCurveCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Raw Evaluations */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Raw Evaluations
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportRawEvaluationsCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
