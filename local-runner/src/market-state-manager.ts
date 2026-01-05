/**
 * market-state-manager.ts - v7.x REV C Partial-Pair Guardrails
 * ============================================================
 * Implements PAIRING state machine with:
 * - State transitions: FLAT → ONE_SIDED_UP/DOWN → PAIRING → PAIRED → UNWIND_ONLY
 * - PAIRING timeout (45s) to prevent half-hedged limbo
 * - Dynamic hedge slippage caps based on volatility
 * - Bounded hedge chunk sizing for inventory scaling
 * - Complete lifecycle logging (PAIRING_STARTED, PAIRING_TIMEOUT_REVERT)
 * 
 * REV C spec: Fine-tuned for 15-minute markets
 */

import { saveBotEvent } from './backend.js';

// ============================================================
// CONFIGURATION - REV C DEFAULTS
// ============================================================

export const MARKET_STATE_CONFIG = {
  // A) PAIRING State Timeout (REV C: tightened for 15-min markets)
  pairingTimeoutSeconds: 45,        // Max dwell time in PAIRING state

  // B) Dynamic Hedge Slippage Caps (REV C: explicit defaults)
  hedgeSlippageCaps: {
    BTC: { base: 1.0, max: 2.0 },   // cents
    ETH: { base: 1.5, max: 2.5 },
    SOL: { base: 2.0, max: 3.0 },
    XRP: { base: 2.0, max: 4.0 },
  } as Record<string, { base: number; max: number }>,
  volatilityMultiplier: 50,         // Scaling factor for vol-based cap
  volatilityLookbackSeconds: 300,   // 5 minutes lookback

  // C) Bounded Hedge Chunk Sizing (REV B/C)
  minHedgeChunkAbs: 25,             // Minimum hedge chunk (shares)
  minHedgeChunkPct: 0.25,           // 25% of one-sided position
  maxHedgeChunkAbs: 100,            // Maximum hedge chunk (shares)

  // D) Logging
  logEvents: true,
};

// ============================================================
// TYPES
// ============================================================

export type PairingState = 
  | 'FLAT'
  | 'ONE_SIDED_UP'
  | 'ONE_SIDED_DOWN'
  | 'PAIRING'
  | 'PAIRED'
  | 'UNWIND_ONLY';

export type HedgeReason = 'PAIR_EDGE' | 'EMERGENCY_SKEW';

export interface MarketStateContext {
  marketId: string;
  asset: string;
  state: PairingState;
  
  // Inventory
  upShares: number;
  downShares: number;
  
  // PAIRING lifecycle
  pairingStartTimestamp: number | null;
  pairingReason: HedgeReason | null;
  
  // Volatility tracking for dynamic caps
  priceHistory: Array<{ ts: number; midPrice: number }>;
  
  // State timestamps
  stateEnteredAt: number;
  lastTransitionAt: number;
}

export interface PairingStartedEvent {
  marketId: string;
  asset: string;
  timestamp: number;
  upShares: number;
  downShares: number;
  bestAskUp: number | null;
  bestAskDown: number | null;
  combinedAsk: number | null;
  impliedPairCostCents: number | null;
  hedgeReason: HedgeReason;
}

export interface PairingTimeoutRevertEvent {
  marketId: string;
  asset: string;
  timeInPairing: number;
  upShares: number;
  downShares: number;
  revertedTo: PairingState;
}

export interface HedgePriceCapDynamicEvent {
  marketId: string;
  asset: string;
  baseCap: number;
  dynamicCap: number;
  finalCap: number;
  recentVol: number | null;
}

// ============================================================
// MARKET STATE MANAGER CLASS
// ============================================================

export class MarketStateManager {
  private contexts: Map<string, MarketStateContext> = new Map();
  private config = MARKET_STATE_CONFIG;
  private runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  // ============================================================
  // STATE MANAGEMENT
  // ============================================================

  getOrCreateContext(marketId: string, asset: string): MarketStateContext {
    const key = `${marketId}:${asset}`;
    if (!this.contexts.has(key)) {
      this.contexts.set(key, {
        marketId,
        asset,
        state: 'FLAT',
        upShares: 0,
        downShares: 0,
        pairingStartTimestamp: null,
        pairingReason: null,
        priceHistory: [],
        stateEnteredAt: Date.now(),
        lastTransitionAt: Date.now(),
      });
    }
    return this.contexts.get(key)!;
  }

