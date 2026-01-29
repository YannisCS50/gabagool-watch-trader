// ============================================================
// V35 PROACTIVE REBALANCER
// ============================================================
// Version: V35.9.3 - "Balance-First Rebalancer"
//
// V35.9.3 CHANGES:
// - CRITICAL FIX: Rebalancer now targets BALANCE, not "expensive side lead"
// - The goal is to keep UP ≈ DOWN, with tolerance of ±5 shares
// - If one side leads by more than 5, buy the OTHER side to catch up
// - Removed confusing "expensive/cheap" logic that caused inverted trades
//
// STRATEGY: Keep inventory balanced. Always buy the LAGGING side.
//
// LOGIC:
// 1. Calculate gap = upQty - downQty
// 2. If |gap| <= 5 → balanced, no action needed
// 3. If gap > 5 (UP leads) → buy DOWN to catch up
// 4. If gap < -5 (DOWN leads) → buy UP to catch up
// 5. HYBRID: Only take action if paired >= 10 shares (prevents speculation)
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
  // V35.9.0: State update info
  stateUpdated?: boolean;
  updatedUpQty?: number;
  updatedDownQty?: number;
}

interface CachedOrder {
  orderId: string;
  side: V35Side;
  filledAt?: number; // V35.9.1: Track when order was filled to prevent rapid re-orders
  price: number;
  qty: number;
  marketSlug: string;
  placedAt: number;
  purpose: 'build_winner' | 'hedge';
}

// ============================================================
// CONFIGURATION - V35.9.1 POST-FILL COOLDOWN
// ============================================================

const REBALANCER_CONFIG = {
  checkIntervalMs: 500,           // Fast polling
  allowedExpensiveLead: 5,        // Expensive side may lead by 5 shares
  maxCombinedCost: 1.02,          // Allow up to 2% loss for directional trades
  emergencyMaxCost: 1.15,         // V35.9.0: 15% loss OK in emergency
  emergencyThreshold: 15,         // V35.9.0: Gap >= 15 = emergency (was 20)
  minPairedForBuildWinner: 10,    // V35.9.0: Only build_winner if paired >= 10
  minOrderNotional: 1.50,         // Polymarket minimum
  postFillCooldownMs: 3000,       // V35.9.1: Wait 3s after fill before new rebalance
  orderHoldTimeMs: 1500,          // Min time to keep order before updating
  priceImprovementThreshold: 0.02, // Update order if price drops by 2¢
};

// ============================================================
// PROACTIVE REBALANCER CLASS
// ============================================================

export class ProactiveRebalancer {
  private lastCheckMs = 0;
  private lastFillMs = 0; // V35.9.1: Track last fill time to enforce cooldown
  private cachedOrder: CachedOrder | null = null;
  
  constructor() {}

  /**
   * Main entry point - called from runner loop.
   * 
   * V35.9.0 STRATEGY: "Hybrid Mode"
   * 
   * HEDGE when trailing (gap < 0): Always allowed, uses aggressive limits.
   * BUILD_WINNER when leading but < 5: Only if paired >= 10 shares.
   * 
   * This prevents the bot from speculatively buying one side from flat,
   * which creates unhedged exposure. Build_winner is only used to
   * "extend the lead" when there's already meaningful paired exposure.
   */
  async checkAndRebalance(market: V35Market): Promise<RebalanceResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // V35.9.1: Post-fill cooldown to let API sync catch up
    if (this.lastFillMs > 0 && now - this.lastFillMs < REBALANCER_CONFIG.postFillCooldownMs) {
      const remaining = REBALANCER_CONFIG.postFillCooldownMs - (now - this.lastFillMs);
      console.log(`[Rebalancer] ⏸️ Post-fill cooldown: ${(remaining/1000).toFixed(1)}s remaining`);
      return { attempted: false, hedged: false, reason: `post_fill_cooldown: ${remaining}ms` };
    }
    
    // Rate limit checks
    if (now - this.lastCheckMs < REBALANCER_CONFIG.checkIntervalMs) {
      return { attempted: false, hedged: false, reason: 'cooldown' };
    }
    this.lastCheckMs = now;
    
    const upQty = market.upQty || 0;
    const downQty = market.downQty || 0;
    const paired = Math.min(upQty, downQty);
    
