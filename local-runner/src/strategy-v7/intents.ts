/**
 * Strategy v7.0 Intent Builder
 * ============================================================
 * Builds trading intents based on market conditions
 * Gabagool-style: buy cheaper side first, asymmetric entries
 */

import type { 
  Intent, 
  MarketSnapshot, 
  InventoryState, 
  Side, 
  IntentType,
  HedgeMode,
  DeltaRegime,
  BotState,
} from './types.js';
import { getConfig } from './config.js';
import { 
  calculateAveragePairCost, 
  calculateSkew, 
  getDominantSide, 
  getWeakSide,
  projectPairCostAfterBuy,
} from './inventory.js';
import { isMarketReady, checkReadinessGate } from './readiness.js';

// ============================================================
// DELTA & REGIME CALCULATIONS
// ============================================================

export function calculateDeltaPct(spot: number, strike: number): number {
  if (strike === 0) return 0;
  return Math.abs(spot - strike) / strike;
}

export function getDeltaRegime(deltaPct: number): DeltaRegime {
  const cfg = getConfig();
  if (deltaPct < cfg.delta.lowThreshold) return 'LOW';
  if (deltaPct < cfg.delta.midThreshold) return 'MID';
  return 'HIGH';
}

export function getMaxSkewForRegime(regime: DeltaRegime): number {
  const cfg = getConfig();
  switch (regime) {
    case 'LOW': return cfg.risk.maxSkewLow;
    case 'MID': return cfg.risk.maxSkewMid;
    case 'HIGH': return cfg.risk.maxSkewHigh;
  }
}

// ============================================================
// HEDGE MODE DETERMINATION
// ============================================================

export function determineHedgeMode(
  snap: MarketSnapshot,
  inv: InventoryState,
  deltaPct: number
): HedgeMode {
  const cfg = getConfig();
  const sec = snap.secondsRemaining;
  
  // PANIC: Last resort, very close to expiry
  if (sec <= cfg.timing.panicModeSec) {
    return 'PANIC';
  }
  
  // SURVIVAL: Need to close out, time running out
  if (sec <= cfg.timing.survivalModeSec && inv.unpairedShares > 0) {
    return 'SURVIVAL';
  }
  
  // HIGH_DELTA_CRITICAL: Delta is extreme and time is short
  if (deltaPct > 0.008 && sec < 120 && inv.unpairedShares > 0) {
    return 'HIGH_DELTA_CRITICAL';
  }
  
  return 'NORMAL';
}

// ============================================================
// BOT STATE DETERMINATION
// ============================================================

export function determineBotState(
  inv: InventoryState,
  snap: MarketSnapshot
): BotState {
  const cfg = getConfig();
  
  // FLAT: No position
  if (inv.upShares === 0 && inv.downShares === 0) {
    return 'FLAT';
  }
  
  // UNWIND: Close to expiry
  if (snap.secondsRemaining <= cfg.timing.unwindStartSec) {
    return 'UNWIND';
  }
  
  // ONE_SIDED: Only one side has shares
  if (inv.upShares === 0 || inv.downShares === 0) {
    return 'ONE_SIDED';
  }
  
  // Check skew
  const skew = calculateSkew(inv);
  const deltaRegime = getDeltaRegime(calculateDeltaPct(snap.spotPrice, snap.strikePrice));
  const maxSkew = getMaxSkewForRegime(deltaRegime);
  
  // SKEWED: Outside acceptable skew range
  if (skew > maxSkew || skew < (1 - maxSkew)) {
    return 'SKEWED';
  }
  
  // Check for deep dislocation opportunity
  const upAsk = snap.up.ask ?? 1;
  const downAsk = snap.down.ask ?? 1;
  const combinedAsk = upAsk + downAsk;
  
  if (combinedAsk < cfg.entry.baseEdgeBuffer * 0.96 && snap.secondsRemaining > 180) {
    return 'DEEP_DISLOCATION';
  }
  
  // HEDGED: Balanced position
  return 'HEDGED';
}

// ============================================================
// ENTRY INTENT BUILDER
// ============================================================

