/**
 * V29 Response-Based Strategy - Exit Monitor
 * 
 * CRITICAL: Exit based on POLYMARKET PRICE RESPONSE, not time.
 * 
 * EXIT CONDITIONS (first to trigger wins):
 * 1. TARGET RESPONSE: Unrealized profit reaches target (UP: 1.8-2.0¢, DOWN: 2.0-2.4¢)
 * 2. REPRICING EXHAUSTION: ≥65-70% of expected repricing + price stall
 * 3. ADVERSE SELECTION: Spread widens beyond threshold OR taker surge
 * 4. HARD TIME STOP: Last resort (UP: 6s, DOWN: 7s)
 */

import type { V29Config, Direction, DirectionConfig } from './config.js';
import type { ActivePosition, PriceState } from './types.js';

// ============================================
// EXIT DECISION
// ============================================

export type ExitType = 'target' | 'exhaustion' | 'adverse' | 'timeout';

export interface ExitDecision {
  shouldExit: boolean;
  type?: ExitType;
  reason?: string;
  unrealizedPnl?: number;  // in cents
}

// ============================================
// CORE EXIT LOGIC
// ============================================

/**
 * Check if position should be exited.
 * Called every 100ms while position is open.
 */
export function checkExit(
  position: ActivePosition,
  config: V29Config,
  priceState: PriceState,
  logFn: (msg: string, data?: Record<string, unknown>) => void
): ExitDecision {
  const now = Date.now();
  const holdTimeMs = now - position.entryTime;
  const holdTimeSec = holdTimeMs / 1000;
  
  const dirConfig: DirectionConfig = position.direction === 'UP' ? config.up : config.down;
  
  // Get current share price
  const currentBestBid = position.direction === 'UP' 
    ? priceState.upBestBid 
    : priceState.downBestBid;
  
  const currentBestAsk = position.direction === 'UP'
    ? priceState.upBestAsk
    : priceState.downBestAsk;
  
  if (!currentBestBid || currentBestBid <= 0) {
    // No orderbook - don't exit yet, wait for data
    return { shouldExit: false };
  }
  
  // Calculate unrealized P&L (selling at bid)
  const unrealizedPnlCents = (currentBestBid - position.entryPrice) * 100;
  
  // Update position tracking
  position.lastPrice = currentBestBid;
  position.lastPriceTs = now;
  
  // Track max price seen
  if (currentBestBid > position.maxPriceSeen) {
    position.maxPriceSeen = currentBestBid;
  }
  
  // Calculate total repricing
  position.totalRepricing = (currentBestBid - position.priceAtEntry) * 100;
  
  // Update price history for stall detection
  position.priceHistory.push({ price: currentBestBid, ts: now });
  // Keep only last 2 seconds
  position.priceHistory = position.priceHistory.filter(p => p.ts >= now - 2000);
  
  // ============================================
  // EXIT CONDITION 1: TARGET RESPONSE ACHIEVED
  // ============================================
  
  // Use target range: exit if within target window
  const targetMin = dirConfig.target_profit_cents_min;
  const targetMax = dirConfig.target_profit_cents_max;
  
  if (unrealizedPnlCents >= targetMin) {
    logFn(`✅ EXIT TARGET: ${position.asset} ${position.direction} +${unrealizedPnlCents.toFixed(2)}¢ (target ${targetMin}-${targetMax}¢)`, {
      positionId: position.id,
      unrealizedPnlCents,
      holdTimeSec,
    });
    
    return {
      shouldExit: true,
      type: 'target',
      reason: `profit=${unrealizedPnlCents.toFixed(2)}¢`,
      unrealizedPnl: unrealizedPnlCents,
    };
  }
  
  // ============================================
  // EXIT CONDITION 2: REPRICING EXHAUSTION
  // ============================================
  
  const repricingPct = position.totalRepricing / dirConfig.expected_repricing_cents;
  
  if (repricingPct >= dirConfig.repricing_exhaustion_pct) {
    // Check for price stall
    const priceChangeLastSec = calculatePriceChangePerSec(position.priceHistory);
    
    if (priceChangeLastSec < dirConfig.stall_threshold_cents_per_sec) {
      logFn(`⏸️ EXIT EXHAUSTION: ${position.asset} ${position.direction} | repriced ${(repricingPct * 100).toFixed(0)}% + stall (${priceChangeLastSec.toFixed(2)}¢/s)`, {
        positionId: position.id,
        repricingPct,
        priceChangeLastSec,
        unrealizedPnlCents,
        holdTimeSec,
      });
      
      return {
        shouldExit: true,
        type: 'exhaustion',
        reason: `repriced=${(repricingPct * 100).toFixed(0)}%, stall=${priceChangeLastSec.toFixed(2)}¢/s`,
        unrealizedPnl: unrealizedPnlCents,
      };
    }
  }
  
  // ============================================
  // EXIT CONDITION 3: ADVERSE SELECTION
  // ============================================
  
  if (currentBestAsk && currentBestBid) {
    const currentSpreadCents = (currentBestAsk - currentBestBid) * 100;
    
    if (currentSpreadCents > config.adverse_spread_threshold_cents) {
      logFn(`⚠️ EXIT ADVERSE: ${position.asset} ${position.direction} | spread widened to ${currentSpreadCents.toFixed(1)}¢`, {
        positionId: position.id,
        currentSpreadCents,
        unrealizedPnlCents,
        holdTimeSec,
      });
      
      return {
        shouldExit: true,
        type: 'adverse',
        reason: `spread=${currentSpreadCents.toFixed(1)}¢`,
        unrealizedPnl: unrealizedPnlCents,
      };
    }
  }
  
  // ============================================
  // EXIT CONDITION 4: HARD TIME STOP (LAST RESORT)
  // ============================================
  
  if (holdTimeSec >= dirConfig.max_hold_seconds) {
    logFn(`⏰ EXIT TIMEOUT: ${position.asset} ${position.direction} | held ${holdTimeSec.toFixed(1)}s (max ${dirConfig.max_hold_seconds}s)`, {
      positionId: position.id,
      holdTimeSec,
      unrealizedPnlCents,
    });
    
    return {
      shouldExit: true,
      type: 'timeout',
      reason: `held=${holdTimeSec.toFixed(1)}s`,
      unrealizedPnl: unrealizedPnlCents,
    };
  }
  
  // No exit condition met
  return { shouldExit: false, unrealizedPnl: unrealizedPnlCents };
}

