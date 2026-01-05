/**
 * Strategy v7.0 Types
 * ============================================================
 * Gabagool-style Inventory Arbitrage + Execution Hardening
 * 
 * Core principle: Buy YES + NO asymmetrically when combined < $1.00
 * Guaranteed profit = min(QtyYES, QtyNO) * $1 - (CostYES + CostNO)
 */

export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type Side = 'UP' | 'DOWN';
export type IntentType = 'ENTRY' | 'ACCUMULATE' | 'HEDGE' | 'MICRO_HEDGE' | 'UNWIND';
export type BotState = 'FLAT' | 'ONE_SIDED' | 'HEDGED' | 'SKEWED' | 'DEEP_DISLOCATION' | 'UNWIND';
export type DeltaRegime = 'LOW' | 'MID' | 'HIGH';
export type HedgeMode = 'NORMAL' | 'SURVIVAL' | 'HIGH_DELTA_CRITICAL' | 'PANIC';

// ============================================================
// BOOK & MARKET TYPES
// ============================================================

export interface BookTop {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  levels: number;
  ts: number;
}

export interface MarketSnapshot {
  marketId: string;
  asset: Asset;
  ts: number;
  secondsRemaining: number;
  strikePrice: number;
  spotPrice: number;
  up: BookTop;
  down: BookTop;
  readyUp: boolean;
  readyDown: boolean;
  queueSize: number;
  queueStress: boolean;
}

// ============================================================
// INVENTORY & POSITION TYPES
// ============================================================

export interface InventoryState {
  upShares: number;
  downShares: number;
  upInvested: number;    // USDC
  downInvested: number;  // USDC
  avgUpCost: number;     // Per-share average
  avgDownCost: number;   // Per-share average
  lastPairedTs: number;  // Timestamp when unpaired became 0
  unpairedShares: number;
  unpairedNotional: number;
  unpairedAgeSec: number;
  riskScore: number;
  degradedMode: boolean;
  firstFillTs?: number;
  lastFillTs?: number;
  tradesCount: number;
}

export interface PendingHedge {
  up: number;
  down: number;
}

// ============================================================
// INTENT & ORDER TYPES
// ============================================================

export interface Intent {
  id: string;
  ts: number;
  correlationId: string;
  marketId: string;
  asset: Asset;
  type: IntentType;
  side: Side;
  qtyShares: number;
  limitPrice: number;
  isMarketable: boolean;
  reason: string;
  priority: number;  // Higher = more urgent (HEDGE > ENTRY)
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  fillQty?: number;
  avgFillPrice?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface FillEvent {
  marketId: string;
  orderId: string;
  clientOrderId: string;
  intentType: IntentType;
  side: Side;
  fillQty: number;
  fillPrice: number;
  ts: number;
}

// ============================================================
// MARKET CONTEXT (per-market state container)
// ============================================================

export interface MarketContext {
  marketId: string;
  asset: Asset;
  tokenUp: string;
  tokenDown: string;
  eventStartTime: Date;
  eventEndTime: Date;
  strikePrice: number;
  
  // Readiness
  readinessCache: MarketReadinessCache;
  
  // Inventory
  inventory: InventoryState;
  pendingHedge: PendingHedge;
  
  // State machine
  state: BotState;
  hedgeMode: HedgeMode;
  deltaRegime: DeltaRegime;
  
  // Tracking
  noLiquidityStreak: number;
  adverseStreak: number;
  lastDecisionTs: number;
  lastSnapshotTs: number;
  
