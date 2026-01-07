/**
 * v8 Fair Price Surface
 * 
 * Empirically calibrated fair price model using EWMA of observed mid prices.
 * The surface learns from the market's own repricing behavior.
 */

import { V8 } from './config.js';
import { bucketDeltaForAsset, bucketTimeStandard, formatTimeBucket, getBucketKey, type TimeBucket } from './buckets.js';

/**
 * A single cell in the fair price surface
 */
export interface FairCell {
  fairUp: number;        // EWMA of midUp
  n: number;             // Sample count
  lastUpdatedTs: number; // Timestamp of last update
  p25?: number;          // 25th percentile (optional)
  p75?: number;          // 75th percentile (optional)
  minSeen?: number;      // Min midUp seen
  maxSeen?: number;      // Max midUp seen
}

/**
 * Fair Price Surface
 * 
 * Maintains a grid of fair UP prices indexed by:
 * - asset (BTC, ETH, etc.)
 * - delta bucket (absolute distance from strike in USD)
 * - time bucket (seconds remaining)
 */
export class FairSurface {
  private cells = new Map<string, FairCell>();
  private alpha: number;
  
  constructor(alpha: number = V8.surface.ewmaAlpha) {
    this.alpha = alpha;
  }
  
  /**
   * Generate key for surface lookup
   */
  key(asset: string, deltaBucket: number, tBucket: TimeBucket): string {
    return getBucketKey(asset, deltaBucket, tBucket);
  }
  
  /**
   * Get fair price cell for a bucket
   */
  get(asset: string, deltaBucket: number, tBucket: TimeBucket): FairCell | null {
    return this.cells.get(this.key(asset, deltaBucket, tBucket)) ?? null;
  }
  
  /**
   * Get fair price using raw parameters
   */
  getByParams(asset: string, absDeltaUsd: number, secRemaining: number): FairCell | null {
    const deltaBucket = bucketDeltaForAsset(asset, absDeltaUsd);
    const tBucket = bucketTimeStandard(secRemaining);
    if (!tBucket) return null;
    return this.get(asset, deltaBucket, tBucket);
  }
  
  /**
   * Update fair price surface with new observation
   * 
   * @param asset - Asset symbol
   * @param deltaBucket - Delta bucket value
   * @param tBucket - Time bucket
   * @param midUp - Observed mid price for UP token
   * @param ts - Timestamp in ms
   */
  update(asset: string, deltaBucket: number, tBucket: TimeBucket, midUp: number, ts: number): void {
    const k = this.key(asset, deltaBucket, tBucket);
    const prev = this.cells.get(k);
    
    if (!prev) {
      // First observation for this bucket
      this.cells.set(k, {
        fairUp: midUp,
        n: 1,
        lastUpdatedTs: ts,
        minSeen: midUp,
        maxSeen: midUp,
      });
      return;
    }
    
    // EWMA update: new = old + alpha * (observation - old)
    const fairUp = prev.fairUp + this.alpha * (midUp - prev.fairUp);
    
    this.cells.set(k, {
      ...prev,
      fairUp,
      n: prev.n + 1,
      lastUpdatedTs: ts,
      minSeen: Math.min(prev.minSeen ?? midUp, midUp),
      maxSeen: Math.max(prev.maxSeen ?? midUp, midUp),
    });
  }
  
  /**
   * Update using raw parameters
   */
  updateByParams(asset: string, absDeltaUsd: number, secRemaining: number, midUp: number, ts: number): boolean {
    const deltaBucket = bucketDeltaForAsset(asset, absDeltaUsd);
    const tBucket = bucketTimeStandard(secRemaining);
    if (!tBucket) return false;
    
    this.update(asset, deltaBucket, tBucket, midUp, ts);
    return true;
  }
  
  /**
   * Check if a cell is trusted for trading
   */
  isTrusted(cell: FairCell | null, currentTs: number): boolean {
    if (!cell) return false;
    if (cell.n < V8.surface.minSamplesToTrade) return false;
    if (currentTs - cell.lastUpdatedTs > V8.surface.maxFairUpAgeMs) return false;
    return true;
  }
  
  /**
   * Get fair DOWN price (symmetric: 1 - fairUp)
   */
  getFairDown(cell: FairCell | null): number | undefined {
    if (!cell) return undefined;
    return 1 - cell.fairUp;
  }
  
  /**
   * Get total number of cells in the surface
   */
  getCellCount(): number {
    return this.cells.size;
  }
  
  /**
   * Get surface statistics for monitoring
   */
  getStats(): { totalCells: number; cellsByAsset: Record<string, number>; avgSamples: number } {
    const cellsByAsset: Record<string, number> = {};
    let totalSamples = 0;
    
    for (const [key, cell] of this.cells) {
      const asset = key.split('|')[0];
      cellsByAsset[asset] = (cellsByAsset[asset] ?? 0) + 1;
      totalSamples += cell.n;
    }
    
    return {
      totalCells: this.cells.size,
      cellsByAsset,
      avgSamples: this.cells.size > 0 ? totalSamples / this.cells.size : 0,
    };
  }
  
  /**
   * Clear all surface data
   */
  clear(): void {
    this.cells.clear();
  }
  
  /**
   * Export surface for persistence/debugging
   */
  export(): Map<string, FairCell> {
    return new Map(this.cells);
  }
  
  /**
   * Import surface from saved data
   */
  import(data: Map<string, FairCell>): void {
    this.cells = new Map(data);
  }
}

// Singleton instance
let surfaceInstance: FairSurface | null = null;

/**
 * Get the singleton FairSurface instance
 */
export function getSurface(): FairSurface {
  if (!surfaceInstance) {
    surfaceInstance = new FairSurface(V8.surface.ewmaAlpha);
  }
  return surfaceInstance;
}

/**
 * Reset the surface (for testing)
 */
export function resetSurface(): void {
  surfaceInstance = null;
}