// ============================================
// HELPER: PRICE CHANGE PER SECOND
// ============================================

function calculatePriceChangePerSec(
  history: Array<{ price: number; ts: number }>
): number {
  if (history.length < 2) return 999;  // Not enough data = assume still moving
  
  // Get oldest and newest in last 1 second
  const now = history[history.length - 1].ts;
  const oneSecAgo = now - 1000;
  
  const recentHistory = history.filter(p => p.ts >= oneSecAgo);
  
  if (recentHistory.length < 2) {
    // Not enough data in last second
    return 999;
  }
  
  const oldest = recentHistory[0];
  const newest = recentHistory[recentHistory.length - 1];
  
  const priceChange = Math.abs(newest.price - oldest.price) * 100;  // in cents
  const timeSpan = (newest.ts - oldest.ts) / 1000;  // in seconds
  
  if (timeSpan < 0.1) return 999;  // Too short
  
  return priceChange / timeSpan;
}

// ============================================
// CREATE POSITION TRACKER
// ============================================

export function createPositionTracker(
  signal: any,
  asset: any,
  direction: any,
  marketSlug: string,
  tokenId: string,
  shares: number,
  entryPrice: number,
  orderId?: string
): ActivePosition {
  const now = Date.now();
  
  return {
    id: signal.id,
    signal,
    
    asset,
    direction,
    marketSlug,
    tokenId,
    
    shares,
    entryPrice,
    totalCost: shares * entryPrice,
    entryTime: now,
    orderId,
    
    priceAtEntry: entryPrice,
    lastPrice: entryPrice,
    lastPriceTs: now,
    
    maxPriceSeen: entryPrice,
    totalRepricing: 0,
    
    priceHistory: [{ price: entryPrice, ts: now }],
  };
}
