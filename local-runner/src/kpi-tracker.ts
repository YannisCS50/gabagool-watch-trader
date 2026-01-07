/**
 * kpi-tracker.ts - v8.0 EXECUTION-FIRST SPEC
 * ============================================
 * Tracks execution KPIs and triggers kill-switch when thresholds are breached.
 * 
 * BREAKEVEN ENGINEERING TARGETS (non-negotiable):
 * 1) Hedge success rate >= 88%
 * 2) Median hedge lag <= 30s, P90 <= 60s
 * 3) Hedge taker-rate <= 30%
 * 4) Entry taker-rate <= 40%
 * 5) Fee data completeness = 100%
 * 
 * If ANY target is not met, new entries must STOP.
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const KPI_CONFIG = {
  // Rolling window size for KPI calculation
  windowSize: 20,
  
  // Thresholds (breach any = halt entries)
  thresholds: {
    hedgeSuccessRate: 0.88,      // >= 88%
    medianHedgeLagMs: 30_000,    // <= 30s
    p90HedgeLagMs: 60_000,       // <= 60s
    hedgeTakerRate: 0.30,        // <= 30%
    entryTakerRate: 0.40,        // <= 40%
    feeCompleteness: 1.0,        // = 100%
    emergencyExitRate: 0.20,     // <= 20% (warning, not halt)
  },
  
  // Consecutive breach windows before halt
  breachWindowsBeforeHalt: 1, // Immediate halt on first breach
};

// ============================================================
// TYPES
// ============================================================

export interface FillRecord {
  ts: number;
  marketId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  intent: 'ENTRY' | 'HEDGE' | 'ACCUMULATE' | 'SURVIVAL' | 'EMERGENCY_EXIT';
  liquidity: 'maker' | 'taker';
  feeUsd: number | null;
  fillPrice: number;
  fillQty: number;
}

export interface HedgeRecord {
  entryFillTs: number;
  hedgeFillTs: number | null;
  hedgeLagMs: number | null;
  marketId: string;
  asset: string;
  hedgeAttempts: number;
  finalState: 'HEDGED' | 'EXITED' | 'EXPIRED_UNHEDGED';
  exitUsed: boolean;
}

export interface KPISnapshot {
  ts: number;
  
  // Fill metrics
  entryFillCount: number;
  hedgeFillCount: number;
  entryTakerRate: number;
  hedgeTakerRate: number;
  feeCompleteness: number;
  
  // Hedge metrics
  hedgeSuccessRate: number;
  medianHedgeLagMs: number | null;
  p90HedgeLagMs: number | null;
  emergencyExitRate: number;
  
  // Status
  allPassing: boolean;
  breaches: string[];
}

export type TradingMode = 'FULL' | 'HEDGE_ONLY' | 'HALTED';

// ============================================================
// STATE
// ============================================================

// Rolling windows
const fillRecords: FillRecord[] = [];
const hedgeRecords: HedgeRecord[] = [];

// Current mode
let currentMode: TradingMode = 'FULL';
let lastKPICheck: KPISnapshot | null = null;
let consecutiveBreachWindows = 0;

// ============================================================
// RECORD FUNCTIONS
// ============================================================

/**
 * Record a fill event for KPI tracking
 */
export function recordFill(record: FillRecord): void {
  fillRecords.push(record);
  
  // Keep only last N records per intent type
  const maxRecords = KPI_CONFIG.windowSize * 4; // Buffer for all intent types
  if (fillRecords.length > maxRecords) {
    fillRecords.splice(0, fillRecords.length - maxRecords);
  }
}

/**
 * Record a hedge tracking event
 */
export function recordHedgeOutcome(record: HedgeRecord): void {
  hedgeRecords.push(record);
  
  // Keep only last N records
  if (hedgeRecords.length > KPI_CONFIG.windowSize * 2) {
    hedgeRecords.splice(0, hedgeRecords.length - KPI_CONFIG.windowSize * 2);
  }
  
  // Trigger KPI check on every hedge outcome
  checkKPIs();
}

// ============================================================
// KPI CALCULATION
// ============================================================

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil(sortedArr.length * p) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

/**
 * Get fills by intent from rolling window
 */
function getRecentFillsByIntent(intent: FillRecord['intent']): FillRecord[] {
  const matching = fillRecords.filter(f => f.intent === intent);
  return matching.slice(-KPI_CONFIG.windowSize);
}

/**
 * Calculate taker rate for a set of fills
 */
