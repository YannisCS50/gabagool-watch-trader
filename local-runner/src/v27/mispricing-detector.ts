// ============================================================
// V27 MISPRICING DETECTOR
// ============================================================
//
// Detects when spot price movement has not yet been reflected
// in Polymarket UP/DOWN prices.
//
// Mispricing exists IF:
// A) |delta_abs| > dynamic_delta_threshold(asset)
// B) Polymarket price has not yet moved to historical expectation
// C) Spot is demonstrably leading Polymarket (causality check)
// ============================================================

import { getV27Config, getAssetConfig } from './config.js';
import type { V27OrderBook, V27SpotData } from './index.js';

export interface MispricingSignal {
  exists: boolean;
  side: 'UP' | 'DOWN' | null;
  
  // Delta metrics
  deltaAbs: number;
  deltaPct: number;
  threshold: number;
  
  // Causality
  causalityPass: boolean;
  spotLeadMs: number;
  
  // Expected vs actual
  expectedPolyPrice: number;
  actualPolyPrice: number;
  priceLag: number;
  
  // Confidence
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  
  // Reason if no mispricing
  reason?: string;
}

interface PriceMove {
  timestamp: number;
  price: number;
  delta: number;
}

export class MispricingDetector {
  private spotMoves: Map<string, PriceMove[]> = new Map();
  private polyMoves: Map<string, PriceMove[]> = new Map();
  
  // Historical snap-back data for learning
  private snapBackHistory: Map<string, { delta: number; snappedBack: boolean }[]> = new Map();
  
  // Current evaluation context
  private currentTimeRemaining: number = 900; // Default 15 min
  private currentAsset: string = 'ETH'; // Default asset
  
  // Empirical price lookup table (loaded from DB or hardcoded fallback)
  // Format: { 'BTC:d50-100:t1-3min': { up: 0.75, down: 0.25, std: 0.15 } }
  private empiricalPrices: Map<string, { up: number; down: number; std: number }> = new Map();
  
  // Delta thresholds for bucket classification (in asset's native currency)
  private deltaThresholds: Record<string, number[]> = {
    BTC: [50, 100, 200],      // $50, $100, $200
    ETH: [2, 5],              // $2, $5
    SOL: [0.1, 0.3],          // $0.10, $0.30
    XRP: [0.005, 0.015],      // $0.005, $0.015
  };
  
  // Annualized volatility per asset (used for expected price calculation fallback)
  private assetVolatility: Record<string, number> = {
    BTC: 0.55,   // ~55% annual vol
    ETH: 0.75,   // ~75% annual vol  
    SOL: 1.10,   // ~110% annual vol (more volatile)
    XRP: 1.00,   // ~100% annual vol
  };
  
  constructor() {
    // Initialize for supported assets
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      this.spotMoves.set(asset, []);
      this.polyMoves.set(asset, []);
      this.snapBackHistory.set(asset, []);
    }
    