export function buildEntryIntents(
  snap: MarketSnapshot,
  inv: InventoryState
): Intent[] {
  const cfg = getConfig();
  const intents: Intent[] = [];
  const now = snap.ts;
  
  // Check basic conditions
  if (snap.secondsRemaining <= cfg.entry.stopNewTradesSec) {
    return []; // Too late for new entries
  }
  
  if (snap.secondsRemaining < cfg.entry.minSecondsRemainingToEnter) {
    return []; // Not enough time
  }
  
  // Check readiness
  if (!isMarketReady(snap)) {
    return [];
  }
  
  // Check degraded mode
  if (inv.degradedMode) {
    return []; // Only hedges in degraded mode
  }
  
  // Get prices
  const upAsk = snap.up.ask;
  const downAsk = snap.down.ask;
  
  if (upAsk === null || downAsk === null) {
    return []; // No liquidity
  }
  
  const combinedAsk = upAsk + downAsk;
  const edge = 1 - combinedAsk;
  
  // Check minimum edge
  if (edge < cfg.entry.baseEdgeBuffer) {
    return []; // Not enough edge
  }
  
  // Determine which side to buy (cheaper one)
  const cheaperSide: Side = upAsk <= downAsk ? 'UP' : 'DOWN';
  const cheaperPrice = cheaperSide === 'UP' ? upAsk : downAsk;
  
  // Calculate sizing based on edge
  const baseNotional = cfg.sizing.baseNotionalUsd;
  const edgeMultiplier = 1 + (edge / 0.02); // Scale up for stronger edge
  const notional = Math.min(
    cfg.sizing.maxNotionalPerTrade,
    Math.max(cfg.sizing.minNotionalPerTrade, baseNotional * edgeMultiplier)
  );
  
  const qty = Math.max(
    cfg.sizing.minLotShares,
    Math.min(cfg.sizing.maxLotShares, Math.floor(notional / cheaperPrice))
  );
  
  // Determine intent type
  const intentType: IntentType = 
    inv.upShares === 0 && inv.downShares === 0 ? 'ENTRY' : 'ACCUMULATE';
  
  // Check if this would violate pair cost
  const projectedPairCost = projectPairCostAfterBuy(inv, cheaperSide, qty, cheaperPrice);
  if (projectedPairCost > 0.99 && inv.upShares > 0 && inv.downShares > 0) {
    return []; // Would hurt pair cost too much
  }
  
  intents.push({
    id: `${now}-${snap.marketId}-${cheaperSide}-${intentType}`,
    ts: now,
    correlationId: crypto.randomUUID(),
    marketId: snap.marketId,
    asset: snap.asset,
    type: intentType,
    side: cheaperSide,
    qtyShares: qty,
    limitPrice: cheaperPrice,
    isMarketable: false,
    reason: `EDGE:${(edge * 100).toFixed(2)}c combined=${(combinedAsk * 100).toFixed(1)}c`,
    priority: cfg.queue.entryPriority,
  });
  
  return intents;
}

// ============================================================
// HEDGE INTENT BUILDER
// ============================================================

export function buildHedgeIntents(
  snap: MarketSnapshot,
  inv: InventoryState,
  hedgeMode: HedgeMode
): Intent[] {
  const cfg = getConfig();
  const intents: Intent[] = [];
  const now = snap.ts;
  
  // No hedge needed if balanced
  if (inv.unpairedShares === 0) {
    return [];
  }
  
  // Check readiness
  if (!isMarketReady(snap)) {
    return [];
  }
  
  // Determine hedge side (opposite of dominant)
  const hedgeSide = getWeakSide(inv);
  const hedgeAsk = hedgeSide === 'UP' ? snap.up.ask : snap.down.ask;
  
  if (hedgeAsk === null) {
    return []; // No liquidity on hedge side
  }
  
  // Calculate hedge price based on mode
  let limitPrice: number;
  let isMarketable: boolean;
  
  switch (hedgeMode) {
    case 'PANIC':
      // Accept any reasonable price
      limitPrice = Math.min(cfg.hedge.maxPriceUrgent, hedgeAsk + cfg.hedge.urgentCushionTicks * cfg.tickSize);
      isMarketable = true;
      break;
      
    case 'SURVIVAL':
    case 'HIGH_DELTA_CRITICAL':
      // Aggressive but with some limit
      limitPrice = Math.min(cfg.hedge.maxPriceUrgent, hedgeAsk + cfg.hedge.urgentCushionTicks * cfg.tickSize);
      isMarketable = true;
      break;
      
    case 'NORMAL':
    default:
      // Maker order with cushion
      limitPrice = Math.min(cfg.hedge.maxPriceMaker, hedgeAsk + cfg.hedge.makerCushionTicks * cfg.tickSize);
      isMarketable = false;
  }
  
  // Round to tick
  limitPrice = Math.ceil(limitPrice / cfg.tickSize) * cfg.tickSize;
  
  // Check pair cost gate
  const upAsk = snap.up.ask ?? 0.50;
  const downAsk = snap.down.ask ?? 0.50;
  const projectedCombined = hedgeSide === 'UP'
    ? limitPrice + downAsk
    : upAsk + limitPrice;
  
  // In normal mode, don't burn edge
  if (hedgeMode === 'NORMAL' && projectedCombined > 1 - cfg.hedge.edgeLockBuffer) {
    return []; // Would burn too much edge
  }
  
  // In urgent modes, accept small loss
  if ((hedgeMode === 'SURVIVAL' || hedgeMode === 'HIGH_DELTA_CRITICAL' || hedgeMode === 'PANIC') &&
      projectedCombined > 1 + cfg.hedge.urgentLossCap) {
    // Still proceed in panic, but log warning
    if (hedgeMode !== 'PANIC') {
      return [];
    }
  }
  
  // Calculate quantity
  const qty = Math.min(inv.unpairedShares, cfg.sizing.maxLotShares);
  
  intents.push({
    id: `${now}-${snap.marketId}-${hedgeSide}-HEDGE`,
    ts: now,
    correlationId: crypto.randomUUID(),
    marketId: snap.marketId,
    asset: snap.asset,
    type: 'HEDGE',
    side: hedgeSide,
    qtyShares: qty,
    limitPrice,
    isMarketable,
    reason: `${hedgeMode} hedge: unpaired=${inv.unpairedShares}, projCombined=${(projectedCombined * 100).toFixed(1)}c`,
    priority: cfg.queue.hedgePriority,
  });
  
  return intents;
}

