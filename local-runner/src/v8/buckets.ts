/**
 * v8 Bucketing Logic
 * 
 * Delta and time bucketing for empirical fair price surface
 */

import { V8, getAssetBucketConfig } from './config.js';

/**
 * Clamp a number between lo and hi
 */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute delta bucket (lower bound) for absolute delta USD
 * 
 * @param absDeltaUsd - Absolute difference between spot and strike in USD
 * @param width - Bucket width in USD (asset-specific)
 * @param maxBucket - Maximum bucket value to clamp to
 * @returns Bucket lower bound
 */
export function bucketDelta(absDeltaUsd: number, width: number, maxBucket: number): number {
  const x = clamp(absDeltaUsd, 0, maxBucket);
  return Math.floor(x / width) * width; // bucket lower bound
}

/**
 * Get delta bucket for a specific asset
 */
export function bucketDeltaForAsset(asset: string, absDeltaUsd: number): number {
  const cfg = getAssetBucketConfig(asset);
  return bucketDelta(absDeltaUsd, cfg.deltaWidthUsd, V8.buckets.maxDeltaBucket);
}

/**
 * Time bucket result
 */
export interface TimeBucket {
  lo: number;  // Lower bound in seconds
  hi: number;  // Upper bound in seconds
}

/**
 * Determine time bucket for seconds remaining
 * 
 * @param secRemaining - Seconds remaining in the market
 * @param boundaries - Array of bucket boundaries (e.g., [0, 120, 240, ...])
 * @returns TimeBucket if within valid range, null otherwise
 */
export function bucketTime(secRemaining: number, boundaries: readonly number[]): TimeBucket | null {
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    if (secRemaining >= lo && secRemaining < hi) {
      return { lo, hi };
    }
  }
  return null;
}

/**
 * Get time bucket for standard 15-minute market boundaries
 */
export function bucketTimeStandard(secRemaining: number): TimeBucket | null {
  return bucketTime(secRemaining, V8.buckets.timeBucketsSec);
}

/**
 * Format time bucket as string for logging/keys
 */
export function formatTimeBucket(tb: TimeBucket | null): string {
  if (!tb) return 'NA';
  return `${tb.lo}-${tb.hi}`;
}

/**
 * Get bucket key for surface lookup
 */
export function getBucketKey(asset: string, deltaBucket: number, tBucket: TimeBucket): string {
  return `${asset}|d=${deltaBucket}|t=${tBucket.lo}-${tBucket.hi}`;
}
