// ============================================================
// V27 SHADOW TRADING ENGINE
// ============================================================
//
// CRITICAL: This engine MUST run continuously and log EVERYTHING.
// Silence = failure. Every evaluation must produce a database row.
//
// This is NOT a paper trading bot - it's a data collection engine
// that simulates what a live bot WOULD do, without placing orders.
//
// ADAPTIVE CADENCE:
// - COLD: eval every 1000ms, full snapshot every 2s
// - WARM: eval every 500ms, full snapshot every 1s  
// - HOT: eval every 250ms, event-driven snapshots only
//
// NEAR/HOT detection (objective criteria):
// - near = mispricing >= 0.6*threshold OR stateScore >= P75 OR spotMoveAge<1s OR polyMoveAge<1s
// - hot = mispricing >= 0.85*threshold OR stateScore >= P90 OR spread changed>=1tick/1s
//
// HYSTERESIS:
// - WARM→COLD: near=false for 5s
// - HOT→WARM: hot=false for 3s
//
// ============================================================

import { getV27Config, getAssetConfig } from './config.js';
import { MispricingDetector } from './mispricing-detector.js';
import { AdverseSelectionFilter } from './adverse-selection-filter.js';
import { CadenceController, type CadenceMetrics, type CadenceState } from './cadence-controller.js';
import type { V27Market, V27OrderBook, V27SpotData } from './index.js';
import type { MispricingSignal } from './mispricing-detector.js';
import type { FilterResult } from './adverse-selection-filter.js';

// ============================================================
// TYPES
// ============================================================

export interface ShadowEvaluation {
  // Identifiers
  id: string;
  ts: number;
  iso: string;
  runId: string;
  
  // Market context
  marketId: string;
  marketSlug: string;
  asset: string;
  strikePrice: number;
  timeRemainingSeconds: number;
  
  // Spot data
  spotPrice: number;
  spotSource: string;
  spotTs: number;
  
  // Delta metrics
  deltaAbs: number;
  deltaPct: number;
  threshold: number;
  
  // Polymarket state
  upBid: number;
  upAsk: number;
  upMid: number;
  downBid: number;
  downAsk: number;
  downMid: number;
  spreadUp: number;
  spreadDown: number;
  upDepthBid: number;
  upDepthAsk: number;
  downDepthBid: number;
  downDepthAsk: number;
  
  // Expected fair price (theoretical)
  expectedUpPrice: number;
  expectedDownPrice: number;
  
  // Mispricing
  mispricingExists: boolean;
  mispricingSide: 'UP' | 'DOWN' | null;
  mispricingMagnitude: number; // How far from expected
  
  // Causality
  causalityPassed: boolean;
  spotLeadingMs: number;
  
  // Toxicity / Adverse Selection
  toxicityClass: 'CLEAN' | 'POSSIBLY_INFORMED' | 'TOXIC' | 'N/A';
  takerVolumeLast5s: number;
  takerVolumeP85: number;
  largeTakerFillsLast8s: number;
  bookImbalanceRatio: number;
  spreadExpansionRatio: number;
  filterPassed: boolean;
  filterFailedReason: string | null;
  
  // Decision
  signalType: 'NONE' | 'CANDIDATE' | 'ENTRY' | 'SKIP_TOXIC' | 'SKIP_FILTER' | 'SKIP_LOW_CONFIDENCE';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  
  // Hypothetical execution (if signal)
  hypoSide: 'UP' | 'DOWN' | null;
  hypoPrice: number | null; // best_ask - 1 tick
  hypoShares: number;
  hypoWouldCross: boolean;
  hypoMakerTaker: 'MAKER' | 'TAKER' | null;
  hypoEstimatedFillProb5s: number | null;
  hypoEstimatedFillProb10s: number | null;
  
  // Post-signal tracking reference (filled in later)
  trackingId: string | null;
  
  // Cadence state
  cadenceState: CadenceState;
  isNear: boolean;
  isHot: boolean;
  nearReasons: string[];
  hotReasons: string[];
  stateScore: number;
  
  // Logging type (for adaptive logging)
  logType: 'HEARTBEAT' | 'FULL_SNAPSHOT' | 'EVENT_DRIVEN';
}

export interface PostSignalTracking {
  id: string;
  evaluationId: string;
  marketId: string;
  asset: string;
  signalTs: number;
  signalIso: string;
  
  // Signal state at entry
  signalSide: 'UP' | 'DOWN';
  signalPrice: number; // What we would have paid
  signalSpotPrice: number;
  signalMispricing: number;
  
  // State after 5s
  upMid5s: number | null;
  downMid5s: number | null;
  spotPrice5s: number | null;
  mispricingResolved5s: boolean | null;
  priceImprovement5s: number | null;
  adverseSelection5s: boolean | null;
  
  // State after 10s
  upMid10s: number | null;
  downMid10s: number | null;
  spotPrice10s: number | null;
  mispricingResolved10s: boolean | null;
  priceImprovement10s: number | null;
  adverseSelection10s: boolean | null;
  
