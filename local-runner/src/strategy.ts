/**
 * strategy.ts - Active Strategy Wrapper (v7.0.0)
 * ===============================================
 * GPT Strategy v7.0 – Gabagool Inventory Arbitrage + Execution Hardening
 * 
 * v7.0.0 UPDATE: Complete Rewrite
 * -------------------------------
 * This module now uses the new v7 architecture with:
 *   - Readiness gates (no orderbook = no order)
 *   - Inventory-first signals (unpaired & age are leading)
 *   - Micro-hedge after every fill (exact size)
 *   - Queue-aware throttling
 *   - Degraded mode + circuit breaker
 * 
 * Core Principle:
 * Buy YES + NO asymmetrically when combined < $1.00
 * Guaranteed profit = min(QtyYES, QtyNO) * $1 - (CostYES + CostNO)
 * 
 * States: FLAT → ONE_SIDED → HEDGED / SKEWED / DEEP_DISLOCATION / UNWIND
 * Modes: NORMAL → SURVIVAL → HIGH_DELTA_CRITICAL → PANIC
 */

// ============================================================
// v7 IMPORTS - Primary Strategy
// ============================================================

import {
  // Types
  type Asset,
  type Side,
  type IntentType,
  type Intent,
  type MarketSnapshot,
  type InventoryState,
  type BookTop,
  type HedgeMode,
  type DeltaRegime,
  type BotState,
  type FillEvent,
  type LogEvent,
  
  // Config
  STRATEGY_VERSION as V7_VERSION,
  STRATEGY_NAME as V7_NAME,
  getConfig,
  DEFAULT_CONFIG,
  logEffectiveConfig,
  
  // Readiness
  isTokenReady,
  isMarketReady,
  checkReadinessGate,
  createActionSkippedEvent,
  
  // Inventory
  createEmptyInventory,
  updateInventoryOnFill,
  calculateInventoryRisk,
  calculatePairCost,
  calculateAveragePairCost,
  calculateSkew,
  getDominantSide,
  getWeakSide,
  evaluateDegradedMode,
  createInventoryLogEvent,
  
  // Intents
  calculateDeltaPct,
  getDeltaRegime,
  determineHedgeMode,
  determineBotState,
  buildEntryIntents,
  buildHedgeIntents,
  buildMicroHedgeIntent,
  buildIntentsV7,
  
  // Circuit breaker
  CircuitBreaker,
  createCircuitBreaker,
  recordFailure,
  recordSuccess,
  isCircuitOpen,
  getCircuitBreakerStats,
  
  // Queue
  IntentQueue,
  createIntentQueue,
  enqueueIntent,
  dequeueIntent,
  getQueueStats,
  isQueueStressed,
  pruneStaleIntents,
} from './strategy-v7/index.js';

// ============================================================
// LEGACY IMPORTS - For backward compatibility only
// ============================================================

import { getCurrentConfig, toStrategyObject, type ResolvedConfig } from './resolved-config.js';
import type { OrderbookDepth } from './polymarket.js';

// Re-export legacy types for gradual migration
export type Outcome = Side;  // Map to v7 terminology
export type State = BotState;

export interface TopOfBook {
  up: { bid: number | null; ask: number | null };
  down: { bid: number | null; ask: number | null };
  updatedAtMs: number;
}

export interface Inventory {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  firstFillTs?: number;
  lastFillTs?: number;
  tradesCount?: number;
  marketOpenTs?: number;
}

export interface MarketPosition extends Inventory {
  upInvested: number;
  downInvested: number;
}

export interface PendingHedge {
  up: number;
  down: number;
}

export interface TradeSignal {
  outcome: Outcome;
  price: number;
  shares: number;
  reasoning: string;
  type: 'opening' | 'hedge' | 'accumulate' | 'rebalance' | 'unwind';
  isMarketable?: boolean;
  cushionTicks?: number;
}

