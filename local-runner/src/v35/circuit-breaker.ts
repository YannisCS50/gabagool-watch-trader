// ============================================================
// V35 CIRCUIT BREAKER - MARKET-SPECIFIC SAFETY SYSTEM
// ============================================================
// Version: V35.11.0 - "Never Ban, Always Fix"
//
// V35.11.0 CRITICAL CHANGE: NO MORE BANNING!
// ================================================================
// Instead of banning a market when limits are breached, the circuit
// breaker now PERMANENTLY BLOCKS the leading side and lets the
// rebalancer keep working to fix the imbalance.
//
// OLD BEHAVIOR (banned):
// - At 20 shares imbalance → market banned, bot skips to next cycle
// - Position left unmanaged until expiry
//
// NEW BEHAVIOR (always fix):
// - At 20 shares imbalance → leading side blocked FOREVER
// - Rebalancer keeps trying to buy lagging side (up to 30% loss)
// - Position actively managed until expiry
//
// THRESHOLDS (unchanged):
// - 10 shares: WARNING → block leading side
// - 15 shares: CRITICAL → cancel leading orders + block
// - 20 shares: EXTREME → permanent block, aggressive rebalancing
//
// THE BOT NEVER GIVES UP. IT ALWAYS TRIES TO FIX.
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
  bannedMarketSlug: string | null;  // DEPRECATED: kept for compatibility, always null now
  upQty: number;
  downQty: number;
  imbalance: number;
}

export interface CircuitBreakerConfig {
  // THRESHOLDS - These control blocking behavior (NOT banning)
  absoluteMaxUnpaired: number;      // 20 shares - permanent block for leading side
  warningThreshold: number;         // 10 shares - block leading side
  criticalThreshold: number;        // 15 shares - cancel all leading orders
  
  // RECOVERY (kept for compatibility, but auto-recovery happens when balanced)
  cooldownMs: number;
  autoReset: boolean;
}

