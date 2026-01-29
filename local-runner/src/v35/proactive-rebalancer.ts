// ============================================================
// V35 PROACTIVE REBALANCER
// ============================================================
// Version: V35.5.5 - "Expensive-Side Initiative"
//
// STRATEGY: The EXPENSIVE side (determined by orderbook price) always 
// takes the initiative and is allowed to lead by up to 5 shares.
//
// LOGIC:
// 1. Identify expensive side (higher orderbook price = likely winner)
// 2. Calculate: currentLead = expensiveQty - cheapQty
// 3. If currentLead < 5 → buy expensive side until it leads by 5
// 4. On reversal: the NEW expensive side gets bought until it leads by 5
//
// EXAMPLE:
// - UP=50, DOWN=50, asks UP=0.80/DOWN=0.20 → UP is expensive, buy 5 UP
// - After reversal (asks UP=0.45/DOWN=0.55): DOWN now expensive
// - UP=55, DOWN=50, DOWN trails by 5 → buy 10 DOWN (5 balance + 5 lead)
// ============================================================

import { getV35Config, V35_VERSION } from './config.js';
import type { V35Market, V35Side } from './types.js';
import { placeOrder, getOpenOrders, cancelOrder } from '../polymarket.js';
import { saveBotEvent, type BotEvent } from '../backend.js';
import { getErrorMessage, safeStringify } from './utils.js';
import { getV35SidePricing } from './market-pricing.js';

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

interface CachedOrder {
  orderId: string;
  side: V35Side;
  price: number;
  qty: number;
  marketSlug: string;
  placedAt: number;
  purpose: 'build_winner' | 'hedge';
}

// ============================================================
// CONFIGURATION - EXPENSIVE-SIDE INITIATIVE
// ============================================================

const REBALANCER_CONFIG = {
  checkIntervalMs: 500,           // Fast polling
  allowedExpensiveLead: 5,        // Expensive side may lead by 5 shares
  maxCombinedCost: 1.02,          // Allow up to 2% loss for directional trades
  emergencyMaxCost: 1.05,         // Emergency: allow up to 5% loss
  emergencyThreshold: 20,         // Gap >= 20 = emergency
  minOrderNotional: 1.50,         // Polymarket minimum
  orderHoldTimeMs: 1500,          // Min time to keep order before updating
  priceImprovementThreshold: 0.02, // Update order if price drops by 2¢
};

// ============================================================
// PROACTIVE REBALANCER CLASS
// ============================================================

export class ProactiveRebalancer {
  private lastCheckMs = 0;
  private cachedOrder: CachedOrder | null = null;
  
  constructor() {}

  /**
   * Main entry point - called from runner loop.
   * 
   * V35.5.5 STRATEGY: "Expensive-Side Initiative"
   * 
   * The EXPENSIVE side (determined by orderbook price) always takes the lead.
   * It is allowed to lead by up to 5 shares (allowedExpensiveLead).
   * 
   * Logic:
   * 1. Identify expensive side (higher orderbook price = likely winner)
   * 2. Calculate: currentLead = expensiveQty - cheapQty
   * 3. If currentLead < allowedExpensiveLead → buy expensive side
   * 4. On reversal: the NEW expensive side gets bought until it leads by 5
   * 
   * Example:
   * - UP=50@0.56, DOWN=50@0.30, asks UP=0.80/DOWN=0.20
   * - Expensive=UP, currentLead=0, target=5 → buy 5 UP
   * - After reversal (asks UP=0.45/DOWN=0.55):
   * - Expensive=DOWN, UP=55, DOWN=50, currentLead=-5
   * - Need to buy 10 DOWN (5 to balance + 5 to lead)
   */
  async checkAndRebalance(market: V35Market): Promise<RebalanceResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // Rate limit checks
    if (now - this.lastCheckMs < REBALANCER_CONFIG.checkIntervalMs) {
      return { attempted: false, hedged: false, reason: 'cooldown' };
    }
    this.lastCheckMs = now;
    
    // Get market pricing info (based on orderbook)
    const pricing = getV35SidePricing(market);
    const { expensiveSide, cheapSide } = pricing;
    
    const upQty = market.upQty || 0;
    const downQty = market.downQty || 0;
    
    // Calculate how much the expensive side leads (or trails if negative)
    const expensiveQty = expensiveSide === 'UP' ? upQty : downQty;
    const cheapQty = cheapSide === 'UP' ? upQty : downQty;
    const currentLead = expensiveQty - cheapQty; // Positive = expensive leads
    
    // Target: expensive side should lead by allowedExpensiveLead
    const targetLead = REBALANCER_CONFIG.allowedExpensiveLead;
    const sharesToBuy = targetLead - currentLead;
    
    // If expensive already leads by enough, nothing to do
    if (sharesToBuy <= 0) {
      if (this.cachedOrder) {
        await this.cancelCachedOrder('expensive_leads_enough');
      }
      return { 
        attempted: false, 
        hedged: false, 
        reason: `expensive_leads_by_${currentLead.toFixed(0)}` 
      };
    }
    
