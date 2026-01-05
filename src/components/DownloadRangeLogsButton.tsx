import { useState } from 'react';
import { Download, Loader2, Calendar, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function DownloadRangeLogsButton() {
  const [isDownloading, setIsDownloading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  
  // Default to today 13:30 - now
  const today = new Date().toISOString().split('T')[0];
  const [fromDate, setFromDate] = useState(today);
  const [fromTime, setFromTime] = useState('13:30');
  const [toDate, setToDate] = useState(today);
  const [toTime, setToTime] = useState(new Date().toTimeString().slice(0, 5));

  const downloadRangeLogs = async () => {
    setIsDownloading(true);
    
    try {
      // Build date range
      const fromISO = new Date(`${fromDate}T${fromTime}:00Z`).toISOString();
      const toISO = new Date(`${toDate}T${toTime}:00Z`).toISOString();
      
      toast.info(`Fetching logs from ${fromTime} to ${toTime}...`);

      // Fetch all relevant tables with date range
      const [
        botEventsRes,
        snapshotLogsRes,
        fillLogsRes,
        inventorySnapshotsRes,
        ordersRes,
        orderQueueRes,
        settlementLogsRes,
        hedgeIntentsRes,
      ] = await Promise.all([
        supabase.from('bot_events')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
        
        supabase.from('snapshot_logs')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
        
        supabase.from('fill_logs')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
        
        supabase.from('inventory_snapshots')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
        
        supabase.from('orders')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('created_ts', { ascending: true }),
        
        supabase.from('order_queue')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('created_at', { ascending: true }),
        
        supabase.from('settlement_logs')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
        
        supabase.from('hedge_intents')
          .select('*')
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
          .order('ts', { ascending: true }),
      ]);

      // Build comprehensive JSON export
      const exportData = {
        exportInfo: {
          from: fromISO,
          to: toISO,
          exportedAt: new Date().toISOString(),
          version: 'v6.6.1',
        },
        summary: {
          botEvents: botEventsRes.data?.length || 0,
          snapshots: snapshotLogsRes.data?.length || 0,
          fills: fillLogsRes.data?.length || 0,
          inventorySnapshots: inventorySnapshotsRes.data?.length || 0,
          orders: ordersRes.data?.length || 0,
          orderQueue: orderQueueRes.data?.length || 0,
          settlements: settlementLogsRes.data?.length || 0,
          hedgeIntents: hedgeIntentsRes.data?.length || 0,
        },
        // v6.6.0 Guardrail Analysis
        guardrailAnalysis: analyzeGuardrails(botEventsRes.data || [], snapshotLogsRes.data || []),
        // Raw data
        botEvents: botEventsRes.data || [],
        snapshotLogs: snapshotLogsRes.data || [],
        fillLogs: fillLogsRes.data || [],
        inventorySnapshots: inventorySnapshotsRes.data || [],
        orders: ordersRes.data || [],
        orderQueue: orderQueueRes.data || [],
        settlementLogs: settlementLogsRes.data || [],
        hedgeIntents: hedgeIntentsRes.data || [],
      };

      // Create filename with date range
      const filename = `strategy_analysis_${fromDate}_${fromTime.replace(':', '')}_to_${toTime.replace(':', '')}.json`;
      
      // Download as JSON
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${Object.values(exportData.summary).reduce((a, b) => a + b, 0)} records`);
      setIsOpen(false);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export logs');
    } finally {
      setIsDownloading(false);
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
              Includes bot events, snapshots, fills, and guardrail analysis.
            </p>
          </div>
          
          <div className="grid gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">From</Label>
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
              <Label className="text-xs">To</Label>
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
                Exporting...
              </>
            ) : (
              <>
                <Download className="w-4 h-4 mr-2" />
                Export JSON
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
      const paired = Math.min(s.up_shares, s.down_shares);
      const cpp = paired > 0 ? (s.pair_cost || 0) / paired : null;
      return cpp;
    })
    .filter((v): v is number => v !== null && isFinite(v));

  return {
    totalSkippedActions: skippedEvents.length,
    emergencyUnwindEvents: emergencyEvents.length,
    safetyBlockEvents: safetyBlockEvents.length,
    cppAlertEvents: cppEvents.length,
    reasonCodeBreakdown: reasonCounts,
    botStateDistribution: botStates,
    cppStats: cppValues.length > 0 ? {
      count: cppValues.length,
      min: Math.min(...cppValues).toFixed(4),
      max: Math.max(...cppValues).toFixed(4),
      avg: (cppValues.reduce((a, b) => a + b, 0) / cppValues.length).toFixed(4),
    } : null,
  };
}