  // State after 15s
  upMid15s: number | null;
  downMid15s: number | null;
  spotPrice15s: number | null;
  mispricingResolved15s: boolean | null;
  priceImprovement15s: number | null;
  adverseSelection15s: boolean | null;
  
  // Hedge simulation (after mispricing resolves)
  hedgeSimulated: boolean;
  hedgeSide: 'UP' | 'DOWN' | null;
  hedgePrice: number | null;
  hedgeSpread: number | null;
  hedgeMakerTaker: 'MAKER' | 'TAKER' | null;
  simulatedCpp: number | null; // Combined pair price
  hedgeWouldExecute: boolean | null;
  
  // Final determination
  signalWasCorrect: boolean | null;
  wouldHaveProfited: boolean | null;
  
  // Tracking state
  completed: boolean;
}

// ============================================================
// SHADOW ENGINE
// ============================================================

export class ShadowEngine {
  private runId: string;
  private supabase: any;
  
  // Components
  private mispricingDetector: MispricingDetector;
  private adverseFilter: AdverseSelectionFilter;
  private cadenceController: CadenceController;
  
  // Active markets
  private activeMarkets: Map<string, V27Market> = new Map();
  
  // Price state
  private spotPrices: Map<string, { price: number; ts: number; source: string }> = new Map();
  
  // Post-signal tracking
  private activeTracking: Map<string, PostSignalTracking> = new Map();
  
  // Stats
  private stats = {
    totalEvaluations: 0,
    signalsDetected: 0,
    candidateSignals: 0,
    toxicSkips: 0,
    cleanSignals: 0,
    trackingsCompleted: 0,
    dbWriteErrors: 0,
    lastEvaluationTs: 0,
    heartbeatLogs: 0,
    fullSnapshots: 0,
    eventDrivenLogs: 0,
    coldEvals: 0,
    warmEvals: 0,
    hotEvals: 0,
  };
  
  constructor(runId: string, supabase: any) {
    this.runId = runId;
    this.supabase = supabase;
    this.mispricingDetector = new MispricingDetector();
    this.adverseFilter = new AdverseSelectionFilter();
    this.cadenceController = new CadenceController();
  }
  
  // ============================================================
  // MARKET MANAGEMENT
  // ============================================================
  
  registerMarket(market: V27Market): void {
    this.activeMarkets.set(market.id, market);
    this.cadenceController.registerMarket(market.id, market.asset);
    console.log(`[SHADOW] Registered: ${market.asset} ${market.slug}`);
  }
  
  unregisterMarket(marketId: string): void {
    this.activeMarkets.delete(marketId);
    this.cadenceController.unregisterMarket(marketId);
  }
  
  getActiveMarketCount(): number {
    return this.activeMarkets.size;
  }
  
  // ============================================================
  // PRICE FEEDS
  // ============================================================
  
  feedSpotPrice(asset: string, price: number, ts: number, source: string = 'binance'): void {
    this.spotPrices.set(asset, { price, ts, source });
    this.mispricingDetector.recordSpotMove(asset, price, ts);
    this.cadenceController.recordSpotMove(asset, price, ts);
  }
  
  feedOrderBook(marketId: string, book: V27OrderBook): void {
    const market = this.activeMarkets.get(marketId);
    if (!market) return;
    
    this.mispricingDetector.recordPolyMove(market.asset, book.upMid, book.downMid, book.timestamp);
    this.adverseFilter.recordSpread(market.asset, book);
    this.cadenceController.recordPolyMove(marketId, book.upMid, book.downMid, book.timestamp);
    this.cadenceController.recordSpread(marketId, book.spreadUp, book.spreadDown);
  }
  
  feedTakerFill(asset: string, size: number, side: 'UP' | 'DOWN', price: number): void {
    this.adverseFilter.recordTakerFill(asset, size, side, price);
  }
  
  getSpotPrice(asset: string): { price: number; ts: number; source: string } | null {
    return this.spotPrices.get(asset) || null;
  }
  
  // ============================================================
  // CORE EVALUATION LOOP WITH ADAPTIVE CADENCE
  // ============================================================
  
  /**
   * Check if market should be evaluated based on cadence state
   */
  shouldEvaluate(marketId: string): boolean {
    return this.cadenceController.shouldEvaluate(marketId);
  }
  
  /**
   * Get current cadence state for a market
   */
  getCadenceState(marketId: string): CadenceState {
    return this.cadenceController.getState(marketId);
  }
  