    // Initialize empirical price lookup with hardcoded fallback values
    this.initializeEmpiricalPrices();
  }
  
  /**
   * Initialize empirical prices from hardcoded values
   * These are derived from actual market data analysis
   */
  private initializeEmpiricalPrices(): void {
    const timeLabels = ['t<1min', 't1-3min', 't3-5min', 't5-10min', 't>10min'];
    
    // BTC empirical prices
    const btcData: Record<string, number[]> = {
      'd<50':     [0.50, 0.50, 0.50, 0.50, 0.50],
      'd50-100':  [0.85, 0.75, 0.65, 0.60, 0.55],
      'd100-200': [0.95, 0.90, 0.80, 0.72, 0.65],
      'd>200':    [0.99, 0.97, 0.93, 0.88, 0.82],
    };
    
    for (const [delta, prices] of Object.entries(btcData)) {
      prices.forEach((up, i) => {
        this.empiricalPrices.set(`BTC:${delta}:${timeLabels[i]}`, { up, down: 1 - up, std: 0.10 });
      });
    }
    
    // ETH empirical prices
    const ethData: Record<string, number[]> = {
      'd<2':  [0.50, 0.50, 0.50, 0.50, 0.50],
      'd2-5': [0.80, 0.70, 0.62, 0.58, 0.54],
      'd>5':  [0.95, 0.90, 0.82, 0.75, 0.68],
    };
    
    for (const [delta, prices] of Object.entries(ethData)) {
      prices.forEach((up, i) => {
        this.empiricalPrices.set(`ETH:${delta}:${timeLabels[i]}`, { up, down: 1 - up, std: 0.10 });
      });
    }
    
    // SOL empirical prices
    const solData: Record<string, number[]> = {
      'd<0.1':    [0.50, 0.50, 0.50, 0.50, 0.50],
      'd0.1-0.3': [0.78, 0.68, 0.60, 0.56, 0.53],
      'd>0.3':    [0.92, 0.85, 0.78, 0.70, 0.62],
    };
    
    for (const [delta, prices] of Object.entries(solData)) {
      prices.forEach((up, i) => {
        this.empiricalPrices.set(`SOL:${delta}:${timeLabels[i]}`, { up, down: 1 - up, std: 0.12 });
      });
    }
    
    // XRP empirical prices
    const xrpData: Record<string, number[]> = {
      'd<0.005':      [0.50, 0.50, 0.50, 0.50, 0.50],
      'd0.005-0.015': [0.80, 0.70, 0.62, 0.58, 0.54],
      'd>0.015':      [0.94, 0.88, 0.80, 0.72, 0.65],
    };
    
    for (const [delta, prices] of Object.entries(xrpData)) {
      prices.forEach((up, i) => {
        this.empiricalPrices.set(`XRP:${delta}:${timeLabels[i]}`, { up, down: 1 - up, std: 0.10 });
      });
    }
  }
  
  /**
   * Get delta bucket label for an asset
   */
  private getDeltaBucket(asset: string, deltaAbs: number): string {
    const thresholds = this.deltaThresholds[asset] || [1, 5];
    const absDelta = Math.abs(deltaAbs);
    
    switch (asset) {
      case 'BTC':
        if (absDelta < 50) return 'd<50';
        if (absDelta < 100) return 'd50-100';
        if (absDelta < 200) return 'd100-200';
        return 'd>200';
      case 'ETH':
        if (absDelta < 2) return 'd<2';
        if (absDelta < 5) return 'd2-5';
        return 'd>5';
      case 'SOL':
        if (absDelta < 0.1) return 'd<0.1';
        if (absDelta < 0.3) return 'd0.1-0.3';
        return 'd>0.3';
      case 'XRP':
        if (absDelta < 0.005) return 'd<0.005';
        if (absDelta < 0.015) return 'd0.005-0.015';
        return 'd>0.015';
      default:
        return 'd<2';
    }
  }
  
  /**
   * Get time bucket label
   */
  private getTimeBucket(timeRemainingSec: number): string {
    if (timeRemainingSec < 60) return 't<1min';
    if (timeRemainingSec < 180) return 't1-3min';
    if (timeRemainingSec < 300) return 't3-5min';
    if (timeRemainingSec < 600) return 't5-10min';
    return 't>10min';
  }
  
  /**
   * Get expected price from empirical lookup
   */
  getExpectedPrice(asset: string, deltaAbs: number, timeRemainingSec: number): { up: number; down: number; std: number } {
    const deltaBucket = this.getDeltaBucket(asset, deltaAbs);
    const timeBucket = this.getTimeBucket(timeRemainingSec);
    const key = `${asset}:${deltaBucket}:${timeBucket}`;
    
    return this.empiricalPrices.get(key) || { up: 0.50, down: 0.50, std: 0.15 };
  }
  
  /**
   * Record a spot price move
   */
  recordSpotMove(asset: string, price: number, timestamp: number): void {
    const moves = this.spotMoves.get(asset) || [];
    const lastPrice = moves.length > 0 ? moves[moves.length - 1].price : price;
    
    moves.push({
      timestamp,
      price,
      delta: price - lastPrice,
    });
    
    // Keep last 1000 moves
    if (moves.length > 1000) {
      moves.shift();
    }
    
    this.spotMoves.set(asset, moves);
  }
  
  /**
   * Record a Polymarket price move
   */
  recordPolyMove(asset: string, upMid: number, downMid: number, timestamp: number): void {
    const moves = this.polyMoves.get(asset) || [];
    const combinedMid = (upMid + (1 - downMid)) / 2;
    const lastPrice = moves.length > 0 ? moves[moves.length - 1].price : combinedMid;
    
    moves.push({
      timestamp,
      price: combinedMid,
      delta: combinedMid - lastPrice,
    });
    
    if (moves.length > 1000) {
      moves.shift();
    }
    
    this.polyMoves.set(asset, moves);
  }
  
  /**
   * Detect mispricing
   */
  detect(
    asset: string,
    strikePrice: number,
    spot: V27SpotData,
    book: V27OrderBook,
    timeRemainingSeconds: number
  ): MispricingSignal {
    const config = getV27Config();
    
    // Store time remaining for use in calculateExpectedPrice
    this.currentTimeRemaining = timeRemainingSeconds;
    const assetConfig = getAssetConfig(asset);
    
    if (!assetConfig) {
      return this.noMispricing('Unknown asset');
    }
    
    // Calculate delta
    const deltaAbs = spot.price - strikePrice;
    const deltaPct = deltaAbs / strikePrice;
    const threshold = assetConfig.deltaThreshold;
    
    // Check A: Delta exceeds threshold
    if (Math.abs(deltaAbs) <= threshold) {
      return this.noMispricing(`Delta ${deltaAbs.toFixed(4)} below threshold ${threshold}`, {
        deltaAbs,
        deltaPct,
        threshold,
      });
    }
    
    // ============================================================
    // EMPIRICAL MISPRICING DETECTION
    // ============================================================
    //
    // Use historical market data to determine expected prices.
    // A mispricing exists when actual market price is significantly
    // different from the empirical average for this delta/time bucket.
    //
    // Key insight: If delta is +$100 BTC with 2 min left, historically
    // UP trades at ~0.90. If current UP ask is 0.50, that's underpriced!
    // ============================================================
    
    // Get empirical expected prices based on asset, delta, and time remaining
    // Note: empirical prices assume delta > 0 means UP favored
    const empirical = this.getExpectedPrice(asset, deltaAbs, timeRemainingSeconds);
    
    // If delta is negative (spot below strike), swap expected prices
    const spotAboveStrike = deltaAbs > 0;
    const expectedUpPrice = spotAboveStrike ? empirical.up : empirical.down;
    const expectedDownPrice = spotAboveStrike ? empirical.down : empirical.up;
    
    // Calculate how much each side is underpriced
    // Positive = underpriced (good to buy), Negative = overpriced (avoid)
    const upUnderpricing = expectedUpPrice - book.upAsk;  // Expected - actual ask
    const downUnderpricing = expectedDownPrice - book.downAsk;
    
    // Find the side that is most underpriced (best opportunity)
    let buyableSide: 'UP' | 'DOWN' | null = null;
    let bestUnderpricing = 0;
    let actualPrice = 0;
    let expectedPrice = 0;
    
    // Only consider buying if underpriced by at least 2%
    const minUnderpricingThreshold = 0.02;
    
    if (upUnderpricing > minUnderpricingThreshold && upUnderpricing > downUnderpricing) {
      buyableSide = 'UP';
      bestUnderpricing = upUnderpricing;
      actualPrice = book.upAsk;
      expectedPrice = expectedUpPrice;
    } else if (downUnderpricing > minUnderpricingThreshold && downUnderpricing > upUnderpricing) {
      buyableSide = 'DOWN';
      bestUnderpricing = downUnderpricing;
      actualPrice = book.downAsk;
      expectedPrice = expectedDownPrice;
    }
    
    // No underpriced side found
    if (!buyableSide) {
      return this.noMispricing('No side is sufficiently underpriced', {
        deltaAbs,
        deltaPct,
        threshold,
        expectedPolyPrice: expectedUpPrice,
        actualPolyPrice: book.upAsk,
      });
    }
    
    const priceLag = bestUnderpricing;
    
    // Check C: Causality - spot must lead Polymarket
    const causalityResult = this.checkCausality(asset, spot.timestamp, config);
    
    if (!causalityResult.pass) {
      return this.noMispricing(`Causality failed: ${causalityResult.reason}`, {
        deltaAbs,
        deltaPct,
        threshold,
        causalityPass: false,
        spotLeadMs: causalityResult.spotLeadMs,
      });
    }
    
    // Determine confidence based on multiple factors
    const confidence = this.calculateConfidence(
      Math.abs(deltaAbs),
      threshold,
      Math.abs(priceLag),
      timeRemainingSeconds
    );
    
    return {
      exists: true,
      side: buyableSide,
      deltaAbs,
      deltaPct,
      threshold,
      causalityPass: true,
      spotLeadMs: causalityResult.spotLeadMs,
      expectedPolyPrice: expectedPrice,
      actualPolyPrice: actualPrice,
      priceLag,
      confidence,
    };
  }
  
  /**
   * Check causality: spot must lead Polymarket by 200-3000ms
   */
  private checkCausality(
    asset: string,
    spotTimestamp: number,
    config: { causalityMinMs: number; causalityMaxMs: number }
  ): { pass: boolean; spotLeadMs: number; reason?: string } {
    const polyMoves = this.polyMoves.get(asset) || [];
    
    if (polyMoves.length === 0) {
      return { pass: false, spotLeadMs: 0, reason: 'No Polymarket data' };
    }
    
    // Find the most recent significant Polymarket move
    const recentPolyMove = this.findRecentSignificantMove(polyMoves);
    
    if (!recentPolyMove) {
      // No recent Polymarket move - spot is clearly leading
      return { pass: true, spotLeadMs: 500 }; // Assume reasonable lead
    }
    
    const spotLeadMs = recentPolyMove.timestamp - spotTimestamp;
    
    // Spot should have moved BEFORE Polymarket (negative spotLeadMs means spot moved first)
    // We want spot to lead by 200-3000ms
    if (spotLeadMs > 0) {
      // Polymarket moved before spot timestamp - bad
      return { pass: false, spotLeadMs: -spotLeadMs, reason: 'Polymarket moved first' };
    }
    
    const leadTime = Math.abs(spotLeadMs);
    
    if (leadTime < config.causalityMinMs) {
      return { pass: false, spotLeadMs: leadTime, reason: 'Spot lead too short' };
    }
    
    if (leadTime > config.causalityMaxMs) {
      return { pass: false, spotLeadMs: leadTime, reason: 'Spot lead too stale' };
    }
    
    return { pass: true, spotLeadMs: leadTime };
  }
  
  /**
   * Find recent significant move in price history
   */
  private findRecentSignificantMove(moves: PriceMove[]): PriceMove | null {
    const now = Date.now();
    const lookbackMs = 5000; // Last 5 seconds
    
    for (let i = moves.length - 1; i >= 0; i--) {
      const move = moves[i];
      if (now - move.timestamp > lookbackMs) break;
      
      // Significant move = >0.5% price change
      if (Math.abs(move.delta) > 0.005) {
        return move;
      }
    }
    
    return null;
  }
  
  /**
   * Calculate expected Polymarket price using simplified binary option model
   * 
   * Key insight: The probability of spot ending above/below strike depends on:
   * 1. Current distance from strike (delta)
   * 2. Time remaining (more time = more uncertainty = prices closer to 0.50)
   * 3. Asset volatility
   * 
   * With 1 minute left and price $40 below strike → UP should be ~0.01
   * With 14 minutes left and price at strike → UP should be ~0.50
   */
  private calculateExpectedPrice(deltaPct: number, isUp: boolean, asset?: string): number {
    // Time remaining in fraction of 15-minute window
    const timeRemaining = this.currentTimeRemaining;
    const timeFraction = Math.max(0.01, timeRemaining / 900); // 0.01 to 1.0
    
    // Get asset volatility (default to ETH-like)
    const annualVol = this.assetVolatility[asset || 'ETH'] || 0.75;
    
    // Convert to 15-minute volatility
    // Annual vol → per-minute vol → 15-minute vol
    // σ_15min = σ_annual * sqrt(15 / (365 * 24 * 60))
    const minutesPerYear = 365 * 24 * 60;
    const vol15min = annualVol * Math.sqrt(15 / minutesPerYear);
    
    // Adjusted volatility based on time remaining
    // Less time = less expected movement = steeper probability curve
    const adjustedVol = vol15min * Math.sqrt(timeFraction);
    
    // Prevent division by zero
    const effectiveVol = Math.max(adjustedVol, 0.001);
    
    // Calculate z-score: how many standard deviations is current price from strike?
    // deltaPct is (spot - strike) / strike
    // z = deltaPct / adjustedVol
    const z = deltaPct / effectiveVol;
    
    // Use cumulative normal distribution approximation for probability
    // P(spot > strike at expiry) ≈ Φ(z) for UP
    // P(spot < strike at expiry) ≈ Φ(-z) for DOWN
    const probUp = this.normalCDF(z);
    const probDown = 1 - probUp;
    
    // Clamp to realistic market bounds (never exactly 0 or 1)
    const clamp = (p: number) => Math.max(0.005, Math.min(0.995, p));
    
    return isUp ? clamp(probUp) : clamp(probDown);
  }
  
  /**
   * Cumulative distribution function for standard normal distribution
   * Uses Abramowitz and Stegun approximation
   */
  private normalCDF(x: number): number {
    // Handle extreme values
    if (x < -8) return 0;
    if (x > 8) return 1;
    
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    
    return 0.5 * (1 + sign * y);
  }
  
  /**
   * Calculate confidence level
   */
  private calculateConfidence(
    deltaAbs: number,
    threshold: number,
    priceLag: number,
    timeRemaining: number
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    let score = 0;
    
    // Delta well above threshold
    if (deltaAbs > threshold * 1.5) score += 2;
    else if (deltaAbs > threshold * 1.2) score += 1;
    
    // Large price lag
    if (priceLag > 0.05) score += 2;
    else if (priceLag > 0.03) score += 1;
    
    // Reasonable time remaining (not too close to expiry)
    if (timeRemaining > 300) score += 1;
    
    if (score >= 4) return 'HIGH';
    if (score >= 2) return 'MEDIUM';
    return 'LOW';
  }
  
  /**
   * Return a "no mispricing" signal
   */
  private noMispricing(reason: string, partial?: Partial<MispricingSignal>): MispricingSignal {
    return {
      exists: false,
      side: null,
      deltaAbs: partial?.deltaAbs ?? 0,
      deltaPct: partial?.deltaPct ?? 0,
      threshold: partial?.threshold ?? 0,
      causalityPass: partial?.causalityPass ?? false,
      spotLeadMs: partial?.spotLeadMs ?? 0,
      expectedPolyPrice: partial?.expectedPolyPrice ?? 0.5,
      actualPolyPrice: partial?.actualPolyPrice ?? 0.5,
      priceLag: 0,
      confidence: 'LOW',
      reason,
    };
  }
  
  /**
   * Record outcome for threshold learning
   */
  recordOutcome(asset: string, delta: number, snappedBack: boolean): void {
    const history = this.snapBackHistory.get(asset) || [];
    history.push({ delta: Math.abs(delta), snappedBack });
    
    // Keep last 500 outcomes
    if (history.length > 500) {
      history.shift();
    }
    
    this.snapBackHistory.set(asset, history);
    
    // Periodically recalibrate threshold
    if (history.length >= 50 && history.length % 50 === 0) {
      this.recalibrateThreshold(asset);
    }
  }
  
  /**
   * Recalibrate threshold based on historical outcomes
   */
  private recalibrateThreshold(asset: string): void {
    const history = this.snapBackHistory.get(asset);
    const assetConfig = getAssetConfig(asset);
    
    if (!history || history.length < 50 || !assetConfig) return;
    
    // Find delta where snap-back probability > 55%
    const sorted = [...history].sort((a, b) => a.delta - b.delta);
    
    for (let i = 0; i < sorted.length; i++) {
      const aboveThreshold = sorted.slice(i);
      const snapBackRate = aboveThreshold.filter(h => h.snappedBack).length / aboveThreshold.length;
      
      if (snapBackRate > 0.55) {
        const newThreshold = sorted[i].delta;
        
        // Only update if within bounds
        if (newThreshold >= assetConfig.deltaThresholdMin && 
            newThreshold <= assetConfig.deltaThresholdMax) {
          console.log(`[V27] Recalibrating ${asset} threshold: ${assetConfig.deltaThreshold} → ${newThreshold.toFixed(4)}`);
          assetConfig.deltaThreshold = newThreshold;
        }
        break;
      }
    }
  }
}
