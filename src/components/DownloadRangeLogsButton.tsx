import { useState } from 'react';
import { Download, Loader2, Calendar, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import JSZip from 'jszip';

// Table names as type for type safety
type TableName = 'bot_events' | 'snapshot_logs' | 'fill_logs' | 'inventory_snapshots' | 
                  'orders' | 'order_queue' | 'settlement_logs' | 'hedge_intents' | 
                  'price_ticks' | 'funding_snapshots';

// Helper to fetch ALL records with pagination (Supabase default limit is 1000)
async function fetchAllRecords(
  tableName: TableName,
  fromISO: string,
  toISO: string,
  orderColumn: string = 'created_at'
): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let allRecords: any[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .order(orderColumn as any, { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error(`Error fetching ${tableName}:`, error);
      break;
    }

    if (data && data.length > 0) {
      allRecords = allRecords.concat(data);
      offset += PAGE_SIZE;
      hasMore = data.length === PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }

  return allRecords;
}

export function DownloadRangeLogsButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [progress, setProgress] = useState('');
  
  // Default to today 13:30 - now (LOCAL TIME)
  const now = new Date();
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD format
  const [fromDate, setFromDate] = useState(today);
  const [fromTime, setFromTime] = useState('13:30');
  const [toDate, setToDate] = useState(today);
  const [toTime, setToTime] = useState(
    now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  );

  const downloadRangeLogs = async () => {
    setIsDownloading(true);
    
    try {
      // Build date range - input is LOCAL TIME, convert to UTC for database query
      const fromLocal = new Date(`${fromDate}T${fromTime}:00`);
      const toLocal = new Date(`${toDate}T${toTime}:00`);
      const fromISO = fromLocal.toISOString();
      const toISO = toLocal.toISOString();
      
      toast.info(`Fetching all logs from ${fromTime} to ${toTime}...`);

      // Fetch all tables with full pagination
      setProgress('Fetching bot_events...');
      const botEvents = await fetchAllRecords('bot_events', fromISO, toISO, 'ts');
      
      setProgress('Fetching snapshot_logs...');
      const snapshotLogs = await fetchAllRecords('snapshot_logs', fromISO, toISO, 'ts');
      
      setProgress('Fetching fill_logs...');
      const fillLogs = await fetchAllRecords('fill_logs', fromISO, toISO, 'ts');
      
      setProgress('Fetching inventory_snapshots...');
      const inventorySnapshots = await fetchAllRecords('inventory_snapshots', fromISO, toISO, 'ts');
      
      setProgress('Fetching orders...');
      const orders = await fetchAllRecords('orders', fromISO, toISO, 'created_ts');
      
      setProgress('Fetching order_queue...');
      const orderQueue = await fetchAllRecords('order_queue', fromISO, toISO, 'created_at');
      
      setProgress('Fetching settlement_logs...');
      const settlementLogs = await fetchAllRecords('settlement_logs', fromISO, toISO, 'ts');
      
      setProgress('Fetching hedge_intents...');
      const hedgeIntents = await fetchAllRecords('hedge_intents', fromISO, toISO, 'ts');
      
      setProgress('Fetching price_ticks...');
      const priceTicks = await fetchAllRecords('price_ticks', fromISO, toISO, 'created_at');
      
      setProgress('Fetching funding_snapshots...');
      const fundingSnapshots = await fetchAllRecords('funding_snapshots', fromISO, toISO, 'ts');
      
      setProgress('Building export...');

      // Build comprehensive JSON export
      const exportData = {
        exportInfo: {
          from: fromISO,
          to: toISO,
          exportedAt: new Date().toISOString(),
          version: 'v6.6.1',
          note: 'Complete strategy analysis export with all records (no pagination limits)',
        },
        summary: {
          botEvents: botEvents.length,
          snapshots: snapshotLogs.length,
          fills: fillLogs.length,
          inventorySnapshots: inventorySnapshots.length,
          orders: orders.length,
          orderQueue: orderQueue.length,
          settlements: settlementLogs.length,
          hedgeIntents: hedgeIntents.length,
          priceTicks: priceTicks.length,
          fundingSnapshots: fundingSnapshots.length,
          totalRecords: botEvents.length + snapshotLogs.length + fillLogs.length + 
                        inventorySnapshots.length + orders.length + orderQueue.length + 
                        settlementLogs.length + hedgeIntents.length + priceTicks.length +
                        fundingSnapshots.length,
        },
        // v6.6.0 Guardrail Analysis
        guardrailAnalysis: analyzeGuardrails(botEvents, snapshotLogs),
        // PnL Analysis
        pnlAnalysis: analyzePnL(fillLogs, settlementLogs, snapshotLogs),
        // Raw data (all records, no limits)
        botEvents,
        snapshotLogs,
        fillLogs,
        inventorySnapshots,
        orders,
        orderQueue,
        settlementLogs,
        hedgeIntents,
        priceTicks,
        fundingSnapshots,
      };

      // Create ZIP file with compression
      setProgress('Compressing...');
      const zip = new JSZip();
      
      // Add main analysis file
      zip.file('analysis.json', JSON.stringify({
        exportInfo: exportData.exportInfo,
        summary: exportData.summary,
        guardrailAnalysis: exportData.guardrailAnalysis,
        pnlAnalysis: exportData.pnlAnalysis,
      }, null, 2));
      
      // Add raw data files separately (easier to process)
      zip.file('bot_events.json', JSON.stringify(botEvents));
      zip.file('snapshot_logs.json', JSON.stringify(snapshotLogs));
      zip.file('fill_logs.json', JSON.stringify(fillLogs));
      zip.file('inventory_snapshots.json', JSON.stringify(inventorySnapshots));
      zip.file('orders.json', JSON.stringify(orders));
      zip.file('order_queue.json', JSON.stringify(orderQueue));
      zip.file('settlement_logs.json', JSON.stringify(settlementLogs));
      zip.file('hedge_intents.json', JSON.stringify(hedgeIntents));
      zip.file('price_ticks.json', JSON.stringify(priceTicks));
      zip.file('funding_snapshots.json', JSON.stringify(fundingSnapshots));

      // Create filename with date range
      const filename = `strategy_analysis_${fromDate}_${fromTime.replace(':', '')}_to_${toTime.replace(':', '')}.zip`;
      
      // Generate compressed ZIP
      const blob = await zip.generateAsync({ 
        type: 'blob', 
        compression: 'DEFLATE', 
        compressionOptions: { level: 9 } 
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${exportData.summary.totalRecords} records`);
      setIsOpen(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export logs');
    } finally {
      setIsDownloading(false);
      setProgress('');
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
        >
          <Calendar className="w-4 h-4" />
          Export Range
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Export Strategy Logs</h4>
            <p className="text-xs text-muted-foreground">
              Complete export: bot events, snapshots, fills, orders, prices, and analysis.
            </p>
          </div>
          
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">From (local time)</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="flex-1 h-8 text-xs"
                />
                <div className="relative">
                  <Clock className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                  <Input
                    type="time"
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                    className="w-24 h-8 text-xs pl-7"
                  />
                </div>
              </div>
            </div>
            
            <div className="space-y-1.5">
              <Label className="text-xs">To (local time)</Label>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="flex-1 h-8 text-xs"
                />
                <div className="relative">
                  <Clock className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                  <Input
                    type="time"
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                    className="w-24 h-8 text-xs pl-7"
                  />
                </div>
              </div>
            </div>
          </div>

          <Button
            onClick={downloadRangeLogs}
            disabled={isDownloading}
            className="w-full"
            size="sm"
          >
            {isDownloading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {progress || 'Exporting...'}
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                Export ZIP
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// v6.6.0 Guardrail Analysis Helper
function analyzeGuardrails(botEvents: any[], snapshots: any[]) {
  const skippedEvents = botEvents.filter(e => e.event_type === 'ACTION_SKIPPED');
  const emergencyEvents = botEvents.filter(e => 
    e.event_type === 'EMERGENCY_UNWIND' || 
    e.reason_code === 'EMERGENCY_UNWIND' ||
    e.reason_code === 'EMERGENCY_COOLDOWN'
  );
  const safetyBlockEvents = botEvents.filter(e => 
    e.reason_code === 'SAFETY_BLOCK'
  );
  const cppEvents = botEvents.filter(e => 
    e.reason_code === 'CPP_EMERGENCY' || 
    e.reason_code === 'CPP_UNDEFINED_ONE_SIDED'
  );

  // Count reason codes
  const reasonCounts: Record<string, number> = {};
  skippedEvents.forEach(e => {
    const reason = e.reason_code || 'UNKNOWN';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  });

  // All event types
  const eventTypeCounts: Record<string, number> = {};
  botEvents.forEach(e => {
    const type = e.event_type || 'UNKNOWN';
    eventTypeCounts[type] = (eventTypeCounts[type] || 0) + 1;
  });

  // Unique bot states from snapshots
  const botStates: Record<string, number> = {};
  snapshots.forEach(s => {
    const state = s.bot_state || 'UNKNOWN';
    botStates[state] = (botStates[state] || 0) + 1;
  });

  // CPP stats from snapshots (pair_cost / paired_shares)
  const cppValues = snapshots
    .filter(s => s.up_shares > 0 && s.down_shares > 0)
    .map(s => {
      const paired = Math.min(Number(s.up_shares), Number(s.down_shares));
      const cpp = paired > 0 ? (Number(s.pair_cost) || 0) / paired : null;
      return cpp;
    })
    .filter((v): v is number => v !== null && isFinite(v));

  return {
    totalEvents: botEvents.length,
    totalSnapshots: snapshots.length,
    totalSkippedActions: skippedEvents.length,
    emergencyUnwindEvents: emergencyEvents.length,
    safetyBlockEvents: safetyBlockEvents.length,
    cppAlertEvents: cppEvents.length,
    eventTypeBreakdown: eventTypeCounts,
    reasonCodeBreakdown: reasonCounts,
    botStateDistribution: botStates,
    cppStats: cppValues.length > 0 ? {
      count: cppValues.length,
      min: Math.min(...cppValues).toFixed(4),
      max: Math.max(...cppValues).toFixed(4),
      avg: (cppValues.reduce((a, b) => a + b, 0) / cppValues.length).toFixed(4),
      median: cppValues.sort((a, b) => a - b)[Math.floor(cppValues.length / 2)]?.toFixed(4),
    } : null,
  };
}

// PnL Analysis Helper
function analyzePnL(fills: any[], settlements: any[], snapshots: any[]) {
  // Total notional traded
  const totalNotional = fills.reduce((sum, f) => sum + (Number(f.fill_notional) || 0), 0);
  
  // Fills by intent
  const fillsByIntent: Record<string, { count: number; notional: number }> = {};
  fills.forEach(f => {
    const intent = f.intent || 'UNKNOWN';
    if (!fillsByIntent[intent]) {
      fillsByIntent[intent] = { count: 0, notional: 0 };
    }
    fillsByIntent[intent].count++;
    fillsByIntent[intent].notional += Number(f.fill_notional) || 0;
  });

  // Fills by asset
  const fillsByAsset: Record<string, { count: number; notional: number }> = {};
  fills.forEach(f => {
    const asset = f.asset || 'UNKNOWN';
    if (!fillsByAsset[asset]) {
      fillsByAsset[asset] = { count: 0, notional: 0 };
    }
    fillsByAsset[asset].count++;
    fillsByAsset[asset].notional += Number(f.fill_notional) || 0;
  });

  // Unique markets
  const uniqueMarkets = new Set(fills.map(f => f.market_id)).size;

  // Settlement summary
  const totalRealizedPnL = settlements.reduce((sum, s) => sum + (Number(s.realized_pnl) || 0), 0);
  const totalTheoreticalPnL = settlements.reduce((sum, s) => sum + (Number(s.theoretical_pnl) || 0), 0);
  const settlementCount = settlements.length;
  
  // Failure analysis
  const failures = settlements.filter(s => s.failure_flag);
  const failuresByFlag: Record<string, number> = {};
  failures.forEach(s => {
    const flag = s.failure_flag || 'UNKNOWN';
    failuresByFlag[flag] = (failuresByFlag[flag] || 0) + 1;
  });

  // Hedge lag analysis from fills
  const hedgeLags = fills
    .filter(f => f.hedge_lag_ms !== null && f.hedge_lag_ms !== undefined)
    .map(f => Number(f.hedge_lag_ms));
  
  return {
    totalFills: fills.length,
    totalNotionalUsd: totalNotional.toFixed(2),
    uniqueMarkets,
    fillsByIntent,
    fillsByAsset,
    settlements: {
      count: settlementCount,
      totalRealizedPnL: totalRealizedPnL.toFixed(2),
      totalTheoreticalPnL: totalTheoreticalPnL.toFixed(2),
      failures: failures.length,
      failuresByFlag,
    },
    hedgeLagStats: hedgeLags.length > 0 ? {
      count: hedgeLags.length,
      minMs: Math.min(...hedgeLags),
      maxMs: Math.max(...hedgeLags),
      avgMs: Math.round(hedgeLags.reduce((a, b) => a + b, 0) / hedgeLags.length),
      medianMs: hedgeLags.sort((a, b) => a - b)[Math.floor(hedgeLags.length / 2)],
    } : null,
  };
}