  /**
   * Evaluate a single market - called based on adaptive cadence
   * Returns the evaluation for immediate display/logging
   */
  async evaluate(marketId: string, book: V27OrderBook): Promise<ShadowEvaluation | null> {
    const market = this.activeMarkets.get(marketId);
    if (!market) return null;
    
    const config = getV27Config();
    const assetConfig = getAssetConfig(market.asset);
    if (!assetConfig) return null;
    
    // Get spot price
    const spotData = this.spotPrices.get(market.asset);
    if (!spotData) {
      // Still log that we couldn't evaluate due to no spot
      console.log(`[SHADOW] ${market.asset} ${market.slug}: No spot price`);
      return null;
    }
    
    const now = Date.now();
    const timeRemainingSeconds = (market.eventEndTime.getTime() - now) / 1000;
    
    if (timeRemainingSeconds <= 0) {
      this.unregisterMarket(marketId);
      return null;
    }
    
    // Create evaluation ID
    const evalId = `shadow_${now}_${Math.random().toString(36).slice(2, 8)}`;
    
    // 1. DETECT MISPRICING
    const spot: V27SpotData = {
      price: spotData.price,
      timestamp: spotData.ts,
      source: spotData.source,
    };
    
    const mispricing = this.mispricingDetector.detect(
      market.asset,
      market.strikePrice,
      spot,
      book,
      timeRemainingSeconds
    );
    
    // 2. RUN TOXICITY FILTER (only if mispricing exists)
    let filter: FilterResult;
    let toxicityClass: 'CLEAN' | 'POSSIBLY_INFORMED' | 'TOXIC' | 'N/A' = 'N/A';
    
    if (mispricing.exists && mispricing.side) {
      filter = this.adverseFilter.evaluate(market.asset, book, mispricing.side);
      
      // Classify toxicity
      if (!filter.pass) {
        if (filter.failedFilter === 'AGGRESSIVE_FLOW') {
          toxicityClass = 'TOXIC';
        } else {
          toxicityClass = 'POSSIBLY_INFORMED';
        }
      } else {
        toxicityClass = 'CLEAN';
      }
    } else {
      filter = {
        pass: false,
        failedFilter: 'NO_MISPRICING',
        details: {
          aggressiveFlow: { pass: true, largeTakerFillsLast8s: 0, takerVolumeLast5s: 0, p90Threshold: 50, p85VolumeThreshold: 100 },
          bookShape: { pass: true, mispricedSideDepth: 0, oppositeSideDepth: 0, asymmetryRatio: 1 },
          spreadExpansion: { pass: true, currentSpread: 0, medianSpread: 0, expansionRatio: 1 },
        },
      };
    }
    
    // 3. DETERMINE SIGNAL TYPE
    let signalType: ShadowEvaluation['signalType'] = 'NONE';
    let hypoSide: 'UP' | 'DOWN' | null = null;
    let hypoPrice: number | null = null;
    let hypoWouldCross = false;
    let hypoMakerTaker: 'MAKER' | 'TAKER' | null = null;
    let hypoEstimatedFillProb5s: number | null = null;
    let hypoEstimatedFillProb10s: number | null = null;
    let trackingId: string | null = null;
    
    if (mispricing.exists && mispricing.side) {
      this.stats.signalsDetected++;
      
      if (mispricing.confidence === 'LOW') {
        signalType = 'SKIP_LOW_CONFIDENCE';
      } else if (!filter.pass) {
        if (toxicityClass === 'TOXIC') {
          signalType = 'SKIP_TOXIC';
          this.stats.toxicSkips++;
        } else {
          signalType = 'SKIP_FILTER';
        }
        // Still simulate execution for analysis
        signalType = filter.failedFilter === 'AGGRESSIVE_FLOW' ? 'SKIP_TOXIC' : 'SKIP_FILTER';
      } else {
        signalType = 'ENTRY';
        this.stats.cleanSignals++;
      }
      
      // Always simulate hypothetical execution for analysis
      this.stats.candidateSignals++;
      hypoSide = mispricing.side;
      
      // Hypothetical price: best_ask - 1 tick for passive limit
      const bestAsk = hypoSide === 'UP' ? book.upAsk : book.downAsk;
      const bestBid = hypoSide === 'UP' ? book.upBid : book.downBid;
      hypoPrice = Math.max(bestAsk - 0.01, bestBid + 0.01);
      
      // Would this cross?
      hypoWouldCross = hypoPrice >= bestAsk;
      hypoMakerTaker = hypoWouldCross ? 'TAKER' : 'MAKER';
      
      // Estimate fill probability based on spread and depth
      const spread = bestAsk - bestBid;
      const depth = hypoSide === 'UP' ? book.upDepthAsk : book.downDepthAsk;
      
      // Simple heuristic: tighter spread + more depth = higher fill prob
      hypoEstimatedFillProb5s = Math.min(0.9, Math.max(0.1, 
        0.5 - (spread * 5) + (Math.min(depth, 100) / 200)
      ));
      hypoEstimatedFillProb10s = Math.min(0.95, hypoEstimatedFillProb5s + 0.15);
      
      // Start post-signal tracking for ENTRY and CANDIDATE signals
      if (signalType === 'ENTRY' || toxicityClass !== 'TOXIC') {
        trackingId = this.startPostSignalTracking(
          evalId,
          market,
          hypoSide,
          hypoPrice,
          spotData.price,
          mispricing.priceLag
        );
      }
    }
    
    // 4. COMPUTE STATE SCORE (composite signal strength)
    // Higher score = closer to entry signal
    const stateScore = this.computeStateScore(mispricing, filter, book);
    
    // 5. BUILD CADENCE METRICS AND UPDATE CADENCE STATE
    const cadenceMetrics = this.cadenceController.buildMetrics(
      marketId,
      market.asset,
      Math.abs(mispricing.priceLag), // mispricing magnitude
      mispricing.threshold,
      stateScore,
      book.spreadUp,
      book.spreadDown
    );
    
    const cadenceState = this.cadenceController.updateState(marketId, market.asset, cadenceMetrics);
    const cadenceEval = this.cadenceController.evaluateCadence(marketId, market.asset, cadenceMetrics);
    
    // Mark that we evaluated
    this.cadenceController.markEvaluated(marketId);
    
    // Update cadence stats
    switch (cadenceState) {
      case 'COLD': this.stats.coldEvals++; break;
      case 'WARM': this.stats.warmEvals++; break;
      case 'HOT': this.stats.hotEvals++; break;
    }
    
    // 6. DETERMINE LOG TYPE
    // - HEARTBEAT: light log each eval
    // - FULL_SNAPSHOT: detailed log on schedule (2s COLD, 1s WARM)
    // - EVENT_DRIVEN: in HOT mode, only on signal events
    let logType: ShadowEvaluation['logType'] = 'HEARTBEAT';
    
    if (signalType !== 'NONE') {
      // Any signal = event-driven log
      logType = 'EVENT_DRIVEN';
      this.stats.eventDrivenLogs++;
    } else if (this.cadenceController.shouldLogFullSnapshot(marketId)) {
      // Time for a full snapshot
      logType = 'FULL_SNAPSHOT';
      this.cadenceController.markFullSnapshot(marketId);
      this.stats.fullSnapshots++;
    } else {
      this.stats.heartbeatLogs++;
    }
    
    // 7. BUILD EVALUATION RECORD
    const evaluation: ShadowEvaluation = {
      id: evalId,
      ts: now,
      iso: new Date(now).toISOString(),
      runId: this.runId,
      
      marketId: market.id,
      marketSlug: market.slug,
      asset: market.asset,
      strikePrice: market.strikePrice,
      timeRemainingSeconds,
      
      spotPrice: spotData.price,
      spotSource: spotData.source,
      spotTs: spotData.ts,
      
      deltaAbs: mispricing.deltaAbs,
      deltaPct: mispricing.deltaPct,
      threshold: mispricing.threshold,
      
      upBid: book.upBid,
      upAsk: book.upAsk,
      upMid: book.upMid,
      downBid: book.downBid,
      downAsk: book.downAsk,
      downMid: book.downMid,
      spreadUp: book.spreadUp,
      spreadDown: book.spreadDown,
      upDepthBid: book.upDepthBid,
      upDepthAsk: book.upDepthAsk,
      downDepthBid: book.downDepthBid,
      downDepthAsk: book.downDepthAsk,
      
      expectedUpPrice: mispricing.expectedPolyPrice,
      expectedDownPrice: 1 - mispricing.expectedPolyPrice,
      
      mispricingExists: mispricing.exists,
      mispricingSide: mispricing.side,
      mispricingMagnitude: Math.abs(mispricing.priceLag),
      
      causalityPassed: mispricing.causalityPass,
      spotLeadingMs: mispricing.spotLeadMs,
      
      toxicityClass,
      takerVolumeLast5s: filter.details.aggressiveFlow.takerVolumeLast5s,
      takerVolumeP85: filter.details.aggressiveFlow.p85VolumeThreshold,
      largeTakerFillsLast8s: filter.details.aggressiveFlow.largeTakerFillsLast8s,
      bookImbalanceRatio: filter.details.bookShape.asymmetryRatio,
      spreadExpansionRatio: filter.details.spreadExpansion.expansionRatio,
      filterPassed: filter.pass,
      filterFailedReason: filter.failedFilter || null,
      
      signalType,
      confidence: mispricing.confidence,
      
      hypoSide,
      hypoPrice,
      hypoShares: assetConfig.probeShares,
      hypoWouldCross,
      hypoMakerTaker,
      hypoEstimatedFillProb5s,
      hypoEstimatedFillProb10s,
      
      trackingId,
      
      // Cadence fields
      cadenceState,
      isNear: cadenceEval.isNear,
      isHot: cadenceEval.isHot,
      nearReasons: cadenceEval.nearReasons,
      hotReasons: cadenceEval.hotReasons,
      stateScore,
      logType,
    };
    
    // 8. PERSIST TO DATABASE
    // Persist FULL_SNAPSHOT, EVENT_DRIVEN, and also every 10th HEARTBEAT for visibility
    const shouldPersist = logType === 'FULL_SNAPSHOT' || 
                          logType === 'EVENT_DRIVEN' || 
                          (this.stats.totalEvaluations % 10 === 0);
    if (shouldPersist) {
      await this.persistEvaluation(evaluation);
    }
    
    // 9. UPDATE STATS
    this.stats.totalEvaluations++;
    this.stats.lastEvaluationTs = now;
    
    // 10. CONSOLE LOG (adaptive based on log type)
    this.logEvaluation(evaluation);
    
    return evaluation;
  }
  
