// ============================================================
// V35 PROACTIVE REBALANCER
// ============================================================
// Version: V35.5.2 - "Cached Hedge Orders"
//
// STRATEGY: Pre-place limit orders at max profitable price.
// When imbalance exists, place a BUY limit order at the price
// that would lock in profit. The order sits and waits for the
// market to come to us - instant execution when price arrives.
//
// Benefits:
// 1. No latency when price becomes favorable
// 2. Order is already in the book, ready to be hit
// 3. Updates order if better price becomes available
// ============================================================

import { getV35Config, V35_VERSION } from './config.js';
import type { V35Market, V35Side } from './types.js';
import { placeOrder, getOpenOrders, cancelOrder } from '../polymarket.js';
import { saveBotEvent, type BotEvent } from '../backend.js';
import { getErrorMessage, safeStringify } from './utils.js';

// ============================================================
// TYPES
// ============================================================

export interface RebalanceResult {
  attempted: boolean;
  hedged: boolean;
  reason?: string;
  hedgeSide?: V35Side;
  hedgeQty?: number;
  hedgePrice?: number;
  combinedCost?: number;
  edge?: number;
}

interface CachedHedgeOrder {
  orderId: string;
  side: V35Side;
  price: number;
  qty: number;
  marketSlug: string;
  placedAt: number;
}

// ============================================================
// PROACTIVE REBALANCER CLASS
// ============================================================

export class ProactiveRebalancer {
  private lastCheckMs = 0;
  private checkIntervalMs = 500; // Fast polling for quick response
  
  // Cached hedge order: pre-placed and waiting for fill
  private cachedOrder: CachedHedgeOrder | null = null;
  
  constructor() {}

  /**
   * Main entry point - called from runner loop.
   * 
   * Strategy:
   * 1. If imbalance > threshold, calculate max profitable hedge price
   * 2. Place limit order at that price (or update existing)
   * 3. Monitor for fill - when price comes to us, instant execution
   */
  async checkAndRebalance(market: V35Market): Promise<RebalanceResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // Rate limit checks
    if (now - this.lastCheckMs < this.checkIntervalMs) {
      return { attempted: false, hedged: false, reason: 'cooldown' };
    }
    this.lastCheckMs = now;
    
    // Calculate imbalance
    const upQty = market.upQty || 0;
    const downQty = market.downQty || 0;
    const gap = Math.abs(upQty - downQty);
    
    // Only act on meaningful imbalance
    if (gap < 5) {
      // Clear any cached order if we're balanced
      if (this.cachedOrder) {
        await this.cancelCachedOrder('position_balanced');
      }
      return { attempted: false, hedged: false, reason: 'balanced' };
    }
    
