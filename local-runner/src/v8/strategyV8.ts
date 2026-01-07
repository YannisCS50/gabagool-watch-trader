/**
 * v8 Strategy - State Mispricing Strategy
 * 
 * Core strategy that trades on empirically calibrated fair price surface.
 * 
 * Flow:
 * 1. Learn fair UP prices from observed mid prices (EWMA)
 * 2. Detect mispricing: when askUp < fairUp (we can buy cheap)
 * 3. Enter on underpriced side
 * 4. Wait for market correction (repricing)
 * 5. Hedge opposite side AFTER correction
 * 
 * Key invariants:
 * - INV-2: NO-CROSSING (maker-first)
 * - INV-3: BOOK FRESHNESS
 * - INV-4: SINGLE OUTSTANDING ORDER per (market, token, intent)
 * - INV-5: HEDGE PRIORITY
 * - INV-6: FEE AWARENESS
 */

import { V8, getAssetBucketConfig } from './config.js';
import { bucketDeltaForAsset, bucketTimeStandard, formatTimeBucket, type TimeBucket } from './buckets.js';
import { getSurface, type FairCell } from './fairSurface.js';
import { validateMakerPrice, computeMakerBuyPrice, isBookFresh, isBookValid, getSpread, getMid, type BookTop, type ValidationResult } from './priceGuard.js';
import type { 
  ExecutionV8, 
  MarketSnapshotV8, 
  SpotTick, 
  TokenSide, 
  MarketStateV8, 
  Phase,
  StrategyStatsV8,
  KillSwitchState,
  FillEventV8,
  TokenBook,
} from './types.js';
import { getTelemetry, type TelemetryV8, type V8EvalEvent, type V8OrderEvent, type V8CorrectionEvent, type V8SkipEvent, type V8StateChangeEvent, type V8FillEvent } from './telemetryV8.js';

/**
 * Compute mid price from book
 */
function mid(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

/**
 * Convert TokenBook to BookTop for price guard
 */
function toBookTop(book: TokenBook): BookTop {
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    ageMs: book.ageMs,
  };
}

/**
 * v8 Strategy Implementation
 */
export class StrategyV8 {
  private exec: ExecutionV8;
  private tel: TelemetryV8;
  
  // Spot price cache
  private spot = new Map<string, { ts: number; price: number }>();
  
  // Market state
  private states = new Map<string, MarketStateV8>();
  
  // Kill switch state
  private killSwitch: KillSwitchState = {
    entriesDisabled: false,
    staleBookSkipCount: 0,
    totalEvalCount: 0,
    makerFillCount: 0,
    takerFillCount: 0,
    missingFeeCount: 0,
  };
  
  // Statistics
  private stats: StrategyStatsV8 = {
    totalEvals: 0,
    entriesAttempted: 0,
    entriesFilled: 0,
    hedgesAttempted: 0,
    hedgesFilled: 0,
    correctionsTriggered: 0,
    staleBookSkips: 0,
    makerFills: 0,
    takerFills: 0,
    surfaceUpdates: 0,
  };
  
  // Concurrent markets per asset tracking
  private activeMarketsByAsset = new Map<string, Set<string>>();
  
  constructor(exec: ExecutionV8, tel?: TelemetryV8) {
    this.exec = exec;
    this.tel = tel ?? getTelemetry();
    
    console.log('[V8] StrategyV8 initialized');
    console.log(`[V8] Enabled assets: ${V8.enabledAssets.join(', ')}`);
    console.log(`[V8] Entry edge: ${(V8.entry.edgeEntryMin * 100).toFixed(0)}¢`);
    console.log(`[V8] Correction threshold: ${(V8.correction.edgeCorrectedMax * 100).toFixed(0)}¢`);
  }
  
  /**
   * Handle spot price update
   */
  onSpot(tick: SpotTick): void {
    this.spot.set(tick.asset, { ts: tick.ts, price: tick.price });
  }
  