function calculateTakerRate(fills: FillRecord[]): number {
  if (fills.length === 0) return 0;
  const takerCount = fills.filter(f => f.liquidity === 'taker').length;
  return takerCount / fills.length;
}

/**
 * Calculate fee completeness for a set of fills
 */
function calculateFeeCompleteness(fills: FillRecord[]): number {
  if (fills.length === 0) return 1; // No fills = no incomplete data
  const withFee = fills.filter(f => f.feeUsd !== null && f.feeUsd !== undefined).length;
  return withFee / fills.length;
}

/**
 * Compute current KPI snapshot
 */
export function computeKPIs(): KPISnapshot {
  const now = Date.now();
  
  // Get recent fills by intent
  const entryFills = getRecentFillsByIntent('ENTRY');
  const hedgeFills = getRecentFillsByIntent('HEDGE');
  const allFills = [...entryFills, ...hedgeFills, 
    ...getRecentFillsByIntent('ACCUMULATE'),
    ...getRecentFillsByIntent('SURVIVAL'),
    ...getRecentFillsByIntent('EMERGENCY_EXIT')
  ];
  
  // Taker rates
  const entryTakerRate = calculateTakerRate(entryFills);
  const hedgeTakerRate = calculateTakerRate(hedgeFills);
  
  // Fee completeness (across all fills)
  const feeCompleteness = calculateFeeCompleteness(allFills);
  
  // Hedge outcomes from rolling window
  const recentHedges = hedgeRecords.slice(-KPI_CONFIG.windowSize);
  
  // Hedge success rate
  const hedgedCount = recentHedges.filter(h => h.finalState === 'HEDGED').length;
  const hedgeSuccessRate = recentHedges.length > 0 
    ? hedgedCount / recentHedges.length 
    : 1; // No hedges = not failing
  
  // Emergency exit rate
  const exitCount = recentHedges.filter(h => h.exitUsed).length;
  const emergencyExitRate = recentHedges.length > 0 
    ? exitCount / recentHedges.length 
    : 0;
  
  // Hedge lag percentiles
  const hedgeLags = recentHedges
    .filter(h => h.hedgeLagMs !== null && h.hedgeLagMs !== undefined)
    .map(h => h.hedgeLagMs!)
    .sort((a, b) => a - b);
  
  const medianHedgeLagMs = percentile(hedgeLags, 0.5);
  const p90HedgeLagMs = percentile(hedgeLags, 0.9);
  
  // Check breaches
  const breaches: string[] = [];
  const thresholds = KPI_CONFIG.thresholds;
  
  if (recentHedges.length >= 5) { // Only check if we have enough data
    if (hedgeSuccessRate < thresholds.hedgeSuccessRate) {
      breaches.push(`HEDGE_SUCCESS: ${(hedgeSuccessRate * 100).toFixed(1)}% < ${thresholds.hedgeSuccessRate * 100}%`);
    }
  }
  
  if (hedgeLags.length >= 5) {
    if (medianHedgeLagMs !== null && medianHedgeLagMs > thresholds.medianHedgeLagMs) {
      breaches.push(`MEDIAN_HEDGE_LAG: ${medianHedgeLagMs}ms > ${thresholds.medianHedgeLagMs}ms`);
    }
    if (p90HedgeLagMs !== null && p90HedgeLagMs > thresholds.p90HedgeLagMs) {
      breaches.push(`P90_HEDGE_LAG: ${p90HedgeLagMs}ms > ${thresholds.p90HedgeLagMs}ms`);
    }
  }
  
  if (hedgeFills.length >= 5) {
    if (hedgeTakerRate > thresholds.hedgeTakerRate) {
      breaches.push(`HEDGE_TAKER_RATE: ${(hedgeTakerRate * 100).toFixed(1)}% > ${thresholds.hedgeTakerRate * 100}%`);
    }
  }
  
  if (entryFills.length >= 5) {
    if (entryTakerRate > thresholds.entryTakerRate) {
      breaches.push(`ENTRY_TAKER_RATE: ${(entryTakerRate * 100).toFixed(1)}% > ${thresholds.entryTakerRate * 100}%`);
    }
  }
  
  if (allFills.length > 0) {
    if (feeCompleteness < thresholds.feeCompleteness) {
      breaches.push(`FEE_COMPLETENESS: ${(feeCompleteness * 100).toFixed(1)}% < 100%`);
    }
  }
  
  return {
    ts: now,
    entryFillCount: entryFills.length,
    hedgeFillCount: hedgeFills.length,
    entryTakerRate,
    hedgeTakerRate,
    feeCompleteness,
    hedgeSuccessRate,
    medianHedgeLagMs,
    p90HedgeLagMs,
    emergencyExitRate,
    allPassing: breaches.length === 0,
    breaches,
  };
}