  // Micro-hedge state
  microHedgeState: MicroHedgeState;
}

export interface MarketReadinessCache {
  upReady: boolean;
  downReady: boolean;
  upLastSnapshotTs: number;
  downLastSnapshotTs: number;
  upTopBid: number | null;
  upTopAsk: number | null;
  downTopBid: number | null;
  downTopAsk: number | null;
}

export interface MicroHedgeState {
  pendingShares: number;
  lastAttemptTs: number;
  retryCount: number;
  cooldownUntil: number;
}

// ============================================================
// LOGGING EVENT TYPES
// ============================================================

export type SkipReason = 
  | 'NO_ORDERBOOK'
  | 'COOLDOWN'
  | 'QUEUE_STRESS'
  | 'FUNDS'
  | 'NO_DEPTH'
  | 'PAIR_COST'
  | 'DEGRADED_MODE'
  | 'RATE_LIMIT'
  | 'STALE_MARKET'
  | 'TOO_LATE'
  | 'MIN_EDGE';

export interface ActionSkippedEvent {
  type: 'ACTION_SKIPPED';
  ts: number;
  marketId: string;
  asset: Asset;
  reason: SkipReason;
  intendedAction: IntentType;
  details?: string;
}

export interface SnapshotLogEvent {
  type: 'SNAPSHOT';
  ts: number;
  marketId: string;
  asset: Asset;
  secondsRemaining: number;
  strike: number;
  spot: number;
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  readyUp: boolean;
  readyDown: boolean;
  queueSize: number;
  queueStress: boolean;
  state: BotState;
  hedgeMode: HedgeMode;
}

export interface InventoryLogEvent {
  type: 'INVENTORY';
  ts: number;
  marketId: string;
  asset: Asset;
  upShares: number;
  downShares: number;
  avgUpCost: number;
  avgDownCost: number;
  unpairedShares: number;
  unpairedNotional: number;
  unpairedAgeSec: number;
  riskScore: number;
  degradedMode: boolean;
  pairCost: number;
}

export interface IntentCreatedEvent {
  type: 'INTENT_CREATED';
  ts: number;
  intent: Intent;
}

export interface OrderEvent {
  type: 'ORDER_SUBMITTED' | 'ORDER_ACK' | 'ORDER_FAIL' | 'ORDER_CANCEL';
  ts: number;
  marketId: string;
  clientOrderId: string;
  orderId?: string;
  side: Side;
  qty: number;
  price: number;
  intentType: IntentType;
  errorCode?: string;
  errorMessage?: string;
}

export interface FillLogEvent {
  type: 'FILL';
  ts: number;
  marketId: string;
  clientOrderId: string;
  orderId: string;
  intentType: IntentType;
  side: Side;
  fillQty: number;
  fillPrice: number;
  fillNotional: number;
}

export interface ModeChangeEvent {
  type: 'DEGRADED_MODE_ENTER' | 'DEGRADED_MODE_EXIT' | 'CIRCUIT_BREAKER_ENTER' | 'CIRCUIT_BREAKER_EXIT';
  ts: number;
  marketId?: string;
  reason: string;
}

export type LogEvent = 
  | ActionSkippedEvent
  | SnapshotLogEvent
  | InventoryLogEvent
  | IntentCreatedEvent
  | OrderEvent
  | FillLogEvent
  | ModeChangeEvent;

// ============================================================
// METRICS & STATS
// ============================================================

export interface BotMetrics {
  decisions: number;
  ordersPlaced: number;
  ordersFailed: number;
  ordersCanceled: number;
  fills: number;
  fillQty: number;
  
  microHedgesTriggered: number;
  microHedgesSucceeded: number;
  
  degradedModeEnterCount: number;
  circuitBreakerTriggerCount: number;
  
  noLiquidityStreakMax: number;
  adverseStreakMax: number;
  
  realizedPairCostMin: number;
  realizedPairCostLast: number;
  
  hedgeMode: HedgeMode;
  deltaRegime: DeltaRegime;
}

// ============================================================
// SETTLEMENT
// ============================================================

export interface SettlementResult {
  marketId: string;
  asset: Asset;
  winningSide: Side;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  payout: number;
  pnl: number;
  pairCost: number;
  success: boolean;
  failureReason?: string;
}
