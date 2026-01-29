// ============================================================
// V35 EXPIRY SNAPSHOT SCHEDULER
// ============================================================
// Captures market state exactly 1 second before expiry (e.g., 12:59:59)
// This ensures we have an accurate historical record of each 15-minute
// market's final state, independent of when cleanupExpiredMarkets() runs.
// ============================================================

import type { V35Market, V35MarketMetrics, V35Asset } from './types.js';
import { calculateMarketMetrics } from './types.js';
import { getCachedPosition } from '../position-cache.js';

// ============================================================
// TYPES
// ============================================================

export interface V35ExpirySnapshot {
  // Identification
  marketSlug: string;
  asset: V35Asset;
  expiryTime: string; // ISO timestamp of market expiry
  snapshotTime: string; // ISO timestamp when snapshot was taken
  secondsBeforeExpiry: number;
  
  // Position state (from Polymarket API - ground truth)
  apiUpQty: number;
  apiDownQty: number;
  apiUpCost: number;
  apiDownCost: number;
  
  // Local state (for comparison/debugging)
  localUpQty: number;
  localDownQty: number;
  localUpCost: number;
  localDownCost: number;
  
  // Calculated metrics
  paired: number;
  unpaired: number;
  combinedCost: number;
  lockedProfit: number;
  avgUpPrice: number;
  avgDownPrice: number;
  
  // Orderbook state at snapshot time
  upBestBid: number | null;
  upBestAsk: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  combinedAsk: number | null;
  
  // Order counts
  upOrdersCount: number;
  downOrdersCount: number;
  
  // State flags
  wasImbalanced: boolean;
  imbalanceRatio: number | null;
}

// ============================================================
// SCHEDULED SNAPSHOT MANAGER
// ============================================================

// Track scheduled timeouts per market
const scheduledSnapshots = new Map<string, NodeJS.Timeout>();

// Callback for when snapshot is captured
type SnapshotCallback = (snapshot: V35ExpirySnapshot) => void;
let onSnapshotCallback: SnapshotCallback | null = null;

/**
 * Set the callback function that will be called when a snapshot is captured
 */
export function setSnapshotCallback(callback: SnapshotCallback): void {
  onSnapshotCallback = callback;
}

/**
 * Schedule a snapshot to be taken 1 second before market expiry
 */
export function scheduleExpirySnapshot(market: V35Market): void {
  const slug = market.slug;
  
  // Cancel any existing scheduled snapshot for this market
  if (scheduledSnapshots.has(slug)) {
    clearTimeout(scheduledSnapshots.get(slug)!);
    scheduledSnapshots.delete(slug);
  }
  
  const now = Date.now();
  const expiryMs = market.expiry.getTime();
  const snapshotTime = expiryMs - 1000; // 1 second before expiry
  const delayMs = snapshotTime - now;
  
  // Only schedule if there's time left
  if (delayMs <= 0) {
    console.log(`[ExpirySnapshot] Market ${slug.slice(-25)} already expired, skipping schedule`);
    return;
  }
  
  console.log(`[ExpirySnapshot] Scheduled snapshot for ${slug.slice(-25)} in ${(delayMs / 1000).toFixed(0)}s`);
  
  const timeout = setTimeout(() => {
    captureSnapshot(market);
    scheduledSnapshots.delete(slug);
  }, delayMs);
  
  scheduledSnapshots.set(slug, timeout);
}

/**
 * Cancel a scheduled snapshot for a market
 */
export function cancelExpirySnapshot(slug: string): void {
  if (scheduledSnapshots.has(slug)) {
    clearTimeout(scheduledSnapshots.get(slug)!);
    scheduledSnapshots.delete(slug);
    console.log(`[ExpirySnapshot] Cancelled snapshot for ${slug.slice(-25)}`);
  }
}

/**
 * Cancel all scheduled snapshots
 */
export function cancelAllExpirySnapshots(): void {
  for (const [slug, timeout] of scheduledSnapshots.entries()) {
    clearTimeout(timeout);
    console.log(`[ExpirySnapshot] Cancelled snapshot for ${slug.slice(-25)}`);
  }
  scheduledSnapshots.clear();
}

/**
 * Get count of scheduled snapshots
 */