export interface MarketState {
  state: State;
  inventory: Inventory;
  pendingHedge: PendingHedge;
  noLiquidityStreak: number;
  adverseStreak: number;
  lastDecisionTs: number;
}

export interface LegacyTradeSignal extends TradeSignal {}

// ============================================================
// v7 RE-EXPORTS
// ============================================================

export {
  // Version info
  V7_VERSION as STRATEGY_VERSION,
  V7_NAME as STRATEGY_NAME,
  
  // Types
  type Asset,
  type Side,
  type IntentType,
  type Intent,
  type MarketSnapshot,
  type InventoryState,
  type BookTop,
  type HedgeMode,
  type DeltaRegime,
  type BotState,
  type FillEvent,
  type LogEvent,
  
  // Config
  getConfig,
  DEFAULT_CONFIG,
  logEffectiveConfig,
  
  // Readiness
  isTokenReady,
  isMarketReady,
  checkReadinessGate,
  createActionSkippedEvent,
  
  // Inventory
  createEmptyInventory,
  updateInventoryOnFill,
  calculateInventoryRisk,
  calculatePairCost,
  calculateAveragePairCost,
  calculateSkew,
  getDominantSide,
  getWeakSide,
  evaluateDegradedMode,
  createInventoryLogEvent,
  
  // Intents
  calculateDeltaPct,
  getDeltaRegime,
  determineHedgeMode,
  determineBotState,
  buildEntryIntents,
  buildHedgeIntents,
  buildMicroHedgeIntent,
  buildIntentsV7,
  
  // Circuit breaker
  type CircuitBreaker,
  createCircuitBreaker,
  recordFailure,
  recordSuccess,
  isCircuitOpen,
  getCircuitBreakerStats,
  
  // Queue
  type IntentQueue,
  createIntentQueue,
  enqueueIntent,
  dequeueIntent,
  getQueueStats,
  isQueueStressed,
  pruneStaleIntents,
};

// ============================================================
// LEGACY COMPATIBILITY - STRATEGY OBJECT
// ============================================================

/**
 * Returns the effective STRATEGY object.
 * Uses v7 config, falls back to ResolvedConfig for legacy code.
 */
export function getStrategy(): any {
  const v7Config = getConfig();
  if (v7Config) {
    return {
      version: v7Config.version,
      tradeSizeUsd: {
        base: v7Config.sizing.baseNotionalUsd,
        min: v7Config.sizing.minNotionalPerTrade,
        max: v7Config.sizing.maxNotionalPerTrade,
      },
      edge: {
        baseBuffer: v7Config.entry.baseEdgeBuffer,
        strongEdge: v7Config.entry.strongEdgeThreshold,
        allowOverpay: v7Config.hedge.urgentLossCap,
        feesBuffer: 0.002,
        slippageBuffer: 0.004,
        deepDislocationThreshold: 0.96,
      },
      timing: {
        stopNewTradesSec: v7Config.entry.stopNewTradesSec,
        hedgeTimeoutSec: v7Config.hedge.hedgeTimeoutLowSec,
        hedgeMustBySec: v7Config.hedge.hedgeMustBySec,
        unwindStartSec: v7Config.timing.unwindStartSec,
        entryWindowStartSec: v7Config.timing.entryWindowStartSec,
        entryWindowEndSec: v7Config.timing.entryWindowEndSec,
      },
      skew: {
        target: 0.50,
        rebalanceThreshold: 0.20,
        hardCap: v7Config.risk.maxSkewLow,
      },
      limits: {
        maxTotalNotional: v7Config.risk.globalMaxNotional,
        maxPerSide: v7Config.risk.perMarketMaxNotional,
        maxSharesPerSide: 500,
      },
      opening: {
        maxPrice: 0.52,
        shares: v7Config.sizing.lotShares,
      },
      hedge: {
        maxPrice: v7Config.hedge.maxPriceMaker,
        forceTimeoutSec: v7Config.hedge.hedgeMustBySec,
        cooldownMs: v7Config.microHedge.cooldownMs,
      },
      tick: {
        fallback: v7Config.tickSize,
      },
    };
  }
  
  // Fallback to legacy ResolvedConfig
  const cfg = getCurrentConfig();
  if (cfg) {
    return toStrategyObject(cfg);
  }
  
  // Ultimate fallback
  return {
    version: '7.0.0',
    tradeSizeUsd: { base: 10, min: 5, max: 25 },
    edge: { baseBuffer: 0.015 },
    timing: { stopNewTradesSec: 60 },
  };
}

