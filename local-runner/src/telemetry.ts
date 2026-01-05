/**
 * telemetry.ts
 * --------------------------------------------------------------------------
 * Per-market telemetry aggregation for regime time and dislocation counters.
 * 
 * Tracks:
 * - Time spent in each delta regime (LOW, MID, HIGH)
 * - Dislocation counts (combined ask < 0.95, < 0.97)
 * - Max/min delta during market lifetime
 * - Hedge lag tracking for pair completion
 */

import {
  logSnapshot,
  logFill,
  logSettlement,
  SnapshotLog,
  FillLog,
  SettlementLog,
  calculateDelta,
  calculateMid,
  calculateSpread,
  calculateSkew,
  calculatePairCost,
  calculateAvgCost,
  SNAPSHOT_INTERVAL_MS
} from './logger.js';
import { saveFillLogs, saveSettlementLogs, saveSnapshotLogs } from './backend.js';

const FLUSH_INTERVAL_MS = 2000; // Flush to DB every 2 seconds (was 5s)
const MAX_BATCH = 500; // Increased batch size for higher volume

const snapshotQueue: SnapshotLog[] = [];
const fillQueue: FillLog[] = [];
const settlementQueue: SettlementLog[] = [];
let flushTimerStarted = false;

function startFlushLoop() {
  if (flushTimerStarted) return;
  flushTimerStarted = true;

  setInterval(() => {
    void flushQueues();
  }, FLUSH_INTERVAL_MS).unref?.();
}

async function flushQueues() {
  // Snapshot logs
  if (snapshotQueue.length > 0) {
    const batch = snapshotQueue.splice(0, MAX_BATCH);
    await saveSnapshotLogs(batch);
  }

  // Fill logs
  if (fillQueue.length > 0) {
    const batch = fillQueue.splice(0, MAX_BATCH);
    await saveFillLogs(batch);
  }

  // Settlement logs (rare)
  if (settlementQueue.length > 0) {
    const batch = settlementQueue.splice(0, MAX_BATCH);
    await saveSettlementLogs(batch);
  }
}

export type DeltaRegime = 'LOW' | 'MID' | 'HIGH';
export type BotState = 'FLAT' | 'ONE_SIDED' | 'HEDGED' | 'SKEWED' | 'UNWIND' | 'DEEP_DISLOCATION';
export type TradeIntent = 'ENTRY' | 'ACCUMULATE' | 'HEDGE' | 'REBAL' | 'UNWIND';

// Delta regime thresholds (v4.2.1)
const DELTA_LOW_THRESHOLD = 0.0030;  // < 0.30%
const DELTA_MID_THRESHOLD = 0.0070;  // 0.30% - 0.70%

// Dislocation thresholds
const DISLOCATION_95 = 0.95;
const DISLOCATION_97 = 0.97;

// ---------- Per-Market Telemetry State ----------

export interface MarketTelemetry {
  marketId: string;
  asset: 'BTC' | 'ETH';
  
  // First and last fill timestamps
  firstFillTs: number | null;
  lastFillTs: number | null;
  
  // Regime time counters (in seconds)
  timeInLow: number;
  timeInMid: number;
  timeInHigh: number;
  
  // Delta tracking
  maxDelta: number | null;
  minDelta: number | null;
  lastDelta: number | null;
  lastDeltaRegime: DeltaRegime | null;
  
  // Dislocation counters
  countDislocation95: number;
  countDislocation97: number;
  last180sSnapshots: { ts: number; combined: number }[];  // Rolling buffer
  
  // Streak counters
  noLiquidityStreak: number;
  adverseStreak: number;
  
  // Hedge lag tracking
  pendingHedges: Map<string, { entrySide: 'UP' | 'DOWN'; entryTs: number }>;
  
  // Last snapshot timestamp
  lastSnapshotTs: number;
}

// Global telemetry store
const telemetryStore = new Map<string, MarketTelemetry>();

// ---------- Telemetry Management ----------

export function getOrCreateTelemetry(marketId: string, asset: 'BTC' | 'ETH'): MarketTelemetry {
  let telemetry = telemetryStore.get(marketId);
  if (!telemetry) {
    telemetry = {
      marketId,
      asset,
      firstFillTs: null,
      lastFillTs: null,
      timeInLow: 0,
      timeInMid: 0,
      timeInHigh: 0,
      maxDelta: null,
      minDelta: null,
      lastDelta: null,
      lastDeltaRegime: null,
      countDislocation95: 0,
      countDislocation97: 0,
      last180sSnapshots: [],
      noLiquidityStreak: 0,
      adverseStreak: 0,
      pendingHedges: new Map(),
      lastSnapshotTs: 0,
    };
    telemetryStore.set(marketId, telemetry);
  }
  return telemetry;
}

