import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

async function fetchAllRecords(
  tableName: string,
  orderColumn: string = 'created_at',
  limit: number = 50000
): Promise<Record<string, unknown>[]> {
  const pageSize = 1000;
  let allData: Record<string, unknown>[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && allData.length < limit) {
    // Use raw query to avoid type issues with dynamic table names
    const { data, error } = await supabase
      .from(tableName as any)
      .select('*')
      .order(orderColumn, { ascending: false })
      .range(offset, offset + pageSize - 1);

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

  const exportOrderbookSnapshots = async () => {
    setIsExporting(true);
    try {
      toast.info('Fetching orderbook snapshots...');
      const data = await fetchAllRecords('v35_orderbook_snapshots', 'ts');
      
      const date = new Date().toISOString().split('T')[0];
      downloadCsv(data, `v35-orderbook-snapshots-${date}.csv`);
      
      toast.success(`Exported ${data.length} orderbook snapshots`);
    } catch (error: any) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportSettlements = async () => {
    setIsExporting(true);
    try {
      toast.info('Fetching settlements...');
      const data = await fetchAllRecords('v35_settlements', 'created_at');
      
      const date = new Date().toISOString().split('T')[0];
      downloadCsv(data, `v35-settlements-${date}.csv`);
      
      toast.success(`Exported ${data.length} settlements`);
    } catch (error: any) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportFills = async () => {
    setIsExporting(true);
    try {
      toast.info('Fetching fills...');
      const data = await fetchAllRecords('fill_logs', 'created_at');
      
      const date = new Date().toISOString().split('T')[0];
      downloadCsv(data, `v35-fills-${date}.csv`);
      
      toast.success(`Exported ${data.length} fills`);
    } catch (error: any) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportAllJson = async () => {
    setIsExporting(true);
    try {
      toast.info('Fetching all V35 data...');
      
      const [orderbooks, settlements, fills, positions, events] = await Promise.all([
        fetchAllRecords('v35_orderbook_snapshots', 'ts', 10000),
        fetchAllRecords('v35_settlements', 'created_at'),
        fetchAllRecords('fill_logs', 'created_at', 10000),
        fetchAllRecords('bot_positions', 'updated_at'),
        fetchAllRecords('bot_events', 'ts', 10000),
      ]);

      const exportData = {
        exported_at: new Date().toISOString(),
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

      const date = new Date().toISOString().split('T')[0];
      downloadJson(exportData, `v35-full-export-${date}.json`);
      
      toast.success(`Exported all V35 data (${orderbooks.length + settlements.length + fills.length} records)`);
    } catch (error: any) {
      console.error('Export failed:', error);
      toast.error(`Export failed: ${error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
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
        <DropdownMenuLabel>Export V35 Data</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={exportOrderbookSnapshots}>
          📊 Orderbook Snapshots (CSV)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportSettlements}>
          💰 Settlements (CSV)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportFills}>
          ⚡ Fills (CSV)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={exportAllJson}>
          📦 Full Export (JSON)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