  /**
   * Compute a state score (0-1) representing proximity to entry signal
   */
  private computeStateScore(
    mispricing: MispricingSignal,
    filter: FilterResult,
    book: V27OrderBook
  ): number {
    let score = 0;
    
    // Mispricing contribution (0-0.4)
    if (mispricing.exists) {
      const mispricingRatio = Math.min(Math.abs(mispricing.priceLag) / mispricing.threshold, 2);
      score += 0.4 * Math.min(mispricingRatio, 1);
    }
    
    // Causality contribution (0-0.2)
    if (mispricing.causalityPass) {
      score += 0.2;
    } else if (mispricing.spotLeadMs > 0) {
      score += 0.1; // Partial credit if spot is leading
    }
    
    // Filter contribution (0-0.2)
    if (filter.pass) {
      score += 0.2;
    } else if (filter.failedFilter !== 'AGGRESSIVE_FLOW') {
      score += 0.1; // Partial credit if not toxic
    }
    
    // Book quality contribution (0-0.2)
    const avgSpread = (book.spreadUp + book.spreadDown) / 2;
    if (avgSpread < 0.02) {
      score += 0.2;
    } else if (avgSpread < 0.04) {
      score += 0.1;
    }
    
    return Math.min(score, 1);
  }
  
  // ============================================================
  // POST-SIGNAL TRACKING
  // ============================================================
  
