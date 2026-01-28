// ============================================================
// V35 CIRCUIT BREAKER - HARD SAFETY SYSTEM
// ============================================================
// Version: V35.3.0 - "Robust Hedging"
//
// This module provides ABSOLUTE safety guarantees that cannot be bypassed.
// When tripped, it halts ALL trading activity immediately.
//
// ROOT CAUSE FIX: Previous versions had guards in multiple places
// (quoting-engine, runner, hedge-manager) but they weren't coordinated.
// This module provides a SINGLE SOURCE OF TRUTH for safety state.
// ============================================================

import { EventEmitter } from 'events';
import { cancelAllOrders, cancelSideOrders } from './order-manager.js';
import type { V35Market } from './types.js';

// ============================================================
// TYPES
// ============================================================

export interface CircuitBreakerState {
  tripped: boolean;
  trippedAt: number | null;
  reason: string | null;
  marketSlug: string | null;
  upQty: number;
  downQty: number;
  imbalance: number;
}

export interface CircuitBreakerConfig {
  // ABSOLUTE HARD LIMITS - These CANNOT be exceeded
  absoluteMaxUnpaired: number;      // 50 shares - instant halt
  warningThreshold: number;         // 20 shares - block leading side
  criticalThreshold: number;        // 35 shares - cancel all, prepare halt
  
  // RECOVERY
  cooldownMs: number;               // Time before auto-reset (if enabled)
  autoReset: boolean;               // Whether to auto-reset after cooldown
}

// ============================================================
// DEFAULT CONFIG - CONSERVATIVE
// ============================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  absoluteMaxUnpaired: 50,
  warningThreshold: 20,
  criticalThreshold: 35,
  cooldownMs: 60_000,
  autoReset: false, // Manual reset required for safety
};

// ============================================================
// CIRCUIT BREAKER CLASS
// ============================================================

