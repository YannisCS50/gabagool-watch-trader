/**
 * funding.ts - Balance Gate & Reserve Manager
 * ============================================================
 * v6.0.0 Reliability Patch
 * 
 * Purpose:
 * - Prevent "not enough balance/allowance" failed orders
 * - Track reserved notional for open orders
 * - Block orders when insufficient funds
 * 
 * Components:
 * - getAvailableBalance(): Fetch current USDC balance
 * - getReservedNotional(): Sum of open order notional per market
 * - canPlaceOrder(): Check if order can be placed
 * - ReserveManager: Track reserved notional per order
 */

import { getBalance } from './polymarket.js';

// ============================================================
// CONFIGURATION
// ============================================================

export const FUNDING_CONFIG = {
  safetyBufferUsd: 10,          // Keep $10 buffer to avoid race conditions
  minBalanceForTrading: 50,     // Minimum $50 to start trading
  staleBalanceMs: 10_000,       // Balance cache TTL 10 seconds
  logEvents: true,              // Log funding events
  // v6.0.1: Per-market limits
  maxReservedPerMarket: 150,    // Max $150 reserved per market
  maxTotalReserved: 400,        // Max $400 total reserved across all markets
};

// ============================================================
// TYPES
// ============================================================

export interface ReservedOrder {
  orderId: string;
  marketId: string;
  notional: number;
  side: 'UP' | 'DOWN';
  createdAt: number;
}

export interface BalanceCheckResult {
  canProceed: boolean;
  availableBalance: number;
  reservedNotional: number;
  freeBalance: number;
  requiredNotional: number;
  reasonCode?: 'INSUFFICIENT_BALANCE' | 'INSUFFICIENT_ALLOWANCE' | 'BELOW_MIN_BALANCE' | 'OK';
  reason?: string;
}

export interface OrderBlockedEvent {
  type: 'ORDER_BLOCKED_INSUFFICIENT_FUNDS';
  ts: number;
  marketId: string;
  side: 'UP' | 'DOWN';
  requiredNotional: number;
  availableBalance: number;
  reservedNotional: number;
  freeBalance: number;
}

// ============================================================
// RESERVE MANAGER - Track reserved notional for open orders
// ============================================================

class ReserveManagerImpl {
  private reserves = new Map<string, ReservedOrder>();
  private marketReserves = new Map<string, number>(); // marketId -> total reserved

  /**
   * Reserve notional for a new order
   */
  reserve(orderId: string, marketId: string, notional: number, side: 'UP' | 'DOWN'): void {
    const order: ReservedOrder = {
      orderId,
      marketId,
      notional,
      side,
      createdAt: Date.now(),
    };
    
    this.reserves.set(orderId, order);
    
    const current = this.marketReserves.get(marketId) || 0;
    this.marketReserves.set(marketId, current + notional);
    
    if (FUNDING_CONFIG.logEvents) {
      console.log(`💰 [RESERVE] +$${notional.toFixed(2)} for ${orderId.slice(0, 12)}... (market: ${marketId})`);
    }
  }

  /**
   * Release reservation when order is cancelled or fails
   */
  release(orderId: string): void {
    const order = this.reserves.get(orderId);
    if (!order) return;
    
    this.reserves.delete(orderId);
    
    const current = this.marketReserves.get(order.marketId) || 0;
    const newValue = Math.max(0, current - order.notional);
    this.marketReserves.set(order.marketId, newValue);
    
    if (FUNDING_CONFIG.logEvents) {
      console.log(`💰 [RELEASE] -$${order.notional.toFixed(2)} for ${orderId.slice(0, 12)}... (market: ${order.marketId})`);
    }
  }

