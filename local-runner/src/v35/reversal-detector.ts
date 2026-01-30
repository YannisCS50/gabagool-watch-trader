// ============================================================
// V36 REVERSAL DETECTOR - BINANCE-BASED STOP-LOSS
// ============================================================
// Version: V36.1.0 - "Binance Lead Indicator"
//
// CORE CONCEPT:
// Binance price feed LEADS Polymarket by a few seconds.
// When Binance shows a significant adverse move:
// 1. The "expensive" side is about to become cheap (winner → loser)
// 2. We need to EMERGENCY HEDGE before the Polymarket price updates
// 3. This prevents holding an unhedged losing position
//
// TRIGGER CONDITIONS:
// - Binance shows >0.20% move in the WRONG direction
// - We have pending pairs waiting for maker fill
// - The maker order hasn't filled yet
//
// ACTION:
// - Cancel the passive maker order
// - Place TAKER order at current ask to close position
// - Accept small loss (~2-5%) instead of full loss (50-100%)
// ============================================================

import { getBinanceFeed, type V35Asset } from './binance-feed.js';
import { getPairTracker, type PendingPair } from './pair-tracker.js';
import type { V35Market, V35Side } from './types.js';
import { logV35GuardEvent } from './backend.js';

// ============================================================
// CONFIGURATION
// ============================================================

export interface ReversalDetectorConfig {
  // Threshold for detecting reversals (percentage)
  reversalThresholdPct: number;      // e.g., 0.20 = 0.20%
  
  // Minimum momentum to consider it a trend
  minMomentumPct: number;            // e.g., 0.10 = 0.10%
  
  // How often to check for reversals (ms)
  checkIntervalMs: number;
  
  // Cooldown after triggering emergency (ms)
  cooldownAfterEmergencyMs: number;
}

const DEFAULT_CONFIG: ReversalDetectorConfig = {
  reversalThresholdPct: 0.20,
  minMomentumPct: 0.10,
  checkIntervalMs: 200,
  cooldownAfterEmergencyMs: 5000,
};

// ============================================================
// REVERSAL DETECTOR CLASS
// ============================================================

export class ReversalDetector {
  private config: ReversalDetectorConfig;
  private lastCheckMs = 0;
  private lastEmergencyMs = 0;
  private previousMomentum: Map<V35Asset, number> = new Map();
  
