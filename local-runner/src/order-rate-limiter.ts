/**
 * order-rate-limiter.ts - Circuit Breaker for Cancel/Replace Churn
 * ============================================================
 * v6.0.0 Reliability Patch
 * 
 * Purpose:
 * - Limit cancel/replace operations per market and globally
 * - Pause markets that exceed rate limits
 * - Provide circuit breaker functionality
 * 
 * Events logged:
 * - RATE_LIMIT_EXCEEDED
 * - MARKET_PAUSED
 * - CIRCUIT_BREAKER_TRIGGERED
 */

// ============================================================
// CONFIGURATION
// ============================================================

export const RATE_LIMIT_CONFIG = {
  // Per market limits
  maxCancelReplacePerMarketPerMinute: 10,
  maxOrdersPerMarketPerMinute: 15,
  
  // Global limits
  maxTotalCancelsPerMinute: 50,
  maxTotalOrdersPerMinute: 100,
  
  // Pause duration when limit exceeded
  marketPauseDurationMs: 30_000,  // 30 seconds
  globalPauseDurationMs: 60_000,  // 60 seconds
  
  // Circuit breaker thresholds
  consecutiveFailuresBeforeBreak: 5,
  circuitBreakerResetMs: 120_000,  // 2 minutes
  
  logEvents: true,
};

// ============================================================
// TYPES
// ============================================================

export interface RateLimitEvent {
  type: 'order' | 'cancel' | 'replace';
  marketId: string;
  ts: number;
}

export interface MarketState {
  marketId: string;
  events: RateLimitEvent[];
  pausedUntil: number;
  consecutiveFailures: number;
  lastFailureTs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  pausedUntilMs?: number;
  waitMs?: number;
}

export interface CircuitBreakerState {
  isOpen: boolean;
  openedAt: number;
  failures: number;
  lastFailure: number;
}

// ============================================================
// RATE LIMITER IMPLEMENTATION
// ============================================================

class OrderRateLimiterImpl {
  private marketStates = new Map<string, MarketState>();
  private globalEvents: RateLimitEvent[] = [];
  private globalPausedUntil = 0;
  private circuitBreaker: CircuitBreakerState = {
    isOpen: false,
    openedAt: 0,
    failures: 0,
    lastFailure: 0,
  };