/**
 * STRATEGY object for backwards compatibility.
 * Uses Proxy to dynamically return current config values.
 */
export const STRATEGY = new Proxy({} as any, {
  get(_target, prop: string) {
    const strategy = getStrategy();
    return strategy[prop];
  },
});

// ============================================================
// LEGACY WRAPPER FUNCTIONS
// ============================================================

export function dynamicEdgeBuffer(
  noLiquidityStreak: number,
  adverseStreak: number
): number {
  const cfg = getConfig();
  let buffer = cfg.entry.baseEdgeBuffer;
  
  if (noLiquidityStreak > 3) buffer -= 0.005;
  if (adverseStreak > 2) buffer += 0.005;
  
  return Math.max(0.01, Math.min(0.03, buffer));
}

export function executionAwareEdgeOk(
  upAsk: number,
  downAsk: number,
  upMid: number,
  downMid: number,
  buffer?: number
): { ok: boolean; edge: number; combined: number } {
  const cfg = getConfig();
  const effectiveBuffer = buffer ?? cfg.entry.baseEdgeBuffer;
  const combinedAsk = upAsk + downAsk;
  const edge = 1 - combinedAsk;
  
  return {
    ok: edge >= effectiveBuffer,
    edge,
    combined: combinedAsk,
  };
}

export function pairedLockOk(
  upAsk: number,
  downAsk: number,
  buffer?: number
): boolean {
  const cfg = getConfig();
  const effectiveBuffer = buffer ?? cfg.entry.baseEdgeBuffer;
  return (upAsk + downAsk) < (1 - effectiveBuffer);
}

export function buildEntry(
  upAsk: number,
  downAsk: number,
  tradeSize?: number
): TradeSignal | null {
  const cfg = getConfig();
  const effectiveSize = tradeSize ?? cfg.sizing.lotShares;
  
  const combinedAsk = upAsk + downAsk;
  const edge = 1 - combinedAsk;
  
  if (edge < cfg.entry.baseEdgeBuffer) return null;
  
  const cheaper: Outcome = upAsk <= downAsk ? 'UP' : 'DOWN';
  const price = cheaper === 'UP' ? upAsk : downAsk;
  
  return {
    outcome: cheaper,
    price,
    shares: effectiveSize,
    reasoning: `ENTRY: edge=${(edge * 100).toFixed(2)}c`,
    type: 'opening',
    isMarketable: false,
  };
}

export function buildHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number
): TradeSignal {
  const cfg = getConfig();
  const price = Math.min(cfg.hedge.maxPriceMaker, Math.ceil(ask / tick) * tick);
  
  return {
    outcome: side,
    price,
    shares: qty,
    reasoning: `HEDGE ${side}`,
    type: 'hedge',
    isMarketable: false,
  };
}

export function buildForceHedge(
  side: Outcome,
  ask: number,
  tick: number,
  qty: number,
  existingAvg: number
): TradeSignal | null {
  const cfg = getConfig();
  const price = Math.min(cfg.hedge.maxPriceUrgent, ask + cfg.hedge.urgentCushionTicks * tick);
  
  return {
    outcome: side,
    price,
    shares: qty,
    reasoning: `FORCE HEDGE ${side}`,
    type: 'hedge',
    isMarketable: true,
    cushionTicks: cfg.hedge.urgentCushionTicks,
  };
}

