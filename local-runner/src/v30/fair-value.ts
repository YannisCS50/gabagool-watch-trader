/**
 * V30 Fair Value Model
 * 
 * Calculates p_t = P(Z_T > Strike | C_t, Z_t, τ)
 * Uses empirical data from historical ticks + outcomes
 * 
 * IMPROVED:
 * - Better heuristic with asset-specific volatility
 * - Uses both Binance (C_t) and Chainlink (Z_t) for delta calculation
 * - Time-weighted confidence scaling
 */

import { DELTA_BUCKET_SIZE, DEFAULT_DELTA_BUCKET_SIZE, MIN_FAIR_VALUE_SAMPLES, FAIR_VALUE_ALPHA, TIME_BUCKETS } from './config.js';
import type { FairValueResult, Asset } from './types.js';

interface FairCell {
  p_up: number;       // EWMA of P(UP wins)
  samples: number;    // Number of observations
  lastUpdate: number; // Timestamp of last update
}

// Asset-specific volatility (approx daily % move scaled to 15min)
// 15min volatility ≈ daily vol / sqrt(96) (96 15-min periods per day)
const ASSET_VOLATILITY: Record<Asset, number> = {
  BTC: 150,   // ~$150 typical 15-min range for BTC at $95k (0.16%)
  ETH: 15,    // ~$15 typical 15-min range for ETH at $3.5k
  SOL: 1.5,   // ~$1.5 typical 15-min range for SOL at $200
  XRP: 0.02,  // ~$0.02 typical 15-min range for XRP at $2.5
};

// How much to weight Chainlink vs Binance in delta calculation
// Chainlink is the settlement price, so it matters more near expiry
const CHAINLINK_WEIGHT_AT_EXPIRY = 0.8;  // 80% Chainlink weight at τ=0
const CHAINLINK_WEIGHT_AT_START = 0.2;   // 20% Chainlink weight at τ=900s

export class EmpiricalFairValue {
  private cells: Map<string, FairCell> = new Map();
  private alpha: number;

  constructor(alpha: number = FAIR_VALUE_ALPHA) {
    this.alpha = alpha;
  }

  /**
   * Generate bucket key for lookup
   */
  private key(asset: Asset, deltaBucket: number, timeBucket: number): string {
    return `${asset}:${deltaBucket}:${timeBucket}`;
  }

  /**
   * Get the time bucket for given seconds remaining
   */
  private getTimeBucket(secRemaining: number): number {
    for (let i = 0; i < TIME_BUCKETS.length - 1; i++) {
      if (secRemaining >= TIME_BUCKETS[i + 1]) {
        return TIME_BUCKETS[i];
      }
    }
    return TIME_BUCKETS[TIME_BUCKETS.length - 1];
  }

  /**
   * Get the delta bucket for given delta to strike (asset-specific)
   */
  private getDeltaBucket(asset: Asset, deltaToStrike: number): number {
    const bucketSize = DELTA_BUCKET_SIZE[asset] ?? DEFAULT_DELTA_BUCKET_SIZE;
    return Math.round(deltaToStrike / bucketSize) * bucketSize;
  }

  /**
   * Calculate blended delta using both Binance and Chainlink
   * Near expiry, Chainlink matters more (it's the settlement oracle)
   */
  getBlendedDelta(
    binancePrice: number,
    chainlinkPrice: number | null,
    strikePrice: number,
    secRemaining: number
  ): number {
    // If no Chainlink, just use Binance
    if (!chainlinkPrice) {
      return binancePrice - strikePrice;
    }

    // Calculate weight based on time remaining
    // At τ=900s: chainlinkWeight = 0.2
    // At τ=0s: chainlinkWeight = 0.8
    const timeProgress = (900 - secRemaining) / 900;
    const chainlinkWeight = CHAINLINK_WEIGHT_AT_START + 
      (CHAINLINK_WEIGHT_AT_EXPIRY - CHAINLINK_WEIGHT_AT_START) * timeProgress;
    
    // Blend the two price sources
    const blendedPrice = (1 - chainlinkWeight) * binancePrice + chainlinkWeight * chainlinkPrice;
    
    return blendedPrice - strikePrice;
  }

  /**
   * Get fair probability for given market conditions
   */
  getFairP(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number
  ): FairValueResult {
    const deltaBucket = this.getDeltaBucket(asset, deltaToStrike);
    const timeBucket = this.getTimeBucket(secRemaining);
    const k = this.key(asset, deltaBucket, timeBucket);
    
    const cell = this.cells.get(k);
    
    if (!cell || cell.samples < MIN_FAIR_VALUE_SAMPLES) {
      // Fallback: use improved delta-based heuristic
      const heuristicP = this.improvedHeuristic(asset, deltaToStrike, secRemaining);
      return {
        p_up: heuristicP,
        p_down: 1 - heuristicP,
        confidence: cell ? cell.samples / MIN_FAIR_VALUE_SAMPLES : 0,
        samples: cell?.samples ?? 0,
      };
    }

    return {
      p_up: cell.p_up,
      p_down: 1 - cell.p_up,
      confidence: Math.min(1, cell.samples / (MIN_FAIR_VALUE_SAMPLES * 5)),
      samples: cell.samples,
    };
  }