// ============================================================
// DEFAULT CONFIG - V35.11.0 NEVER BAN
// ============================================================

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  absoluteMaxUnpaired: 20,   // Permanent block threshold (NOT ban)
  warningThreshold: 10,      // Block leading side
  criticalThreshold: 15,     // Cancel leading side orders
  cooldownMs: 60_000,
  autoReset: true,
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
  
  // V35.11.0: Track BLOCKED markets (still trying to fix, NOT banned)
  private blockedMarkets = new Set<string>();
  
  // DEPRECATED: bannedMarkets kept for API compatibility but never used
  private bannedMarkets = new Set<string>();
  
  // Track violation count per market (for logging)
  private marketViolations = new Map<string, number>();
  
  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * V35.11.0: Check if a specific market is banned
   * ALWAYS returns FALSE - we never ban anymore, we just block leading side
   */
  isMarketBanned(marketSlug: string): boolean {
    // V35.11.0: NEVER return true - we don't ban markets anymore
    return false;
  }
  
  /**
   * V35.11.0: Check if leading side is blocked for this market
   */
  isLeadingSideBlocked(marketSlug: string): boolean {
    return this.blockedMarkets.has(marketSlug);
  }
  
  /**
   * V35.11.0: Clear block for a specific market (called when balanced or expired)
   */
  clearMarketBlock(marketSlug: string): void {
    if (this.blockedMarkets.has(marketSlug)) {
      console.log(`[CircuitBreaker] ✅ Clearing block for market: ${marketSlug.slice(-25)}`);
      this.blockedMarkets.delete(marketSlug);
    }
    // Also clear from legacy banned set for compatibility
    this.bannedMarkets.delete(marketSlug);
  }
  
  /**
   * DEPRECATED: Kept for compatibility, now calls clearMarketBlock
   */
  clearMarketBan(marketSlug: string): void {
    this.clearMarketBlock(marketSlug);
  }
  
  /**
   * Check market state and determine blocking behavior
   * V35.11.0: NEVER returns shouldStop=true, only blocks leading side
   * Returns TRUE if trading should STOP for THIS MARKET - but now always FALSE
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
    // V35.11.0: CHECK IF BALANCED - CLEAR ANY BLOCKS
    // =========================================================================
    if (imbalance < this.config.warningThreshold) {
      // Market is healthy - clear any blocks
      if (this.blockedMarkets.has(market.slug)) {
        console.log(`[CircuitBreaker] ✅ Imbalance resolved (${imbalance.toFixed(0)} < ${this.config.warningThreshold}), clearing block`);
        this.blockedMarkets.delete(market.slug);
        this.marketViolations.set(market.slug, 0);
      }
      
      return {
        shouldStop: false,  // V35.11.0: NEVER stop
        shouldBlockUp: false,
        shouldBlockDown: false,
        reason: null,
      };
    }
    
    // =========================================================================
    // LEVEL 1: EXTREME IMBALANCE (20+ shares) - PERMANENT BLOCK + AGGRESSIVE REBALANCE
    // V35.11.0: NO BAN, just permanent block until fixed
    // =========================================================================
    if (imbalance >= this.config.absoluteMaxUnpaired) {
      const reason = `EXTREME IMBALANCE: ${imbalance.toFixed(0)} >= ${this.config.absoluteMaxUnpaired} shares - BLOCKING ${leadingSide}, REBALANCING`;
      console.log(`[CircuitBreaker] 🚨 ${reason}`);
      console.log(`[CircuitBreaker] 🔧 NOT banning - will keep trying to fix via rebalancer`);
      
      // Mark as blocked (NOT banned)
      this.blockedMarkets.add(market.slug);
      
      // LOG GUARD EVENT TO DATABASE
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'BALANCE_GUARD',
        blockedSide: leadingSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: leadingSide,
        reason: `EXTREME (trying to fix): ${reason}`,
      }).catch(() => {});
      
      // Cancel ALL orders for leading side
      console.log(`[CircuitBreaker] 🛑 Cancelling ${leadingSide} orders, rebalancer will buy ${leadingSide === 'UP' ? 'DOWN' : 'UP'}...`);
      await cancelSideOrders(market, leadingSide, dryRun);
      
      return {
        shouldStop: false,  // V35.11.0: NEVER STOP! Let rebalancer work
        shouldBlockUp: leadingSide === 'UP',
        shouldBlockDown: leadingSide === 'DOWN',
        reason,
      };
    }
    
    // =========================================================================
    // LEVEL 2: CRITICAL (15 shares) - Cancel leading side, block, keep trying
    // V35.11.0: NO BAN even with repeated violations
    // =========================================================================
    if (imbalance >= this.config.criticalThreshold) {
      const reason = `CRITICAL: ${imbalance.toFixed(0)} >= ${this.config.criticalThreshold} shares`;
      console.log(`[CircuitBreaker] 🔴 ${reason} - Cancelling ${leadingSide} orders, rebalancer active`);
      
      // Mark as blocked
      this.blockedMarkets.add(market.slug);
      
      // LOG GUARD EVENT TO DATABASE
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'BALANCE_GUARD',
        blockedSide: leadingSide,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide: leadingSide,
        reason: `CRITICAL (fixing): ${reason}`,
      }).catch(() => {});
      
      // Cancel leading side orders
      await cancelSideOrders(market, leadingSide, dryRun);
      
      // Track violation count (for logging only, no longer triggers ban)
      const violations = (this.marketViolations.get(market.slug) || 0) + 1;
      this.marketViolations.set(market.slug, violations);
      
      // V35.11.0: REMOVED ban on repeated violations - just keep trying
      if (violations >= 3) {
        console.log(`[CircuitBreaker] ⚠️ ${violations} critical violations, but NOT banning - rebalancer will keep trying`);
      }
      
      return {
        shouldStop: false,  // V35.11.0: NEVER STOP
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
   * V35.11.0: Block a market's leading side (NOT ban!)
   * The rebalancer will keep trying to fix the imbalance
   */
  private blockMarket(marketSlug: string, reason: string, upQty: number, downQty: number, imbalance: number): void {
    this.blockedMarkets.add(marketSlug);
    
    this.state = {
      tripped: true,
      trippedAt: Date.now(),
      reason,
      bannedMarketSlug: null,  // V35.11.0: Never set bannedMarketSlug anymore
      upQty,
      downQty,
      imbalance,
    };
    
    const leadingSide = upQty > downQty ? 'UP' : 'DOWN';
    console.log(`[CircuitBreaker] 🔧 MARKET BLOCKED: ${marketSlug.slice(-25)}`);
    console.log(`[CircuitBreaker]    Reason: ${reason}`);
    console.log(`[CircuitBreaker]    State: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} Imbalance=${imbalance.toFixed(0)}`);
    console.log(`[CircuitBreaker]    ✅ ${leadingSide} blocked, rebalancer buying ${leadingSide === 'UP' ? 'DOWN' : 'UP'}`);
    console.log(`[CircuitBreaker]    ⏳ Will keep trying until balanced or market expires`);
    
    this.emit('marketBlocked', { marketSlug, reason, imbalance });
  }
  
  /**
   * DEPRECATED: banMarket - now just calls blockMarket
   */
  private banMarket(marketSlug: string, reason: string, upQty: number, downQty: number, imbalance: number): void {
    // V35.11.0: Redirect to blockMarket (no more banning)
    this.blockMarket(marketSlug, reason, upQty, downQty, imbalance);
  }
  
  /**
   * DEPRECATED: trip - now just calls blockMarket
   */
  private trip(reason: string, marketSlug: string, upQty: number, downQty: number, imbalance: number): void {
    this.blockMarket(marketSlug, reason, upQty, downQty, imbalance);
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
   * V35.11.0: Check if tripped for a SPECIFIC market
   * ALWAYS returns FALSE - we don't trip/ban anymore
   */
  isTrippedForMarket(marketSlug: string): boolean {
    // V35.11.0: Never return true - we don't ban
    return false;
  }
  
  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }
  
  /**
   * Get list of all blocked markets (NOT banned - they're still being worked on)
   */
  getBlockedMarkets(): string[] {
    return Array.from(this.blockedMarkets);
  }
  
  /**
   * DEPRECATED: getBannedMarkets - returns empty array now
   */
  getBannedMarkets(): string[] {
    return [];  // V35.11.0: No markets are ever banned anymore
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
    
    this.blockedMarkets.clear();
    this.bannedMarkets.clear();  // Legacy, kept for compatibility
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