// ============================================================
// KPI CHECK & MODE CONTROL
// ============================================================

/**
 * Check KPIs and update trading mode
 */
export function checkKPIs(runId?: string): KPISnapshot {
  const snapshot = computeKPIs();
  lastKPICheck = snapshot;
  
  if (snapshot.allPassing) {
    consecutiveBreachWindows = 0;
    
    // Restore FULL mode if we were in HEDGE_ONLY
    if (currentMode === 'HEDGE_ONLY') {
      console.log(`✅ KPIs passing - restoring FULL trading mode`);
      currentMode = 'FULL';
      
      saveBotEvent({
        event_type: 'KPI_RESTORED',
        asset: 'ALL',
        ts: snapshot.ts,
        run_id: runId,
        data: snapshot,
      }).catch(() => {});
    }
  } else {
    consecutiveBreachWindows++;
    
    console.log(`⚠️ KPI BREACH (window ${consecutiveBreachWindows}):`);
    snapshot.breaches.forEach(b => console.log(`   - ${b}`));
    
    if (consecutiveBreachWindows >= KPI_CONFIG.breachWindowsBeforeHalt) {
      if (currentMode === 'FULL') {
        console.log(`🛑 KPI breach threshold reached - switching to HEDGE_ONLY mode`);
        currentMode = 'HEDGE_ONLY';
        
        saveBotEvent({
          event_type: 'KPI_BREACH',
          asset: 'ALL',
          ts: snapshot.ts,
          run_id: runId,
          data: {
            ...snapshot,
            action: 'HALT_ENTRIES',
            consecutiveBreaches: consecutiveBreachWindows,
          },
        }).catch(() => {});
      }
    }
  }
  
  return snapshot;
}

// ============================================================
// MODE QUERIES
// ============================================================

/**
 * Get current trading mode
 */
export function getTradingMode(): TradingMode {
  return currentMode;
}

/**
 * Check if entries are allowed
 */
export function areEntriesAllowed(): boolean {
  return currentMode === 'FULL';
}

/**
 * Check if hedges are allowed
 */
export function areHedgesAllowed(): boolean {
  return currentMode !== 'HALTED';
}

/**
 * Get last KPI snapshot
 */
export function getLastKPISnapshot(): KPISnapshot | null {
  return lastKPICheck;
}

/**
 * Force halt (manual intervention)
 */
export function forceHalt(reason: string, runId?: string): void {
  console.log(`🛑 FORCE HALT: ${reason}`);
  currentMode = 'HALTED';
  
  saveBotEvent({
    event_type: 'FORCE_HALT',
    asset: 'ALL',
    ts: Date.now(),
    run_id: runId,
    data: { reason },
  }).catch(() => {});
}

/**
 * Resume from halt (manual intervention)
 */
export function resumeFromHalt(runId?: string): void {
  console.log(`▶️ Resuming from HALT - switching to HEDGE_ONLY mode`);
  currentMode = 'HEDGE_ONLY';
  consecutiveBreachWindows = 0;
  
  saveBotEvent({
    event_type: 'RESUME_FROM_HALT',
    asset: 'ALL',
    ts: Date.now(),
    run_id: runId,
    data: { previousMode: 'HALTED', newMode: 'HEDGE_ONLY' },
  }).catch(() => {});
}

/**
 * Reset KPI state (for testing)
 */
export function resetKPIState(): void {
  fillRecords.length = 0;
  hedgeRecords.length = 0;
  currentMode = 'FULL';
  lastKPICheck = null;
  consecutiveBreachWindows = 0;
}

// ============================================================
// EXPORTS
// ============================================================

export const KPITracker = {
  // Recording
  recordFill,
  recordHedgeOutcome,
  
  // Computation
  computeKPIs,
  checkKPIs,
  
  // Mode queries
  getTradingMode,
  areEntriesAllowed,
  areHedgesAllowed,
  getLastKPISnapshot,
  
  // Control
  forceHalt,
  resumeFromHalt,
  resetKPIState,
  
  // Config
  CONFIG: KPI_CONFIG,
};

export default KPITracker;
