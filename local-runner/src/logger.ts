/**
 * logger.ts
 * --------------------------------------------------------------------------
 * JSONL file logging with daily rotation for Polymarket 15m bot observability.
 * 
 * Features:
 * - Daily file rotation (one file per day per log type)
 * - Append-only JSONL format
 * - Low overhead async writes
 * - Configurable snapshot cadence
 */

import fs from 'fs';
import path from 'path';

// Configuration
export const SNAPSHOT_INTERVAL_MS = 1000; // 1 second - capture every tick
const LOGS_DIR = path.join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ---------- Log File Management ----------

function getDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// v8.0.0: Extended log types for Gabagool observability directive
export type LogType = 
  | 'snapshot' 
  | 'fill' 
  | 'settlement' 
  | 'settlement_failure'
  | 'decision'      // DECISION_SNAPSHOT
  | 'reconciliation' // STATE_RECONCILIATION_RESULT
  | 'hedge_skip'    // HEDGE_SKIP_EXPLAINED
  | 'mtm';          // MARK_TO_MARKET_SNAPSHOT

function getLogFilePath(logType: LogType): string {
  const dateStr = getDateString();
  return path.join(LOGS_DIR, `${logType}_${dateStr}.jsonl`);
}

export function appendJsonl(logType: LogType, data: object): void {
  const filePath = getLogFilePath(logType);
  const line = JSON.stringify(data) + '\n';
  
  fs.appendFile(filePath, line, (err) => {
    if (err) {
      console.error(`❌ Logger error (${logType}):`, err.message);
    }
  });
}

// ---------- Snapshot Log Schema ----------
// v6.0.0: Extended with additional price context for enrichment
// v6.5.0: Extended with inventory risk metrics
// v8.1.0: Extended asset types to include SOL and XRP

export type SnapshotAssetType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface SnapshotLog {
  ts: number;                    // epoch ms
  iso: string;                   // ISO timestamp
  marketId: string;
  asset: SnapshotAssetType;
  secondsRemaining: number;
  
  // Price context (v6.0.0 - ensure these are ALWAYS populated)
  spotPrice: number | null;      // Current spot price from Chainlink
  strikePrice: number | null;    // Strike price for this market
  delta: number | null;          // abs(spot - strike) / strike
  
  // External prices (for enrichment)
  btcPrice: number | null;       // v6.0.0: BTC Chainlink price
  ethPrice: number | null;       // v6.0.0: ETH Chainlink price
  
  // Order book
  upBid: number | null;
  upAsk: number | null;
  upMid: number | null;
  downBid: number | null;
  downAsk: number | null;
  downMid: number | null;
  spreadUp: number | null;       // upAsk - upBid
  spreadDown: number | null;     // downAsk - downBid
  combinedAsk: number | null;    // upAsk + downAsk
  combinedMid: number | null;    // upMid + downMid
  cheapestAskPlusOtherMid: number | null;
  
  // Best asks for enrichment (v6.0.0)
  upBestAsk: number | null;      // Alias for upAsk (for enrichment clarity)
  downBestAsk: number | null;    // Alias for downAsk (for enrichment clarity)
  
  // v6.2.0: Orderbook readiness
  orderbookReady: boolean;       // true = bids & asks present + depth initialized
  
  // Bot state
  botState: string;              // FLAT | ONE_SIDED | HEDGED | etc
  upShares: number;
  downShares: number;
  avgUpCost: number | null;
  avgDownCost: number | null;
  pairCost: number | null;
  skew: number | null;           // upShares / (upShares + downShares)
  noLiquidityStreak: number;
  adverseStreak: number;
  
  // v6.5.0: Inventory Risk Metrics
  unpairedShares?: number;          // abs(upShares - downShares)
  unpairedNotionalUsd?: number;     // unpaired × avg cost
  unpairedAgeSec?: number;          // time since unpaired became non-zero
  inventoryRiskScore?: number;      // notional × age (higher = more risk)
  degradedMode?: boolean;           // true if in degraded mode
  queueStress?: boolean;            // true if queue stressed
}

export function logSnapshot(data: SnapshotLog): void {
  appendJsonl('snapshot', data);
}

// ---------- Fill Log Schema ----------

// v6.0.0: Extended FillLog with additional context for enrichment
// v8.1.0: Extended asset types to include SOL and XRP for V26 strategy
export type AssetType = 'BTC' | 'ETH' | 'SOL' | 'XRP';

export interface FillLog {
  ts: number;
  iso: string;
  marketId: string;
  asset: AssetType;
  side: 'UP' | 'DOWN';
  orderId: string | null;
  clientOrderId: string | null;
  fillQty: number;
  fillPrice: number;
  fillNotional: number;
  intent: 'ENTRY' | 'ACCUMULATE' | 'HEDGE' | 'REBAL' | 'UNWIND';
  secondsRemaining: number;
  
  // Price context (v6.0.0 - MUST be populated for enrichment)
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;
  
  // External prices (v6.0.0)
  btcPrice: number | null;
  ethPrice: number | null;
  
  // Order book context at fill time (v6.0.0)
  upBestAsk: number | null;
  downBestAsk: number | null;
  upBestBid: number | null;
  downBestBid: number | null;
  
  hedgeLagMs: number | null;     // Time from opening fill to hedge fill
}

export function logFill(data: FillLog): void {
  appendJsonl('fill', data);
}