export function shouldUnwind(
  secondsRemaining: number,
  hedgeLagSec: number,
  noLiquidityStreak: number
): { unwind: boolean; reason: string } {
  const cfg = getConfig();
  
  if (secondsRemaining < cfg.timing.unwindStartSec) {
    return { unwind: true, reason: `Time critical: ${secondsRemaining}s remaining` };
  }
  if (hedgeLagSec > cfg.hedge.hedgeMustBySec) {
    return { unwind: true, reason: `Hedge timeout: ${hedgeLagSec}s lag` };
  }
  if (noLiquidityStreak >= 6) {
    return { unwind: true, reason: `No liquidity streak: ${noLiquidityStreak}` };
  }
  return { unwind: false, reason: '' };
}

export function evaluateOpportunity(
  book: TopOfBook,
  position: MarketPosition,
  remainingSeconds: number,
  lastTradeAtMs: number,
  nowMs: number,
  availableBalance?: number,
  currentPrice?: number,
  strikePrice?: number
): TradeSignal | null {
  // Convert to v7 format and use v7 logic
  const cfg = getConfig();
  
  const upAsk = book.up.ask;
  const downAsk = book.down.ask;
  
  if (upAsk === null || downAsk === null) return null;
  if (remainingSeconds < cfg.entry.stopNewTradesSec) return null;
  
  const inv: InventoryState = {
    upShares: position.upShares,
    downShares: position.downShares,
    upInvested: position.upInvested,
    downInvested: position.downInvested,
    avgUpCost: position.upShares > 0 ? position.upInvested / position.upShares : 0,
    avgDownCost: position.downShares > 0 ? position.downInvested / position.downShares : 0,
    lastPairedTs: nowMs,
    unpairedShares: Math.abs(position.upShares - position.downShares),
    unpairedNotional: 0,
    unpairedAgeSec: 0,
    riskScore: 0,
    degradedMode: false,
    tradesCount: 0,
  };
  
  // Check if we need to hedge
  if (inv.unpairedShares > 0) {
    const hedgeSide = getWeakSide(inv);
    const hedgeAsk = hedgeSide === 'UP' ? upAsk : downAsk;
    
    return buildHedge(hedgeSide, hedgeAsk, cfg.tickSize, inv.unpairedShares);
  }
  
  // Check for entry opportunity
  const combinedAsk = upAsk + downAsk;
  const edge = 1 - combinedAsk;
  
  if (edge >= cfg.entry.baseEdgeBuffer) {
    return buildEntry(upAsk, downAsk);
  }
  
  return null;
}

export function checkBalanceForOpening(
  availableBalance: number,
  requiredNotional?: number
): { canProceed: boolean; reason?: string } {
  const cfg = getConfig();
  const effectiveNotional = requiredNotional ?? cfg.sizing.baseNotionalUsd;
  
  if (availableBalance < effectiveNotional) {
    return { canProceed: false, reason: `Insufficient balance: ${availableBalance} < ${effectiveNotional}` };
  }
  return { canProceed: true };
}

export function checkLiquidityForAccumulate(
  upDepth: OrderbookDepth,
  downDepth: OrderbookDepth,
  requiredShares: number
): { canProceed: boolean; reason?: string } {
  const upLiquidity = upDepth.asks?.[0]?.size ?? 0;
  const downLiquidity = downDepth.asks?.[0]?.size ?? 0;
  
  if (upLiquidity < requiredShares * 0.5 && downLiquidity < requiredShares * 0.5) {
    return { canProceed: false, reason: 'Insufficient liquidity on both sides' };
  }
  return { canProceed: true };
}

export function calculatePreHedgePrice(
  openingPrice: number,
  openingSide: Outcome,
  hedgeAsk?: number,
  tick?: number
): { maxHedgePrice: number; breakeven: number } {
  const cfg = getConfig();
  const effectiveTick = tick ?? cfg.tickSize;
  
  const breakeven = 1 - openingPrice;
  const maxHedgePrice = hedgeAsk ? Math.min(breakeven, hedgeAsk + effectiveTick) : breakeven;
  
  return { maxHedgePrice, breakeven };
}