  updateInventory(marketId: string, asset: string, upShares: number, downShares: number): void {
    const ctx = this.getOrCreateContext(marketId, asset);
    ctx.upShares = upShares;
    ctx.downShares = downShares;
  }

  // ============================================================
  // A) STATE TRANSITIONS
  // ============================================================

  determineState(ctx: MarketStateContext, secondsRemaining: number): PairingState {
    const { upShares, downShares } = ctx;
    const paired = Math.min(upShares, downShares);
    const minPaired = 20; // From pairedControl.minShares

    // UNWIND_ONLY near expiry
    if (secondsRemaining <= 45) {
      return 'UNWIND_ONLY';
    }

    // FLAT if no inventory
    if (upShares === 0 && downShares === 0) {
      return 'FLAT';
    }

    // PAIRED if balanced
    if (paired >= minPaired && Math.abs(upShares - downShares) <= paired * 0.2) {
      return 'PAIRED';
    }

    // ONE_SIDED if only one side
    if (upShares > 0 && downShares === 0) {
      return 'ONE_SIDED_UP';
    }
    if (downShares > 0 && upShares === 0) {
      return 'ONE_SIDED_DOWN';
    }

    // PAIRING if in transition
    if (ctx.state === 'PAIRING') {
      return 'PAIRING';
    }

    // Default to current state or ONE_SIDED based on dominant side
    if (upShares > downShares) {
      return 'ONE_SIDED_UP';
    }
    return 'ONE_SIDED_DOWN';
  }

  transitionState(
    ctx: MarketStateContext,
    newState: PairingState,
    reason?: HedgeReason,
    bookData?: { bestAskUp: number | null; bestAskDown: number | null }
  ): void {
    const oldState = ctx.state;
    if (oldState === newState) return;

    const now = Date.now();

    // Handle transition INTO PAIRING
    if (newState === 'PAIRING' && oldState.startsWith('ONE_SIDED')) {
      ctx.pairingStartTimestamp = now;
      ctx.pairingReason = reason || 'PAIR_EDGE';
      
      // Log PAIRING_STARTED
      this.logPairingStarted(ctx, bookData);
    }

    // Handle transition OUT OF PAIRING
    if (oldState === 'PAIRING' && newState !== 'PAIRING') {
      ctx.pairingStartTimestamp = null;
      ctx.pairingReason = null;
    }

    ctx.state = newState;
    ctx.stateEnteredAt = now;
    ctx.lastTransitionAt = now;
  }

  // ============================================================
  // A) PAIRING TIMEOUT CHECK
  // ============================================================

  checkPairingTimeout(ctx: MarketStateContext): { timedOut: boolean; timeInPairing: number } {
    if (ctx.state !== 'PAIRING' || !ctx.pairingStartTimestamp) {
      return { timedOut: false, timeInPairing: 0 };
    }

    const now = Date.now();
    const timeInPairingMs = now - ctx.pairingStartTimestamp;
    const timeInPairingSec = timeInPairingMs / 1000;

    if (timeInPairingSec >= this.config.pairingTimeoutSeconds) {
      // Determine revert target
      const revertTo: PairingState = ctx.upShares > ctx.downShares 
        ? 'ONE_SIDED_UP' 
        : 'ONE_SIDED_DOWN';

      // Log timeout revert
      this.logPairingTimeoutRevert(ctx, timeInPairingSec, revertTo);

      // Perform transition
      ctx.state = revertTo;
      ctx.pairingStartTimestamp = null;
      ctx.pairingReason = null;
      ctx.lastTransitionAt = now;

      return { timedOut: true, timeInPairing: timeInPairingSec };
    }

    return { timedOut: false, timeInPairing: timeInPairingSec };
  }

  // ============================================================
  // B) DYNAMIC HEDGE SLIPPAGE CAPS
  // ============================================================