  /**
   * Main tick handler - evaluates market and makes decisions
   */
  async onTick(m: MarketSnapshotV8): Promise<void> {
    // Filter by enabled assets
    if (!V8.enabledAssets.includes(m.asset as any)) return;
    
    const ts = m.ts;
    const surface = getSurface();
    const reasons: string[] = [];
    
    this.stats.totalEvals++;
    this.killSwitch.totalEvalCount++;
    
    // Log every 10th eval for debugging (rate limited)
    const logKey = `v8_eval_${m.marketId}`;
    const lastLog = (global as any)[logKey] ?? 0;
    const shouldLog = ts - lastLog > 10_000; // Log every 10 seconds max
    if (shouldLog) {
      (global as any)[logKey] = ts;
    }
    
    // Get spot price
    const spotData = this.spot.get(m.asset);
    const spot = spotData?.price ?? NaN;
    if (!Number.isFinite(spot) || spot <= 0) {
      reasons.push('NO_SPOT');
      if (shouldLog) {
        console.log(`[V8] ${m.asset} NO_SPOT - waiting for Chainlink feed`);
      }
    }
    
    // Get time bucket
    const tBucket = bucketTimeStandard(m.secRemaining);
    if (!tBucket) {
      reasons.push('TIME_NOT_15M_BUCKET');
    }
    
    // Book sanity + freshness
    const up = m.up;
    const down = m.down;
    
    const upBookValid = isBookValid(toBookTop(up));
    const downBookValid = isBookValid(toBookTop(down));
    
    if (!upBookValid) reasons.push('UP_BOOK_INVALID');
    if (!downBookValid) reasons.push('DOWN_BOOK_INVALID');
    
    const upFresh = isBookFresh(toBookTop(up));
    const downFresh = isBookFresh(toBookTop(down));
    
    if (!upFresh || !downFresh) {
      reasons.push('STALE_BOOK');
      this.stats.staleBookSkips++;
      this.killSwitch.staleBookSkipCount++;
    }
    
    const spreadUp = getSpread(toBookTop(up));
    const spreadDown = getSpread(toBookTop(down));
    
    if (spreadUp > 0.50 || spreadDown > 0.50) {
      reasons.push('BOOK_BAD_SPREAD');
    }
    
    // Compute delta
    const deltaUsd = Number.isFinite(spot) ? (spot - m.strike) : 0;
    const absDeltaUsd = Math.abs(deltaUsd);
    
    // Update surface if book is valid (online learning)
    if (reasons.length === 0 && tBucket && upBookValid && downBookValid) {
      const deltaBucket = bucketDeltaForAsset(m.asset, absDeltaUsd);
      const midUp = mid(up.bestBid, up.bestAsk);
      
      if (midUp > 0 && midUp < 1) {
        surface.update(m.asset, deltaBucket, tBucket, midUp, ts);
        this.stats.surfaceUpdates++;
      }
    }
    
    // Compute fair prices and edges
    let chosen: TokenSide | 'NONE' = 'NONE';
    let fairUp: number | undefined;
    let fairN: number | undefined;
    let fairTrusted = false;
    let edgeUp: number | undefined;
    let edgeDown: number | undefined;
    let deltaBucketUsed = 0;
    let tBucketStr = formatTimeBucket(tBucket);
    
    if (tBucket && Number.isFinite(spot) && reasons.length === 0) {
      deltaBucketUsed = bucketDeltaForAsset(m.asset, absDeltaUsd);
      const cell = surface.get(m.asset, deltaBucketUsed, tBucket);
      
      fairUp = cell?.fairUp;
      fairN = cell?.n ?? 0;
      fairTrusted = surface.isTrusted(cell, ts);
      
      // Debug: Log surface status periodically
      if (shouldLog) {
        const totalCells = surface.getCellCount();
        console.log(`[V8] ${m.asset} surface: n=${fairN}/${V8.surface.minSamplesToTrade} trusted=${fairTrusted} cells=${totalCells}`);
        if (fairUp !== undefined) {
          console.log(`[V8] ${m.asset} fairUp=${(fairUp * 100).toFixed(1)}¢ askUp=${(up.bestAsk * 100).toFixed(1)}¢ edge=${((fairUp - up.bestAsk) * 100).toFixed(1)}¢`);
        }
      }
      
      if (fairTrusted && fairUp !== undefined) {
        const fairDown = 1 - fairUp;
        
        // Edge = fair - ask (how much cheaper than fair we can buy)
        edgeUp = fairUp - up.bestAsk;
        edgeDown = fairDown - down.bestAsk;
        
        // Directional preference based on delta sign
        if (deltaUsd >= 0) {
          // Spot > strike: UP more likely to win
          if (edgeUp >= V8.entry.edgeEntryMin) chosen = 'UP';
          // But if DOWN has stronger edge, consider it
          if (edgeDown >= V8.entry.edgeEntryMin && edgeDown > (edgeUp ?? -9)) {
            chosen = 'DOWN';
          }
        } else {
          // Spot < strike: DOWN more likely to win
          if (edgeDown >= V8.entry.edgeEntryMin) chosen = 'DOWN';
          // But if UP has stronger edge, consider it
          if (edgeUp >= V8.entry.edgeEntryMin && edgeUp > (edgeDown ?? -9)) {
            chosen = 'UP';
          }
        }
        
        // Debug: Log edge analysis when trusted
        if (shouldLog && (edgeUp !== undefined || edgeDown !== undefined)) {
          console.log(`[V8] ${m.asset} delta=$${deltaUsd.toFixed(2)} edgeUp=${((edgeUp ?? 0) * 100).toFixed(1)}¢ edgeDown=${((edgeDown ?? 0) * 100).toFixed(1)}¢ chosen=${chosen}`);
        }
      }
    }
    
    // Log evaluation
    const evalEvent: V8EvalEvent = {
      type: 'V8_EVAL',
      ts,
      marketId: m.marketId,
      asset: m.asset,
      secRemaining: m.secRemaining,
      strike: m.strike,
      spot,
      deltaUsd,
      absDeltaUsd,
      askUp: up.bestAsk,
      bidUp: up.bestBid,
      midUp: mid(up.bestBid, up.bestAsk),
      spreadUp,
      depthAskUp: up.depthAsk,
      depthBidUp: up.depthBid,
      ageUp: up.ageMs,
      askDown: down.bestAsk,
      bidDown: down.bestBid,
      midDown: mid(down.bestBid, down.bestAsk),
      spreadDown,
      depthAskDown: down.depthAsk,
      depthBidDown: down.depthBid,
      ageDown: down.ageMs,
      deltaBucket: deltaBucketUsed,
      tBucket: tBucketStr,
      fairUp,
      fairN,
      fairTrusted,
      edgeUp,
      edgeDown,
      chosen,
      reasons,
      upShares: m.position.upShares,
      downShares: m.position.downShares,
    };
    this.tel.emit(evalEvent);
    
    // Get or create market state
    let state = this.states.get(m.marketId);
    if (!state) {
      state = { phase: 'IDLE', createdTs: ts };
      this.states.set(m.marketId, state);
    }
    
    // INV-5: HEDGE PRIORITY - check hedge conditions first
    if (state.phase === 'HAS_ENTRY') {
      await this.checkCorrection(m, state, fairUp, fairTrusted);
      return; // Don't evaluate entry when in hedge mode
    }
    
    if (state.phase === 'HEDGE_IN_PROGRESS') {
      // Monitor hedge completion
      return;
    }
    
    // Entry evaluation
    if (state.phase === 'IDLE') {
      await this.evaluateEntry(m, chosen, fairTrusted, reasons);
    }
  }
  