export function clearTelemetry(marketId: string): void {
  telemetryStore.delete(marketId);
}

// ---------- Delta Regime Helpers ----------

export function getDeltaRegime(delta: number | null): DeltaRegime {
  if (delta === null) return 'LOW';
  if (delta < DELTA_LOW_THRESHOLD) return 'LOW';
  if (delta < DELTA_MID_THRESHOLD) return 'MID';
  return 'HIGH';
}

// ---------- Bot State Determination ----------

export function determineBotState(
  upShares: number,
  downShares: number,
  secondsRemaining: number,
  combinedAsk: number | null,
  delta: number | null
): BotState {
  // Check for deep dislocation
  if (combinedAsk !== null && combinedAsk < DISLOCATION_95 && 
      delta !== null && delta < 0.004 && secondsRemaining > 180) {
    return 'DEEP_DISLOCATION';
  }
  
  // Check for unwind mode
  if (secondsRemaining <= 45) {
    return 'UNWIND';
  }
  
  // Check position state
  if (upShares === 0 && downShares === 0) {
    return 'FLAT';
  }
  
  const total = upShares + downShares;
  const skew = total > 0 ? Math.abs(upShares - downShares) / total : 0;
  
  if (upShares === 0 || downShares === 0) {
    return 'ONE_SIDED';
  }
  
  if (skew > 0.20) {
    return 'SKEWED';
  }
  
  return 'HEDGED';
}

// ---------- Snapshot Recording ----------

export interface SnapshotInput {
  marketId: string;
  asset: 'BTC' | 'ETH';
  secondsRemaining: number;
  spotPrice: number | null;
  strikePrice: number | null;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  // v6.0.0: Additional context for enrichment
  btcPrice?: number | null;
  ethPrice?: number | null;
  // v6.2.0: Orderbook readiness flag
  orderbookReady?: boolean;
}

export function recordSnapshot(input: SnapshotInput): void {
  const now = Date.now();
  const telemetry = getOrCreateTelemetry(input.marketId, input.asset);
  
  // Rate limit snapshots
  if (now - telemetry.lastSnapshotTs < SNAPSHOT_INTERVAL_MS) {
    return;
  }
  telemetry.lastSnapshotTs = now;
  
  // Calculate derived values
  const delta = calculateDelta(input.spotPrice, input.strikePrice);
  const upMid = calculateMid(input.upBid, input.upAsk);
  const downMid = calculateMid(input.downBid, input.downAsk);
  const spreadUp = calculateSpread(input.upBid, input.upAsk);
  const spreadDown = calculateSpread(input.downBid, input.downAsk);
  const combinedAsk = (input.upAsk !== null && input.downAsk !== null) 
    ? input.upAsk + input.downAsk 
    : null;
  const combinedMid = (upMid !== null && downMid !== null) ? upMid + downMid : null;
  
  // Calculate cheapestAskPlusOtherMid
  let cheapestAskPlusOtherMid: number | null = null;
  if (input.upAsk !== null && input.downAsk !== null && upMid !== null && downMid !== null) {
    if (input.upAsk <= input.downAsk) {
      cheapestAskPlusOtherMid = input.upAsk + downMid;
    } else {
      cheapestAskPlusOtherMid = input.downAsk + upMid;
    }
  }
  
  const skew = calculateSkew(input.upShares, input.downShares);
  const pairCost = calculatePairCost(input.upShares, input.downShares, input.upCost, input.downCost);
  const avgUpCost = calculateAvgCost(input.upShares, input.upCost);
  const avgDownCost = calculateAvgCost(input.downShares, input.downCost);
  
  const botState = determineBotState(
    input.upShares, 
    input.downShares, 
    input.secondsRemaining, 
    combinedAsk, 
    delta
  );
  
  // Update telemetry regime time
  const regime = getDeltaRegime(delta);
  if (telemetry.lastDeltaRegime !== null) {
    const elapsedSec = SNAPSHOT_INTERVAL_MS / 1000;
    switch (telemetry.lastDeltaRegime) {
      case 'LOW': telemetry.timeInLow += elapsedSec; break;
      case 'MID': telemetry.timeInMid += elapsedSec; break;
      case 'HIGH': telemetry.timeInHigh += elapsedSec; break;
    }
  }
  telemetry.lastDeltaRegime = regime;
  
  // Update delta tracking
  if (delta !== null) {
    telemetry.lastDelta = delta;
    if (telemetry.maxDelta === null || delta > telemetry.maxDelta) {
      telemetry.maxDelta = delta;
    }
    if (telemetry.minDelta === null || delta < telemetry.minDelta) {
      telemetry.minDelta = delta;
    }
  }
  
  // Update dislocation counters
  if (combinedAsk !== null) {
    if (combinedAsk < DISLOCATION_95) {
      telemetry.countDislocation95++;
    }
    if (combinedAsk < DISLOCATION_97) {
      telemetry.countDislocation97++;
    }
    
    // Track last 180s dislocations
    telemetry.last180sSnapshots.push({ ts: now, combined: combinedAsk });
    const cutoff = now - 180000;
    telemetry.last180sSnapshots = telemetry.last180sSnapshots.filter(s => s.ts >= cutoff);
  }
  
  // v6.2.0: Determine orderbook readiness
  const orderbookReady = input.orderbookReady ?? (
    input.upBid !== null && input.upAsk !== null &&
    input.downBid !== null && input.downAsk !== null
  );

  // Build and log snapshot with v6.0.0 extended fields
  const snapshotLog: SnapshotLog = {
    ts: now,
    iso: new Date(now).toISOString(),
    marketId: input.marketId,
    asset: input.asset,
    secondsRemaining: input.secondsRemaining,
    spotPrice: input.spotPrice,
    strikePrice: input.strikePrice,
    delta,
    btcPrice: input.btcPrice ?? null,
    ethPrice: input.ethPrice ?? null,
    upBid: input.upBid,
    upAsk: input.upAsk,
    upMid,
    downBid: input.downBid,
    downAsk: input.downAsk,
    downMid,
    spreadUp,
    spreadDown,
    combinedAsk,
    combinedMid,
    cheapestAskPlusOtherMid,
    upBestAsk: input.upAsk,    // Alias for enrichment clarity
    downBestAsk: input.downAsk, // Alias for enrichment clarity
    orderbookReady,            // v6.2.0
    botState,
    upShares: input.upShares,
    downShares: input.downShares,
    avgUpCost,
    avgDownCost,
    pairCost,
    skew,
    noLiquidityStreak: telemetry.noLiquidityStreak,
    adverseStreak: telemetry.adverseStreak,
  };

  logSnapshot(snapshotLog);

  // Also send to backend (buffered)
  startFlushLoop();
  snapshotQueue.push(snapshotLog);
  if (snapshotQueue.length >= MAX_BATCH) {
    void flushQueues().catch(() => {
      // Ignore - logging is non-critical
    });
  }
}

