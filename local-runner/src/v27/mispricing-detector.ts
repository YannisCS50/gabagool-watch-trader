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
  
  // Asset volatility (annualized, approximate)
  private assetVolatility: Record<string, number> = {
    BTC: 0.60,  // 60% annual vol
    ETH: 0.75,  // 75% annual vol
    SOL: 1.00,  // 100% annual vol
    XRP: 0.90,  // 90% annual vol
  };
  
  constructor() {
    // Initialize for supported assets
    for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
      this.spotMoves.set(asset, []);
      this.polyMoves.set(asset, []);
      this.snapBackHistory.set(asset, []);
    }
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
    // CRITICAL FIX: Buy the CHEAP side, not the expensive side!
    // ============================================================
    //
    // If spot > strike (delta positive):
    //   - UP should become expensive (~0.70-0.90)
    //   - DOWN should become cheap (~0.10-0.30)
    //   → If UP is STILL cheap (below theoretical), BUY UP
    //   → If DOWN is STILL expensive (above 1-theoretical), BUY DOWN
    //
    // The key insight: we want to buy when the market HASN'T YET
    // adjusted to the new reality. That means buying the side that
    // is UNDERPRICED relative to its theoretical value.
    // ============================================================
    
    // Calculate expected Polymarket prices based on delta, time remaining, and volatility
    const expectedUpPrice = this.calculateExpectedPrice(deltaPct, true, asset);
    const expectedDownPrice = this.calculateExpectedPrice(deltaPct, false, asset);
    
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
