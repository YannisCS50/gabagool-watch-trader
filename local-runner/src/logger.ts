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
export const SNAPSHOT_INTERVAL_MS = 2000; // 2 seconds
const LOGS_DIR = path.join(process.cwd(), 'logs');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ---------- Log File Management ----------

function getDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getLogFilePath(logType: 'snapshot' | 'fill' | 'settlement'): string {
  const dateStr = getDateString();
  return path.join(LOGS_DIR, `${logType}_${dateStr}.jsonl`);
}

export function appendJsonl(logType: 'snapshot' | 'fill' | 'settlement', data: object): void {
  const filePath = getLogFilePath(logType);
  const line = JSON.stringify(data) + '\n';
  
  fs.appendFile(filePath, line, (err) => {
    if (err) {
      console.error(`❌ Logger error (${logType}):`, err.message);
    }
  });
}

// ---------- Snapshot Log Schema ----------

export interface SnapshotLog {
  ts: number;                    // epoch ms
  iso: string;                   // ISO timestamp
  marketId: string;
  asset: 'BTC' | 'ETH';
  secondsRemaining: number;
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;          // abs(spot - strike) / strike
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
  botState: string;              // FLAT | ONE_SIDED | HEDGED | etc
  upShares: number;
  downShares: number;
  avgUpCost: number | null;
  avgDownCost: number | null;
  pairCost: number | null;
  skew: number | null;           // upShares / (upShares + downShares)
  noLiquidityStreak: number;
  adverseStreak: number;
}

export function logSnapshot(data: SnapshotLog): void {
  appendJsonl('snapshot', data);
}

// ---------- Fill Log Schema ----------

export interface FillLog {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  side: 'UP' | 'DOWN';
  orderId: string | null;
  clientOrderId: string | null;
  fillQty: number;
  fillPrice: number;
  fillNotional: number;
  intent: 'ENTRY' | 'ACCUMULATE' | 'HEDGE' | 'REBAL' | 'UNWIND';
  secondsRemaining: number;
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;
  hedgeLagMs: number | null;     // Time from opening fill to hedge fill
}

export function logFill(data: FillLog): void {
  appendJsonl('fill', data);
}

// ---------- Settlement Summary Log Schema ----------

export interface SettlementLog {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
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
}

export function logSettlement(data: SettlementLog): void {
  appendJsonl('settlement', data);
  console.log(`📊 Settlement logged: ${data.marketId} - PnL: ${data.realizedPnL?.toFixed(2) ?? 'unknown'}`);
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