    // Get current market asks
    const upAsk = market.upBestAsk || 0;
    const downAsk = market.downBestAsk || 0;
    
    if (upAsk <= 0 || downAsk <= 0 || upAsk >= 1 || downAsk >= 1) {
      return { attempted: false, hedged: false, reason: 'no_liquidity' };
    }
    
    // ================================================================
    // V35.5.5: BUY EXPENSIVE SIDE TO TAKE/MAINTAIN INITIATIVE
    // ================================================================
    const targetSide = expensiveSide;
    const targetPrice = expensiveSide === 'UP' ? upAsk : downAsk;
    const targetQty = sharesToBuy;
    
    // Determine purpose based on current lead
    const purpose: 'build_winner' | 'hedge' = currentLead < 0 
      ? 'hedge'         // Expensive is trailing, need to catch up
      : 'build_winner'; // Expensive leads but not by enough
    
    // Calculate projected combined cost
    const cheapPrice = cheapSide === 'UP' ? upAsk : downAsk;
    const currentCheapQty = cheapSide === 'UP' ? upQty : downQty;
    const currentCheapCost = cheapSide === 'UP' ? market.upCost : market.downCost;
    const avgCheapPrice = currentCheapQty > 0 ? currentCheapCost / currentCheapQty : 0;
    
    // After buying, what would the combined cost be for paired shares?
    const projectedCombined = avgCheapPrice + targetPrice;
    
    // Emergency mode: gap is very large
    const gap = Math.abs(upQty - downQty);
    const isEmergency = gap >= REBALANCER_CONFIG.emergencyThreshold;
    const effectiveMaxCost = isEmergency 
      ? REBALANCER_CONFIG.emergencyMaxCost 
      : REBALANCER_CONFIG.maxCombinedCost;
    
    // Check viability
    if (projectedCombined > effectiveMaxCost) {
      console.log(`[Rebalancer] ⚠️ ${purpose} too expensive: combined $${projectedCombined.toFixed(3)} > $${effectiveMaxCost.toFixed(2)}${isEmergency ? ' (emergency limit)' : ''}`);
      return { 
        attempted: true, 
        hedged: false, 
        reason: `${purpose}_too_expensive: ${projectedCombined.toFixed(3)}`,
        hedgeSide: targetSide,
        hedgeQty: targetQty,
      };
    }
    
    // Log the action
    console.log(`[Rebalancer] 📈 ${purpose.toUpperCase()}: ${expensiveSide} is expensive, needs ${sharesToBuy.toFixed(0)} more to lead by ${targetLead}`);
    console.log(`[Rebalancer]    Current: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} | Expensive=${expensiveSide} leads by ${currentLead.toFixed(0)}${isEmergency ? ' ⚠️ EMERGENCY' : ''}`);
    console.log(`[Rebalancer]    Will buy ${targetQty.toFixed(0)} ${targetSide} @ $${targetPrice.toFixed(3)} | Combined: $${projectedCombined.toFixed(3)}`);
    
    // Check minimum notional
    if (targetQty * targetPrice < REBALANCER_CONFIG.minOrderNotional) {
      return { 
        attempted: true, 
        hedged: false, 
        reason: `below_min_notional`,
        hedgeSide: targetSide,
        hedgeQty: targetQty,
      };
    }
    
    // ================================================================
    // CHECK EXISTING CACHED ORDER
    // ================================================================
    
    if (this.cachedOrder && this.cachedOrder.marketSlug === market.slug) {
      return await this.monitorCachedOrder(market, targetSide, targetPrice, targetQty, purpose);
    }
    
    // Clear stale cached order from different market
    if (this.cachedOrder && this.cachedOrder.marketSlug !== market.slug) {
      await this.cancelCachedOrder('market_changed');
    }
    
    // ================================================================
    // PLACE NEW ORDER AT CURRENT MARKET PRICE
    // ================================================================
    