  recordPrice(marketId: string, asset: string, midPrice: number): void {
    const ctx = this.getOrCreateContext(marketId, asset);
    const now = Date.now();
    
    // Add to history
    ctx.priceHistory.push({ ts: now, midPrice });
    
    // Prune old entries (keep only lookback window)
    const cutoff = now - (this.config.volatilityLookbackSeconds * 1000);
    ctx.priceHistory = ctx.priceHistory.filter(p => p.ts >= cutoff);
  }

  calculateDynamicHedgeCap(asset: string, ctx: MarketStateContext): {
    baseCap: number;
    dynamicCap: number;
    finalCap: number;
    recentVol: number | null;
  } {
    const caps = this.config.hedgeSlippageCaps[asset] || { base: 2.0, max: 4.0 };
    const baseCap = caps.base;
    const maxCap = caps.max;

    // Calculate recent volatility
    const recentVol = this.calculateRecentVolatility(ctx);

    if (recentVol === null) {
      // Fallback to base cap only
      return { baseCap, dynamicCap: baseCap, finalCap: baseCap, recentVol: null };
    }

    // Dynamic cap formula from spec
    const dynamicCap = baseCap + (recentVol * this.config.volatilityMultiplier * 100);
    const finalCap = Math.min(dynamicCap, maxCap);

    return { baseCap, dynamicCap, finalCap, recentVol };
  }

  private calculateRecentVolatility(ctx: MarketStateContext): number | null {
    const history = ctx.priceHistory;
    if (history.length < 2) return null;

    const latest = history[history.length - 1];
    const oldest = history[0];

    if (oldest.midPrice === 0) return null;

    const vol = Math.abs(latest.midPrice - oldest.midPrice) / oldest.midPrice;
    return vol;
  }

  isHedgePriceAllowed(
    asset: string,
    ctx: MarketStateContext,
    impliedPairCostCents: number
  ): { allowed: boolean; cap: ReturnType<typeof this.calculateDynamicHedgeCap> } {
    const cap = this.calculateDynamicHedgeCap(asset, ctx);
    
    // Rule: impliedPairCostCents <= (100 + finalCap)
    const threshold = 100 + cap.finalCap;
    const allowed = impliedPairCostCents <= threshold;

    // Log dynamic cap calculation
    if (this.config.logEvents) {
      this.logHedgePriceCapDynamic(ctx.marketId, asset, cap);
    }

    return { allowed, cap };
  }

  // ============================================================
  // C) BOUNDED HEDGE CHUNK SIZING
  // ============================================================

  calculateBoundedHedgeChunk(oneSidedShares: number): {
    rawChunk: number;
    boundedChunk: number;
  } {
    const rawChunk = oneSidedShares * this.config.minHedgeChunkPct;
    
    const boundedChunk = Math.max(
      this.config.minHedgeChunkAbs,
      Math.min(rawChunk, this.config.maxHedgeChunkAbs)
    );

    return { rawChunk, boundedChunk };
  }

  isHedgeSizeAllowed(intendedHedgeSize: number, oneSidedShares: number): boolean {
    const { boundedChunk } = this.calculateBoundedHedgeChunk(oneSidedShares);
    return intendedHedgeSize >= boundedChunk;
  }

  // ============================================================
  // D) LOGGING
  // ============================================================

  private logPairingStarted(
    ctx: MarketStateContext,
    bookData?: { bestAskUp: number | null; bestAskDown: number | null }
  ): void {
    if (!this.config.logEvents) return;

    const combinedAsk = (bookData?.bestAskUp && bookData?.bestAskDown)
      ? bookData.bestAskUp + bookData.bestAskDown
      : null;

    const impliedPairCostCents = combinedAsk !== null 
      ? Math.round(combinedAsk * 100) 
      : null;

    const event: PairingStartedEvent = {
      marketId: ctx.marketId,
      asset: ctx.asset,
      timestamp: Date.now(),
      upShares: ctx.upShares,
      downShares: ctx.downShares,
      bestAskUp: bookData?.bestAskUp ?? null,
      bestAskDown: bookData?.bestAskDown ?? null,
      combinedAsk,
      impliedPairCostCents,
      hedgeReason: ctx.pairingReason || 'PAIR_EDGE',
    };

    saveBotEvent({
      event_type: 'PAIRING_STARTED',
      asset: ctx.asset,
      market_id: ctx.marketId,
      ts: Date.now(),
      run_id: this.runId,
      data: event,
    }).catch(console.error);

    console.log(`[MarketState] PAIRING_STARTED: ${ctx.asset} up=${ctx.upShares} down=${ctx.downShares} reason=${event.hedgeReason}`);
  }

