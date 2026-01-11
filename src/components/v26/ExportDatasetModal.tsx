import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Download, FileArchive, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format, subDays } from 'date-fns';

interface ExportState {
  status: 'idle' | 'exporting' | 'success' | 'error';
  progress: number;
  message: string;
  rowCounts?: Record<string, number>;
  checksPassed?: boolean;
}

export function ExportDatasetModal() {
  const defaultWallet = import.meta.env.VITE_POLY_WALLET_ADDRESS || '';
  
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState(defaultWallet);
  const [fromDate, setFromDate] = useState(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
  const [toDate, setToDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [exportState, setExportState] = useState<ExportState>({
    status: 'idle',
    progress: 0,
    message: '',
  });

  const handleExport = async () => {
    if (!wallet.trim()) {
      toast.error('Wallet address is required');
      return;
    }

    setExportState({ status: 'exporting', progress: 10, message: 'Connecting to backend...' });

    try {
      setExportState({ status: 'exporting', progress: 30, message: 'Fetching data from tables...' });

      const { data, error } = await supabase.functions.invoke('v26-export-dataset', {
        body: {
          wallet: wallet.trim(),
          from_date: `${fromDate}T00:00:00Z`,
          to_date: `${toDate}T23:59:59Z`,
        },
      });

      if (error) {
        throw new Error(error.message || 'Export failed');
      }

      setExportState({ status: 'exporting', progress: 80, message: 'Generating ZIP file...' });

      // Handle the response - it should be a blob
      let blob: Blob;
      if (data instanceof Blob) {
        blob = data;
      } else if (data instanceof ArrayBuffer) {
        blob = new Blob([data], { type: 'application/zip' });
      } else if (typeof data === 'object' && data.error) {
        throw new Error(data.error);
      } else {
        // Try to convert whatever we got
        blob = new Blob([data], { type: 'application/zip' });
      }

      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `polymarket_export_${wallet.slice(0, 8).toLowerCase()}_${fromDate}_${toDate}_${Date.now()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportState({
        status: 'success',
        progress: 100,
        message: 'Export complete! File downloaded.',
        checksPassed: true,
      });

      toast.success('Dataset exported successfully');
    } catch (err) {
      console.error('Export error:', err);
      setExportState({
        status: 'error',
        progress: 0,
        message: err instanceof Error ? err.message : 'Export failed',
      });
      toast.error('Export failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const resetState = () => {
    setExportState({ status: 'idle', progress: 0, message: '' });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetState(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <FileArchive className="h-4 w-4" />
          Export Dataset
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="h-5 w-5" />
            Export Full Dataset
          </DialogTitle>
          <DialogDescription>
            Generate a comprehensive ZIP with all accounting data for external analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Wallet Input */}
          <div className="space-y-2">
            <Label htmlFor="wallet">Wallet Address</Label>
            <Input
              id="wallet"
              placeholder="0x..."
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              disabled={exportState.status === 'exporting'}
            />
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="from">From Date</Label>
              <Input
                id="from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                disabled={exportState.status === 'exporting'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="to">To Date</Label>
              <Input
                id="to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={exportState.status === 'exporting'}
              />
            </div>
          </div>

          {/* Export Contents Preview */}
          <div className="rounded-lg border p-3 bg-muted/30">
            <div className="text-sm font-medium mb-2">Export will include:</div>
            <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
              <div>• Raw subgraph events</div>
              <div>• Cashflow ledger</div>
              <div>• Market lifecycle</div>
              <div>• Market P&L</div>
              <div>• Daily P&L</div>
              <div>• Execution metrics</div>
              <div>• Hedge metrics</div>
              <div>• Position timeseries</div>
            </div>
          </div>

          {/* Progress / Status */}
          {exportState.status !== 'idle' && (
            <div className="space-y-2">
              {exportState.status === 'exporting' && (
                <>
                  <Progress value={exportState.progress} className="h-2" />
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {exportState.message}
                  </div>
                </>
              )}

              {exportState.status === 'success' && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle className="h-4 w-4" />
                  {exportState.message}
                </div>
              )}

              {exportState.status === 'error' && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {exportState.message}
                </div>
              )}

              {exportState.rowCounts && (
                <div className="grid grid-cols-2 gap-1 text-xs">
                  {Object.entries(exportState.rowCounts).map(([file, count]) => (
                    <div key={file} className="flex justify-between">
                      <span className="text-muted-foreground">{file}:</span>
                      <Badge variant="secondary" className="text-xs">{count}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleExport}
            disabled={exportState.status === 'exporting' || !wallet.trim()}
            className="gap-2"
          >
            {exportState.status === 'exporting' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                Export ZIP
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