  /**
   * Evaluate entry opportunity
   */
  private async evaluateEntry(
    m: MarketSnapshotV8,
    chosen: TokenSide | 'NONE',
    fairTrusted: boolean,
    reasons: string[]
  ): Promise<void> {
    const ts = m.ts;
    
    // Kill switch check
    if (this.killSwitch.entriesDisabled) {
      this.emitSkip(ts, m, 'ENTRY', undefined, 'KILL_SWITCH_ACTIVE', { reason: this.killSwitch.disabledReason });
      return;
    }
    
    // Time window gate
    if (m.secRemaining < V8.entry.minSecRemaining) {
      this.emitSkip(ts, m, 'ENTRY', undefined, 'TOO_LATE', { secRemaining: m.secRemaining });
      return;
    }
    if (m.secRemaining > V8.entry.maxSecRemaining) {
      this.emitSkip(ts, m, 'ENTRY', undefined, 'TOO_EARLY', { secRemaining: m.secRemaining });
      return;
    }
    
    // Fair surface must be trusted
    if (!fairTrusted) {
      this.emitSkip(ts, m, 'ENTRY', undefined, 'FAIR_NOT_TRUSTED');
      return;
    }
    
    // Must have chosen a side
    if (chosen === 'NONE') {
      this.emitSkip(ts, m, 'ENTRY', undefined, 'NO_EDGE', { reasons });
      return;
    }
    
    // No existing position
    if (m.position.upShares > 0 || m.position.downShares > 0) {
      this.emitSkip(ts, m, 'ENTRY', chosen, 'POSITION_EXISTS', { 
        upShares: m.position.upShares, 
        downShares: m.position.downShares 
      });
      return;
    }
    
    // Concurrent markets check
    const assetMarkets = this.activeMarketsByAsset.get(m.asset) ?? new Set();
    if (assetMarkets.size >= V8.entry.maxConcurrentMarketsPerAsset && !assetMarkets.has(m.marketId)) {
      this.emitSkip(ts, m, 'ENTRY', chosen, 'MAX_CONCURRENT_MARKETS', { 
        current: assetMarkets.size, 
        max: V8.entry.maxConcurrentMarketsPerAsset 
      });
      return;
    }
    
    // INV-4: Single outstanding order check
    const openOrders = this.exec.getOpenOrders(m.marketId, chosen, 'ENTRY');
    if (openOrders > 0) {
      this.emitSkip(ts, m, 'ENTRY', chosen, 'ORDER_IN_FLIGHT');
      return;
    }
    
    // Spread and depth checks
    const book = chosen === 'UP' ? m.up : m.down;
    const spread = book.bestAsk - book.bestBid;
    
    if (spread > V8.entry.maxSpread) {
      this.emitSkip(ts, m, 'ENTRY', chosen, 'SPREAD_TOO_WIDE', { spread, max: V8.entry.maxSpread });
      return;
    }
    
    if (book.depthAsk < V8.entry.minDepth || book.depthBid < V8.entry.minDepth) {
      this.emitSkip(ts, m, 'ENTRY', chosen, 'DEPTH_TOO_LOW', { 
        depthAsk: book.depthAsk, 
        depthBid: book.depthBid, 
        min: V8.entry.minDepth 
      });
      return;
    }
    
    // Compute maker price
    const raw = computeMakerBuyPrice(toBookTop(book));
    const validation = validateMakerPrice('BUY', raw, V8.execution.tick, toBookTop(book));
    
    // Log order attempt
    const orderEvent: V8OrderEvent = {
      type: 'V8_ORDER',
      ts,
      marketId: m.marketId,
      asset: m.asset,
      intent: 'ENTRY',
      token: chosen,
      side: 'BUY',
      size: V8.entry.baseShares,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      bookAgeMs: book.ageMs,
      rawPrice: raw,
      finalPrice: validation.ok ? validation.price : undefined,
      reject: validation.ok ? undefined : validation.reason,
    };
    this.tel.emit(orderEvent);
    
    // INV-2: NO-CROSSING check
    if (!validation.ok) {
      return;
    }
    
    // Place order
    this.stats.entriesAttempted++;
    const correlationId = `v8-entry-${m.marketId}-${Date.now()}`;
    
    const resp = await this.exec.placeLimit({
      marketId: m.marketId,
      token: chosen,
      side: 'BUY',
      price: validation.price,
      size: V8.entry.baseShares,
      intent: 'ENTRY',
      correlationId,
      eventStartTime: m.eventStartTime,
      eventEndTime: m.eventEndTime,
    });
    
    if (resp.ok) {
      // Update state
      const state = this.states.get(m.marketId)!;
      this.changePhase(m.marketId, m.asset, state, 'HAS_ENTRY', 'ENTRY_ORDER_PLACED');
      state.entryToken = chosen;
      
      // Track active markets
      if (!this.activeMarketsByAsset.has(m.asset)) {
        this.activeMarketsByAsset.set(m.asset, new Set());
      }
      this.activeMarketsByAsset.get(m.asset)!.add(m.marketId);
    }
  }
  
