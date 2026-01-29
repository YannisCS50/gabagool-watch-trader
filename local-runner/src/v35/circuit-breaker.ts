// ============================================================
// V35 CIRCUIT BREAKER - MARKET-SPECIFIC SAFETY SYSTEM
// ============================================================
// Version: V35.4.0 - "Skip to Next Market"
//
// CRITICAL CHANGE: Circuit breaker is now MARKET-SPECIFIC.
// When tripped, it ONLY bans the problematic market, NOT the entire bot.
// The bot automatically skips to the next 15-minute market.
//
// V35.4.0 FIX:
// - Tripping bans ONLY the specific market that caused the issue
// - Bot continues trading other markets and waits for next market cycle
// - Automatic reset when a new market slug is detected
// - strategy_enabled flag is NO LONGER touched (bot stays running)
// ============================================================

import { EventEmitter } from 'events';
import { cancelAllOrders, cancelSideOrders } from './order-manager.js';
import type { V35Market } from './types.js';
import { logV35GuardEvent } from './backend.js';

// ============================================================
// TYPES
// ============================================================

export interface CircuitBreakerState {
  tripped: boolean;
  trippedAt: number | null;
  reason: string | null;
  bannedMarketSlug: string | null;  // Only THIS market is banned
  upQty: number;
  downQty: number;
  imbalance: number;
}

export interface CircuitBreakerConfig {
  // ABSOLUTE HARD LIMITS - These CANNOT be exceeded
  // V35.10.3: Tightened from 15/25/35 → 10/15/20
  absoluteMaxUnpaired: number;      // 20 shares - instant halt for THIS MARKET
  warningThreshold: number;         // 10 shares - block leading side
  criticalThreshold: number;        // 15 shares - cancel all, prepare halt
  
  // RECOVERY
  cooldownMs: number;               // Time before auto-reset (if enabled)
  autoReset: boolean;               // Whether to auto-reset after cooldown
}