    // ================================================================
    // V35.9.3: BALANCE-FIRST LOGIC
    // ================================================================
    // Simple: gap = upQty - downQty
    // If gap > +5 → UP leads too much → buy DOWN
    // If gap < -5 → DOWN leads too much → buy UP
    // If |gap| <= 5 → balanced, no action
    const gap = upQty - downQty;
    const maxAllowedGap = REBALANCER_CONFIG.allowedExpensiveLead; // ±5
    
    // If balanced, nothing to do
    if (Math.abs(gap) <= maxAllowedGap) {
      if (this.cachedOrder) {
        await this.cancelCachedOrder('already_balanced');
      }
      return {
        attempted: false,
        hedged: false,
        reason: `balanced (gap=${gap.toFixed(1)}, max=±${maxAllowedGap})`,
      };
    }
    
    // Determine which side to buy (the LAGGING side)
    const buySide: V35Side = gap > 0 ? 'DOWN' : 'UP'; // If UP leads, buy DOWN
    const targetQty = Math.abs(gap) - maxAllowedGap; // How much to buy to get within tolerance
    
    // Get current market asks
    const upAsk = market.upBestAsk || 0;
    const downAsk = market.downBestAsk || 0;
    
    if (upAsk <= 0 || downAsk <= 0 || upAsk >= 1 || downAsk >= 1) {
      return { attempted: false, hedged: false, reason: 'no_liquidity' };
    }
    
    const targetPrice = buySide === 'UP' ? upAsk : downAsk;

    // V35.9.3: HYBRID MODE - only rebalance if there's meaningful paired exposure
    // This prevents speculative one-sided buying from flat
    if (paired < REBALANCER_CONFIG.minPairedForBuildWinner) {
      console.log(`[Rebalancer] ⏳ HYBRID: Skipping rebalance (paired=${paired.toFixed(0)} < ${REBALANCER_CONFIG.minPairedForBuildWinner})`);
      return {
        attempted: false,
        hedged: false,
        reason: `hybrid_skip: paired=${paired.toFixed(0)}`,
      };
    }
    
    // Calculate projected combined cost
    const leadingSide: V35Side = gap > 0 ? 'UP' : 'DOWN';
    const leadingQty = leadingSide === 'UP' ? upQty : downQty;
    const leadingCost = leadingSide === 'UP' ? market.upCost : market.downCost;
    const avgLeadingPrice = leadingQty > 0 ? leadingCost / leadingQty : 0;
    const projectedCombined = avgLeadingPrice + targetPrice;
    
    // Emergency mode at large gaps
    const absGap = Math.abs(gap);
    const isEmergency = absGap >= REBALANCER_CONFIG.emergencyThreshold;
    const effectiveMaxCost = isEmergency 
      ? REBALANCER_CONFIG.emergencyMaxCost 
      : REBALANCER_CONFIG.maxCombinedCost;
    
    // Check viability
    if (projectedCombined > effectiveMaxCost) {
      console.log(`[Rebalancer] ⚠️ Rebalance too expensive: combined $${projectedCombined.toFixed(3)} > $${effectiveMaxCost.toFixed(2)}${isEmergency ? ' (emergency 1.15)' : ''}`);
      return {
        attempted: true,
        hedged: false,
        reason: `rebalance_too_expensive: ${projectedCombined.toFixed(3)}`,
        hedgeSide: buySide,
        hedgeQty: targetQty,
      };
    }
    
    // Log the action
    console.log(`[Rebalancer] 📈 REBALANCE: gap=${gap.toFixed(0)} (max ±${maxAllowedGap})${isEmergency ? ' ⚠️ EMERGENCY' : ''}`);
    console.log(`[Rebalancer]    State: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} | Paired=${paired.toFixed(0)}`);
    console.log(`[Rebalancer]    Will buy ${targetQty.toFixed(0)} ${buySide} @ $${targetPrice.toFixed(3)} to balance | Combined: $${projectedCombined.toFixed(3)}`);
    
    // Check minimum notional
    if (targetQty * targetPrice < REBALANCER_CONFIG.minOrderNotional) {
      return {
        attempted: true,
        hedged: false,
        reason: `below_min_notional`,
        hedgeSide: buySide,
        hedgeQty: targetQty,
      };
    }
    
    // ================================================================
    // CHECK EXISTING CACHED ORDER
    // ================================================================
    
    if (this.cachedOrder && this.cachedOrder.marketSlug === market.slug) {
      return await this.monitorCachedOrder(market, buySide, targetPrice, targetQty, purpose);
    }
    
