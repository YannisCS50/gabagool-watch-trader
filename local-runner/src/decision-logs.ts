/**
 * decision-logs.ts — v8.0.0 GABAGOOL OBSERVABILITY DIRECTIVE
 * ===========================================================
 * 
 * New log event types for complete decision transparency.
 * These events ensure the bot's decisions are FULLY explainable.
 * 
 * Events defined:
 * 1. DECISION_SNAPSHOT — emitted BEFORE every order placement
 * 2. ACCOUNT_POSITION_SNAPSHOT — canonical account truth vs local state
 * 3. STATE_RECONCILIATION_RESULT — after comparing local vs account
 * 4. FILL_ATTRIBUTION — maker vs taker + fee impact per fill
 * 5. HEDGE_SKIP_EXPLAINED — why the bot did NOT hedge while skewed
 * 6. MARK_TO_MARKET_SNAPSHOT — honest MTM/PnL with confidence
 * 
 * CORE PRINCIPLE:
 * If something goes wrong, logs must make it obvious WHY.
 */

import { appendJsonl } from './logger.js';
import { saveBotEvent } from './backend.js';

// ============================================================
// 1. DECISION_SNAPSHOT — BEFORE EVERY ORDER
// ============================================================

export type DecisionIntent = 'ENTRY' | 'HEDGE' | 'MICRO_ADD' | 'UNWIND' | 'CANCEL' | 'SKIP';
export type DecisionState = 'FLAT' | 'ONE_SIDED' | 'PAIRING' | 'SKEWED' | 'HEDGE_ONLY' | 'HOLD_ONLY';
export type DecisionSide = 'UP' | 'DOWN' | 'NONE';

export interface GuardEvaluation {
  guardName: string;
  threshold: number | string;
  value: number | string;
  passed: boolean;
}

export interface DecisionSnapshot {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  windowStart: string;           // ISO timestamp of market window start
  secondsRemaining: number;
  correlationId?: string;        // Links decision → order → fill
  runId?: string;

  // State
  state: DecisionState;
  intent: DecisionIntent;
  chosenSide: DecisionSide;
  reasonCode: string;            // Enum-style reason (e.g., 'CPP_FEASIBLE', 'PROJECTED_CPP_TOO_HIGH')

  // Economic context — CPP projections
  projectedCppMaker: number | null;
  projectedCppTaker: number | null;
  cppPairedOnly: number | null;  // Current paired CPP (if paired)

  // Inventory
  avgUp: number | null;          // Dollars, explicit
  avgDown: number | null;        // Dollars, explicit
  upShares: number;
  downShares: number;
  pairedShares: number;          // min(upShares, downShares)
  unpairedShares: number;        // abs(upShares - downShares)

  // Orderbook context
  bestBidUp: number | null;
  bestAskUp: number | null;
  bestBidDown: number | null;
  bestAskDown: number | null;
  depthSummaryUp: string | null;   // e.g., "50@0.48, 100@0.47"
  depthSummaryDown: string | null;
  bookReadyUp: boolean;
  bookReadyDown: boolean;

  // Price context
  spotPrice: number | null;
  strikePrice: number | null;
  delta: number | null;

  // Guards evaluated (show your work)
  guardsEvaluated: GuardEvaluation[];

  // Order details (if not SKIP)
  orderSide?: 'UP' | 'DOWN';
  orderQty?: number;
  orderPrice?: number;
  orderTag?: 'ENTRY' | 'HEDGE' | 'REBAL' | 'UNWIND';
}

export function logDecisionSnapshot(data: DecisionSnapshot): void {
  appendJsonl('snapshot', { ...data, logType: 'DECISION_SNAPSHOT' });
  
  // Also save to Supabase bot_events
  saveBotEvent({
    event_type: 'DECISION_SNAPSHOT',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    correlation_id: data.correlationId,
    reason_code: data.reasonCode,
    data: {
      state: data.state,
      intent: data.intent,
      chosenSide: data.chosenSide,
      projectedCppMaker: data.projectedCppMaker,
      projectedCppTaker: data.projectedCppTaker,
      cppPairedOnly: data.cppPairedOnly,
      upShares: data.upShares,
      downShares: data.downShares,
      pairedShares: data.pairedShares,
      unpairedShares: data.unpairedShares,
      bookReadyUp: data.bookReadyUp,
      bookReadyDown: data.bookReadyDown,
      guardsEvaluated: data.guardsEvaluated,
      orderSide: data.orderSide,
      orderQty: data.orderQty,
      orderPrice: data.orderPrice,
    },
  }).catch(() => {});
}