// ============================================================
// DEFAULT CONFIG - CONSERVATIVE
// ============================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  absoluteMaxUnpaired: 20,   // V35.10.3: HARD LIMIT - instant halt for this market
  warningThreshold: 10,      // V35.10.3: Block leading side
  criticalThreshold: 15,     // V35.10.3: Cancel leading side orders
  cooldownMs: 60_000,
  autoReset: true, // V35.4.0: Auto-reset when new market starts
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
    bannedMarketSlug: null,
    upQty: 0,
    downQty: 0,
    imbalance: 0,
  };
  
  // Track violations per market
  private marketViolations = new Map<string, number>();
  
  // V35.4.0: Track banned markets (skip these, wait for next)
  private bannedMarkets = new Set<string>();
  
  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * V35.4.0: Check if a specific market is banned (skip it, wait for next)
   */
  isMarketBanned(marketSlug: string): boolean {
    return this.bannedMarkets.has(marketSlug);
  }
  
  /**
   * V35.4.0: Clear ban for a specific market (called when market expires)
   */
  clearMarketBan(marketSlug: string): void {
    if (this.bannedMarkets.has(marketSlug)) {
      console.log(`[CircuitBreaker] ✅ Clearing ban for expired market: ${marketSlug.slice(-25)}`);
      this.bannedMarkets.delete(marketSlug);
      
      // If this was the currently-tripped market, reset the state
      if (this.state.bannedMarketSlug === marketSlug) {
        this.reset();
      }
    }
  }
  
  /**
   * Check market state and trip breaker if necessary
   * Returns TRUE if trading should STOP for THIS MARKET
   * V35.4.0: Now market-specific - other markets can continue trading
   */
  async checkMarket(market: V35Market, dryRun: boolean): Promise<{
    shouldStop: boolean;
    shouldBlockUp: boolean;
    shouldBlockDown: boolean;
    reason: string | null;
  }> {
    // V35.4.0: If this specific market is banned, skip it immediately
    if (this.bannedMarkets.has(market.slug)) {
      return {
        shouldStop: true,
        shouldBlockUp: true,
        shouldBlockDown: true,
        reason: `Market banned - waiting for next cycle`,
      };
    }
    
    const imbalance = Math.abs(market.upQty - market.downQty);
    const leadingSide = market.upQty > market.downQty ? 'UP' : 'DOWN';
    
    // Log every check for visibility
    console.log(`[CircuitBreaker] 🔍 ${market.slug.slice(-25)} | UP=${market.upQty.toFixed(0)} DOWN=${market.downQty.toFixed(0)} | Imbalance=${imbalance.toFixed(0)}`);
    
    // =========================================================================
    // LEVEL 1: ABSOLUTE HARD STOP (35 shares) - BAN THIS MARKET ONLY
    // =========================================================================
    if (imbalance >= this.config.absoluteMaxUnpaired) {
      const reason = `ABSOLUTE LIMIT BREACHED: ${imbalance.toFixed(0)} >= ${this.config.absoluteMaxUnpaired} shares`;
      console.log(`[CircuitBreaker] 🚨🚨🚨 ${reason}`);
      console.log(`[CircuitBreaker] ⏭️ BANNING this market, will skip to next cycle`);
      
      // LOG GUARD EVENT TO DATABASE
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'BALANCE_GUARD',
        blockedSide: leadingSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: leadingSide,
        reason: `MARKET BANNED: ${reason}`,
      }).catch(() => {});
      
      // V35.4.0: Ban THIS market only, don't stop entire bot
      this.banMarket(market.slug, reason, market.upQty, market.downQty, imbalance);
      
      // EMERGENCY: Cancel ALL orders for this market immediately
      console.log(`[CircuitBreaker] 🚨 EMERGENCY CANCEL for ${market.slug.slice(-25)}...`);
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
      
      // LOG GUARD EVENT TO DATABASE
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'BALANCE_GUARD',
        blockedSide: leadingSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: leadingSide,
        reason: `CRITICAL: ${reason}`,
      }).catch(() => {});
      
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
      
      // LOG GUARD EVENT TO DATABASE
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'GAP_GUARD',
        blockedSide: leadingSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: leadingSide,
        reason: `WARNING: ${reason}`,
      }).catch(() => {});
      
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
   * V35.4.0: Ban a specific market (skip to next cycle)
   * Does NOT stop the entire bot - only this market
   */
  private banMarket(marketSlug: string, reason: string, upQty: number, downQty: number, imbalance: number): void {
    this.bannedMarkets.add(marketSlug);
    
    this.state = {
      tripped: true,
      trippedAt: Date.now(),
      reason,
      bannedMarketSlug: marketSlug,
      upQty,
      downQty,
      imbalance,
    };
    
    console.log(`[CircuitBreaker] ⛔ MARKET BANNED: ${marketSlug.slice(-25)}`);
    console.log(`[CircuitBreaker]    Reason: ${reason}`);
    console.log(`[CircuitBreaker]    State: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} Imbalance=${imbalance.toFixed(0)}`);
    console.log(`[CircuitBreaker]    ⏭️ Bot will SKIP this market and continue with next cycle`);
    console.log(`[CircuitBreaker]    ✅ NO MANUAL INTERVENTION REQUIRED`);
    
    this.emit('marketBanned', { marketSlug, reason, imbalance });
  }
  
  /**
   * Legacy trip method (kept for compatibility, now calls banMarket)
   */
  private trip(reason: string, marketSlug: string, upQty: number, downQty: number, imbalance: number): void {
    this.banMarket(marketSlug, reason, upQty, downQty, imbalance);
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
   * Check if breaker is tripped (for any market)
   */
  isTripped(): boolean {
    return this.state.tripped;
  }
  
  /**
   * V35.4.0: Check if tripped for a SPECIFIC market
   */
  isTrippedForMarket(marketSlug: string): boolean {
    return this.bannedMarkets.has(marketSlug);
  }
  
  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }
  
  /**
   * Get list of all banned markets
   */
  getBannedMarkets(): string[] {
    return Array.from(this.bannedMarkets);
  }
  
  /**
   * Manual reset (clears all bans)
   */
  reset(): void {
    if (!this.state.tripped && this.bannedMarkets.size === 0) return;
    
    console.log(`[CircuitBreaker] ⚡ RESET - Clearing all bans`);
    console.log(`[CircuitBreaker]    Previous state: ${JSON.stringify(this.state)}`);
    console.log(`[CircuitBreaker]    Banned markets cleared: ${Array.from(this.bannedMarkets).join(', ')}`);
    
    this.state = {
      tripped: false,
      trippedAt: null,
      reason: null,
      bannedMarketSlug: null,
      upQty: 0,
      downQty: 0,
      imbalance: 0,
    };
    
    this.bannedMarkets.clear();
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
