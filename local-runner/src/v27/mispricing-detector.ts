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
    
    // Calculate expected Polymarket prices based on delta
    const expectedUpPrice = this.calculateExpectedPrice(deltaPct, true);
    const expectedDownPrice = this.calculateExpectedPrice(deltaPct, false);
    
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
   * Calculate expected Polymarket price based on delta
   * This is a simplified model - should be trained on historical data
   */
  private calculateExpectedPrice(deltaPct: number, isUp: boolean): number {
    // Basic logistic model
    // When delta% is positive and large, UP should be ~0.7-0.8
    // When delta% is negative and large, DOWN should be ~0.7-0.8
    
    const k = 20; // Steepness
    const base = 0.5;
    
    if (isUp) {
      // UP price increases as spot goes above strike
      return base + 0.3 * (1 / (1 + Math.exp(-k * deltaPct)) - 0.5);
    } else {
      // DOWN price increases as spot goes below strike
      return base + 0.3 * (1 / (1 + Math.exp(k * deltaPct)) - 0.5);
    }
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