  /**
   * Check for correction and trigger hedge
   */
  private async checkCorrection(
    m: MarketSnapshotV8,
    state: MarketStateV8,
    fairUp: number | undefined,
    fairTrusted: boolean
  ): Promise<void> {
    const ts = m.ts;
    const entryToken = state.entryToken!;
    
    // Get current position
    const entryShares = entryToken === 'UP' ? m.position.upShares : m.position.downShares;
    
    // Not filled yet
    if (entryShares <= 0) {
      return;
    }
    
    // Get entry average
    const entryAvg = entryToken === 'UP' ? m.position.avgUp : m.position.avgDown;
    if (!Number.isFinite(entryAvg)) {
      return;
    }
    
    // Record first fill timestamp
    if (!state.entryFillTs) {
      state.entryFillTs = ts;
      state.entryAvg = entryAvg;
      state.entryShares = entryShares;
      this.stats.entriesFilled++;
    }
    
    const secSinceFill = (ts - state.entryFillTs) / 1000;
    
    // If fair surface not trusted, do nothing (safe)
    if (!fairTrusted || fairUp === undefined) {
      return;
    }
    
    // Compute current edge and unrealized
    const entryBook = entryToken === 'UP' ? m.up : m.down;
    const midEntry = mid(entryBook.bestBid, entryBook.bestAsk);
    const unrealized = (midEntry - entryAvg!) * entryShares;
    
    const fairDown = 1 - fairUp;
    const edgeEntryNow = entryToken === 'UP' 
      ? (fairUp - m.up.bestAsk) 
      : (fairDown - m.down.bestAsk);
    
    // Check correction conditions
    const minSecPassed = secSinceFill >= V8.correction.minSecondsAfterEntryFill;
    const edgeCorrected = edgeEntryNow <= V8.correction.edgeCorrectedMax;
    const profitTriggered = unrealized >= V8.correction.profitTriggerUsd;
    const beforeDeadline = m.secRemaining > V8.hedge.deadlineSecRemaining;
    
    if (minSecPassed && edgeCorrected && profitTriggered && beforeDeadline) {
      this.stats.correctionsTriggered++;
      
      // Log correction
      const corrEvent: V8CorrectionEvent = {
        type: 'V8_CORRECTION',
        ts,
        marketId: m.marketId,
        asset: m.asset,
        entryToken,
        secSinceEntryFill: secSinceFill,
        edgeNow: edgeEntryNow,
        unrealizedUsd: unrealized,
        midEntry,
        entryAvg: entryAvg!,
      };
      this.tel.emit(corrEvent);
      
      // Attempt hedge
      await this.attemptHedge(m, state, entryAvg!);
    }
  }
  