  /**
   * Improved heuristic with asset-specific volatility
   * 
   * Key insight: The probability should depend on:
   * 1. How far we are from strike (delta)
   * 2. How much time is left (more time = more uncertainty)
   * 3. Asset volatility (BTC moves more in $ than XRP)
   * 
   * We use a logistic function with proper volatility scaling:
   * z = delta / (σ * sqrt(τ/900))
   * p = 1 / (1 + exp(-z * k))
   * 
   * Where k controls the steepness (higher = more certain near strike)
   */
  private improvedHeuristic(asset: Asset, deltaToStrike: number, secRemaining: number): number {
    const sigma = ASSET_VOLATILITY[asset] || 100;
    
    // Time scaling: uncertainty increases with sqrt of time
    // At τ=900s: full uncertainty
    // At τ=0s: near certainty (outcome almost determined)
    const timeScale = Math.sqrt(Math.max(1, secRemaining) / 900);
    
    // Normalize delta by expected price movement
    // If delta >> expected movement, outcome is near certain
    const expectedMove = sigma * timeScale;
    const normalizedDelta = deltaToStrike / expectedMove;
    
    // Steepness factor - controls how quickly probability changes
    // Higher = more extreme probabilities away from strike
    const steepness = 2.0;
    
    // Logistic function
    const z = normalizedDelta * steepness;
    let p = 1 / (1 + Math.exp(-z));
    
    // Apply time-based certainty boost near expiry
    // At τ < 60s: if delta is clearly positive/negative, be more certain
    if (secRemaining < 60) {
      const certaintyBoost = (60 - secRemaining) / 60; // 0 to 1
      if (p > 0.5) {
        p = p + (1 - p) * certaintyBoost * 0.3; // Move toward 1
      } else {
        p = p - p * certaintyBoost * 0.3; // Move toward 0
      }
    }
    
    // Clamp to reasonable range (never 0% or 100% until settlement)
    const minP = secRemaining > 30 ? 0.05 : 0.02;
    const maxP = secRemaining > 30 ? 0.95 : 0.98;
    return Math.max(minP, Math.min(maxP, p));
  }

  /**
   * Legacy heuristic (kept for reference)
   */
  private deltaHeuristic(deltaToStrike: number, secRemaining: number): number {
    const timeWeight = Math.max(0.1, secRemaining / 900);
    const normalizedDelta = deltaToStrike / (50 * timeWeight);
    const p = 1 / (1 + Math.exp(-normalizedDelta));
    return Math.max(0.1, Math.min(0.9, p));
  }

  /**
   * Update fair value with new observation
   * Called after market resolution with known outcome
   */
  update(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number,
    upWon: boolean,
    ts: number = Date.now()
  ): void {
    const deltaBucket = this.getDeltaBucket(asset, deltaToStrike);
    const timeBucket = this.getTimeBucket(secRemaining);
    const k = this.key(asset, deltaBucket, timeBucket);
    
    const cell = this.cells.get(k);
    const outcome = upWon ? 1 : 0;
    
    if (!cell) {
      this.cells.set(k, {
        p_up: outcome,
        samples: 1,
        lastUpdate: ts,
      });
    } else {
      // EWMA update
      cell.p_up = this.alpha * outcome + (1 - this.alpha) * cell.p_up;
      cell.samples++;
      cell.lastUpdate = ts;
    }
  }

  /**
   * Bulk load from historical data
   */
  loadFromHistory(data: Array<{
    asset: Asset;
    deltaToStrike: number;
    secRemaining: number;
    upWon: boolean;
    ts: number;
  }>): void {
    // Sort by timestamp to process in order
    const sorted = [...data].sort((a, b) => a.ts - b.ts);
    for (const row of sorted) {
      this.update(row.asset, row.deltaToStrike, row.secRemaining, row.upWon, row.ts);
    }
  }

  /**
   * Get statistics about the model
   */
  getStats(): {
    totalCells: number;
    trustedCells: number;
    avgSamples: number;
    byAsset: Record<string, number>;
  } {
    let totalSamples = 0;
    let trustedCount = 0;
    const byAsset: Record<string, number> = {};

    for (const [key, cell] of this.cells) {
      totalSamples += cell.samples;
      if (cell.samples >= MIN_FAIR_VALUE_SAMPLES) {
        trustedCount++;
      }
      const asset = key.split(':')[0];
      byAsset[asset] = (byAsset[asset] || 0) + 1;
    }

    return {
      totalCells: this.cells.size,
      trustedCells: trustedCount,
      avgSamples: this.cells.size > 0 ? totalSamples / this.cells.size : 0,
      byAsset,
    };
  }

  /**
   * Export model state for persistence
   */
  export(): Map<string, FairCell> {
    return new Map(this.cells);
  }

  /**
   * Import model state
   */
  import(data: Map<string, FairCell>): void {
    this.cells = new Map(data);
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.cells.clear();
  }
}

// Singleton instance
let instance: EmpiricalFairValue | null = null;

export function getFairValueModel(): EmpiricalFairValue {
  if (!instance) {
    instance = new EmpiricalFairValue();
  }
  return instance;
}

export function resetFairValueModel(): void {
  instance = null;
}