    // Determine hedge parameters
    const needsMore: V35Side = upQty < downQty ? 'UP' : 'DOWN';
    const hedgeQty = gap;
    const hedgeAsk = needsMore === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Average cost of the LEADING side (what we're hedging against)
    const leadingAvg = needsMore === 'UP' 
      ? (market.downQty > 0 ? market.downCost / market.downQty : 0)
      : (market.upQty > 0 ? market.upCost / market.upQty : 0);
    
    if (hedgeAsk <= 0 || hedgeAsk >= 1) {
      return { attempted: false, hedged: false, reason: 'no_liquidity' };
    }
    
    // Calculate max profitable hedge price
    const maxProfitablePrice = Math.min(
      1 - leadingAvg - config.minEdgeAfterHedge,
      0.95
    );
    
    // Check minimum notional
    const minNotional = config.minHedgeNotional || 1.50;
    if (hedgeQty * maxProfitablePrice < minNotional) {
      return { 
        attempted: true, 
        hedged: false, 
        reason: `below_min_notional`,
        hedgeSide: needsMore,
        hedgeQty,
      };
    }
    
    const projectedCombined = leadingAvg + hedgeAsk;
    const projectedEdge = 1 - projectedCombined;
    const leadingSide = needsMore === 'UP' ? 'DOWN' : 'UP';
    
    // ================================================================
    // CHECK EXISTING CACHED ORDER
    // ================================================================
    
    if (this.cachedOrder && this.cachedOrder.marketSlug === market.slug) {
      return await this.monitorCachedOrder(market, hedgeAsk, maxProfitablePrice, leadingAvg);
    }
    
    // Clear stale cached order from different market
    if (this.cachedOrder && this.cachedOrder.marketSlug !== market.slug) {
      await this.cancelCachedOrder('market_changed');
    }
    
    // ================================================================
    // PLACE NEW CACHED HEDGE ORDER
    // ================================================================
    
    const tokenId = needsMore === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[Rebalancer] 🎯 PLACING CACHED HEDGE ORDER`);
    console.log(`[Rebalancer]    Imbalance: ${gap} shares (UP: ${upQty}, DOWN: ${downQty})`);
    console.log(`[Rebalancer]    Need: ${hedgeQty} ${needsMore} @ limit $${maxProfitablePrice.toFixed(3)}`);
    console.log(`[Rebalancer]    Current ask: $${hedgeAsk.toFixed(3)} | ${leadingSide} avg: $${leadingAvg.toFixed(3)}`);
    console.log(`[Rebalancer]    Order will fill when ask ≤ $${maxProfitablePrice.toFixed(3)}`);
    
    if (config.dryRun) {
      console.log(`[Rebalancer] [DRY RUN] Would place cached order`);
      return { attempted: true, hedged: false, reason: 'dry_run' };
    }
    
    try {
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: maxProfitablePrice,
        size: hedgeQty,
        orderType: 'GTC',
      });
      
      if (!result.success || !result.orderId) {
        console.log(`[Rebalancer] ❌ Failed to place cached order: ${result.error}`);
        return { attempted: true, hedged: false, reason: result.error || 'placement_failed' };
      }
      
      // Cache the order
      this.cachedOrder = {
        orderId: result.orderId,
        side: needsMore,
        price: maxProfitablePrice,
        qty: hedgeQty,
        marketSlug: market.slug,
        placedAt: now,
      };
      
      console.log(`[Rebalancer] ✓ Cached order placed: ${result.orderId.slice(0, 8)}...`);
      
      await this.logEvent('cached_hedge_placed', market, {
        hedge_side: needsMore,
        hedge_qty: hedgeQty,
        target_price: maxProfitablePrice,
        current_ask: hedgeAsk,
        leading_avg: leadingAvg,
        order_id: result.orderId,
      });
      
      return {
        attempted: true,
        hedged: false,
        reason: 'cached_order_placed',
        hedgeSide: needsMore,
        hedgeQty,
        hedgePrice: maxProfitablePrice,
      };
      
    } catch (err) {
      console.error(`[Rebalancer] Error placing cached order:`, getErrorMessage(err));
      return { attempted: true, hedged: false, reason: `error: ${getErrorMessage(err)}` };
    }
  }
  
  /**
   * Monitor an existing cached order for fills or price improvements
   */
  private async monitorCachedOrder(
    market: V35Market,
    currentAsk: number,
    maxProfitablePrice: number,
    leadingAvg: number
  ): Promise<RebalanceResult> {
    const cached = this.cachedOrder!;
    const now = Date.now();
    
    // Check order status
    const { orders, error } = await getOpenOrders();
    if (error) {
      console.log(`[Rebalancer] ⚠️ Status check failed: ${error}`);
      return { attempted: true, hedged: false, reason: 'status_check_error' };
    }
    
    const stillOpen = orders.find(o => o.orderId === cached.orderId);
    
    // ================================
    // ORDER FILLED!
    // ================================
    if (!stillOpen) {
      const waitTimeMs = now - cached.placedAt;
      console.log(`[Rebalancer] 🎉 CACHED HEDGE FILLED! ${cached.qty} ${cached.side} @ $${cached.price.toFixed(3)} (waited ${(waitTimeMs/1000).toFixed(1)}s)`);
      
      await this.logEvent('cached_hedge_filled', market, {
        hedge_side: cached.side,
        hedge_qty: cached.qty,
        hedge_price: cached.price,
        wait_time_ms: waitTimeMs,
        combined_cost: leadingAvg + cached.price,
        edge: 1 - (leadingAvg + cached.price),
      });
      
      this.cachedOrder = null;
      
      return {
        attempted: true,
        hedged: true,
        hedgeSide: cached.side,
        hedgeQty: cached.qty,
        hedgePrice: cached.price,
        combinedCost: leadingAvg + cached.price,
        edge: 1 - (leadingAvg + cached.price),
      };
    }
    
    // ================================
    // CHECK FOR PARTIAL FILL
    // ================================
    const originalSize = stillOpen.originalSize || cached.qty;
    const remainingSize = stillOpen.size || 0;
    const filledQty = Math.max(0, originalSize - remainingSize);
    
    if (filledQty > 0) {
      console.log(`[Rebalancer] ✓ Partial fill: ${filledQty}/${cached.qty} filled, ${remainingSize} remaining`);
      // Update cached qty to track remaining
      cached.qty = remainingSize;
    }
    
    // ================================
    // CHECK FOR PRICE IMPROVEMENT
    // ================================
    const priceDiff = cached.price - currentAsk;
    
    // If ask dropped significantly (>2¢) and is still profitable, update order
    if (priceDiff > 0.02 && currentAsk <= maxProfitablePrice) {
      console.log(`[Rebalancer] 📉 Price improved! Ask $${currentAsk.toFixed(3)} vs order $${cached.price.toFixed(3)}`);
      console.log(`[Rebalancer]    Updating order to better price: $${currentAsk.toFixed(3)}`);
      
      // Cancel and re-place at better price
      await this.cancelCachedOrder('price_improved');
      // Next loop will place new order at better price
      return { attempted: true, hedged: false, reason: 'updating_price' };
    }
    
    // ================================
    // STILL WAITING
    // ================================
    const waitingSecs = ((now - cached.placedAt) / 1000).toFixed(0);
    console.log(`[Rebalancer] ⏳ Waiting: ${cached.qty} ${cached.side} @ $${cached.price.toFixed(3)} | Ask: $${currentAsk.toFixed(3)} | ${waitingSecs}s`);
    
    return {
      attempted: true,
      hedged: false,
      reason: 'cached_order_waiting',
      hedgeSide: cached.side,
      hedgeQty: cached.qty,
      hedgePrice: cached.price,
    };
  }
  
  /**
   * Cancel the cached order
   */
  private async cancelCachedOrder(reason: string): Promise<void> {
    if (!this.cachedOrder) return;
    
    console.log(`[Rebalancer] 🗑️ Cancelling cached order (${reason}): ${this.cachedOrder.orderId.slice(0, 8)}...`);
    
    try {
      await cancelOrder(this.cachedOrder.orderId);
    } catch (err) {
      console.log(`[Rebalancer] ⚠️ Cancel failed: ${getErrorMessage(err)}`);
    }
    
    this.cachedOrder = null;
  }
  
  /**
   * Log events to bot_events table
   */
  private async logEvent(
    eventType: string,
    market: V35Market,
    data: Record<string, unknown>
  ): Promise<void> {
    try {
      const event: BotEvent = {
        event_type: eventType,
        asset: market.asset,
        market_id: market.slug,
        ts: Date.now(),
        data: {
          ...data,
          up_qty: market.upQty,
          down_qty: market.downQty,
          version: V35_VERSION,
        },
      };
      await saveBotEvent(event);
    } catch (err) {
      console.error('[Rebalancer] Failed to log event:', getErrorMessage(err));
    }
  }
  
  /**
   * Clear cached order when switching markets
   */
  async clearForNewMarket(): Promise<void> {
    if (this.cachedOrder) {
      await this.cancelCachedOrder('new_market');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SINGLETON
// ============================================================

let instance: ProactiveRebalancer | null = null;

export function getProactiveRebalancer(): ProactiveRebalancer {
  if (!instance) {
    instance = new ProactiveRebalancer();
  }
  return instance;
}

export function resetProactiveRebalancer(): void {
  instance = null;
}

export function resetOpportunityTracking(): void {
  // For backwards compatibility - now handled by clearForNewMarket
  if (instance) {
    instance.clearForNewMarket();
  }
}