// ---------- Fill Recording ----------

// v6.0.0: Extended FillInput with orderbook context
export interface FillInput {
  marketId: string;
  asset: 'BTC' | 'ETH';
  side: 'UP' | 'DOWN';
  orderId: string | null;
  fillQty: number;
  fillPrice: number;
  intent: TradeIntent;
  secondsRemaining: number;
  spotPrice: number | null;
  strikePrice: number | null;
  // v6.0.0: Additional context for enrichment
  btcPrice?: number | null;
  ethPrice?: number | null;
  upBestAsk?: number | null;
  downBestAsk?: number | null;
  upBestBid?: number | null;
  downBestBid?: number | null;
}

export function recordFill(input: FillInput): void {
  const now = Date.now();
  const telemetry = getOrCreateTelemetry(input.marketId, input.asset);
  
  // Track first/last fill
  if (telemetry.firstFillTs === null) {
    telemetry.firstFillTs = now;
  }
  telemetry.lastFillTs = now;
  
  // Calculate hedge lag
  let hedgeLagMs: number | null = null;
  
  if (input.intent === 'ENTRY') {
    // Store pending hedge for this entry
    telemetry.pendingHedges.set(input.orderId || `entry_${now}`, {
      entrySide: input.side,
      entryTs: now,
    });
  } else if (input.intent === 'HEDGE') {
    // Find matching entry and calculate lag
    const oppositeSide = input.side === 'UP' ? 'DOWN' : 'UP';
    for (const [key, entry] of telemetry.pendingHedges.entries()) {
      if (entry.entrySide === oppositeSide) {
        hedgeLagMs = now - entry.entryTs;
        telemetry.pendingHedges.delete(key);
        break;
      }
    }
  }
  
  const delta = calculateDelta(input.spotPrice, input.strikePrice);
  
  // Build fill log with v6.0.0 extended fields
  const fillLog: FillLog = {
    ts: now,
    iso: new Date(now).toISOString(),
    marketId: input.marketId,
    asset: input.asset,
    side: input.side,
    orderId: input.orderId,
    clientOrderId: null,
    fillQty: input.fillQty,
    fillPrice: input.fillPrice,
    fillNotional: input.fillQty * input.fillPrice,
    intent: input.intent,
    secondsRemaining: input.secondsRemaining,
    spotPrice: input.spotPrice,
    strikePrice: input.strikePrice,
    delta,
    btcPrice: input.btcPrice ?? null,
    ethPrice: input.ethPrice ?? null,
    upBestAsk: input.upBestAsk ?? null,
    downBestAsk: input.downBestAsk ?? null,
    upBestBid: input.upBestBid ?? null,
    downBestBid: input.downBestBid ?? null,
    hedgeLagMs,
  };

  logFill(fillLog);

  // Also send to backend (buffered)
  startFlushLoop();
  fillQueue.push(fillLog);
  if (fillQueue.length >= MAX_BATCH) {
    void flushQueues().catch(() => {
      // Ignore - logging is non-critical
    });
  }
}