    const tokenId = targetSide === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[Rebalancer] 🎯 PLACING ${purpose.toUpperCase()} ORDER`);
    console.log(`[Rebalancer]    ${targetQty.toFixed(0)} ${targetSide} @ $${targetPrice.toFixed(3)} (CURRENT ASK)`);
    
    if (config.dryRun) {
      console.log(`[Rebalancer] [DRY RUN] Would place order`);
      return { attempted: true, hedged: false, reason: 'dry_run' };
    }
    
    try {
      // Place order at current ask - should fill immediately or very soon
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: targetPrice,
        size: targetQty,
        orderType: 'GTC', // Use GTC, but at current ask it should fill fast
      });
      
      if (!result.success || !result.orderId) {
        console.log(`[Rebalancer] ❌ Failed to place order: ${result.error}`);
        return { attempted: true, hedged: false, reason: result.error || 'placement_failed' };
      }
      
      // Cache the order
      this.cachedOrder = {
        orderId: result.orderId,
        side: targetSide,
        price: targetPrice,
        qty: targetQty,
        marketSlug: market.slug,
        placedAt: now,
        purpose,
      };
      
      console.log(`[Rebalancer] ✓ Order placed: ${result.orderId.slice(0, 8)}... (${purpose})`);
      
      await this.logEvent(`${purpose}_order_placed`, market, {
        side: targetSide,
        qty: targetQty,
        price: targetPrice,
        purpose,
        order_id: result.orderId,
        up_qty: upQty,
        down_qty: downQty,
        expensive_side: expensiveSide,
      });
      
      return {
        attempted: true,
        hedged: false,
        reason: 'order_placed',
        hedgeSide: targetSide,
        hedgeQty: targetQty,
        hedgePrice: targetPrice,
      };
      
    } catch (err) {
      console.error(`[Rebalancer] Error placing order:`, getErrorMessage(err));
      return { attempted: true, hedged: false, reason: `error: ${getErrorMessage(err)}` };
    }
  }
  
  /**
   * Monitor an existing cached order for fills or price improvements
   */
  private async monitorCachedOrder(
    market: V35Market,
    expectedSide: V35Side,
    currentAsk: number,
    expectedQty: number,
    expectedPurpose: 'build_winner' | 'hedge'
  ): Promise<RebalanceResult> {
    const cached = this.cachedOrder!;
    const now = Date.now();
    
    // If the purpose changed (e.g., we were building winner but now need to hedge), cancel and re-place
    if (cached.purpose !== expectedPurpose || cached.side !== expectedSide) {
      console.log(`[Rebalancer] 🔄 Strategy changed: ${cached.purpose} → ${expectedPurpose}`);
      await this.cancelCachedOrder('strategy_changed');
      return { attempted: true, hedged: false, reason: 'strategy_changed' };
    }
    
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
      console.log(`[Rebalancer] 🎉 ORDER FILLED! ${cached.qty.toFixed(0)} ${cached.side} @ $${cached.price.toFixed(3)} (waited ${(waitTimeMs/1000).toFixed(1)}s) [${cached.purpose}]`);
      
      await this.logEvent(`${cached.purpose}_filled`, market, {
        side: cached.side,
        qty: cached.qty,
        price: cached.price,
        wait_time_ms: waitTimeMs,
        purpose: cached.purpose,
      });
      
      this.cachedOrder = null;
      
      return {
        attempted: true,
        hedged: cached.purpose === 'hedge',
        hedgeSide: cached.side,
        hedgeQty: cached.qty,
        hedgePrice: cached.price,
      };
    }
    
    // ================================
    // CHECK FOR PARTIAL FILL
    // ================================
    const originalSize = stillOpen.originalSize || cached.qty;
    const remainingSize = stillOpen.size || 0;
    const filledQty = Math.max(0, originalSize - remainingSize);
    
    if (filledQty > 0) {
      console.log(`[Rebalancer] ✓ Partial fill: ${filledQty.toFixed(0)}/${cached.qty.toFixed(0)} filled, ${remainingSize.toFixed(0)} remaining`);
      cached.qty = remainingSize;
    }
    
    // ================================
    // CHECK IF WE SHOULD UPDATE PRICE
    // ================================
    // If market ask dropped significantly, update our order to match
    const priceDiff = cached.price - currentAsk;
    const holdTimeElapsed = (now - cached.placedAt) >= REBALANCER_CONFIG.orderHoldTimeMs;
    
    if (holdTimeElapsed && priceDiff > REBALANCER_CONFIG.priceImprovementThreshold) {
      console.log(`[Rebalancer] 📉 Price improved! Ask $${currentAsk.toFixed(3)} vs order $${cached.price.toFixed(3)}`);
      console.log(`[Rebalancer]    Updating order to better price: $${currentAsk.toFixed(3)}`);
      
      await this.cancelCachedOrder('price_improved');
      return { attempted: true, hedged: false, reason: 'updating_price' };
    }
    
    // If market ask INCREASED, we might want to cancel and re-evaluate
    // But for now, keep the order at our better price - it might get filled
    
    // ================================
    // STILL WAITING
    // ================================
    const waitingSecs = ((now - cached.placedAt) / 1000).toFixed(0);
    console.log(`[Rebalancer] ⏳ Waiting: ${cached.qty.toFixed(0)} ${cached.side} @ $${cached.price.toFixed(3)} | Ask: $${currentAsk.toFixed(3)} | ${waitingSecs}s [${cached.purpose}]`);
    
    return {
      attempted: true,
      hedged: false,
      reason: 'order_waiting',
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
    
    console.log(`[Rebalancer] 🗑️ Cancelling order (${reason}): ${this.cachedOrder.orderId.slice(0, 8)}...`);
    
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
  
  /**
   * Get current cached order info (for debugging/monitoring)
   */
  getCachedOrderInfo(): CachedOrder | null {
    return this.cachedOrder ? { ...this.cachedOrder } : null;
  }
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