export class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState = {
    tripped: false,
    trippedAt: null,
    reason: null,
    marketSlug: null,
    upQty: 0,
    downQty: 0,
    imbalance: 0,
  };
  
  // Track violations per market
  private marketViolations = new Map<string, number>();
  
  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Check market state and trip breaker if necessary
   * Returns TRUE if trading should STOP
   */
  async checkMarket(market: V35Market, dryRun: boolean): Promise<{
    shouldStop: boolean;
    shouldBlockUp: boolean;
    shouldBlockDown: boolean;
    reason: string | null;
  }> {
    const imbalance = Math.abs(market.upQty - market.downQty);
    const leadingSide = market.upQty > market.downQty ? 'UP' : 'DOWN';
    
    // Log every check for visibility
    console.log(`[CircuitBreaker] 🔍 ${market.slug.slice(-25)} | UP=${market.upQty.toFixed(0)} DOWN=${market.downQty.toFixed(0)} | Imbalance=${imbalance.toFixed(0)}`);
    
    // =========================================================================
    // LEVEL 1: ABSOLUTE HARD STOP (50 shares)
    // =========================================================================
    if (imbalance >= this.config.absoluteMaxUnpaired) {
      const reason = `ABSOLUTE LIMIT BREACHED: ${imbalance.toFixed(0)} >= ${this.config.absoluteMaxUnpaired} shares`;
      console.log(`[CircuitBreaker] 🚨🚨🚨 ${reason}`);
      
      // TRIP THE BREAKER
      this.trip(reason, market.slug, market.upQty, market.downQty, imbalance);
      
      // EMERGENCY: Cancel ALL orders immediately via API
      console.log(`[CircuitBreaker] 🚨 EMERGENCY CANCEL - fetching ALL open orders from Polymarket API...`);
      await this.emergencyCancel(market, dryRun);
      
      return {
        shouldStop: true,
        shouldBlockUp: true,
        shouldBlockDown: true,
        reason,
      };
    }
    
    // =========================================================================
    // LEVEL 2: CRITICAL (35 shares) - Cancel leading side, prepare for halt
    // =========================================================================
    if (imbalance >= this.config.criticalThreshold) {
      const reason = `CRITICAL: ${imbalance.toFixed(0)} >= ${this.config.criticalThreshold} shares`;
      console.log(`[CircuitBreaker] 🔴 ${reason} - Cancelling ${leadingSide} orders`);
      
      // Cancel leading side orders
      await cancelSideOrders(market, leadingSide, dryRun);
      
      // Track violation count
      const violations = (this.marketViolations.get(market.slug) || 0) + 1;
      this.marketViolations.set(market.slug, violations);
      
      // If 3+ violations in a row, trip the breaker
      if (violations >= 3) {
        const tripReason = `REPEATED CRITICAL VIOLATIONS: ${violations}x in ${market.slug}`;
        this.trip(tripReason, market.slug, market.upQty, market.downQty, imbalance);
        await this.emergencyCancel(market, dryRun);
        
        return {
          shouldStop: true,
          shouldBlockUp: true,
          shouldBlockDown: true,
          reason: tripReason,
        };
      }
      
      return {
        shouldStop: false,
        shouldBlockUp: leadingSide === 'UP',
        shouldBlockDown: leadingSide === 'DOWN',
        reason,
      };
    }
    
    // =========================================================================
    // LEVEL 3: WARNING (20 shares) - Block leading side only
    // =========================================================================
    if (imbalance >= this.config.warningThreshold) {
      const reason = `WARNING: ${imbalance.toFixed(0)} >= ${this.config.warningThreshold} shares`;
      console.log(`[CircuitBreaker] ⚠️ ${reason} - Blocking ${leadingSide} quotes`);
      
      return {
        shouldStop: false,
        shouldBlockUp: leadingSide === 'UP',
        shouldBlockDown: leadingSide === 'DOWN',
        reason,
      };
    }
    
    // All clear - reset violation count
    this.marketViolations.set(market.slug, 0);
    
    return {
      shouldStop: false,
      shouldBlockUp: false,
      shouldBlockDown: false,
      reason: null,
    };
  }
  
  /**
   * Trip the circuit breaker
   */
  private trip(reason: string, marketSlug: string, upQty: number, downQty: number, imbalance: number): void {
    this.state = {
      tripped: true,
      trippedAt: Date.now(),
      reason,
      marketSlug,
      upQty,
      downQty,
      imbalance,
    };
    
    console.log(`[CircuitBreaker] 🚨🚨🚨 CIRCUIT BREAKER TRIPPED 🚨🚨🚨`);
    console.log(`[CircuitBreaker]    Reason: ${reason}`);
    console.log(`[CircuitBreaker]    Market: ${marketSlug}`);
    console.log(`[CircuitBreaker]    State: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} Imbalance=${imbalance.toFixed(0)}`);
    console.log(`[CircuitBreaker]    ALL TRADING HALTED - Manual reset required`);
    
    this.emit('tripped', this.state);
  }
  
  /**
   * Emergency cancel - fetch ALL open orders from API and cancel them
   * This bypasses local order tracking which may be stale
   */
  private async emergencyCancel(market: V35Market, dryRun: boolean): Promise<number> {
    if (dryRun) {
      console.log(`[CircuitBreaker] [DRY RUN] Would emergency cancel all orders`);
      return 0;
    }
    
    try {
      // Import dynamically to avoid circular deps
      const { getOpenOrders, cancelOrder } = await import('../polymarket.js');
      
      const { orders, error } = await getOpenOrders();
      if (error || !orders) {
        console.error(`[CircuitBreaker] Failed to fetch orders for emergency cancel: ${error}`);
        return 0;
      }
      
      // Filter orders for this market's tokens
      const marketOrders = orders.filter(o => 
        o.tokenId === market.upTokenId || o.tokenId === market.downTokenId
      );
      
      console.log(`[CircuitBreaker] Found ${marketOrders.length} open orders to cancel`);
      
      let cancelled = 0;
      for (const order of marketOrders) {
        try {
          await cancelOrder(order.orderId);
          cancelled++;
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 100));
        } catch (err: any) {
          console.error(`[CircuitBreaker] Failed to cancel ${order.orderId}: ${err?.message}`);
        }
      }
      
      console.log(`[CircuitBreaker] ✅ Emergency cancelled ${cancelled}/${marketOrders.length} orders`);
      return cancelled;
      
    } catch (err: any) {
      console.error(`[CircuitBreaker] Emergency cancel failed: ${err?.message}`);
      return 0;
    }
  }
  
  /**
   * Check if breaker is tripped
   */
  isTripped(): boolean {
    return this.state.tripped;
  }
  
  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }
  
  /**
   * Manual reset (requires explicit action)
   */
  reset(): void {
    if (!this.state.tripped) return;
    
    console.log(`[CircuitBreaker] ⚡ MANUAL RESET - Clearing tripped state`);
    console.log(`[CircuitBreaker]    Previous state: ${JSON.stringify(this.state)}`);
    
    this.state = {
      tripped: false,
      trippedAt: null,
      reason: null,
      marketSlug: null,
      upQty: 0,
      downQty: 0,
      imbalance: 0,
    };
    
    this.marketViolations.clear();
    this.emit('reset');
  }
  
  /**
   * Update config at runtime
   */
  updateConfig(updates: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log(`[CircuitBreaker] Config updated:`, this.config);
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let instance: CircuitBreaker | null = null;

export function getCircuitBreaker(): CircuitBreaker {
  if (!instance) {
    instance = new CircuitBreaker();
  }
  return instance;
}

export function resetCircuitBreaker(): void {
  if (instance) {
    instance.removeAllListeners();
    instance.reset();
  }
  instance = null;
}

export function initCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  if (instance) {
    instance.updateConfig(config || {});
    return instance;
  }
  instance = new CircuitBreaker(config);
  return instance;
}