  private startPostSignalTracking(
    evaluationId: string,
    market: V27Market,
    side: 'UP' | 'DOWN',
    price: number,
    spotPrice: number,
    mispricing: number
  ): string {
    const trackingId = `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const tracking: PostSignalTracking = {
      id: trackingId,
      evaluationId,
      marketId: market.id,
      asset: market.asset,
      signalTs: Date.now(),
      signalIso: new Date().toISOString(),
      
      signalSide: side,
      signalPrice: price,
      signalSpotPrice: spotPrice,
      signalMispricing: mispricing,
      
      upMid5s: null,
      downMid5s: null,
      spotPrice5s: null,
      mispricingResolved5s: null,
      priceImprovement5s: null,
      adverseSelection5s: null,
      
      upMid10s: null,
      downMid10s: null,
      spotPrice10s: null,
      mispricingResolved10s: null,
      priceImprovement10s: null,
      adverseSelection10s: null,
      
      upMid15s: null,
      downMid15s: null,
      spotPrice15s: null,
      mispricingResolved15s: null,
      priceImprovement15s: null,
      adverseSelection15s: null,
      
      hedgeSimulated: false,
      hedgeSide: null,
      hedgePrice: null,
      hedgeSpread: null,
      hedgeMakerTaker: null,
      simulatedCpp: null,
      hedgeWouldExecute: null,
      
      signalWasCorrect: null,
      wouldHaveProfited: null,
      
      completed: false,
    };
    
    this.activeTracking.set(trackingId, tracking);
    
    // Schedule tracking updates
    setTimeout(() => this.updateTracking(trackingId, 5), 5000);
    setTimeout(() => this.updateTracking(trackingId, 10), 10000);
    setTimeout(() => this.updateTracking(trackingId, 15), 15000);
    
    return trackingId;
  }
  
  /**
   * Update tracking at 5s, 10s, or 15s mark
   */
  private async updateTracking(trackingId: string, seconds: 5 | 10 | 15): Promise<void> {
    const tracking = this.activeTracking.get(trackingId);
    if (!tracking) return;
    
    const market = this.activeMarkets.get(tracking.marketId);
    const spotData = this.spotPrices.get(tracking.asset);
    
    // We need current orderbook - this will be fed from the main loop
    // For now, use a placeholder approach where we check if data is available
    
    // Get current spot
    const currentSpot = spotData?.price ?? null;
    
    // We'll update with available data - the main loop should call feedOrderBook
    // which we can use to get current prices
    
    if (seconds === 5) {
      tracking.spotPrice5s = currentSpot;
      // Price improvement = positive if our side moved up (for UP signal) or down (for DOWN signal)
      if (currentSpot !== null) {
        // Check if mispricing resolved (spot moved toward or past strike)
        const signalDelta = tracking.signalSpotPrice - (market?.strikePrice ?? 0);
        const currentDelta = currentSpot - (market?.strikePrice ?? 0);
        // Mispricing resolved if delta decreased
        tracking.mispricingResolved5s = Math.abs(currentDelta) < Math.abs(signalDelta);
        
        // Adverse selection = price moved against us immediately
        if (tracking.signalSide === 'UP') {
          tracking.adverseSelection5s = currentSpot < tracking.signalSpotPrice;
        } else {
          tracking.adverseSelection5s = currentSpot > tracking.signalSpotPrice;
        }
      }
    } else if (seconds === 10) {
      tracking.spotPrice10s = currentSpot;
      if (currentSpot !== null) {
        const signalDelta = tracking.signalSpotPrice - (market?.strikePrice ?? 0);
        const currentDelta = currentSpot - (market?.strikePrice ?? 0);
        tracking.mispricingResolved10s = Math.abs(currentDelta) < Math.abs(signalDelta);
        
        if (tracking.signalSide === 'UP') {
          tracking.adverseSelection10s = currentSpot < tracking.signalSpotPrice;
        } else {
          tracking.adverseSelection10s = currentSpot > tracking.signalSpotPrice;
        }
      }
    } else if (seconds === 15) {
      tracking.spotPrice15s = currentSpot;
      if (currentSpot !== null) {
        const signalDelta = tracking.signalSpotPrice - (market?.strikePrice ?? 0);
        const currentDelta = currentSpot - (market?.strikePrice ?? 0);
        tracking.mispricingResolved15s = Math.abs(currentDelta) < Math.abs(signalDelta);
        
        if (tracking.signalSide === 'UP') {
          tracking.adverseSelection15s = currentSpot < tracking.signalSpotPrice;
        } else {
          tracking.adverseSelection15s = currentSpot > tracking.signalSpotPrice;
        }
      }
      
      // Final determination
      tracking.completed = true;
      tracking.signalWasCorrect = tracking.mispricingResolved15s === true;
      
      // Would have profited if signal was correct and no severe adverse selection
      tracking.wouldHaveProfited = tracking.signalWasCorrect && 
        !(tracking.adverseSelection5s === true && tracking.adverseSelection10s === true);
      
      // Persist completed tracking
      await this.persistTracking(tracking);
      this.stats.trackingsCompleted++;
      
      // Clean up
      this.activeTracking.delete(trackingId);
      
      console.log(`[SHADOW] Tracking complete: ${tracking.asset} ${tracking.signalSide} | ` +
        `Resolved: ${tracking.mispricingResolved15s} | Adverse: ${tracking.adverseSelection5s} | ` +
        `Correct: ${tracking.signalWasCorrect}`);
    }
  }
  
  /**
   * Update tracking with current orderbook data
   * Call this from the main loop when orderbook is received
   */
  updateTrackingWithOrderbook(marketId: string, book: V27OrderBook): void {
    for (const tracking of this.activeTracking.values()) {
      if (tracking.marketId !== marketId) continue;
      
      const elapsed = Date.now() - tracking.signalTs;
      
      if (elapsed >= 5000 && elapsed < 6000 && tracking.upMid5s === null) {
        tracking.upMid5s = book.upMid;
        tracking.downMid5s = book.downMid;
        
        // Calculate price improvement
        const signalMid = tracking.signalSide === 'UP' ? book.upMid : book.downMid;
        tracking.priceImprovement5s = signalMid - tracking.signalPrice;
      }
      
      if (elapsed >= 10000 && elapsed < 11000 && tracking.upMid10s === null) {
        tracking.upMid10s = book.upMid;
        tracking.downMid10s = book.downMid;
        
        const signalMid = tracking.signalSide === 'UP' ? book.upMid : book.downMid;
        tracking.priceImprovement10s = signalMid - tracking.signalPrice;
        
        // Simulate hedge if mispricing resolved
        if (tracking.mispricingResolved10s) {
          this.simulateHedge(tracking, book);
        }
      }
      
      if (elapsed >= 15000 && elapsed < 16000 && tracking.upMid15s === null) {
        tracking.upMid15s = book.upMid;
        tracking.downMid15s = book.downMid;
        
        const signalMid = tracking.signalSide === 'UP' ? book.upMid : book.downMid;
        tracking.priceImprovement15s = signalMid - tracking.signalPrice;
      }
    }
  }
  
  private simulateHedge(tracking: PostSignalTracking, book: V27OrderBook): void {
    tracking.hedgeSimulated = true;
    tracking.hedgeSide = tracking.signalSide === 'UP' ? 'DOWN' : 'UP';
    
    // Hedge would be on opposite side
    const hedgeAsk = tracking.hedgeSide === 'UP' ? book.upAsk : book.downAsk;
    const hedgeBid = tracking.hedgeSide === 'UP' ? book.upBid : book.downBid;
    tracking.hedgeSpread = hedgeAsk - hedgeBid;
    
    // Would use passive limit: bid + 1 tick
    tracking.hedgePrice = hedgeBid + 0.01;
    tracking.hedgeMakerTaker = tracking.hedgePrice >= hedgeAsk ? 'TAKER' : 'MAKER';
    
    // Calculate simulated CPP (combined pair price)
    const entryCost = tracking.signalPrice;
    const hedgeCost = tracking.hedgePrice;
    tracking.simulatedCpp = entryCost + hedgeCost;
    
    // Would hedge if CPP < 1.00 (guaranteed profit)
    tracking.hedgeWouldExecute = tracking.simulatedCpp < 1.00;
    
    console.log(`[SHADOW] Hedge sim: ${tracking.asset} | CPP=${tracking.simulatedCpp.toFixed(3)} | ` +
      `Execute: ${tracking.hedgeWouldExecute}`);
  }
  
  // ============================================================
  // DATABASE PERSISTENCE
  // ============================================================
  
  private async persistEvaluation(eval_: ShadowEvaluation): Promise<void> {
    if (!this.supabase) {
      console.warn('[SHADOW] ⚠️ No Supabase client - evaluation not persisted. Check SUPABASE_URL and SUPABASE_ANON_KEY env vars.');
      this.stats.dbWriteErrors++;
      return;
    }
    
    try {
      const insertData = {
        ts: eval_.ts,
        asset: eval_.asset,
        market_id: eval_.marketId,
        spot_price: eval_.spotPrice,
        spot_source: eval_.spotSource,
        pm_up_bid: eval_.upBid,
        pm_up_ask: eval_.upAsk,
        pm_down_bid: eval_.downBid,
        pm_down_ask: eval_.downAsk,
        theoretical_up: eval_.expectedUpPrice,
        theoretical_down: eval_.expectedDownPrice,
        delta_up: eval_.mispricingSide === 'UP' ? eval_.mispricingMagnitude : 0,
        delta_down: eval_.mispricingSide === 'DOWN' ? eval_.mispricingMagnitude : 0,
        mispricing_side: eval_.mispricingSide,
        mispricing_magnitude: eval_.deltaAbs,
        base_threshold: eval_.threshold,
        dynamic_threshold: eval_.threshold,
        threshold_source: 'config',
        taker_flow_p90: eval_.takerVolumeP85,
        book_imbalance: eval_.bookImbalanceRatio,
        spread_expansion: eval_.spreadExpansionRatio,
        adverse_blocked: !eval_.filterPassed,
        adverse_reason: eval_.filterFailedReason,
        causality_passed: eval_.causalityPassed,
        spot_leading_ms: eval_.spotLeadingMs,
        signal_valid: eval_.signalType === 'ENTRY',
        action: eval_.signalType,
        skip_reason: eval_.signalType === 'NONE' ? 'NO_MISPRICING' : 
                     eval_.signalType.startsWith('SKIP') ? eval_.filterFailedReason : null,
      };
      
      const { error } = await this.supabase.from('v27_evaluations').insert(insertData);
      
      if (error) {
        console.error('[SHADOW] DB insert error:', error.message);
        this.stats.dbWriteErrors++;
      }
    } catch (err) {
      console.error('[SHADOW] Failed to persist evaluation:', err);
      this.stats.dbWriteErrors++;
    }
  }
  
  private async persistTracking(tracking: PostSignalTracking): Promise<void> {
    if (!this.supabase) return;
    
    try {
      // Store in v27_signal_tracking table (we may need to create this)
      const insertData = {
        id: tracking.id,
        evaluation_id: tracking.evaluationId,
        market_id: tracking.marketId,
        asset: tracking.asset,
        signal_ts: tracking.signalTs,
        signal_side: tracking.signalSide,
        signal_price: tracking.signalPrice,
        signal_spot_price: tracking.signalSpotPrice,
        signal_mispricing: tracking.signalMispricing,
        spot_price_5s: tracking.spotPrice5s,
        spot_price_10s: tracking.spotPrice10s,
        spot_price_15s: tracking.spotPrice15s,
        mispricing_resolved_5s: tracking.mispricingResolved5s,
        mispricing_resolved_10s: tracking.mispricingResolved10s,
        mispricing_resolved_15s: tracking.mispricingResolved15s,
        adverse_selection_5s: tracking.adverseSelection5s,
        adverse_selection_10s: tracking.adverseSelection10s,
        adverse_selection_15s: tracking.adverseSelection15s,
        hedge_simulated: tracking.hedgeSimulated,
        hedge_side: tracking.hedgeSide,
        hedge_price: tracking.hedgePrice,
        hedge_spread: tracking.hedgeSpread,
        simulated_cpp: tracking.simulatedCpp,
        hedge_would_execute: tracking.hedgeWouldExecute,
        signal_was_correct: tracking.signalWasCorrect,
        would_have_profited: tracking.wouldHaveProfited,
      };
      
      // Try to insert - table may not exist yet
      const { error } = await this.supabase.from('v27_signal_tracking').insert(insertData);
      
      if (error && !error.message.includes('does not exist')) {
        console.error('[SHADOW] Tracking persist error:', error.message);
      }
    } catch (err) {
      // Non-critical - tracking table may not exist
    }
  }
  
  // ============================================================
  // LOGGING (ADAPTIVE BASED ON CADENCE)
  // ============================================================
  
  private logEvaluation(eval_: ShadowEvaluation): void {
    const emoji = this.getSignalEmoji(eval_.signalType);
    const cadenceEmoji = this.getCadenceEmoji(eval_.cadenceState);
    
    const deltaStr = eval_.deltaAbs.toFixed(2);
    const spotStr = eval_.spotPrice.toFixed(2);
    const timeStr = Math.floor(eval_.timeRemainingSeconds).toString() + 's';
    const scoreStr = eval_.stateScore.toFixed(2);
    
    // Always log ENTRY/SIGNAL or EVENT_DRIVEN
    if (eval_.logType === 'EVENT_DRIVEN') {
      const toxEmoji = this.getToxicityEmoji(eval_.toxicityClass);
      const priceStr = eval_.hypoPrice?.toFixed(3) ?? '-';
      console.log(
        `[SHADOW] ${emoji} ${cadenceEmoji} ${eval_.asset} ${eval_.marketSlug.slice(0, 25)} | ` +
        `spot=${spotStr} Δ=${deltaStr} ${toxEmoji}${eval_.toxicityClass} | ` +
        `${eval_.signalType} ${eval_.hypoSide} @ ${priceStr} | ` +
        `score=${scoreStr} time=${timeStr}`
      );
      
      // Log cadence reasons if near/hot
      if (eval_.isHot && eval_.hotReasons.length > 0) {
        console.log(`   🔥 HOT: ${eval_.hotReasons.slice(0, 2).join(', ')}`);
      } else if (eval_.isNear && eval_.nearReasons.length > 0) {
        console.log(`   📍 NEAR: ${eval_.nearReasons.slice(0, 2).join(', ')}`);
      }
      return;
    }
    
    // FULL_SNAPSHOT: detailed log
    if (eval_.logType === 'FULL_SNAPSHOT') {
      console.log(
        `[SHADOW] ${emoji} ${cadenceEmoji} ${eval_.asset} ${eval_.marketSlug.slice(0, 25)} | ` +
        `spot=${spotStr} strike=${eval_.strikePrice} Δ=${deltaStr} | ` +
        `score=${scoreStr} | ${eval_.cadenceState} | time=${timeStr}`
      );
      return;
    }
    
    // HEARTBEAT: very light log (only in debug or every N)
    // In HOT mode, we skip heartbeat logging entirely (only event-driven)
    if (eval_.cadenceState !== 'HOT') {
      // Light heartbeat - only log occasionally or skip entirely for efficiency
      // For now, let's skip heartbeat console logs to reduce noise
      // The evaluation is still processed, just not console logged
    }
  }
  
  private getSignalEmoji(signalType: ShadowEvaluation['signalType']): string {
    switch (signalType) {
      case 'ENTRY': return '🎯';
      case 'CANDIDATE': return '🔍';
      case 'SKIP_TOXIC': return '☠️';
      case 'SKIP_FILTER': return '⚠️';
      case 'SKIP_LOW_CONFIDENCE': return '🤔';
      case 'NONE': return '⏸️';
      default: return '❓';
    }
  }
  
  private getToxicityEmoji(toxicity: ShadowEvaluation['toxicityClass']): string {
    switch (toxicity) {
      case 'CLEAN': return '✅';
      case 'POSSIBLY_INFORMED': return '⚡';
      case 'TOXIC': return '☠️';
      case 'N/A': return '';
      default: return '';
    }
  }
  
  private getCadenceEmoji(state: CadenceState): string {
    switch (state) {
      case 'COLD': return '🧊';
      case 'WARM': return '🌡️';
      case 'HOT': return '🔥';
      default: return '';
    }
  }
  
  // ============================================================
  // STATS
  // ============================================================
  
  getStats() {
    const cadenceStats = this.cadenceController.getStats();
    return {
      ...this.stats,
      activeTrackings: this.activeTracking.size,
      activeMarkets: this.activeMarkets.size,
      ...cadenceStats,
    };
  }
  
  getCadenceStats() {
    return this.cadenceController.getStats();
  }
  
  printStats(): void {
    const s = this.stats;
    const c = this.cadenceController.getStats();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  📊 V27 SHADOW ENGINE STATS (ADAPTIVE CADENCE)                ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Total Evaluations:    ${s.totalEvaluations.toString().padEnd(40)}║`);
    console.log(`║  ├─ COLD evals:        ${s.coldEvals.toString().padEnd(40)}║`);
    console.log(`║  ├─ WARM evals:        ${s.warmEvals.toString().padEnd(40)}║`);
    console.log(`║  └─ HOT evals:         ${s.hotEvals.toString().padEnd(40)}║`);
    console.log('║                                                               ║');
    console.log(`║  Signals Detected:     ${s.signalsDetected.toString().padEnd(40)}║`);
    console.log(`║  ├─ Clean Signals:     ${s.cleanSignals.toString().padEnd(40)}║`);
    console.log(`║  └─ Toxic Skips:       ${s.toxicSkips.toString().padEnd(40)}║`);
    console.log('║                                                               ║');
    console.log(`║  Log Types:                                                   ║`);
    console.log(`║  ├─ Heartbeats:        ${s.heartbeatLogs.toString().padEnd(40)}║`);
    console.log(`║  ├─ Full Snapshots:    ${s.fullSnapshots.toString().padEnd(40)}║`);
    console.log(`║  └─ Event-Driven:      ${s.eventDrivenLogs.toString().padEnd(40)}║`);
    console.log('║                                                               ║');
    console.log(`║  Cadence State:        🧊${c.coldCount} | 🌡️${c.warmCount} | 🔥${c.hotCount}${' '.repeat(29)}║`);
    console.log(`║  Active Trackings:     ${this.activeTracking.size.toString().padEnd(40)}║`);
    console.log(`║  DB Write Errors:      ${s.dbWriteErrors.toString().padEnd(40)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  }
}
