/**
 * V30 Fair Value Model
 * 
 * Calculates p_t = P(Z_T > Strike | C_t, Z_t, τ)
 * Uses empirical data from historical ticks + outcomes
 */

import { DELTA_BUCKET_SIZE, MIN_FAIR_VALUE_SAMPLES, FAIR_VALUE_ALPHA, TIME_BUCKETS } from './config.js';
import type { FairValueResult, Asset } from './types.js';

interface FairCell {
  p_up: number;       // EWMA of P(UP wins)
  samples: number;    // Number of observations
  lastUpdate: number; // Timestamp of last update
}

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
   * Get the delta bucket for given delta to strike
   */
  private getDeltaBucket(deltaToStrike: number): number {
    return Math.round(deltaToStrike / DELTA_BUCKET_SIZE) * DELTA_BUCKET_SIZE;
  }

  /**
   * Get fair probability for given market conditions
   */
  getFairP(
    asset: Asset,
    deltaToStrike: number,
    secRemaining: number
  ): FairValueResult {
    const deltaBucket = this.getDeltaBucket(deltaToStrike);
    const timeBucket = this.getTimeBucket(secRemaining);
    const k = this.key(asset, deltaBucket, timeBucket);
    
    const cell = this.cells.get(k);
    
    if (!cell || cell.samples < MIN_FAIR_VALUE_SAMPLES) {
      // Fallback: use delta-based heuristic
      // If Binance price > strike by a lot, UP is more likely
      const heuristicP = this.deltaHeuristic(deltaToStrike, secRemaining);
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
   * Simple heuristic when no empirical data available
   * Uses logistic function of normalized delta
   */
  private deltaHeuristic(deltaToStrike: number, secRemaining: number): number {
    // Normalize delta by time remaining (more certainty near expiry)
    const timeWeight = Math.max(0.1, secRemaining / 900);
    const normalizedDelta = deltaToStrike / (50 * timeWeight); // $50 = ~1 std
    
    // Logistic function: 1 / (1 + e^(-x))
    const p = 1 / (1 + Math.exp(-normalizedDelta));
    
    // Clamp to reasonable range
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
    const deltaBucket = this.getDeltaBucket(deltaToStrike);
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