// ============================================================
// 2. ACCOUNT_POSITION_SNAPSHOT — CANONICAL TRUTH
// ============================================================

export interface AccountPositionSnapshot {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  runId?: string;

  // Account state (from Polymarket API)
  accountUpShares: number;
  accountDownShares: number;
  accountAvgUp: number | null;   // Reconstructed from API if available
  accountAvgDown: number | null;

  // Wallet info
  walletAddress: string;
  walletType: 'proxy' | 'safe' | 'eoa';

  // Source metadata
  sourceEndpoint: string;        // e.g., 'data-api.polymarket.com/positions'
  sourceVersion: string;         // API version or timestamp
  fetchDurationMs: number;
}

export function logAccountPositionSnapshot(data: AccountPositionSnapshot): void {
  appendJsonl('snapshot', { ...data, logType: 'ACCOUNT_POSITION_SNAPSHOT' });
  
  saveBotEvent({
    event_type: 'ACCOUNT_POSITION_SNAPSHOT',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    data: {
      accountUpShares: data.accountUpShares,
      accountDownShares: data.accountDownShares,
      accountAvgUp: data.accountAvgUp,
      accountAvgDown: data.accountAvgDown,
      walletAddress: data.walletAddress,
      walletType: data.walletType,
      sourceEndpoint: data.sourceEndpoint,
    },
  }).catch(() => {});
}

// ============================================================
// 3. STATE_RECONCILIATION_RESULT — LOCAL VS ACCOUNT
// ============================================================

export type ReconciliationResult = 'OK' | 'RESYNC' | 'FREEZE_MARKET';

export interface StateReconciliationResult {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  runId?: string;

  // Local state
  localUpShares: number;
  localDownShares: number;
  localUpCost: number;
  localDownCost: number;

  // Account state (from API)
  accountUpShares: number;
  accountDownShares: number;

  // Deltas
  deltaUpShares: number;         // account - local
  deltaDownShares: number;
  deltaInvested: number | null;  // If cost info available

  // Result
  reconciliationResult: ReconciliationResult;
  actionTaken: string;           // e.g., 'SYNCED_LOCAL_TO_ACCOUNT', 'FROZEN_MARKET', 'NO_ACTION'
  reason: string;
}

export function logStateReconciliation(data: StateReconciliationResult): void {
  appendJsonl('snapshot', { ...data, logType: 'STATE_RECONCILIATION_RESULT' });
  
  const severity = data.reconciliationResult === 'FREEZE_MARKET' ? 'ERROR' : 
                   data.reconciliationResult === 'RESYNC' ? 'WARN' : 'INFO';
  
  if (severity !== 'INFO') {
    console.log(`⚠️ [RECONCILIATION] ${data.reconciliationResult}: ${data.asset} ${data.marketId.slice(0, 8)}`);
    console.log(`   Local: UP=${data.localUpShares} DOWN=${data.localDownShares}`);
    console.log(`   Account: UP=${data.accountUpShares} DOWN=${data.accountDownShares}`);
    console.log(`   Delta: UP=${data.deltaUpShares} DOWN=${data.deltaDownShares}`);
    console.log(`   Action: ${data.actionTaken}`);
  }
  
  saveBotEvent({
    event_type: 'STATE_RECONCILIATION_RESULT',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    reason_code: data.reconciliationResult,
    data: {
      localUpShares: data.localUpShares,
      localDownShares: data.localDownShares,
      accountUpShares: data.accountUpShares,
      accountDownShares: data.accountDownShares,
      deltaUpShares: data.deltaUpShares,
      deltaDownShares: data.deltaDownShares,
      actionTaken: data.actionTaken,
    },
  }).catch(() => {});
}

// ============================================================
// 4. FILL_ATTRIBUTION — ECONOMIC TRUTH PER FILL
// ============================================================

export type LiquidityType = 'MAKER' | 'TAKER' | 'UNKNOWN';

export interface FillAttribution {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  runId?: string;
  correlationId?: string;