  /**
   * Attempt to hedge after correction
   */
  private async attemptHedge(
    m: MarketSnapshotV8,
    state: MarketStateV8,
    entryAvg: number
  ): Promise<void> {
    const ts = m.ts;
    const hedgeToken: TokenSide = state.entryToken === 'UP' ? 'DOWN' : 'UP';
    const hedgeBook = hedgeToken === 'UP' ? m.up : m.down;
    const entryShares = state.entryShares!;
    
    // INV-4: Single outstanding order check
    const openOrders = this.exec.getOpenOrders(m.marketId, hedgeToken, 'HEDGE');
    if (openOrders > 0) {
      this.emitSkip(ts, m, 'HEDGE', hedgeToken, 'ORDER_IN_FLIGHT');
      return;
    }
    
    // Hedge affordability checks
    if (hedgeBook.bestAsk > V8.hedge.maxOppAsk) {
      this.emitSkip(ts, m, 'HEDGE', hedgeToken, 'HEDGE_TOO_EXPENSIVE', { 
        ask: hedgeBook.bestAsk, 
        max: V8.hedge.maxOppAsk 
      });
      return;
    }
    
    const combined = entryAvg + hedgeBook.bestAsk;
    if (combined > V8.hedge.maxCppApprox) {
      this.emitSkip(ts, m, 'HEDGE', hedgeToken, 'CPP_TOO_HIGH', { 
        combined, 
        max: V8.hedge.maxCppApprox 
      });
      return;
    }
    
    // Compute hedge size
    const want = Math.min(entryShares * V8.hedge.hedgeRatio, V8.hedge.hedgeMaxShares);
    const hedgeSize = Math.max(V8.hedge.hedgeMinShares, Math.floor(want));
    
    // Compute maker price
    const raw = computeMakerBuyPrice(toBookTop(hedgeBook));
    const validation = validateMakerPrice('BUY', raw, V8.execution.tick, toBookTop(hedgeBook));
    
    // Log order attempt
    const orderEvent: V8OrderEvent = {
      type: 'V8_ORDER',
      ts,
      marketId: m.marketId,
      asset: m.asset,
      intent: 'HEDGE',
      token: hedgeToken,
      side: 'BUY',
      size: hedgeSize,
      bestBid: hedgeBook.bestBid,
      bestAsk: hedgeBook.bestAsk,
      bookAgeMs: hedgeBook.ageMs,
      rawPrice: raw,
      finalPrice: validation.ok ? validation.price : undefined,
      reject: validation.ok ? undefined : validation.reason,
    };
    this.tel.emit(orderEvent);
    
    // INV-2: NO-CROSSING check
    if (!validation.ok) {
      return;
    }
    
    // Place order
    this.stats.hedgesAttempted++;
    state.hedgeAttemptCount = (state.hedgeAttemptCount ?? 0) + 1;
    state.lastHedgeAttemptTs = ts;
    
    const correlationId = `v8-hedge-${m.marketId}-${Date.now()}`;
    
    const resp = await this.exec.placeLimit({
      marketId: m.marketId,
      token: hedgeToken,
      side: 'BUY',
      price: validation.price,
      size: hedgeSize,
      intent: 'HEDGE',
      correlationId,
      eventStartTime: m.eventStartTime,
      eventEndTime: m.eventEndTime,
    });
    
    if (resp.ok) {
      this.changePhase(m.marketId, m.asset, state, 'HEDGE_IN_PROGRESS', 'HEDGE_ORDER_PLACED');
      state.hedgeToken = hedgeToken;
    }
  }
  