  private logPairingTimeoutRevert(
    ctx: MarketStateContext,
    timeInPairing: number,
    revertedTo: PairingState
  ): void {
    if (!this.config.logEvents) return;

    const event: PairingTimeoutRevertEvent = {
      marketId: ctx.marketId,
      asset: ctx.asset,
      timeInPairing,
      upShares: ctx.upShares,
      downShares: ctx.downShares,
      revertedTo,
    };

    saveBotEvent({
      event_type: 'PAIRING_TIMEOUT_REVERT',
      asset: ctx.asset,
      market_id: ctx.marketId,
      ts: Date.now(),
      run_id: this.runId,
      reason_code: 'TIMEOUT',
      data: event,
    }).catch(console.error);

    console.warn(`[MarketState] PAIRING_TIMEOUT_REVERT: ${ctx.asset} after ${timeInPairing.toFixed(1)}s → ${revertedTo}`);
  }

  private logHedgePriceCapDynamic(
    marketId: string,
    asset: string,
    cap: ReturnType<typeof this.calculateDynamicHedgeCap>
  ): void {
    const event: HedgePriceCapDynamicEvent = {
      marketId,
      asset,
      baseCap: cap.baseCap,
      dynamicCap: cap.dynamicCap,
      finalCap: cap.finalCap,
      recentVol: cap.recentVol,
    };

    saveBotEvent({
      event_type: 'HEDGE_PRICE_CAP_DYNAMIC',
      asset,
      market_id: marketId,
      ts: Date.now(),
      run_id: this.runId,
      data: event,
    }).catch(console.error);
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  getState(marketId: string, asset: string): PairingState {
    const key = `${marketId}:${asset}`;
    return this.contexts.get(key)?.state || 'FLAT';
  }

  getContext(marketId: string, asset: string): MarketStateContext | undefined {
    const key = `${marketId}:${asset}`;
    return this.contexts.get(key);
  }

  clearMarket(marketId: string, asset: string): void {
    const key = `${marketId}:${asset}`;
    this.contexts.delete(key);
  }

  // ============================================================
  // TICK PROCESSING (Main entry point per market tick)
  // ============================================================

  processTick(
    marketId: string,
    asset: string,
    upShares: number,
    downShares: number,
    secondsRemaining: number,
    midPrice: number,
    bookData?: { bestAskUp: number | null; bestAskDown: number | null }
  ): {
    state: PairingState;
    pairingTimedOut: boolean;
    timeInPairing: number;
    shouldCancelUnfilledHedges: boolean;
  } {
    const ctx = this.getOrCreateContext(marketId, asset);
    
    // Update inventory
    this.updateInventory(marketId, asset, upShares, downShares);
    
    // Record price for volatility tracking
    this.recordPrice(marketId, asset, midPrice);

    // Check PAIRING timeout first
    const timeoutResult = this.checkPairingTimeout(ctx);

    // Determine correct state based on inventory
    const newState = this.determineState(ctx, secondsRemaining);
    
    // Transition if needed (only if not timed out - timeout already handled transition)
    if (!timeoutResult.timedOut && newState !== ctx.state) {
      // If transitioning to PAIRING, track it
      const reason: HedgeReason | undefined = 
        (ctx.state.startsWith('ONE_SIDED') && newState === 'PAIRING')
          ? 'PAIR_EDGE'
          : undefined;
      
      this.transitionState(ctx, newState, reason, bookData);
    }

    return {
      state: ctx.state,
      pairingTimedOut: timeoutResult.timedOut,
      timeInPairing: timeoutResult.timeInPairing,
      shouldCancelUnfilledHedges: timeoutResult.timedOut,
    };
  }
}

// ============================================================
// EXPORT SINGLETON FACTORY
// ============================================================

let instance: MarketStateManager | null = null;

export function getMarketStateManager(runId: string): MarketStateManager {
  if (!instance) {
    instance = new MarketStateManager(runId);
  }
  return instance;
}

export function resetMarketStateManager(): void {
  instance = null;
}
