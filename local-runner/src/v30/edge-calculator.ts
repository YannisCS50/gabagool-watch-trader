/**
 * V30 Edge Calculator
 * 
 * Calculates edge (Δ) and dynamic threshold (θ)
 * Edge = market price - fair value
 * Negative edge = underpriced = BUY signal
 */

import type { V30Config, EdgeResult, Inventory, FairValueResult } from './types.js';

export class EdgeCalculator {
  private config: V30Config;

  constructor(config: V30Config) {
    this.config = config;
  }

  /**
   * Calculate edges for both sides
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

    // Signal generation
    // Buy if edge is negative enough (price below fair value by more than theta)
    const signal_up = edge_up < -theta;
    const signal_down = edge_down < -theta;

    return {
      edge_up,
      edge_down,
      theta,
      signal_up,
      signal_down,
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
   * IMPORTANT: Only force counter when we have EXPENSIVE exposure (high cost side)
   * Cheap side exposure (e.g. 130 shares @ 10¢ = $13 risk) doesn't need aggressive hedging
   */
  shouldForceCounter(
    inventory: Inventory,
    upAvgPrice?: number,
    downAvgPrice?: number
  ): { 
    force: boolean; 
    direction: 'UP' | 'DOWN' | null;
    reason: string;
  } {
    const ratio = Math.abs(inventory.net) / inventory.i_max;
    
    if (ratio < this.config.force_counter_at_pct) {
      return { force: false, direction: null, reason: '' };
    }

    // Determine which side has more shares
    const dominantSide = inventory.net > 0 ? 'UP' : 'DOWN';
    const dominantShares = inventory.net > 0 ? inventory.up : inventory.down;
    const dominantAvgPrice = inventory.net > 0 ? (upAvgPrice ?? 0.5) : (downAvgPrice ?? 0.5);
    
    // Calculate actual dollar exposure at risk
    // If we bought cheap (e.g. 10¢), max loss is only 10¢ per share
    const exposureAtRisk = dominantShares * dominantAvgPrice;
    
    // Only force counter if exposure > $50 AND avg price > 40¢ (expensive side)
    // Cheap side (< 40¢) has limited downside, no need to panic hedge
    if (dominantAvgPrice < 0.40) {
      return { 
        force: false, 
        direction: null, 
        reason: `Cheap side (${(dominantAvgPrice * 100).toFixed(0)}¢) - no hedge needed` 
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

    // Force buy opposite direction
    const direction = inventory.net > 0 ? 'DOWN' : 'UP';
    return {
      force: true,
      direction,
      reason: `High exposure: ${dominantShares} ${dominantSide} @ ${(dominantAvgPrice * 100).toFixed(0)}¢ = $${exposureAtRisk.toFixed(0)}`,
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