// ============================================================
// MICRO-HEDGE INTENT BUILDER (after fills)
// ============================================================

export function buildMicroHedgeIntent(
  snap: MarketSnapshot,
  inv: InventoryState,
  filledSharesOnDominant: number
): Intent | null {
  const cfg = getConfig();
  const now = snap.ts;
  
  // Check readiness
  if (!isMarketReady(snap)) {
    return null;
  }
  
  // Determine hedge side
  const hedgeSide = getWeakSide(inv);
  const hedgeAsk = hedgeSide === 'UP' ? snap.up.ask : snap.down.ask;
  
  if (hedgeAsk === null) {
    return null;
  }
  
  // Determine urgency
  const urgent = snap.secondsRemaining <= cfg.hedge.hedgeMustBySec;
  const cushionTicks = urgent ? cfg.hedge.urgentCushionTicks : cfg.hedge.makerCushionTicks;
  const maxPrice = urgent ? cfg.hedge.maxPriceUrgent : cfg.hedge.maxPriceMaker;
  
  // Calculate limit price
  let limitPrice = hedgeAsk + cushionTicks * cfg.tickSize;
  limitPrice = Math.min(maxPrice, Math.ceil(limitPrice / cfg.tickSize) * cfg.tickSize);
  
  // Check pair cost gate
  const upAsk = snap.up.ask ?? 0.50;
  const downAsk = snap.down.ask ?? 0.50;
  const projectedCombined = hedgeSide === 'UP'
    ? limitPrice + downAsk
    : upAsk + limitPrice;
  
  const makerOk = projectedCombined <= 1 - cfg.hedge.edgeLockBuffer;
  const urgentOk = projectedCombined <= 1 + cfg.hedge.urgentLossCap;
  
  if (!(urgent ? urgentOk : makerOk)) {
    return null;
  }
  
  // Quantity = exact filled amount (or minimum lot)
  const qty = Math.max(cfg.sizing.minLotShares, filledSharesOnDominant);
  
  return {
    id: `${now}-${snap.marketId}-${hedgeSide}-MICRO`,
    ts: now,
    correlationId: crypto.randomUUID(),
    marketId: snap.marketId,
    asset: snap.asset,
    type: 'MICRO_HEDGE',
    side: hedgeSide,
    qtyShares: qty,
    limitPrice,
    isMarketable: urgent,
    reason: urgent ? 'URGENT_MICRO_HEDGE' : 'MAKER_MICRO_HEDGE',
    priority: cfg.queue.microHedgePriority,
  };
}

// ============================================================
// MAIN INTENT BUILDER (per tick)
// ============================================================

export function buildIntentsV7(
  snap: MarketSnapshot,
  inv: InventoryState,
  log: (event: any) => void
): Intent[] {
  const cfg = getConfig();
  const now = snap.ts;
  
  // Check market readiness
  if (!isMarketReady(snap)) {
    log({
      type: 'ACTION_SKIPPED',
      ts: now,
      marketId: snap.marketId,
      asset: snap.asset,
      reason: 'NO_ORDERBOOK',
      intendedAction: 'ANY',
    });
    return [];
  }
  
  // Determine current state and mode
  const deltaPct = calculateDeltaPct(snap.spotPrice, snap.strikePrice);
  const hedgeMode = determineHedgeMode(snap, inv, deltaPct);
  const botState = determineBotState(inv, snap);
  
  const intents: Intent[] = [];
  
  // Priority 1: Handle urgent hedging modes
  if (hedgeMode !== 'NORMAL') {
    const hedgeIntents = buildHedgeIntents(snap, inv, hedgeMode);
    intents.push(...hedgeIntents);
  }
  
  // Priority 2: Normal hedging if needed
  if (hedgeMode === 'NORMAL' && inv.unpairedShares > 0) {
    // Check hedge timeout
    const hedgeTimeout = getDeltaRegime(deltaPct) === 'LOW'
      ? cfg.hedge.hedgeTimeoutLowSec
      : getDeltaRegime(deltaPct) === 'MID'
        ? cfg.hedge.hedgeTimeoutMidSec
        : cfg.hedge.hedgeTimeoutHighSec;
    
    if (inv.unpairedAgeSec > hedgeTimeout) {
      const hedgeIntents = buildHedgeIntents(snap, inv, 'NORMAL');
      intents.push(...hedgeIntents);
    }
  }
  
  // Priority 3: Entry/accumulate if not degraded and not urgent
  if (!inv.degradedMode && hedgeMode === 'NORMAL' && snap.secondsRemaining > cfg.entry.stopNewTradesSec) {
    const entryIntents = buildEntryIntents(snap, inv);
    intents.push(...entryIntents);
  }
  
  // Sort by priority (higher first)
  intents.sort((a, b) => b.priority - a.priority);
  
  return intents;
}