// ---------- Settlement Recording ----------

export interface SettlementInput {
  marketId: string;
  asset: 'BTC' | 'ETH';
  finalUpShares: number;
  finalDownShares: number;
  upCost: number;
  downCost: number;
  realizedPnL: number | null;
  winningSide: 'UP' | 'DOWN' | null;
  fees?: number;              // v6.4.0: Fees paid in USD
  totalPayoutUsd?: number;    // v6.4.0: Total payout (winning shares * 1.00)
}

export function recordSettlement(input: SettlementInput): void {
  const now = Date.now();
  const telemetry = getOrCreateTelemetry(input.marketId, input.asset);
  
  const avgUpCost = calculateAvgCost(input.finalUpShares, input.upCost);
  const avgDownCost = calculateAvgCost(input.finalDownShares, input.downCost);
  const pairCost = calculatePairCost(
    input.finalUpShares, 
    input.finalDownShares, 
    input.upCost, 
    input.downCost
  );
  
  // Count dislocations in last 180s
  const last180sDislocation95 = telemetry.last180sSnapshots.filter(
    s => s.combined < DISLOCATION_95
  ).length;
  
  // v6.2.0: Calculate theoretical PnL = 1.0 - pair_cost
  const theoreticalPnL = pairCost !== null ? 1.0 - pairCost : null;

  // v6.4.0: Calculate total_payout_usd = winning side shares * 1.00
  const totalPayoutUsd = input.totalPayoutUsd ?? (
    input.winningSide === 'UP' ? input.finalUpShares * 1.0 :
    input.winningSide === 'DOWN' ? input.finalDownShares * 1.0 : null
  );

  const settlementLog: SettlementLog = {
    ts: now,
    iso: new Date(now).toISOString(),
    marketId: input.marketId,
    asset: input.asset,
    openTs: telemetry.firstFillTs,
    closeTs: now,
    finalUpShares: input.finalUpShares,
    finalDownShares: input.finalDownShares,
    avgUpCost,
    avgDownCost,
    pairCost,
    realizedPnL: input.realizedPnL,
    winningSide: input.winningSide,
    maxDelta: telemetry.maxDelta,
    minDelta: telemetry.minDelta,
    timeInLow: telemetry.timeInLow,
    timeInMid: telemetry.timeInMid,
    timeInHigh: telemetry.timeInHigh,
    countDislocation95: telemetry.countDislocation95,
    countDislocation97: telemetry.countDislocation97,
    last180sDislocation95,
    theoreticalPnL,
    fees: input.fees ?? null,           // v6.4.0
    totalPayoutUsd,                     // v6.4.0
  };
  
  logSettlement(settlementLog);

  // Also send to backend (buffered)
  startFlushLoop();
  settlementQueue.push(settlementLog);
  void flushQueues().catch(() => {
    // Ignore - logging is non-critical
  });

  // Clear telemetry for this market
  clearTelemetry(input.marketId);
}

// ---------- Streak Management ----------

export function incrementNoLiquidityStreak(marketId: string, asset: 'BTC' | 'ETH'): void {
  const telemetry = getOrCreateTelemetry(marketId, asset);
  telemetry.noLiquidityStreak++;
}

export function resetNoLiquidityStreak(marketId: string, asset: 'BTC' | 'ETH'): void {
  const telemetry = getOrCreateTelemetry(marketId, asset);
  telemetry.noLiquidityStreak = 0;
}

export function incrementAdverseStreak(marketId: string, asset: 'BTC' | 'ETH'): void {
  const telemetry = getOrCreateTelemetry(marketId, asset);
  telemetry.adverseStreak++;
}

export function resetAdverseStreak(marketId: string, asset: 'BTC' | 'ETH'): void {
  const telemetry = getOrCreateTelemetry(marketId, asset);
  telemetry.adverseStreak = 0;
}

// ---------- Export telemetry store for debugging ----------

export function getTelemetryStore(): Map<string, MarketTelemetry> {
  return telemetryStore;
}
