/**
 * V30 Edge Calculator
 * 
 * Calculates edge (Δ) and dynamic threshold (θ)
 * Edge = market price - fair value
 * Negative edge = underpriced = BUY signal
 * 
 * IMPROVED:
 * - Edge-aware force counter (don't hedge against strong edge)
 * - Better threshold dynamics
 * - Cost-aware hedging with minimum thresholds
 */

import type { V30Config, EdgeResult, Inventory, FairValueResult } from './types.js';

export class EdgeCalculator {
  private config: V30Config;

  constructor(config: V30Config) {
    this.config = config;
  }

  /**
   * Calculate edges for both sides
   * 
   * CRITICAL FIX: Also check that fair value is high enough to trade!
   * With delta=-$113, P(UP wins) might be <5% - never buy UP regardless of price!
   */
  calculateEdge(
    upBestAsk: number,
    downBestAsk: number,
    fairValue: FairValueResult,
    inventory: Inventory,
    secRemaining: number
  ): EdgeResult {
    // Edge calculation
    // Δ_up = q_up - p_up (what we pay minus fair value)
    // Δ_down = q_down - p_down
    // Negative = underpriced = good to buy
    const edge_up = upBestAsk - fairValue.p_up;
    const edge_down = downBestAsk - fairValue.p_down;

    // Dynamic threshold
    const theta = this.calculateThreshold(secRemaining, inventory);

    // ===========================================
    // CRITICAL: MINIMUM FAIR VALUE CHECK
    // ===========================================
    // Never trade a side where fair value is too low!
    // Even if price is "cheap", if fair value is <10%, 
    // we're almost certainly going to lose.
    //
    // Example: delta=-$113, P(UP)=3%, UP price=5¢
    //   Edge = 5¢ - 3¢ = +2¢ (overpriced, no signal anyway)
    //   BUT even if edge was negative, we shouldn't trade!
    //
    // Minimum thresholds:
    // - High confidence (crossing model validated): 10%
    // - Low confidence (heuristic): 15% (more conservative)
    const minFairValue = fairValue.confidence > 0.5 
      ? this.config.min_fair_value_to_trade ?? 0.10
      : this.config.min_fair_value_to_trade_low_confidence ?? 0.15;
    
    // Signal generation
    // Buy if:
    // 1. Edge is negative enough (price below fair value by more than theta)
    // 2. Fair value is high enough to be worth trading
    const signal_up = edge_up < -theta && fairValue.p_up >= minFairValue;
    const signal_down = edge_down < -theta && fairValue.p_down >= minFairValue;

    return {
      edge_up,
      edge_down,
      theta,
      signal_up,
      signal_down,
      // Include fair values for debugging
      fair_p_up: fairValue.p_up,
      fair_p_down: fairValue.p_down,
      min_fair_value_used: minFairValue,
      confidence: fairValue.confidence,
    };
  }

  /**
   * Calculate dynamic threshold θ(τ, I)
   * 
   * θ adjusts based on:
   * - Time remaining (τ): Lower threshold near expiry (more aggressive)
   * - Inventory (I): Higher threshold when holding large positions (more conservative)
   */
  calculateThreshold(secRemaining: number, inventory: Inventory): number {
    let theta = this.config.base_theta;

    // Time decay: threshold decreases as we approach expiry
    // At τ=900s: multiplier = 1.0
    // At τ=0s: multiplier = 1 - time_decay_factor
    const timeProgress = (900 - secRemaining) / 900;
    const timeMultiplier = 1 - (this.config.theta_time_decay_factor * timeProgress);
    theta *= Math.max(0.3, timeMultiplier); // Min 30% of base

    // Inventory pressure: threshold increases with net exposure
    // At I=0: multiplier = 1.0
    // At I=i_max: multiplier = 1 + inventory_factor
    const inventoryRatio = Math.abs(inventory.net) / inventory.i_max;
    const inventoryMultiplier = 1 + (this.config.theta_inventory_factor * inventoryRatio);
    theta *= inventoryMultiplier;

    return theta;
  }