  // Order/fill identifiers
  orderId: string;
  clientOrderId: string | null;
  exchangeOrderId: string | null;

  // Fill details
  side: 'UP' | 'DOWN';
  price: number;
  size: number;
  intent: 'ENTRY' | 'HEDGE' | 'ACCUMULATE' | 'REBAL' | 'UNWIND';

  // Liquidity attribution (THE KEY INSIGHT)
  liquidity: LiquidityType;
  
  // Fee economics
  feePaid: number;               // Actual fee paid (positive = cost)
  rebateExpected: number;        // Expected rebate if maker (positive = income)
  fillCostGross: number;         // size × price
  fillCostNet: number;           // fillCostGross + feePaid - rebateExpected

  // Updated averages AFTER this fill
  updatedAvgUp: number | null;
  updatedAvgDown: number | null;
  updatedCppGross: number | null;    // avgUp + avgDown (without fees)
  updatedCppNetExpected: number | null; // Including fee impact
}

export function logFillAttribution(data: FillAttribution): void {
  appendJsonl('fill', { ...data, logType: 'FILL_ATTRIBUTION' });
  
  const makerIcon = data.liquidity === 'MAKER' ? '🏷️' : data.liquidity === 'TAKER' ? '💸' : '❓';
  console.log(`${makerIcon} [FILL] ${data.side} ${data.size} @ ${data.price.toFixed(4)} (${data.liquidity})`);
  console.log(`   Gross: $${data.fillCostGross.toFixed(4)} | Fee: $${data.feePaid.toFixed(4)} | Net: $${data.fillCostNet.toFixed(4)}`);
  if (data.updatedCppGross !== null) {
    console.log(`   CPP now: ${data.updatedCppGross.toFixed(4)} (gross) / ${data.updatedCppNetExpected?.toFixed(4) ?? 'N/A'} (net)`);
  }
  
  saveBotEvent({
    event_type: 'FILL_ATTRIBUTION',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    correlation_id: data.correlationId,
    data: {
      orderId: data.orderId,
      side: data.side,
      price: data.price,
      size: data.size,
      intent: data.intent,
      liquidity: data.liquidity,
      feePaid: data.feePaid,
      fillCostNet: data.fillCostNet,
      updatedCppGross: data.updatedCppGross,
      updatedCppNetExpected: data.updatedCppNetExpected,
    },
  }).catch(() => {});
}

// ============================================================
// 5. HEDGE_SKIP_EXPLAINED — WHY NOT HEDGED
// ============================================================

export type HedgeSkipReasonCode = 
  | 'BOOK_NOT_READY'
  | 'PROJECTED_CPP_TOO_HIGH'
  | 'NO_LIQUIDITY'
  | 'HOLD_ONLY_ACTIVE'
  | 'BURST_LIMITER'
  | 'INSUFFICIENT_BALANCE'
  | 'PAIRING_TIMEOUT'
  | 'ASYMMETRIC_SETTLEMENT_OK'
  | 'ALREADY_HEDGED'
  | 'MARKET_FROZEN'
  | 'OTHER';

export interface HedgeSkipExplained {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  runId?: string;
  correlationId?: string;

  // What wasn't hedged
  sideNotHedged: 'UP' | 'DOWN';
  sharesUnhedged: number;

  // Why
  reasonCode: HedgeSkipReasonCode;
  reasonDetails: string;

  // Relevant prices at skip time
  bestAskHedgeSide: number | null;
  bestBidHedgeSide: number | null;
  projectedCpp: number | null;
  currentCpp: number | null;

  // State context
  secondsRemaining: number;
  botState: string;
  cppActivityState: 'NORMAL' | 'HEDGE_ONLY' | 'HOLD_ONLY';
}