    // Clear stale cached order from different market
    if (this.cachedOrder && this.cachedOrder.marketSlug !== market.slug) {
      await this.cancelCachedOrder('market_changed');
    }
    
    // ================================================================
    // PLACE NEW ORDER AT CURRENT MARKET PRICE
    // ================================================================
    
    const tokenId = buySide === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[Rebalancer] 🎯 PLACING REBALANCE ORDER`);
    console.log(`[Rebalancer]    ${targetQty.toFixed(0)} ${buySide} @ $${targetPrice.toFixed(3)} (CURRENT ASK)`);
    
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
        side: buySide,
        price: targetPrice,
        qty: targetQty,
        marketSlug: market.slug,
        placedAt: now,
        purpose: 'hedge', // All rebalance orders are hedges (risk reduction)
      };
      
      console.log(`[Rebalancer] ✓ Order placed: ${result.orderId.slice(0, 8)}...`);
      
      await this.logEvent(`rebalance_order_placed`, market, {
        side: buySide,
        qty: targetQty,
        price: targetPrice,
        order_id: result.orderId,
        up_qty: upQty,
        down_qty: downQty,
        gap: gap,
        target_gap: maxAllowedGap,
      });
      
      return {
        attempted: true,
        hedged: false,
        reason: 'order_placed',
          hedgeSide: buySide,
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
      
      // V35.9.0: UPDATE MARKET STATE IMMEDIATELY
      // This is critical - the main runner loop reads market.upQty/downQty
      // and we must reflect fills from the rebalancer, not just WebSocket fills.
      const filledQty = cached.qty;
      const filledPrice = cached.price;
      const filledCost = filledQty * filledPrice;
      
      if (cached.side === 'UP') {
        market.upQty += filledQty;
        market.upCost += filledCost;
        market.upFills++;
      } else {
        market.downQty += filledQty;
        market.downCost += filledCost;
        market.downFills++;
      }
      
      console.log(`[Rebalancer] 📊 STATE UPDATED: UP=${market.upQty.toFixed(0)} DOWN=${market.downQty.toFixed(0)} (added ${filledQty.toFixed(0)} ${cached.side})`);
      
      // V35.9.1: Set cooldown timestamp to prevent rapid re-orders
      this.lastFillMs = now;
      console.log(`[Rebalancer] ⏱️ Post-fill cooldown started (${REBALANCER_CONFIG.postFillCooldownMs}ms)`);
      
      await this.logEvent(`${cached.purpose}_filled`, market, {
        side: cached.side,
        qty: cached.qty,
        price: cached.price,
        wait_time_ms: waitTimeMs,
        purpose: cached.purpose,
        up_qty: market.upQty,
        down_qty: market.downQty,
      });
      
      this.cachedOrder = null;
      
      return {
        attempted: true,
        hedged: cached.purpose === 'hedge',
        hedgeSide: cached.side,
        hedgeQty: cached.qty,
        hedgePrice: cached.price,
        // V35.9.0: Return updated state
        stateUpdated: true,
        updatedUpQty: market.upQty,
        updatedDownQty: market.downQty,
      };
    }
    
    // ================================
    // CHECK FOR PARTIAL FILL - V35.9.0: Update state for partial fills too
    // ================================
    const originalSize = stillOpen.originalSize || cached.qty;
    const remainingSize = stillOpen.size || 0;
    const partialFilledQty = Math.max(0, originalSize - remainingSize);
    
    if (partialFilledQty > 0 && partialFilledQty !== cached.qty) {
      // Some shares were filled - update market state
      const newlyFilled = originalSize - remainingSize - (originalSize - cached.qty);
      if (newlyFilled > 0) {
        const filledCost = newlyFilled * cached.price;
        if (cached.side === 'UP') {
          market.upQty += newlyFilled;
          market.upCost += filledCost;
        } else {
          market.downQty += newlyFilled;
          market.downCost += filledCost;
        }
        console.log(`[Rebalancer] ✓ Partial fill: ${partialFilledQty.toFixed(0)}/${originalSize.toFixed(0)} filled (+${newlyFilled.toFixed(0)} ${cached.side}), ${remainingSize.toFixed(0)} remaining`);
        console.log(`[Rebalancer] 📊 STATE: UP=${market.upQty.toFixed(0)} DOWN=${market.downQty.toFixed(0)}`);
      }
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