  /**
   * Check if an operation is allowed for a market
   */
  checkAllowed(marketId: string, type: 'order' | 'cancel' | 'replace'): RateLimitResult {
    const now = Date.now();
    
    // Check circuit breaker first
    if (this.circuitBreaker.isOpen) {
      if (now - this.circuitBreaker.openedAt > RATE_LIMIT_CONFIG.circuitBreakerResetMs) {
        this.resetCircuitBreaker();
      } else {
        const waitMs = RATE_LIMIT_CONFIG.circuitBreakerResetMs - (now - this.circuitBreaker.openedAt);
        return {
          allowed: false,
          reason: 'CIRCUIT_BREAKER_OPEN',
          waitMs,
        };
      }
    }
    
    // Check global pause
    if (now < this.globalPausedUntil) {
      return {
        allowed: false,
        reason: 'GLOBAL_PAUSE',
        pausedUntilMs: this.globalPausedUntil,
        waitMs: this.globalPausedUntil - now,
      };
    }
    
    // Check global rate limits
    this.pruneOldEvents();
    
    const cancelReplaceEvents = this.globalEvents.filter(e => e.type === 'cancel' || e.type === 'replace');
    if (cancelReplaceEvents.length >= RATE_LIMIT_CONFIG.maxTotalCancelsPerMinute) {
      this.globalPausedUntil = now + RATE_LIMIT_CONFIG.globalPauseDurationMs;
      this.logEvent('GLOBAL_RATE_LIMIT_EXCEEDED', { type, cancelCount: cancelReplaceEvents.length });
      return {
        allowed: false,
        reason: 'GLOBAL_CANCEL_LIMIT',
        pausedUntilMs: this.globalPausedUntil,
        waitMs: RATE_LIMIT_CONFIG.globalPauseDurationMs,
      };
    }
    
    if (this.globalEvents.length >= RATE_LIMIT_CONFIG.maxTotalOrdersPerMinute) {
      this.globalPausedUntil = now + RATE_LIMIT_CONFIG.globalPauseDurationMs;
      this.logEvent('GLOBAL_ORDER_LIMIT_EXCEEDED', { type, orderCount: this.globalEvents.length });
      return {
        allowed: false,
        reason: 'GLOBAL_ORDER_LIMIT',
        pausedUntilMs: this.globalPausedUntil,
        waitMs: RATE_LIMIT_CONFIG.globalPauseDurationMs,
      };
    }
    
    // Check market-specific limits
    const state = this.getOrCreateMarketState(marketId);
    
    // Check market pause
    if (now < state.pausedUntil) {
      return {
        allowed: false,
        reason: 'MARKET_PAUSED',
        pausedUntilMs: state.pausedUntil,
        waitMs: state.pausedUntil - now,
      };
    }
    
    // Prune old market events
    const oneMinuteAgo = now - 60_000;
    state.events = state.events.filter(e => e.ts > oneMinuteAgo);
    
    // Check cancel/replace limit
    const marketCancelReplace = state.events.filter(e => e.type === 'cancel' || e.type === 'replace');
    if ((type === 'cancel' || type === 'replace') && 
        marketCancelReplace.length >= RATE_LIMIT_CONFIG.maxCancelReplacePerMarketPerMinute) {
      state.pausedUntil = now + RATE_LIMIT_CONFIG.marketPauseDurationMs;
      this.logEvent('MARKET_CANCEL_LIMIT_EXCEEDED', { marketId, cancelCount: marketCancelReplace.length });
      return {
        allowed: false,
        reason: 'MARKET_CANCEL_LIMIT',
        pausedUntilMs: state.pausedUntil,
        waitMs: RATE_LIMIT_CONFIG.marketPauseDurationMs,
      };
    }
    
    // Check order limit
    if (state.events.length >= RATE_LIMIT_CONFIG.maxOrdersPerMarketPerMinute) {
      state.pausedUntil = now + RATE_LIMIT_CONFIG.marketPauseDurationMs;
      this.logEvent('MARKET_ORDER_LIMIT_EXCEEDED', { marketId, orderCount: state.events.length });
      return {
        allowed: false,
        reason: 'MARKET_ORDER_LIMIT',
        pausedUntilMs: state.pausedUntil,
        waitMs: RATE_LIMIT_CONFIG.marketPauseDurationMs,
      };
    }
    
    return { allowed: true };
  }

  /**
   * Record an operation (call after successful check)
   */
  recordEvent(marketId: string, type: 'order' | 'cancel' | 'replace'): void {
    const now = Date.now();
    const event: RateLimitEvent = { type, marketId, ts: now };
    
    // Record globally
    this.globalEvents.push(event);
    
    // Record per market
    const state = this.getOrCreateMarketState(marketId);
    state.events.push(event);
    
    // Reset consecutive failures on success
    state.consecutiveFailures = 0;
  }

  /**
   * Record a failure (for circuit breaker)
   */
  recordFailure(marketId: string): void {
    const now = Date.now();
    const state = this.getOrCreateMarketState(marketId);
    
    state.consecutiveFailures++;
    state.lastFailureTs = now;
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = now;
    
    // Check if we need to trip circuit breaker
    if (state.consecutiveFailures >= RATE_LIMIT_CONFIG.consecutiveFailuresBeforeBreak) {
      this.tripCircuitBreaker();
    }
  }

  /**
   * Reset failure count for a market
   */
  resetFailures(marketId: string): void {
    const state = this.marketStates.get(marketId);
    if (state) {
      state.consecutiveFailures = 0;
    }
  }

