import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Download, Loader2, Calendar } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Default cutoff: 2026-01-27 when logging started working correctly
const DEFAULT_CUTOFF_DATE = '2026-01-27';

async function fetchAllRecords(
  tableName: string,
  orderColumn: string = 'created_at',
  fromDate?: string
): Promise<Record<string, unknown>[]> {
  const MAX_ROWS = 10_000_000;
  const pageSize = 1000;
  let allData: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && allData.length < MAX_ROWS) {
    let query = supabase
      .from(tableName as any)
      .select('*')
      .order(orderColumn, { ascending: false });

    // Apply date filter if provided
    if (fromDate) {
      query = query.gte(orderColumn, `${fromDate}T00:00:00Z`);
    }

    const { data, error } = await query.range(offset, offset + pageSize - 1);

    if (error) throw error;

    if (data && Array.isArray(data) && data.length > 0) {
      allData = [...allData, ...(data as unknown as Record<string, unknown>[])];
      offset += pageSize;
      hasMore = data.length === pageSize;
    } else {
      hasMore = false;
    }
  }

  return allData;
}

function downloadCsv(data: Record<string, unknown>[], filename: string): void {
  if (data.length === 0) {
    toast.warning('No data to export');
    return;
  }

  const headers = Object.keys(data[0]);
  const rows = data.map(row =>
    headers.map(h => {
      const val = row[h];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val).replace(/"/g, '""');
      return String(val).replace(/"/g, '""');
    }).join(',')
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadJson(data: unknown, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function V35ExportButton() {
  const [isExporting, setIsExporting] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [fromDate, setFromDate] = useState(DEFAULT_CUTOFF_DATE);
  const [exportType, setExportType] = useState<'orderbooks' | 'settlements' | 'fills' | 'all' | null>(null);

  const handleExportClick = (type: 'orderbooks' | 'settlements' | 'fills' | 'all') => {
    setExportType(type);
    setShowDatePicker(true);
  };

  const executeExport = async () => {
    setShowDatePicker(false);
    setIsExporting(true);
    
    try {
      const dateStr = format(new Date(), 'yyyy-MM-dd');
      
      switch (exportType) {
        case 'orderbooks': {
          toast.info(`Fetching orderbook snapshots from ${fromDate}...`);
          const data = await fetchAllRecords('v35_orderbook_snapshots', 'created_at', fromDate);
          downloadCsv(data, `v35-orderbook-snapshots-${dateStr}.csv`);
          toast.success(`Exported ${data.length} orderbook snapshots`);
          break;
        }
        case 'settlements': {
          toast.info(`Fetching settlements from ${fromDate}...`);
          const data = await fetchAllRecords('v35_settlements', 'created_at', fromDate);
          downloadCsv(data, `v35-settlements-${dateStr}.csv`);
          toast.success(`Exported ${data.length} settlements`);
          break;
        }
        case 'fills': {
          toast.info(`Fetching fills from ${fromDate}...`);
          const data = await fetchAllRecords('v35_fills', 'created_at', fromDate);
          downloadCsv(data, `v35-fills-${dateStr}.csv`);
          toast.success(`Exported ${data.length} fills`);
          break;
        }
        case 'all': {
          toast.info(`Fetching all V35 data from ${fromDate}...`);
          
          const [orderbooks, settlements, fills, positions, events] = await Promise.all([
            fetchAllRecords('v35_orderbook_snapshots', 'created_at', fromDate),
            fetchAllRecords('v35_settlements', 'created_at', fromDate),
            fetchAllRecords('v35_fills', 'created_at', fromDate),
            fetchAllRecords('bot_positions', 'synced_at', fromDate),
            fetchAllRecords('bot_events', 'created_at', fromDate),
          ]);

          const exportData = {
            exported_at: new Date().toISOString(),
            from_date: fromDate,
            summary: {
              orderbook_snapshots: orderbooks.length,
              settlements: settlements.length,
              fills: fills.length,
              positions: positions.length,
              events: events.length,
            },
            data: {
              orderbook_snapshots: orderbooks,
              settlements,
              fills,
              positions,
              events,
            },
          };

          downloadJson(exportData, `v35-full-export-${dateStr}.json`);
          toast.success(`Exported all V35 data (${orderbooks.length + settlements.length + fills.length} records)`);
          break;
        }
      }
    } catch (error: any) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
      setExportType(null);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={isExporting}>
            {isExporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            Export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Export V35 Data (from {fromDate})
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => handleExportClick('orderbooks')}>
            📊 Orderbook Snapshots (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExportClick('settlements')}>
            💰 Settlements (CSV)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleExportClick('fills')}>
            ⚡ Fills (CSV)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => handleExportClick('all')}>
            📦 Full Export (JSON)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showDatePicker} onOpenChange={setShowDatePicker}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Export vanaf datum</DialogTitle>
            <DialogDescription>
              Selecteer de startdatum voor de export. Data vóór deze datum wordt niet meegenomen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="from-date">Vanaf datum</Label>
              <Input
                id="from-date"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Standaard: {DEFAULT_CUTOFF_DATE} (wanneer logging correct begon)
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDatePicker(false)}>
              Annuleren
            </Button>
            <Button onClick={executeExport}>
              <Download className="h-4 w-4 mr-2" />
              Exporteren
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