  /**
   * Check if we should force a counter-bet to reduce inventory
   * 
   * IMPROVED: Edge-aware force counter
   * 
   * Key insight: Don't force counter if edge strongly supports current position
   * - If we're long UP and edge_up is very negative (UP underpriced), hold position
   * - Only force counter when edge is neutral or against us
   * 
   * Also checks:
   * - Only force counter for "expensive" positions (high cost side)
   * - Cheap side exposure (e.g. 130 shares @ 10¢ = $13 risk) doesn't need aggressive hedging
   */
  shouldForceCounter(
    inventory: Inventory,
    edgeResult?: EdgeResult,
    upAvgPrice?: number,
    downAvgPrice?: number
  ): { 
    force: boolean; 
    direction: 'UP' | 'DOWN' | null;
    reason: string;
  } {
    const ratio = Math.abs(inventory.net) / inventory.i_max;
    
    // Not at threshold yet
    if (ratio < this.config.force_counter_at_pct) {
      return { force: false, direction: null, reason: '' };
    }

    // Determine which side has more shares
    const dominantSide = inventory.net > 0 ? 'UP' : 'DOWN';
    const dominantShares = inventory.net > 0 ? inventory.up : inventory.down;
    const dominantAvgPrice = inventory.net > 0 ? (upAvgPrice ?? 0.5) : (downAvgPrice ?? 0.5);
    
    // ============================================
    // EDGE-AWARE CHECK
    // ============================================
    // If edge strongly supports our position, don't force counter!
    if (edgeResult) {
      const dominantEdge = dominantSide === 'UP' ? edgeResult.edge_up : edgeResult.edge_down;
      const oppositeEdge = dominantSide === 'UP' ? edgeResult.edge_down : edgeResult.edge_up;
      
      // Strong edge in our favor: edge < -2*theta (double the normal threshold)
      const strongEdgeThreshold = -2 * edgeResult.theta;
      
      if (dominantEdge < strongEdgeThreshold) {
        return {
          force: false,
          direction: null,
          reason: `Edge supports ${dominantSide} (${(dominantEdge * 100).toFixed(1)}% < ${(strongEdgeThreshold * 100).toFixed(1)}%), holding position`
        };
      }
      
      // If opposite side has negative edge (underpriced), then counter makes sense
      // But if opposite side is overpriced (positive edge), don't force buy it
      if (oppositeEdge > edgeResult.theta) {
        return {
          force: false,
          direction: null,
          reason: `Counter side ${dominantSide === 'UP' ? 'DOWN' : 'UP'} overpriced (${(oppositeEdge * 100).toFixed(1)}%), skipping hedge`
        };
      }
    }
    
    // ============================================
    // COST-AWARE CHECK
    // ============================================
    // Calculate actual dollar exposure at risk
    // If we bought cheap (e.g. 10¢), max loss is only 10¢ per share
    const exposureAtRisk = dominantShares * dominantAvgPrice;
    
    // Only force counter if exposure > $50 AND avg price > 40¢ (expensive side)
    // Cheap side (< 40¢) has limited downside, no need to panic hedge
    if (dominantAvgPrice < 0.40) {
      return { 
        force: false, 
        direction: null, 
        reason: `Cheap side (${(dominantAvgPrice * 100).toFixed(0)}¢) - limited downside, no hedge needed` 
      };
    }
    
    // Even for expensive side, only hedge if exposure is significant
    if (exposureAtRisk < 50) {
      return { 
        force: false, 
        direction: null, 
        reason: `Low exposure ($${exposureAtRisk.toFixed(0)}) - no hedge needed` 
      };
    }

    // ============================================
    // FORCE COUNTER APPROVED
    // ============================================
    // Force buy opposite direction
    const direction = inventory.net > 0 ? 'DOWN' : 'UP';
    return {
      force: true,
      direction,
      reason: `High exposure: ${dominantShares} ${dominantSide} @ ${(dominantAvgPrice * 100).toFixed(0)}¢ = $${exposureAtRisk.toFixed(0)} (edge neutral/against)`,
    };
  }

  /**
   * Check if we're in aggressive exit mode
   */
  shouldAggressiveExit(secRemaining: number): boolean {
    return secRemaining <= this.config.aggressive_exit_sec;
  }

  /**
   * Calculate bet size based on conditions
   */
  calculateBetSize(
    volatility: number = 0,
    inventorySpace: number = Infinity
  ): number {
    let size = this.config.bet_size_base;

    // Reduce size in high volatility
    if (volatility > 0) {
      const volMultiplier = 1 / (1 + this.config.bet_size_vol_factor * volatility);
      size = Math.floor(size * volMultiplier);
    }

    // Cap by available inventory space
    size = Math.min(size, inventorySpace);

    // Minimum viable size
    return Math.max(10, size);
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<V30Config>): void {
    this.config = { ...this.config, ...config };
  }
}