  /**
   * Handle fill event
   */
  onFill(fill: FillEventV8): void {
    const state = this.states.get(fill.marketId);
    
    // INV-6: Fee awareness
    if (fill.feeUsd === undefined && V8.killSwitch.requireFeeUsd) {
      this.killSwitch.missingFeeCount++;
      if (!this.killSwitch.entriesDisabled) {
        this.triggerKillSwitch('MISSING_FEE_USD', { 
          orderId: fill.orderId, 
          marketId: fill.marketId 
        });
      }
    }
    
    // Track maker/taker ratio
    if (fill.liquidity === 'MAKER') {
      this.stats.makerFills++;
      this.killSwitch.makerFillCount++;
    } else if (fill.liquidity === 'TAKER') {
      this.stats.takerFills++;
      this.killSwitch.takerFillCount++;
    }
    
    // Check maker ratio kill switch
    this.checkMakerRatioKillSwitch();
    
    // Log fill
    const fillEvent: V8FillEvent = {
      type: 'V8_FILL',
      ts: fill.ts,
      marketId: fill.marketId,
      asset: fill.asset,
      intent: fill.intent,
      token: fill.token,
      price: fill.price,
      size: fill.size,
      feeUsd: fill.feeUsd,
      liquidity: fill.liquidity,
      secRemaining: fill.secRemaining,
      correlationId: fill.correlationId,
    };
    this.tel.emit(fillEvent);
    
    // Update state based on fill
    if (state) {
      if (fill.intent === 'HEDGE' && state.phase === 'HEDGE_IN_PROGRESS') {
        this.stats.hedgesFilled++;
        state.hedgeShares = (state.hedgeShares ?? 0) + fill.size;
        state.hedgeAvg = fill.price; // Simplified - could compute weighted avg
        
        // Transition to DONE
        this.changePhase(fill.marketId, fill.asset, state, 'DONE', 'HEDGE_FILLED');
      }
    }
  }
  