// ---------- Settlement Summary Log Schema ----------
// v6.5.0: Extended with market aggregation data
// v8.1.0: Extended asset types to include SOL and XRP

export interface SettlementLog {
  ts: number;
  iso: string;
  marketId: string;
  asset: AssetType;
  openTs: number | null;         // First fill timestamp
  closeTs: number;               // Settlement timestamp
  finalUpShares: number;
  finalDownShares: number;
  avgUpCost: number | null;
  avgDownCost: number | null;
  pairCost: number | null;
  realizedPnL: number | null;
  winningSide: 'UP' | 'DOWN' | null;
  maxDelta: number | null;
  minDelta: number | null;
  timeInLow: number;             // Seconds in LOW delta regime
  timeInMid: number;             // Seconds in MID delta regime
  timeInHigh: number;            // Seconds in HIGH delta regime
  countDislocation95: number;    // Count of snapshots with combined < 0.95
  countDislocation97: number;    // Count of snapshots with combined < 0.97
  last180sDislocation95: number; // Dislocation count in final 180s
  // v6.2.0: Theoretical PnL for comparing edge vs execution
  theoreticalPnL: number | null; // 1.0 - pair_cost
  // v6.4.0: Complete settlement metrics
  fees: number | null;           // Fees paid in USD
  totalPayoutUsd: number | null; // Total payout received (winningSide shares * 1.00)
  // v6.5.0: Market aggregations for risk analysis
  pairedDelaySec?: number | null;           // Time from first fill to paired
  unpairedNotionalMax?: number;             // Max unpaired notional during market
  unpairedAgeMaxSec?: number;               // Max age of unpaired exposure
  inventoryRiskScoreMax?: number;           // Max inventory risk score
  degradedModeSecondsTotal?: number;        // Total seconds in degraded mode
  queueStressSecondsTotal?: number;         // Total seconds in queue stress
  actionSkippedCountsByReason?: Record<string, number>; // Skip counts by reason
}

export function logSettlement(data: SettlementLog): void {
  appendJsonl('settlement', data);
  
  // v4.3: Focus on pairCost as THE key metric
  const pairCostStr = data.pairCost !== null ? data.pairCost.toFixed(4) : 'N/A';
  const pairCostOk = data.pairCost !== null && data.pairCost < 1.00;
  const pairCostIcon = pairCostOk ? '✅' : '❌';
  const skew = data.finalUpShares > 0 && data.finalDownShares > 0 
    ? `${data.finalUpShares.toFixed(0)}/${data.finalDownShares.toFixed(0)}` 
    : `${data.finalUpShares.toFixed(0)}/${data.finalDownShares.toFixed(0)} (asymmetric)`;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 SETTLEMENT: ${data.marketId.slice(0, 20)}...`);
  console.log(`   ${pairCostIcon} PAIR_COST: ${pairCostStr} ${pairCostOk ? '(PROFIT LOCKED)' : '(LOSS)'}`);
  console.log(`   📈 Shares: ${skew}`);
  console.log(`   💰 PnL: ${data.realizedPnL?.toFixed(2) ?? 'unknown'} | Winner: ${data.winningSide ?? 'unknown'}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ---------- v4.4: Settlement Failure Log Schema ----------

export interface SettlementFailureLog {
  ts: number;
  iso: string;
  marketId: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  lostSide: 'UP' | 'DOWN';
  lostCost: number;               // This is the 100% loss
  secondsRemaining: number;
  reason: string;
  panicHedgeAttempted: boolean;
}

/**
 * v4.4: Log settlement failure - THE CRITICAL METRIC
 * Optimize for settlement_failures = 0, not PnL
 */
export function logSettlementFailure(data: SettlementFailureLog): void {
  appendJsonl('settlement_failure', data);
  
  // LOUD console output - this should NEVER happen
  console.log(`\n${'🚨'.repeat(30)}`);
  console.log(`🚨🚨🚨 SETTLEMENT FAILURE - 100% LOSS DETECTED 🚨🚨🚨`);
  console.log(`${'🚨'.repeat(30)}`);
  console.log(`   Market: ${data.marketId}`);
  console.log(`   Lost Side: ${data.lostSide} (${data.lostCost.toFixed(2)} USD LOST)`);
  console.log(`   Shares: UP=${data.upShares} / DOWN=${data.downShares}`);
  console.log(`   Reason: ${data.reason}`);
  console.log(`   Seconds Left: ${data.secondsRemaining}`);
  console.log(`${'🚨'.repeat(30)}\n`);
}

// ---------- Helper Functions ----------

export function calculateDelta(spotPrice: number | null, strikePrice: number | null): number | null {
  if (spotPrice === null || strikePrice === null || strikePrice <= 0) return null;
  return Math.abs(spotPrice - strikePrice) / strikePrice;
}

export function calculateMid(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  return (bid + ask) / 2;
}

export function calculateSpread(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  return ask - bid;
}

export function calculateSkew(upShares: number, downShares: number): number | null {
  const total = upShares + downShares;
  if (total === 0) return null;
  return upShares / total;
}

export function calculatePairCost(upShares: number, downShares: number, upCost: number, downCost: number): number | null {
  if (upShares === 0 || downShares === 0) return null;
  const avgUp = upCost / upShares;
  const avgDown = downCost / downShares;
  return avgUp + avgDown;
}

export function calculateAvgCost(shares: number, cost: number): number | null {
  if (shares === 0) return null;
  return cost / shares;
}
