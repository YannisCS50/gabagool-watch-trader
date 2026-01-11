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
    return arr.slice(0, size);
  };

  const getSizeLabel = (size: SampleSize) => size === 'all' ? 'All' : `First ${size}`;

  const exportAllJSON = async (size: SampleSize = 'all') => {
    setExporting(true);
    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        sampleSize: size,
        config: {
          startingBudget: data.stats.startingEquity,
          accountingMode: 'FIFO',
          tickSize: 0.01,
        },
        engineStatus: data.engineStatus,
        stats: data.stats,
        rawEvaluations: sliceData(rawEvaluations, size),
        rawTrackings: sliceData(rawTrackings, size),
        signalLogs: sliceData(data.signalLogs, size),
        postSignalTracking: sliceData(data.postSignalTracking, size),
        hedgeSimulations: sliceData(data.hedgeSimulations, size),
        equityCurve: sliceData(data.equityCurve, size),
        pnlByCategory: data.pnlByCategory,
      };

      const json = JSON.stringify(exportData, null, 2);
      const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
      downloadFile(json, `shadow-export-${sizeLabel}-${Date.now()}.json`, 'application/json');
      toast.success(`Exported ${getSizeLabel(size)} as JSON`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const exportSignalsCSV = (size: SampleSize = 'all') => {
    const headers = [
      'id', 'timestamp', 'asset', 'side', 'delta', 'mispricing', 'threshold',
      'engine_state', 'passed_filters', 'failed_filters'
    ];
    
    const signals = sliceData(data.signalLogs, size);
    const rows = signals.map((s) => [
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
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `signals-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Exported ${getSizeLabel(size)} signals as CSV`);
  };

  const exportTrackingsCSV = (size: SampleSize = 'all') => {
    const headers = [
      'signal_id', 'at_5s_favorable', 'at_5s_adverse', 'at_10s_favorable', 'at_10s_adverse',
      'at_15s_favorable', 'at_15s_adverse', 'resolved', 'resolution_time_s'
    ];
    
    const trackings = sliceData(data.postSignalTracking, size);
    const rows = trackings.map((t) => [
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
    const sizeLabel = size === 'all' ? 'all' : `sample-${size}`;
    downloadFile(csv, `trackings-${sizeLabel}-${Date.now()}.csv`, 'text/csv');
    toast.success(`Exported ${getSizeLabel(size)} trackings as CSV`);
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
    toast.success(`Exported ${getSizeLabel(size)} equity curve as CSV`);
  };

  const exportRawEvaluationsCSV = (size: SampleSize = 'all') => {
    if (rawEvaluations.length === 0) {
      toast.error('No evaluations to export');
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
    toast.success(`Exported ${getSizeLabel(size)} raw evaluations as CSV`);
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
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Export Data</DropdownMenuLabel>
        <DropdownMenuSeparator />
        
        {/* JSON Export with size options */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileJson className="h-4 w-4 mr-2" />
            All Data (JSON)
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
        <DropdownMenuLabel className="text-xs text-muted-foreground">CSV Tables</DropdownMenuLabel>
        
        {/* Signal Logs with size options */}
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
        
        {/* Post-Signal Trackings with size options */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FileSpreadsheet className="h-4 w-4 mr-2" />
            Post-Signal Trackings
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {sampleSizes.map((size) => (
              <DropdownMenuItem key={size} onClick={() => exportTrackingsCSV(size)}>
                <ListFilter className="h-4 w-4 mr-2" />
                {getSizeLabel(size)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        
        {/* Equity Curve with size options */}
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
        
        {/* Raw Evaluations with size options */}
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