  /**
   * Change market phase with logging
   */
  private changePhase(marketId: string, asset: string, state: MarketStateV8, newPhase: Phase, reason: string): void {
    const oldPhase = state.phase;
    state.phase = newPhase;
    
    const event: V8StateChangeEvent = {
      type: 'V8_STATE_CHANGE',
      ts: Date.now(),
      marketId,
      asset,
      fromPhase: oldPhase,
      toPhase: newPhase,
      reason,
    };
    this.tel.emit(event);
  }
  
  /**
   * Emit skip event
   */
  private emitSkip(
    ts: number, 
    m: MarketSnapshotV8, 
    intent: 'ENTRY' | 'HEDGE', 
    token: TokenSide | undefined, 
    reason: string,
    details?: Record<string, unknown>
  ): void {
    const event: V8SkipEvent = {
      type: 'V8_SKIP',
      ts,
      marketId: m.marketId,
      asset: m.asset,
      intent,
      token,
      reason,
      details,
    };
    this.tel.emit(event);
  }
  
  /**
   * Trigger kill switch
   */
  private triggerKillSwitch(reason: string, details: Record<string, unknown>): void {
    this.killSwitch.entriesDisabled = true;
    this.killSwitch.disabledReason = reason;
    this.killSwitch.disabledTs = Date.now();
    
    this.tel.emit({
      type: 'V8_KILL_SWITCH',
      ts: Date.now(),
      reason,
      details,
    });
    
    console.log(`[V8] ⚠️ KILL SWITCH TRIGGERED: ${reason}`);
  }
  
  /**
   * Check maker ratio and trigger kill switch if below threshold
   */
  private checkMakerRatioKillSwitch(): void {
    const total = this.killSwitch.makerFillCount + this.killSwitch.takerFillCount;
    if (total < V8.killSwitch.makerRatioRollingWindow) return;
    
    const makerRatio = this.killSwitch.makerFillCount / total;
    if (makerRatio < V8.killSwitch.minMakerFillRatio && !this.killSwitch.entriesDisabled) {
      this.triggerKillSwitch('MAKER_RATIO_TOO_LOW', { 
        makerRatio, 
        min: V8.killSwitch.minMakerFillRatio,
        makerFills: this.killSwitch.makerFillCount,
        takerFills: this.killSwitch.takerFillCount,
      });
    }
  }
  
  /**
   * Clean up expired market state
   */
  cleanupMarket(marketId: string, asset: string): void {
    this.states.delete(marketId);
    
    const assetMarkets = this.activeMarketsByAsset.get(asset);
    if (assetMarkets) {
      assetMarkets.delete(marketId);
    }
  }
  
  /**
   * Get statistics
   */
  getStats(): StrategyStatsV8 {
    return { ...this.stats };
  }
  
  /**
   * Get kill switch state
   */
  getKillSwitchState(): KillSwitchState {
    return { ...this.killSwitch };
  }
  
  /**
   * Reset kill switch (for testing)
   */
  resetKillSwitch(): void {
    this.killSwitch = {
      entriesDisabled: false,
      staleBookSkipCount: 0,
      totalEvalCount: 0,
      makerFillCount: 0,
      takerFillCount: 0,
      missingFeeCount: 0,
    };
  }
}

// Singleton instance
let strategyInstance: StrategyV8 | null = null;

/**
 * Get the strategy instance
 */
export function getStrategy(): StrategyV8 | null {
  return strategyInstance;
}

/**
 * Initialize the strategy
 */
export function initStrategy(exec: ExecutionV8, tel?: TelemetryV8): StrategyV8 {
  strategyInstance = new StrategyV8(exec, tel);
  return strategyInstance;
}

/**
 * Reset strategy (for testing)
 */
export function resetStrategy(): void {
  strategyInstance = null;
}