export function logHedgeSkipExplained(data: HedgeSkipExplained): void {
  appendJsonl('snapshot', { ...data, logType: 'HEDGE_SKIP_EXPLAINED' });
  
  console.log(`🚫 [HEDGE_SKIP] ${data.asset} ${data.marketId.slice(0, 8)}: ${data.reasonCode}`);
  console.log(`   Side: ${data.sideNotHedged} (${data.sharesUnhedged} shares unhedged)`);
  console.log(`   Reason: ${data.reasonDetails}`);
  if (data.projectedCpp !== null) {
    console.log(`   Projected CPP: ${data.projectedCpp.toFixed(4)} | Current: ${data.currentCpp?.toFixed(4) ?? 'N/A'}`);
  }
  console.log(`   Time remaining: ${data.secondsRemaining}s | State: ${data.botState} | Activity: ${data.cppActivityState}`);
  
  saveBotEvent({
    event_type: 'HEDGE_SKIP_EXPLAINED',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    correlation_id: data.correlationId,
    reason_code: data.reasonCode,
    data: {
      sideNotHedged: data.sideNotHedged,
      sharesUnhedged: data.sharesUnhedged,
      reasonDetails: data.reasonDetails,
      bestAskHedgeSide: data.bestAskHedgeSide,
      projectedCpp: data.projectedCpp,
      currentCpp: data.currentCpp,
      secondsRemaining: data.secondsRemaining,
      botState: data.botState,
      cppActivityState: data.cppActivityState,
    },
  }).catch(() => {});
}

// ============================================================
// 6. MARK_TO_MARKET_SNAPSHOT — HONEST PNL
// ============================================================

export type MtmConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type MtmFallback = 'NONE' | 'LAST_KNOWN' | 'STRIKE_BASED';

export interface MarkToMarketSnapshot {
  ts: number;
  iso: string;
  marketId: string;
  asset: 'BTC' | 'ETH';
  runId?: string;

  // Mid prices
  upMid: number | null;
  downMid: number | null;
  combinedMid: number | null;

  // Book readiness
  bookReadyUp: boolean;
  bookReadyDown: boolean;

  // Fallback info
  fallbackUsed: MtmFallback;
  fallbackAge: number | null;    // Seconds since last known price (if fallback used)

  // Position
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;

  // PnL calculation
  unrealizedPnL: number | null;  // (upShares × upMid + downShares × downMid) - totalCost
  realizedPnL: number | null;    // From closed positions

  // Confidence
  confidence: MtmConfidence;
  confidenceReason: string;      // e.g., 'Both books ready' or 'DOWN book stale'
}

export function logMarkToMarket(data: MarkToMarketSnapshot): void {
  appendJsonl('snapshot', { ...data, logType: 'MARK_TO_MARKET_SNAPSHOT' });
  
  const confIcon = data.confidence === 'HIGH' ? '✅' : 
                   data.confidence === 'MEDIUM' ? '⚠️' : 
                   data.confidence === 'LOW' ? '🔶' : '❓';
  
  const pnlStr = data.unrealizedPnL !== null 
    ? (data.unrealizedPnL >= 0 ? `+$${data.unrealizedPnL.toFixed(2)}` : `-$${Math.abs(data.unrealizedPnL).toFixed(2)}`)
    : 'UNKNOWN';
  
  console.log(`${confIcon} [MTM] ${data.asset}: ${pnlStr} (${data.confidence})`);
  if (data.fallbackUsed !== 'NONE') {
    console.log(`   ⚠️ Fallback used: ${data.fallbackUsed} (${data.fallbackAge}s old)`);
  }
  
  saveBotEvent({
    event_type: 'MARK_TO_MARKET_SNAPSHOT',
    asset: data.asset,
    market_id: data.marketId,
    ts: data.ts,
    run_id: data.runId,
    data: {
      upMid: data.upMid,
      downMid: data.downMid,
      combinedMid: data.combinedMid,
      unrealizedPnL: data.unrealizedPnL,
      confidence: data.confidence,
      fallbackUsed: data.fallbackUsed,
    },
  }).catch(() => {});
}

// ============================================================
// HELPER: Generate correlation ID
// ============================================================

let correlationCounter = 0;

export function generateCorrelationId(prefix: string = 'corr'): string {
  correlationCounter++;
  const ts = Date.now().toString(36);
  const counter = correlationCounter.toString(36).padStart(4, '0');
  const random = Math.random().toString(36).substring(2, 6);
  return `${prefix}_${ts}_${counter}_${random}`;
}

// ============================================================
// EXPORTED TYPES (for use in strategy)
// ============================================================

export type {
  DecisionSnapshot,
  AccountPositionSnapshot,
  StateReconciliationResult,
  FillAttribution,
  HedgeSkipExplained,
  MarkToMarketSnapshot,
  GuardEvaluation,
};