  constructor(config: Partial<ReversalDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Check for reversals and trigger emergency hedges if needed
   */
  async checkForReversals(market: V35Market): Promise<{
    reversalDetected: boolean;
    emergencyTriggered: boolean;
    reason?: string;
  }> {
    const now = Date.now();
    
    // Rate limit checks
    if (now - this.lastCheckMs < this.config.checkIntervalMs) {
      return { reversalDetected: false, emergencyTriggered: false };
    }
    this.lastCheckMs = now;
    
    // Cooldown after emergency
    if (now - this.lastEmergencyMs < this.config.cooldownAfterEmergencyMs) {
      return { reversalDetected: false, emergencyTriggered: false, reason: 'emergency_cooldown' };
    }
    
    // Get Binance feed
    const binance = getBinanceFeed();
    if (!binance.isHealthy()) {
      return { reversalDetected: false, emergencyTriggered: false, reason: 'binance_unhealthy' };
    }
    
    // Get current momentum
    const momentum = binance.getMomentum(market.asset);
    const direction = binance.getTrendDirection(market.asset);
    const previousMomentum = this.previousMomentum.get(market.asset) || 0;
    
    // Store for next check
    this.previousMomentum.set(market.asset, momentum);
    
    // Get pair tracker
    const pairTracker = getPairTracker();
    const activePairs = pairTracker.getMarketPairs(market.slug)
      .filter(p => p.status === 'WAITING_HEDGE');
    
    if (activePairs.length === 0) {
      return { reversalDetected: false, emergencyTriggered: false, reason: 'no_pending_pairs' };
    }
    
    // Check each pending pair for reversal risk
    for (const pair of activePairs) {
      const reversalResult = await this.checkPairReversal(pair, market, momentum, direction, previousMomentum);
      
      if (reversalResult.emergencyTriggered) {
        this.lastEmergencyMs = now;
        return reversalResult;
      }
    }
    
    return { reversalDetected: false, emergencyTriggered: false };
  }
  
  /**
   * Check if a specific pair needs emergency hedging
   */
  private async checkPairReversal(
    pair: PendingPair,
    market: V35Market,
    currentMomentum: number,
    direction: 'UP' | 'DOWN' | 'NEUTRAL',
    previousMomentum: number
  ): Promise<{
    reversalDetected: boolean;
    emergencyTriggered: boolean;
    reason?: string;
  }> {
    // Determine which direction is BAD for our position
    // If we bought the expensive side (e.g., UP), a DOWN move is bad
    // If we bought the expensive side (e.g., DOWN), an UP move is bad
    const badDirection: 'UP' | 'DOWN' = pair.takerSide === 'UP' ? 'DOWN' : 'UP';
    
    // Check if momentum is moving against us
    const isBadDirection = direction === badDirection;
    const momentumChange = Math.abs(currentMomentum - previousMomentum);
    const isStrongMove = Math.abs(currentMomentum) >= this.config.minMomentumPct;
    
    // REVERSAL DETECTION:
    // 1. Momentum is in the BAD direction
    // 2. Momentum is strong enough
    // 3. Momentum changed significantly (sudden move)
    const isReversal = isBadDirection && isStrongMove && momentumChange >= this.config.reversalThresholdPct;
    
    if (!isReversal) {
      return { reversalDetected: false, emergencyTriggered: false };
    }
    
    console.log(`[ReversalDetector] 🚨 REVERSAL DETECTED for ${pair.id}!`);
    console.log(`[ReversalDetector]    Binance: ${direction} ${currentMomentum.toFixed(3)}% (change: ${momentumChange.toFixed(3)}%)`);
    console.log(`[ReversalDetector]    Our position: ${pair.takerSide} is now at risk!`);
    
    // Log the event
    logV35GuardEvent({
      marketSlug: market.slug,
      asset: market.asset,
      guardType: 'REVERSAL_DETECTED',
      blockedSide: pair.takerSide,
      upQty: market.upQty,
      downQty: market.downQty,
      expensiveSide: pair.takerSide,
      reason: `Binance reversal: ${direction} ${currentMomentum.toFixed(3)}%`,
    }).catch(() => {});
    
    // Get current ask for emergency hedge
    const currentAsk = pair.makerSide === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Trigger emergency hedge
    const pairTracker = getPairTracker();
    const result = await pairTracker.triggerEmergencyHedge(pair, market, currentAsk);
    
    if (result.success) {
      console.log(`[ReversalDetector] ✅ Emergency hedge triggered for ${pair.id}`);
      return { reversalDetected: true, emergencyTriggered: true };
    } else {
      console.log(`[ReversalDetector] ⚠️ Emergency hedge failed: ${result.error}`);
      return { reversalDetected: true, emergencyTriggered: false, reason: result.error };
    }
  }
  
  /**
   * Get status summary
   */
  getStatus(): {
    lastCheckMs: number;
    lastEmergencyMs: number;
    momentumByAsset: Record<string, number>;
  } {
    const binance = getBinanceFeed();
    const momentumByAsset: Record<string, number> = {};
    
    for (const [asset, momentum] of this.previousMomentum.entries()) {
      momentumByAsset[asset] = momentum;
    }
    
    return {
      lastCheckMs: this.lastCheckMs,
      lastEmergencyMs: this.lastEmergencyMs,
      momentumByAsset,
    };
  }
  
  /**
   * Configure thresholds
   */
  configure(config: Partial<ReversalDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Reset state
   */
  reset(): void {
    this.lastCheckMs = 0;
    this.lastEmergencyMs = 0;
    this.previousMomentum.clear();
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let detectorInstance: ReversalDetector | null = null;

export function getReversalDetector(): ReversalDetector {
  if (!detectorInstance) {
    detectorInstance = new ReversalDetector();
  }
  return detectorInstance;
}

export function resetReversalDetector(): void {
  if (detectorInstance) {
    detectorInstance.reset();
  }
  detectorInstance = null;
}
