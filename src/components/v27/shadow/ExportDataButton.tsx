import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Download, FileJson, FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ShadowDashboardData } from '@/hooks/useShadowDashboard';

interface ExportDataButtonProps {
  data: ShadowDashboardData;
  rawEvaluations: any[];
  rawTrackings: any[];
}

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

  const exportAllJSON = async () => {
    setExporting(true);
    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        config: {
          startingBudget: data.stats.startingEquity,
          accountingMode: 'FIFO',
          tickSize: 0.01,
        },
        engineStatus: data.engineStatus,
        stats: data.stats,
        rawEvaluations,
        rawTrackings,
        signalLogs: data.signalLogs,
        postSignalTracking: data.postSignalTracking,
        hedgeSimulations: data.hedgeSimulations,
        equityCurve: data.equityCurve,
        pnlByCategory: data.pnlByCategory,
      };

      const json = JSON.stringify(exportData, null, 2);
      downloadFile(json, `shadow-export-${Date.now()}.json`, 'application/json');
      toast.success('Exported all data as JSON');
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const exportSignalsCSV = () => {
    const headers = [
      'id', 'timestamp', 'asset', 'side', 'delta', 'mispricing', 'threshold',
      'engine_state', 'passed_filters', 'failed_filters'
    ];
    
    const rows = data.signalLogs.map((s) => [
      s.id,
      s.iso,
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
    downloadFile(csv, `signals-${Date.now()}.csv`, 'text/csv');
    toast.success('Exported signals as CSV');
  };

  const exportTrackingsCSV = () => {
    const headers = [
      'signal_id', 'at_5s_favorable', 'at_5s_adverse', 'at_10s_favorable', 'at_10s_adverse',
      'at_15s_favorable', 'at_15s_adverse', 'resolved', 'resolution_time_s'
    ];
    
    const rows = data.postSignalTracking.map((t) => [
      t.signalId,
      t.at5s?.favorable.toFixed(4) || '',
      t.at5s?.adverse.toFixed(4) || '',
      t.at10s?.favorable.toFixed(4) || '',
      t.at10s?.adverse.toFixed(4) || '',
      t.at15s?.favorable.toFixed(4) || '',
      t.at15s?.adverse.toFixed(4) || '',
      t.mispricingResolved ? 'true' : 'false',
      t.resolutionTimeSeconds?.toString() || '',
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    downloadFile(csv, `trackings-${Date.now()}.csv`, 'text/csv');
    toast.success('Exported trackings as CSV');
  };

  const exportEquityCurveCSV = () => {
    const headers = ['timestamp', 'equity', 'realized_pnl', 'unrealized_pnl', 'fees', 'drawdown'];
    
    const rows = data.equityCurve.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.equity.toFixed(2),
      e.realizedPnl.toFixed(2),
      e.unrealizedPnl.toFixed(2),
      e.fees.toFixed(4),
      e.drawdown.toFixed(6),
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    downloadFile(csv, `equity-curve-${Date.now()}.csv`, 'text/csv');
    toast.success('Exported equity curve as CSV');
  };

  const exportRawEvaluationsCSV = () => {
    if (rawEvaluations.length === 0) {
      toast.error('No evaluations to export');
      return;
    }

    const headers = Object.keys(rawEvaluations[0]);
    const rows = rawEvaluations.map((e) => 
      headers.map((h) => {
        const val = e[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      })
    );

    const csv = [headers.join(','), ...rows.map((r) => r.map(v => `"${v}"`).join(','))].join('\n');
    downloadFile(csv, `raw-evaluations-${Date.now()}.csv`, 'text/csv');
    toast.success('Exported raw evaluations as CSV');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={exporting}>
          {exporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Export All
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Export Format</DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        <DropdownMenuItem onClick={exportAllJSON}>
          <FileJson className="h-4 w-4 mr-2" />
          All Data (JSON)
        </DropdownMenuItem>
        
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">CSV Tables</DropdownMenuLabel>
        
        <DropdownMenuItem onClick={exportSignalsCSV}>
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Signal Logs
        </DropdownMenuItem>
        
        <DropdownMenuItem onClick={exportTrackingsCSV}>
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Post-Signal Trackings
        </DropdownMenuItem>
        
        <DropdownMenuItem onClick={exportEquityCurveCSV}>
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Equity Curve
        </DropdownMenuItem>
        
        <DropdownMenuItem onClick={exportRawEvaluationsCSV}>
          <FileSpreadsheet className="h-4 w-4 mr-2" />
          Raw Evaluations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