export function checkHardSkewStop(position: MarketPosition): { blocked: boolean; reason?: string } {
  const cfg = getConfig();
  const total = position.upShares + position.downShares;
  if (total === 0) return { blocked: false };
  
  const skew = position.upShares / total;
  if (skew > cfg.risk.maxSkewLow || skew < (1 - cfg.risk.maxSkewLow)) {
    return { blocked: true, reason: `Skew ${(skew * 100).toFixed(0)}% exceeds cap` };
  }
  return { blocked: false };
}

// ============================================================
// v6.1 COMPATIBILITY EXPORTS
// ============================================================

export function unpairedShares(inv: Inventory | InventoryState): number {
  return Math.abs(inv.upShares - inv.downShares);
}

export function pairedShares(inv: Inventory | InventoryState): number {
  return Math.min(inv.upShares, inv.downShares);
}

export function pairCost(inv: MarketPosition | InventoryState): number {
  const paired = pairedShares(inv);
  if (paired === 0) return 0;
  
  const invState = inv as InventoryState;
  const upCost = invState.upInvested ?? (inv as MarketPosition).upCost;
  const downCost = invState.downInvested ?? (inv as MarketPosition).downCost;
  
  return (upCost + downCost) / paired;
}

export function avgPrice(inv: Inventory, side: Outcome): number {
  if (side === 'UP') {
    return inv.upShares > 0 ? inv.upCost / inv.upShares : 0;
  }
  return inv.downShares > 0 ? inv.downCost / inv.downShares : 0;
}

export function lockedProfit(inv: MarketPosition): number {
  const paired = pairedShares(inv);
  if (paired === 0) return 0;
  return paired - (inv.upInvested + inv.downInvested);
}

export function calculateProfit(inv: MarketPosition): number {
  return lockedProfit(inv);
}

export function calculateProfitPercent(inv: MarketPosition): number {
  const totalInvested = inv.upInvested + inv.downInvested;
  if (totalInvested === 0) return 0;
  return (lockedProfit(inv) / totalInvested) * 100;
}

export function determineState(inv: Inventory): State {
  if (inv.upShares === 0 && inv.downShares === 0) return 'FLAT';
  if (inv.upShares === 0 || inv.downShares === 0) return 'ONE_SIDED';
  
  const skew = calculateSkew(inv as InventoryState);
  if (skew > 0.7 || skew < 0.3) return 'SKEWED';
  
  return 'HEDGED';
}

export function calculateEdge(upAsk: number, downAsk: number): number {
  return 1 - (upAsk + downAsk);
}

// Micro-hedge compatibility
export interface MicroHedgeState {
  pendingShares: number;
  lastAttemptTs: number;
  retryCount: number;
  cooldownUntil: number;
}

export interface MicroHedgeIntent {
  side: Outcome;
  qty: number;
  price: number;
  isUrgent: boolean;
}

export interface MicroHedgeResult {
  success: boolean;
  filledQty?: number;
  error?: string;
}

export function buildMicroHedge(
  inv: Inventory,
  book: TopOfBook,
  unpairedDelta: number,
  secondsRemaining: number
): MicroHedgeIntent | null {
  const cfg = getConfig();
  
  const weakSide: Outcome = inv.upShares < inv.downShares ? 'UP' : 'DOWN';
  const ask = weakSide === 'UP' ? book.up.ask : book.down.ask;
  
  if (ask === null) return null;
  
  const isUrgent = secondsRemaining <= cfg.hedge.hedgeMustBySec;
  const price = isUrgent
    ? Math.min(cfg.hedge.maxPriceUrgent, ask + cfg.hedge.urgentCushionTicks * cfg.tickSize)
    : Math.min(cfg.hedge.maxPriceMaker, ask + cfg.hedge.makerCushionTicks * cfg.tickSize);
  
  return {
    side: weakSide,
    qty: Math.max(cfg.sizing.minLotShares, unpairedDelta),
    price,
    isUrgent,
  };
}