export function getScheduledSnapshotCount(): number {
  return scheduledSnapshots.size;
}

// ============================================================
// SNAPSHOT CAPTURE
// ============================================================

/**
 * Capture the market state snapshot
 * Called exactly 1 second before market expiry
 */
function captureSnapshot(market: V35Market): void {
  const now = new Date();
  const secondsBeforeExpiry = (market.expiry.getTime() - now.getTime()) / 1000;
  
  console.log(`📸 [ExpirySnapshot] Capturing final state for ${market.slug.slice(-25)} (${secondsBeforeExpiry.toFixed(1)}s before expiry)`);
  
  // Get ground truth from Polymarket API
  const apiPosition = getCachedPosition(market.slug);
  
  // Use API values if available, otherwise fall back to local
  const apiUpQty = apiPosition?.upShares ?? market.upQty;
  const apiDownQty = apiPosition?.downShares ?? market.downQty;
  const apiUpCost = apiPosition?.upCost ?? market.upCost;
  const apiDownCost = apiPosition?.downCost ?? market.downCost;
  
  // Calculate metrics from API values (ground truth)
  const avgUpPrice = apiUpQty > 0 ? apiUpCost / apiUpQty : 0;
  const avgDownPrice = apiDownQty > 0 ? apiDownCost / apiDownQty : 0;
  const paired = Math.min(apiUpQty, apiDownQty);
  const unpaired = Math.abs(apiUpQty - apiDownQty);
  const combinedCost = (apiUpQty > 0 && apiDownQty > 0) ? avgUpPrice + avgDownPrice : 0;
  const lockedProfit = (combinedCost > 0 && combinedCost < 1.0) ? paired * (1.0 - combinedCost) : 0;
  
  // Calculate imbalance ratio
  const minQty = Math.min(apiUpQty, apiDownQty);
  const maxQty = Math.max(apiUpQty, apiDownQty);
  const imbalanceRatio = minQty > 0 ? maxQty / minQty : null;
  
  // Orderbook state
  const combinedAsk = (market.upBestAsk > 0 && market.downBestAsk > 0)
    ? market.upBestAsk + market.downBestAsk
    : null;
  
  const snapshot: V35ExpirySnapshot = {
    marketSlug: market.slug,
    asset: market.asset,
    expiryTime: market.expiry.toISOString(),
    snapshotTime: now.toISOString(),
    secondsBeforeExpiry,
    
    // API ground truth
    apiUpQty,
    apiDownQty,
    apiUpCost,
    apiDownCost,
    
    // Local state for comparison
    localUpQty: market.upQty,
    localDownQty: market.downQty,
    localUpCost: market.upCost,
    localDownCost: market.downCost,
    
    // Metrics
    paired,
    unpaired,
    combinedCost,
    lockedProfit,
    avgUpPrice,
    avgDownPrice,
    
    // Orderbook
    upBestBid: market.upBestBid > 0 ? market.upBestBid : null,
    upBestAsk: market.upBestAsk > 0 && market.upBestAsk < 1 ? market.upBestAsk : null,
    downBestBid: market.downBestBid > 0 ? market.downBestBid : null,
    downBestAsk: market.downBestAsk > 0 && market.downBestAsk < 1 ? market.downBestAsk : null,
    combinedAsk,
    
    // Orders
    upOrdersCount: market.upOrders.size,
    downOrdersCount: market.downOrders.size,
    
    // Flags
    wasImbalanced: unpaired >= 10,
    imbalanceRatio,
  };
  
  // Log summary
  console.log(`📸 [ExpirySnapshot] ${market.slug.slice(-25)}:`);
  console.log(`   📊 API State: UP=${apiUpQty.toFixed(1)} DOWN=${apiDownQty.toFixed(1)}`);
  console.log(`   💰 Paired: ${paired.toFixed(0)} | CPP: $${combinedCost.toFixed(4)} | Locked: $${lockedProfit.toFixed(2)}`);
  if (unpaired >= 5) {
    console.log(`   ⚠️ Unpaired: ${unpaired.toFixed(1)} shares (ratio: ${imbalanceRatio?.toFixed(1) ?? 'N/A'}:1)`);
  }
  
  // Call the callback to persist
  if (onSnapshotCallback) {
    onSnapshotCallback(snapshot);
  }
}