  /**
   * Trip the circuit breaker (pause all trading)
   */
  private tripCircuitBreaker(): void {
    if (this.circuitBreaker.isOpen) return;
    
    this.circuitBreaker.isOpen = true;
    this.circuitBreaker.openedAt = Date.now();
    
    this.logEvent('CIRCUIT_BREAKER_TRIGGERED', {
      failures: this.circuitBreaker.failures,
      resetAfterMs: RATE_LIMIT_CONFIG.circuitBreakerResetMs,
    });
  }

  /**
   * Reset the circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.circuitBreaker.isOpen = false;
    this.circuitBreaker.failures = 0;
    this.logEvent('CIRCUIT_BREAKER_RESET', {});
  }

  /**
   * Force reset circuit breaker (manual intervention)
   */
  forceResetCircuitBreaker(): void {
    this.resetCircuitBreaker();
    console.log('⚡ Circuit breaker force reset');
  }

  /**
   * Get current status
   */
  getStatus(): {
    circuitBreakerOpen: boolean;
    globalPaused: boolean;
    globalPausedUntil: number;
    pausedMarkets: string[];
    eventsLastMinute: number;
    cancelsLastMinute: number;
  } {
    const now = Date.now();
    this.pruneOldEvents();
    
    const pausedMarkets: string[] = [];
    for (const [marketId, state] of this.marketStates) {
      if (now < state.pausedUntil) {
        pausedMarkets.push(marketId);
      }
    }
    
    return {
      circuitBreakerOpen: this.circuitBreaker.isOpen,
      globalPaused: now < this.globalPausedUntil,
      globalPausedUntil: this.globalPausedUntil,
      pausedMarkets,
      eventsLastMinute: this.globalEvents.length,
      cancelsLastMinute: this.globalEvents.filter(e => e.type === 'cancel' || e.type === 'replace').length,
    };
  }

  /**
   * Clear all state (for restart)
   */
  clear(): void {
    this.marketStates.clear();
    this.globalEvents = [];
    this.globalPausedUntil = 0;
    this.circuitBreaker = {
      isOpen: false,
      openedAt: 0,
      failures: 0,
      lastFailure: 0,
    };
  }

  // ========== HELPERS ==========

  private getOrCreateMarketState(marketId: string): MarketState {
    let state = this.marketStates.get(marketId);
    if (!state) {
      state = {
        marketId,
        events: [],
        pausedUntil: 0,
        consecutiveFailures: 0,
        lastFailureTs: 0,
      };
      this.marketStates.set(marketId, state);
    }
    return state;
  }

  private pruneOldEvents(): void {
    const oneMinuteAgo = Date.now() - 60_000;
    this.globalEvents = this.globalEvents.filter(e => e.ts > oneMinuteAgo);
  }

  private logEvent(type: string, data: Record<string, unknown>): void {
    if (RATE_LIMIT_CONFIG.logEvents) {
      console.log(`⚡ [${type}]`, JSON.stringify(data));
    }
  }
}

// Singleton instance
export const OrderRateLimiter = new OrderRateLimiterImpl();

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Check if we can place an order, respecting rate limits
 */
export function canPlaceOrderRateLimited(marketId: string): RateLimitResult {
  return OrderRateLimiter.checkAllowed(marketId, 'order');
}

/**
 * Check if we can cancel an order, respecting rate limits
 */
export function canCancelOrderRateLimited(marketId: string): RateLimitResult {
  return OrderRateLimiter.checkAllowed(marketId, 'cancel');
}

/**
 * Record successful order placement
 */
export function recordOrderPlaced(marketId: string): void {
  OrderRateLimiter.recordEvent(marketId, 'order');
}

/**
 * Record successful cancel
 */
export function recordOrderCancelled(marketId: string): void {
  OrderRateLimiter.recordEvent(marketId, 'cancel');
}

/**
 * Record order failure
 */
export function recordOrderFailure(marketId: string): void {
  OrderRateLimiter.recordFailure(marketId);
}