  /**
   * Decrement reservation when order is partially/fully filled
   */
  onFill(orderId: string, filledNotional: number): void {
    const order = this.reserves.get(orderId);
    if (!order) return;
    
    const newNotional = Math.max(0, order.notional - filledNotional);
    
    if (newNotional <= 0) {
      // Fully filled, release entirely
      this.release(orderId);
    } else {
      // Partial fill, reduce reservation
      const reduction = order.notional - newNotional;
      order.notional = newNotional;
      
      const current = this.marketReserves.get(order.marketId) || 0;
      this.marketReserves.set(order.marketId, Math.max(0, current - reduction));
      
      if (FUNDING_CONFIG.logEvents) {
        console.log(`💰 [PARTIAL] -$${reduction.toFixed(2)} for ${orderId.slice(0, 12)}... (remaining: $${newNotional.toFixed(2)})`);
      }
    }
  }

  /**
   * Get total reserved notional across all markets
   */
  getTotalReserved(): number {
    let total = 0;
    for (const order of this.reserves.values()) {
      total += order.notional;
    }
    return total;
  }

  /**
   * Get reserved notional for a specific market
   */
  getMarketReserved(marketId: string): number {
    return this.marketReserves.get(marketId) || 0;
  }

  /**
   * Reconcile reserves with actual open orders
   * Call periodically to clean up stale reservations
   */
  reconcile(activeOrderIds: Set<string>): void {
    const staleOrders: string[] = [];
    
    for (const orderId of this.reserves.keys()) {
      if (!activeOrderIds.has(orderId)) {
        staleOrders.push(orderId);
      }
    }
    
    for (const orderId of staleOrders) {
      if (FUNDING_CONFIG.logEvents) {
        console.log(`💰 [RECONCILE] Releasing stale reservation: ${orderId.slice(0, 12)}...`);
      }
      this.release(orderId);
    }
    
    if (staleOrders.length > 0) {
      console.log(`💰 [RECONCILE] Released ${staleOrders.length} stale reservations`);
    }
  }

  /**
   * Clear all reservations (e.g., on restart)
   */
  clear(): void {
    const count = this.reserves.size;
    this.reserves.clear();
    this.marketReserves.clear();
    if (count > 0) {
      console.log(`💰 [CLEAR] Cleared ${count} reservations`);
    }
  }

  /**
   * Get all current reservations (for debugging)
   */
  getAll(): ReservedOrder[] {
    return Array.from(this.reserves.values());
  }
}

// Singleton instance
export const ReserveManager = new ReserveManagerImpl();

// ============================================================
// BALANCE CACHE
// ============================================================

let cachedBalance: { usdc: number; fetchedAt: number } | null = null;

async function getAvailableBalance(forceRefresh = false): Promise<number> {
  const now = Date.now();
  
  if (!forceRefresh && cachedBalance && now - cachedBalance.fetchedAt < FUNDING_CONFIG.staleBalanceMs) {
    return cachedBalance.usdc;
  }
  
  try {
    const result = await getBalance();
    cachedBalance = {
      usdc: result.usdc ?? 0,
      fetchedAt: now,
    };
    return cachedBalance.usdc;
  } catch (error) {
    console.error('💰 [ERROR] Failed to fetch balance:', error);
    // Return cached value if available, otherwise 0
    return cachedBalance?.usdc ?? 0;
  }
}

export function invalidateBalanceCacheNow(): void {
  cachedBalance = null;
}

// ============================================================
// ORDER PLACEMENT CHECK
// ============================================================