export function logMicroHedgeIntent(intent: MicroHedgeIntent): void {
  console.log(`[v7] MICRO_HEDGE_INTENT: ${intent.side} ${intent.qty} @ ${intent.price} (urgent=${intent.isUrgent})`);
}

export function logMicroHedgeResult(result: MicroHedgeResult): void {
  if (result.success) {
    console.log(`[v7] MICRO_HEDGE_SUCCESS: filled ${result.filledQty}`);
  } else {
    console.log(`[v7] MICRO_HEDGE_FAILED: ${result.error}`);
  }
}

// v6.1.1 compatibility stubs
export interface V611GuardrailResult {
  blocked: boolean;
  trigger?: string;
  reason?: string;
}

export function checkV611Guardrails(inv: Inventory, secondsRemaining: number): V611GuardrailResult {
  const cfg = getConfig();
  
  if (secondsRemaining < cfg.timing.panicModeSec && unpairedShares(inv) > 0) {
    return { blocked: true, trigger: 'PANIC_MODE', reason: 'Must hedge before expiry' };
  }
  
  return { blocked: false };
}

// Tick utilities
export class TickInferer {
  private tick: number = 0.01;
  
  observe(price: number): void {
    // Infer from price
  }
  
  get(): number {
    return this.tick;
  }
}

export const tickInferer = new TickInferer();

export function roundDown(price: number, tick: number = 0.01): number {
  return Math.floor(price / tick) * tick;
}

export function roundUp(price: number, tick: number = 0.01): number {
  return Math.ceil(price / tick) * tick;
}

// Fill handler
export function onFill(
  inv: Inventory,
  side: Outcome,
  fillQty: number,
  fillPrice: number,
  ts: number
): Inventory {
  const updated = { ...inv };
  const cost = fillQty * fillPrice;
  
  if (side === 'UP') {
    updated.upShares = inv.upShares + fillQty;
    updated.upCost = inv.upCost + cost;
  } else {
    updated.downShares = inv.downShares + fillQty;
    updated.downCost = inv.downCost + cost;
  }
  
  updated.lastFillTs = ts;
  updated.tradesCount = (inv.tradesCount ?? 0) + 1;
  if (!updated.firstFillTs) updated.firstFillTs = ts;
  
  return updated;
}

// ============================================================
// v7.0.1 PATCH LAYER RE-EXPORTS
// ============================================================

export {
  V7_PATCH_VERSION,
  // Readiness
  isMarketReady as v7IsMarketReady,
  checkReadinessGate as v7CheckReadinessGate,
  clearReadinessState as v7ClearReadinessState,
  // Intent Slots
  getIntentSlots,
  setPendingEntry,
  setPendingHedge,
  clearEntrySlot,
  clearHedgeSlot,
  getPendingIntentCount,
  canAddIntent,
  clearIntentSlots,
  // Micro-hedge Accumulator
  getMicroHedgeAccumulator,
  accumulateHedgeNeeded,
  shouldPlaceMicroHedge,
  clearMicroHedgeAccumulator,
  resetMicroHedgeAccumulator,
  // Risk Score / Degraded Mode
  calculateRiskScore,
  isActionAllowedInDegradedMode,
  // Queue Stress
  updateGlobalPendingCount,
  isQueueStressed as v7IsQueueStressed,
  isActionAllowedInQueueStress,
  // Combined Gate
  checkV7Gates,
  // Stats
  getV7PatchStats,
  logV7PatchStatus,
  // Types
  type MarketBook as V7MarketBook,
  type ReadinessState,
  type PendingIntent as V7PendingIntent,
  type IntentType as V7IntentType,
  type MicroHedgeAccumulator,
  type RiskScoreResult,
  type V7GateResult,
  type V7PatchStats,
} from './v7-patch.js';
