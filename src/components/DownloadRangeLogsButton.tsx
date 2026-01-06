import { useState } from 'react';
import { Download, Loader2, Calendar, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import JSZip from 'jszip';

// Rev D.1 Logging Specification Document
const REV_D1_LOGGING_SPEC = `# Loveable Prompt: Logging Uitbreidingen voor Rev D.1

## Context

We implementeren Rev D.1 (CPP-First Inventory Strategy). Om te valideren of de nieuwe logica werkt, hebben we extra logging nodig. Zonder deze logging kunnen we niet zien:
- Hoeveel entries worden geskipped door de CPP check
- Wanneer de activity state verandert
- Waarom hedge/accumulate beslissingen worden genomen

---

## DEEL 1: Nieuwe Bot Events

### 1.1 V73_ENTRY_SKIP Event

Log wanneer een entry wordt geskipped door de pre-entry CPP check.

\`\`\`typescript
// Wanneer: In computeSignal() case 'FLAT', wanneer entry wordt geskipped
// Waar: strategy.ts of waar je entry beslissingen maakt

saveBotEvent({
  event_type: 'V73_ENTRY_SKIP',
  asset,
  market_id: marketId,
  ts: Date.now(),
  run_id: runId,
  reason_code: 'PROJECTED_CPP_TOO_HIGH',  // of 'COMBINED_TOO_HIGH'
  data: {
    projected_cpp_maker: projectedCppMaker,
    projected_cpp_taker: projectedCppTaker,
    threshold: 0.98,
    up_bid: upBid,
    up_ask: upAsk,
    down_bid: downBid,
    down_ask: downAsk,
    combined_ask: upAsk + downAsk,
    combined_maker: (upBid + tick) + (downBid + tick),
    seconds_remaining: remainingSeconds,
  }
}).catch(() => {});
\`\`\`

**Throttling:** Max 1x per 10 seconden per market om spam te voorkomen.

---

### 1.2 CPP_STATE_CHANGE Event

Log wanneer de activity state verandert (NORMAL → HEDGE_ONLY → HOLD_ONLY).

\`\`\`typescript
saveBotEvent({
  event_type: 'CPP_STATE_CHANGE',
  asset,
  market_id: marketId,
  ts: Date.now(),
  run_id: runId,
  reason_code: newState,  // 'NORMAL', 'HEDGE_ONLY', 'HOLD_ONLY'
  data: {
    old_state: oldState,
    new_state: newState,
    current_cpp: currentCpp,
    trigger_threshold: threshold,
    up_shares: inv.upShares,
    down_shares: inv.downShares,
    avg_up_cost: avgUpCost,
    avg_down_cost: avgDownCost,
    seconds_remaining: remainingSeconds,
  }
}).catch(() => {});
\`\`\`

**Belangrijk:** Log ALLEEN bij daadwerkelijke state CHANGE, niet elke tick.

---

### 1.3 V73_HEDGE_DECISION Event

Log elke hedge beslissing met volledige context.

\`\`\`typescript
saveBotEvent({
  event_type: 'V73_HEDGE_DECISION',
  asset,
  market_id: marketId,
  ts: Date.now(),
  run_id: runId,
  reason_code: decision,  // 'HEDGE_OK', 'HEDGE_WAIT', 'HEDGE_BLOCKED'
  data: {
    decision: decision,
    decision_reason: reason,
    projected_cpp_maker: projectedCppMaker,
    projected_cpp_taker: projectedCppTaker,
    target_max_cpp: 0.99,
    absolute_max_cpp: 1.03,
    dominant_side: dominantSide,
    dominant_shares: dominantShares,
    minority_side: minoritySide,
    minority_shares: minorityShares,
    hedge_bid: hedgeBid,
    hedge_ask: hedgeAsk,
    activity_state: activityState,
    seconds_remaining: remainingSeconds,
  }
}).catch(() => {});
\`\`\`

**Throttling:** Max 1x per 5 seconden per market.

---

### 1.4 V73_ACCUM_DECISION Event

Log accumulate beslissingen.

\`\`\`typescript
saveBotEvent({
  event_type: 'V73_ACCUM_DECISION',
  asset,
  market_id: marketId,
  ts: Date.now(),
  run_id: runId,
  reason_code: decision,  // 'ACCUM_OK', 'ACCUM_BLOCKED', 'ACCUM_NO_IMPROVE'
  data: {
    decision: decision,
    decision_reason: reason,
    current_cpp: currentCpp,
    projected_new_cpp: projectedNewCpp,
    target_side: minoritySide,
    add_shares: addShares,
    maker_price: makerPrice,
    activity_state: activityState,
    seconds_remaining: remainingSeconds,
  }
}).catch(() => {});
\`\`\`

**Throttling:** Max 1x per 10 seconden per market.

---

## DEEL 2: Database Schema Uitbreidingen

### 2.1 inventory_snapshots Tabel

\`\`\`sql
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS activity_state TEXT;
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS projected_cpp_maker DECIMAL(10,6);
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS projected_cpp_taker DECIMAL(10,6);
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS dominant_side TEXT;
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS minority_side TEXT;
\`\`\`

### 2.2 snapshot_logs Tabel

\`\`\`sql
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS projected_cpp_maker DECIMAL(10,6);
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS projected_cpp_taker DECIMAL(10,6);
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS activity_state TEXT;
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS entry_allowed BOOLEAN;
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS hedge_allowed BOOLEAN;
ALTER TABLE snapshot_logs ADD COLUMN IF NOT EXISTS accum_allowed BOOLEAN;
\`\`\`

### 2.3 fill_logs Tabel

\`\`\`sql
ALTER TABLE fill_logs ADD COLUMN IF NOT EXISTS projected_cpp_at_fill DECIMAL(10,6);
ALTER TABLE fill_logs ADD COLUMN IF NOT EXISTS actual_cpp_after_fill DECIMAL(10,6);
ALTER TABLE fill_logs ADD COLUMN IF NOT EXISTS cpp_drift DECIMAL(10,6);
ALTER TABLE fill_logs ADD COLUMN IF NOT EXISTS activity_state_at_fill TEXT;
\`\`\`

---

## DEEL 3: Analysis Query Voorbeelden

### 3.1 Entry Skip Analyse

\`\`\`sql
SELECT 
  reason_code,
  COUNT(*) as count,
  AVG((data->>'projected_cpp_maker')::decimal) as avg_projected_cpp
FROM bot_events
WHERE event_type = 'V73_ENTRY_SKIP'
  AND ts > NOW() - INTERVAL '24 hours'
GROUP BY reason_code;
\`\`\`

### 3.2 Activity State Distributies

\`\`\`sql
SELECT 
  activity_state,
  COUNT(*) as snapshot_count,
  COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as percentage
FROM snapshot_logs
WHERE ts > NOW() - INTERVAL '24 hours'
GROUP BY activity_state;
\`\`\`

### 3.3 CPP Drift Analyse

\`\`\`sql
SELECT 
  asset,
  AVG(cpp_drift) as avg_drift,
  STDDEV(cpp_drift) as stddev_drift,
  MIN(cpp_drift) as min_drift,
  MAX(cpp_drift) as max_drift
FROM fill_logs
WHERE cpp_drift IS NOT NULL
  AND ts > NOW() - INTERVAL '24 hours'
GROUP BY asset;
\`\`\`

### 3.4 Hedge Decision Breakdown

\`\`\`sql
SELECT 
  data->>'decision' as decision,
  data->>'decision_reason' as reason,
  COUNT(*) as count
FROM bot_events
WHERE event_type = 'V73_HEDGE_DECISION'
  AND ts > NOW() - INTERVAL '24 hours'
GROUP BY data->>'decision', data->>'decision_reason'
ORDER BY count DESC;
\`\`\`

---

## DEEL 4: Implementatie Checklist

### Stap 1: Database Migraties
- [ ] Run ALTER TABLE statements voor inventory_snapshots
- [ ] Run ALTER TABLE statements voor snapshot_logs
- [ ] Run ALTER TABLE statements voor fill_logs
- [ ] Verify kolommen bestaan

### Stap 2: TypeScript Types
- [ ] Update InventorySnapshot interface
- [ ] Update SnapshotLog interface
- [ ] Update FillLog interface

### Stap 3: Event Logging
- [ ] Implementeer V73_ENTRY_SKIP logging
- [ ] Implementeer CPP_STATE_CHANGE logging
- [ ] Implementeer V73_HEDGE_DECISION logging
- [ ] Implementeer V73_ACCUM_DECISION logging
- [ ] Add throttling voor alle events

### Stap 4: Snapshot Updates
- [ ] Update saveSnapshotLog met projected_cpp_maker
- [ ] Update saveSnapshotLog met activity_state
- [ ] Update saveSnapshotLog met entry/hedge/accum_allowed

### Stap 5: Fill Log Updates
- [ ] Log projected_cpp_at_fill bij fills
- [ ] Log actual_cpp_after_fill bij fills
- [ ] Bereken en log cpp_drift

### Stap 6: Validatie
- [ ] Run bot voor 1 uur
- [ ] Check of nieuwe events verschijnen
- [ ] Run analysis queries
- [ ] Verify data kwaliteit
`;

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
        // Rev D.1 specific analysis
        revD1Analysis: analyzeRevD1(botEvents, snapshotLogs, fillLogs, inventorySnapshots),
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
        revD1Analysis: exportData.revD1Analysis,
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
      
      // Add Rev D.1 logging specification document
      zip.file('docs/REV_D1_LOGGING_SPEC.md', REV_D1_LOGGING_SPEC);

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

// Rev D.1 Analysis Helper - Analyzes V73 specific events and CPP metrics
function analyzeRevD1(botEvents: any[], snapshots: any[], fills: any[], inventorySnapshots: any[]) {
  // V73 Entry Skip events
  const entrySkips = botEvents.filter(e => e.event_type === 'V73_ENTRY_SKIP');
  const entrySkipsByReason: Record<string, number> = {};
  entrySkips.forEach(e => {
    const reason = e.reason_code || 'UNKNOWN';
    entrySkipsByReason[reason] = (entrySkipsByReason[reason] || 0) + 1;
  });
  
  // CPP State Change events
  const stateChanges = botEvents.filter(e => e.event_type === 'CPP_STATE_CHANGE');
  const stateTransitions: Record<string, number> = {};
  stateChanges.forEach(e => {
    const data = e.data || {};
    const transition = `${data.old_state || 'UNKNOWN'} → ${data.new_state || 'UNKNOWN'}`;
    stateTransitions[transition] = (stateTransitions[transition] || 0) + 1;
  });
  
  // V73 Hedge Decision events
  const hedgeDecisions = botEvents.filter(e => e.event_type === 'V73_HEDGE_DECISION');
  const hedgeDecisionsByType: Record<string, number> = {};
  hedgeDecisions.forEach(e => {
    const decision = e.reason_code || 'UNKNOWN';
    hedgeDecisionsByType[decision] = (hedgeDecisionsByType[decision] || 0) + 1;
  });
  
  // V73 Accumulate Decision events  
  const accumDecisions = botEvents.filter(e => e.event_type === 'V73_ACCUM_DECISION');
  const accumDecisionsByType: Record<string, number> = {};
  accumDecisions.forEach(e => {
    const decision = e.reason_code || 'UNKNOWN';
    accumDecisionsByType[decision] = (accumDecisionsByType[decision] || 0) + 1;
  });
  
  // Activity state distribution from snapshots
  const activityStates: Record<string, number> = {};
  snapshots.forEach(s => {
    const state = s.activity_state || 'NOT_SET';
    activityStates[state] = (activityStates[state] || 0) + 1;
  });
  
  // Projected CPP stats from snapshots
  const projectedCppMakerValues = snapshots
    .filter(s => s.projected_cpp_maker !== null && s.projected_cpp_maker !== undefined)
    .map(s => Number(s.projected_cpp_maker))
    .filter(v => isFinite(v));
    
  const projectedCppTakerValues = snapshots
    .filter(s => s.projected_cpp_taker !== null && s.projected_cpp_taker !== undefined)
    .map(s => Number(s.projected_cpp_taker))
    .filter(v => isFinite(v));
  
  // CPP drift from fills
  const cppDriftValues = fills
    .filter(f => f.cpp_drift !== null && f.cpp_drift !== undefined)
    .map(f => Number(f.cpp_drift))
    .filter(v => isFinite(v));
  
  // Dominant/minority side distribution from inventory snapshots
  const dominantSideCounts: Record<string, number> = {};
  inventorySnapshots.forEach(s => {
    const side = s.dominant_side || 'NOT_SET';
    dominantSideCounts[side] = (dominantSideCounts[side] || 0) + 1;
  });
  
  // Entry/hedge/accum allowed stats from snapshots
  const allowedStats = {
    entryAllowed: snapshots.filter(s => s.entry_allowed === true).length,
    entryBlocked: snapshots.filter(s => s.entry_allowed === false).length,
    hedgeAllowed: snapshots.filter(s => s.hedge_allowed === true).length,
    hedgeBlocked: snapshots.filter(s => s.hedge_allowed === false).length,
    accumAllowed: snapshots.filter(s => s.accum_allowed === true).length,
    accumBlocked: snapshots.filter(s => s.accum_allowed === false).length,
  };

  return {
    entrySkips: {
      total: entrySkips.length,
      byReason: entrySkipsByReason,
    },
    stateChanges: {
      total: stateChanges.length,
      transitions: stateTransitions,
    },
    hedgeDecisions: {
      total: hedgeDecisions.length,
      byDecision: hedgeDecisionsByType,
    },
    accumDecisions: {
      total: accumDecisions.length,
      byDecision: accumDecisionsByType,
    },
    activityStateDistribution: activityStates,
    allowedStats,
    projectedCppMaker: projectedCppMakerValues.length > 0 ? {
      count: projectedCppMakerValues.length,
      min: Math.min(...projectedCppMakerValues).toFixed(4),
      max: Math.max(...projectedCppMakerValues).toFixed(4),
      avg: (projectedCppMakerValues.reduce((a, b) => a + b, 0) / projectedCppMakerValues.length).toFixed(4),
    } : null,
    projectedCppTaker: projectedCppTakerValues.length > 0 ? {
      count: projectedCppTakerValues.length,
      min: Math.min(...projectedCppTakerValues).toFixed(4),
      max: Math.max(...projectedCppTakerValues).toFixed(4),
      avg: (projectedCppTakerValues.reduce((a, b) => a + b, 0) / projectedCppTakerValues.length).toFixed(4),
    } : null,
    cppDrift: cppDriftValues.length > 0 ? {
      count: cppDriftValues.length,
      min: Math.min(...cppDriftValues).toFixed(4),
      max: Math.max(...cppDriftValues).toFixed(4),
      avg: (cppDriftValues.reduce((a, b) => a + b, 0) / cppDriftValues.length).toFixed(4),
    } : null,
    dominantSideDistribution: dominantSideCounts,
  };
}