export async function canPlaceOrder(
  marketId: string,
  side: 'UP' | 'DOWN',
  requiredNotional: number,
  forceRefresh = false
): Promise<BalanceCheckResult> {
  const availableBalance = await getAvailableBalance(forceRefresh);
  const reservedNotional = ReserveManager.getTotalReserved();
  const marketReserved = ReserveManager.getMarketReserved(marketId);
  const freeBalance = availableBalance - reservedNotional - FUNDING_CONFIG.safetyBufferUsd;
  
  // Check minimum balance for trading
  if (availableBalance < FUNDING_CONFIG.minBalanceForTrading) {
    const event: OrderBlockedEvent = {
      type: 'ORDER_BLOCKED_INSUFFICIENT_FUNDS',
      ts: Date.now(),
      marketId,
      side,
      requiredNotional,
      availableBalance,
      reservedNotional,
      freeBalance,
    };
    logBlockedOrder(event);
    
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'BELOW_MIN_BALANCE',
      reason: `Balance $${availableBalance.toFixed(2)} < minimum $${FUNDING_CONFIG.minBalanceForTrading}`,
    };
  }
  
  // v6.0.1: Check per-market limit
  if (marketReserved + requiredNotional > FUNDING_CONFIG.maxReservedPerMarket) {
    const event: OrderBlockedEvent = {
      type: 'ORDER_BLOCKED_INSUFFICIENT_FUNDS',
      ts: Date.now(),
      marketId,
      side,
      requiredNotional,
      availableBalance,
      reservedNotional,
      freeBalance,
    };
    logBlockedOrder(event);
    
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'INSUFFICIENT_BALANCE',
      reason: `Market reserved $${marketReserved.toFixed(2)} + $${requiredNotional.toFixed(2)} > max $${FUNDING_CONFIG.maxReservedPerMarket} per market`,
    };
  }
  
  // v6.0.1: Check total reserved limit
  if (reservedNotional + requiredNotional > FUNDING_CONFIG.maxTotalReserved) {
    const event: OrderBlockedEvent = {
      type: 'ORDER_BLOCKED_INSUFFICIENT_FUNDS',
      ts: Date.now(),
      marketId,
      side,
      requiredNotional,
      availableBalance,
      reservedNotional,
      freeBalance,
    };
    logBlockedOrder(event);
    
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'INSUFFICIENT_BALANCE',
      reason: `Total reserved $${reservedNotional.toFixed(2)} + $${requiredNotional.toFixed(2)} > max $${FUNDING_CONFIG.maxTotalReserved}`,
    };
  }
  
  // Check if we have enough free balance for this order
  if (freeBalance < requiredNotional) {
    const event: OrderBlockedEvent = {
      type: 'ORDER_BLOCKED_INSUFFICIENT_FUNDS',
      ts: Date.now(),
      marketId,
      side,
      requiredNotional,
      availableBalance,
      reservedNotional,
      freeBalance,
    };
    logBlockedOrder(event);
    
    return {
      canProceed: false,
      availableBalance,
      reservedNotional,
      freeBalance,
      requiredNotional,
      reasonCode: 'INSUFFICIENT_BALANCE',
      reason: `Free balance $${freeBalance.toFixed(2)} < required $${requiredNotional.toFixed(2)} (available: $${availableBalance.toFixed(2)}, reserved: $${reservedNotional.toFixed(2)})`,
    };
  }
  
  return {
    canProceed: true,
    availableBalance,
    reservedNotional,
    freeBalance,
    requiredNotional,
    reasonCode: 'OK',
  };
}

// ============================================================
// LOGGING
// ============================================================

const blockedOrderLog: OrderBlockedEvent[] = [];

function logBlockedOrder(event: OrderBlockedEvent): void {
  blockedOrderLog.push(event);
  
  // Keep only last 1000 events
  while (blockedOrderLog.length > 1000) {
    blockedOrderLog.shift();
  }
  
  if (FUNDING_CONFIG.logEvents) {
    console.log(`🛑 [ORDER_BLOCKED] ${event.side} on ${event.marketId}`);
    console.log(`   Required: $${event.requiredNotional.toFixed(2)}`);
    console.log(`   Available: $${event.availableBalance.toFixed(2)}`);
    console.log(`   Reserved: $${event.reservedNotional.toFixed(2)}`);
    console.log(`   Free: $${event.freeBalance.toFixed(2)}`);
  }
}

export function getBlockedOrderStats(): {
  total: number;
  last1h: number;
  last24h: number;
  byMarket: Map<string, number>;
} {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  
  let last1h = 0;
  let last24h = 0;
  const byMarket = new Map<string, number>();
  
  for (const event of blockedOrderLog) {
    if (now - event.ts < hour) last1h++;
    if (now - event.ts < day) last24h++;
    
    const count = byMarket.get(event.marketId) || 0;
    byMarket.set(event.marketId, count + 1);
  }
  
  return {
    total: blockedOrderLog.length,
    last1h,
    last24h,
    byMarket,
  };
}

// ============================================================
// EXPORTS
// ============================================================

export {
  getAvailableBalance,
};
