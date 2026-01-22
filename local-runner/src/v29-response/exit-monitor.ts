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

export type ExitType = 'target' | 'trailing' | 'exhaustion' | 'stagnation' | 'adverse' | 'timeout';

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
  currentPriceToStrikeDelta: number,  // Current price - strike (for momentum tracking)
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
  // PRICE-TO-STRIKE DELTA MOMENTUM TRACKING (User requested 2026-01-22)
  // Track if price-to-strike delta is growing in our direction
  // UP trade: delta should be increasing (price moving further above strike)
  // DOWN trade: delta should be decreasing (price moving further below strike)
  // ============================================
  let momentumContinues = false;
  
  if (config.delta_momentum_hold_enabled && currentPriceToStrikeDelta !== 0) {
    // Initialize maxDeltaInDirection if not set
    if (position.maxDeltaInDirection === undefined) {
      position.maxDeltaInDirection = position.initialDelta || currentPriceToStrikeDelta;
    }
    
    // Check if delta is moving favorably for our position
    if (position.direction === 'UP') {
      // For UP trades: delta growing more positive = momentum continues
      if (currentPriceToStrikeDelta > position.maxDeltaInDirection) {
        const growth = currentPriceToStrikeDelta - position.maxDeltaInDirection;
        if (growth >= (config.delta_momentum_min_growth || 5)) {
          momentumContinues = true;
          position.maxDeltaInDirection = currentPriceToStrikeDelta;
          logFn(`🚀 MOMENTUM UP: ${position.asset} | Δ grew +$${growth.toFixed(0)} to +$${currentPriceToStrikeDelta.toFixed(0)} (extending hold)`, {
            positionId: position.id,
            initialDelta: position.initialDelta,
            currentDelta: currentPriceToStrikeDelta,
            growth,
          });
        }
      }
    } else {
      // For DOWN trades: delta growing more negative = momentum continues
      if (currentPriceToStrikeDelta < position.maxDeltaInDirection) {
        const growth = Math.abs(currentPriceToStrikeDelta - position.maxDeltaInDirection);
        if (growth >= (config.delta_momentum_min_growth || 5)) {
          momentumContinues = true;
          position.maxDeltaInDirection = currentPriceToStrikeDelta;
          logFn(`🚀 MOMENTUM DOWN: ${position.asset} | Δ fell -$${growth.toFixed(0)} to $${currentPriceToStrikeDelta.toFixed(0)} (extending hold)`, {
            positionId: position.id,
            initialDelta: position.initialDelta,
            currentDelta: currentPriceToStrikeDelta,
            growth,
          });
        }
      }
    }
  }
  
  // ============================================
  // EXIT CONDITION 1: TARGET / TRAILING PROFIT
  // ============================================
  
  // Use target range: exit if within target window
  const targetMin = dirConfig.target_profit_cents_min;
  const targetMax = dirConfig.target_profit_cents_max;
  
  // TRAILING PROFIT LOGIC
  if (dirConfig.trailing_enabled && unrealizedPnlCents >= dirConfig.trailing_start_cents) {
    // Calculate max unrealized P&L (from max price seen)
    const maxUnrealizedPnlCents = (position.maxPriceSeen - position.entryPrice) * 100;
    
    // Calculate pullback from max
    const pullbackCents = maxUnrealizedPnlCents - unrealizedPnlCents;
    
    // If we've pulled back too much from max, exit to lock in profit
    if (pullbackCents >= dirConfig.trailing_pullback_cents && unrealizedPnlCents > 0) {
      logFn(`📈 EXIT TRAILING: ${position.asset} ${position.direction} +${unrealizedPnlCents.toFixed(2)}¢ (max was +${maxUnrealizedPnlCents.toFixed(2)}¢, pullback ${pullbackCents.toFixed(2)}¢)`, {
        positionId: position.id,
        unrealizedPnlCents,
        maxUnrealizedPnlCents,
        pullbackCents,
        holdTimeSec,
      });
      
      return {
        shouldExit: true,
        type: 'trailing',
        reason: `trail: +${unrealizedPnlCents.toFixed(1)}¢ (max +${maxUnrealizedPnlCents.toFixed(1)}¢)`,
        unrealizedPnl: unrealizedPnlCents,
      };
    }
    
    // Dynamic target: raise target based on how far we've gone
    // Every trailing_step_cents of profit above start, raise the min target
    const stepsAboveStart = Math.floor((maxUnrealizedPnlCents - dirConfig.trailing_start_cents) / dirConfig.trailing_step_cents);
    const dynamicTargetMin = targetMin + (stepsAboveStart * 0.5);  // Raise by 0.5¢ per step
    
    // If we're still above dynamic target, let it ride (don't exit yet)
    if (unrealizedPnlCents >= dynamicTargetMin && pullbackCents < dirConfig.trailing_pullback_cents) {
      // Still in trailing mode, don't exit
      return { shouldExit: false, unrealizedPnl: unrealizedPnlCents };
    }
  }
  
  // FIXED TARGET: Exit if we hit target without trailing
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
  // EXIT CONDITION 2b: STAGNATION DETECTION (NEW)
  // ============================================
  // Analysis showed: losers have ~+2.6% at 1s then ~+2.8% at 5s (stagnation)
  // Winners show: ~+4.7% at 1s then ~+5.6% at 5s (momentum continues)
  // If we're past the stagnation check time and price hasn't improved much, exit early
  
  if (dirConfig.stagnation_check_after_ms && dirConfig.stagnation_threshold_cents) {
    if (holdTimeMs >= dirConfig.stagnation_check_after_ms) {
      // Check if price has improved since ~1 second in
      const priceAt1s = position.priceHistory.find(p => 
        p.ts >= position.entryTime + 900 && p.ts <= position.entryTime + 1100
      );
      
      if (priceAt1s) {
        const improvementSince1s = (currentBestBid - priceAt1s.price) * 100;
        
        // If we're in profit at 1s but haven't improved much since then → stagnation
        const profitAt1s = (priceAt1s.price - position.entryPrice) * 100;
        
        if (profitAt1s > 0 && improvementSince1s < dirConfig.stagnation_threshold_cents) {
          logFn(`📉 EXIT STAGNATION: ${position.asset} ${position.direction} | profit@1s=${profitAt1s.toFixed(2)}¢, improvement since=${improvementSince1s.toFixed(2)}¢ (threshold=${dirConfig.stagnation_threshold_cents}¢)`, {
            positionId: position.id,
            profitAt1s,
            improvementSince1s,
            holdTimeSec,
            unrealizedPnlCents,
          });
          
          return {
            shouldExit: true,
            type: 'stagnation',
            reason: `stagnated: +${profitAt1s.toFixed(1)}¢@1s, +${improvementSince1s.toFixed(1)}¢ since`,
            unrealizedPnl: unrealizedPnlCents,
          };
        }
      }
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
  // Modified for DELTA MOMENTUM: Extend hold time if momentum continues
  // ============================================
  
  // Calculate effective max hold time (base + momentum extension)
  const baseMaxHold = dirConfig.max_hold_seconds;
  let effectiveMaxHold = baseMaxHold;
  
  if (config.delta_momentum_hold_enabled && momentumContinues) {
    // Allow extending hold time up to the max extension
    const remainingExtension = config.delta_momentum_max_extension_seconds - (position.momentumExtensionUsed || 0);
    
    if (remainingExtension > 0) {
      // Extend by 1 second per momentum check
      const extensionThisCheck = Math.min(1, remainingExtension);
      position.momentumExtensionUsed = (position.momentumExtensionUsed || 0) + extensionThisCheck;
      effectiveMaxHold = baseMaxHold + position.momentumExtensionUsed;
      
      logFn(`⏳ MOMENTUM EXTENSION: ${position.asset} ${position.direction} | hold extended to ${effectiveMaxHold.toFixed(1)}s (used ${position.momentumExtensionUsed.toFixed(1)}s of ${config.delta_momentum_max_extension_seconds}s)`, {
        positionId: position.id,
        baseMaxHold,
        effectiveMaxHold,
        momentumExtensionUsed: position.momentumExtensionUsed,
        holdTimeSec,
      });
    }
  }
  
  if (holdTimeSec >= effectiveMaxHold) {
    logFn(`⏰ EXIT TIMEOUT: ${position.asset} ${position.direction} | held ${holdTimeSec.toFixed(1)}s (max ${effectiveMaxHold.toFixed(1)}s, base ${baseMaxHold}s)`, {
      positionId: position.id,
      holdTimeSec,
      baseMaxHold,
      effectiveMaxHold,
      momentumExtensionUsed: position.momentumExtensionUsed || 0,
      unrealizedPnlCents,
    });
    
    return {
      shouldExit: true,
      type: 'timeout',
      reason: `held=${holdTimeSec.toFixed(1)}s (max=${effectiveMaxHold.toFixed(1)}s)`,
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
  initialPriceToStrikeDelta: number,  // Delta when position opened
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
    
    // PRICE-TO-STRIKE DELTA MOMENTUM TRACKING (User requested 2026-01-22)
    initialDelta: initialPriceToStrikeDelta,
    maxDeltaInDirection: initialPriceToStrikeDelta,
    momentumExtensionUsed: 0,
  };
}
