// ============================================================
// V35 PROACTIVE REBALANCER
// ============================================================
// Version: V35.10.3 - "Aggressive Hedge + Tighter Limits"
//
// V35.10.3 SAFETY TIGHTENING:
// ================================================================
// - Emergency mode triggers at 10 shares (was 15)
// - Emergency max cost: 1.20 (was 1.15) - accept 20% loss to balance
// - Works with circuit breaker 10/15/20 thresholds
//
// V35.10.0 ORIGINAL REWRITE:
// ================================================================
// PROBLEM 1: Bot placed orders on fixed grid far from market ask
// SOLUTION: Now places ONE order at current ask + small offset
//
// PROBLEM 2: "Paired >= 10" guard blocked all rebalancing from flat
// SOLUTION: Removed this guard. ANY imbalance > 5 triggers rebalance.
//
// PROBLEM 3: No continuous hedging - only hedged on new fills
// SOLUTION: Now actively seeks hedges for EXISTING unhedged exposure
//           every loop iteration, not just after fills.
//
// PROBLEM 4: With 10 UP @ 36c and UP now at 13c, bot didn't re-hedge
// SOLUTION: Rebalancer now ALWAYS tries to buy lagging side if gap > 5,
//           regardless of "paired" volume or original entry prices.
//
// STRATEGY: Keep UP ≈ DOWN within ±5 shares tolerance.
// - If gap > 5 → buy the LAGGING side (not expensive/cheap, just lagging)
// - Place order AT or VERY CLOSE to current ask for max fill probability
// - Accept losses up to 20% in emergency (1.20 combined cost)
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
  filledAt?: number;
  price: number;
  qty: number;
  marketSlug: string;
  placedAt: number;
}

// ============================================================
// CONFIGURATION - V35.10.0 SMART SPREAD PLACEMENT
// ============================================================

const REBALANCER_CONFIG = {
  checkIntervalMs: 500,           // Fast polling
  balanceTolerance: 5,            // ±5 shares is "balanced"
  maxCombinedCost: 1.02,          // Accept up to 2% loss for balance
  emergencyMaxCost: 1.20,         // V35.10.3: 20% loss OK in emergency (was 1.15)
  emergencyThreshold: 10,         // V35.10.3: Gap >= 10 = emergency mode (was 15)
  minOrderNotional: 1.05,         // Just above Polymarket $1 minimum
  postFillCooldownMs: 2000,       // V35.10.0: Reduced to 2s for faster recovery
  orderHoldTimeMs: 1000,          // Min time to keep order before updating
  priceOffsetFromAsk: 0.005,      // V35.10.0: Place order 0.5¢ above ask for speed
};

// ============================================================
// PROACTIVE REBALANCER CLASS
// ============================================================

export class ProactiveRebalancer {
  private lastCheckMs = 0;
  private lastFillMs = 0;
  private cachedOrder: CachedOrder | null = null;
  
  constructor() {}

  /**
   * Main entry point - called from runner loop.
   * 
   * V35.10.0 STRATEGY: "Continuous Balance"
   * 
   * 1. Calculate gap = upQty - downQty
   * 2. If |gap| <= 5 → balanced, no action needed
   * 3. If gap > 5 (UP leads) → buy DOWN to catch up
   * 4. If gap < -5 (DOWN leads) → buy UP to catch up
   * 5. Place order AT current ask (not on fixed grid) for max fill probability
   * 
   * NO "PAIRED" REQUIREMENT - We actively balance even from flat positions.
   * This ensures we ALWAYS try to reduce exposure, not just after fills.
   */
  async checkAndRebalance(market: V35Market): Promise<RebalanceResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // Post-fill cooldown to let API sync catch up
    if (this.lastFillMs > 0 && now - this.lastFillMs < REBALANCER_CONFIG.postFillCooldownMs) {
      const remaining = REBALANCER_CONFIG.postFillCooldownMs - (now - this.lastFillMs);
      return { attempted: false, hedged: false, reason: `post_fill_cooldown: ${remaining}ms` };
    }
    
    // Rate limit checks
    if (now - this.lastCheckMs < REBALANCER_CONFIG.checkIntervalMs) {
      return { attempted: false, hedged: false, reason: 'cooldown' };
    }
    this.lastCheckMs = now;
    
    const upQty = market.upQty || 0;
    const downQty = market.downQty || 0;
    
    // ================================================================
    // V35.10.0: SIMPLE BALANCE LOGIC
    // ================================================================
    // gap = upQty - downQty
    // positive gap → UP leads → buy DOWN
    // negative gap → DOWN leads → buy UP
    const gap = upQty - downQty;
    const maxAllowedGap = REBALANCER_CONFIG.balanceTolerance;
    
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
    const buySide: V35Side = gap > 0 ? 'DOWN' : 'UP';
    const targetQty = Math.abs(gap) - maxAllowedGap; // How much to buy to get within tolerance
    
    // Get current market asks
    const upAsk = market.upBestAsk || 0;
    const downAsk = market.downBestAsk || 0;
    
    if (upAsk <= 0 || downAsk <= 0 || upAsk >= 1 || downAsk >= 1) {
      return { attempted: false, hedged: false, reason: 'no_liquidity' };
    }
    
    // V35.10.0: Use current ask + small offset for fast fills
    const baseAsk = buySide === 'UP' ? upAsk : downAsk;
    const targetPrice = Math.min(baseAsk + REBALANCER_CONFIG.priceOffsetFromAsk, 0.95);
    
    // Calculate projected combined cost using the LEADING side's average cost
    const leadingSide: V35Side = gap > 0 ? 'UP' : 'DOWN';
    const leadingQty = leadingSide === 'UP' ? upQty : downQty;
    const leadingCost = leadingSide === 'UP' ? market.upCost : market.downCost;
    const avgLeadingPrice = leadingQty > 0 ? leadingCost / leadingQty : 0.50;
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
    const paired = Math.min(upQty, downQty);
    console.log(`[Rebalancer] 📈 REBALANCE: gap=${gap.toFixed(0)} (max ±${maxAllowedGap})${isEmergency ? ' ⚠️ EMERGENCY' : ''}`);
    console.log(`[Rebalancer]    State: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} | Paired=${paired.toFixed(0)}`);
    console.log(`[Rebalancer]    Buying ${targetQty.toFixed(0)} ${buySide} @ $${targetPrice.toFixed(3)} (ask=$${baseAsk.toFixed(3)}) | Combined: $${projectedCombined.toFixed(3)}`);
    
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
      return await this.monitorCachedOrder(market, buySide, targetPrice, targetQty);
    }
    
    // Clear stale cached order from different market
    if (this.cachedOrder && this.cachedOrder.marketSlug !== market.slug) {
      await this.cancelCachedOrder('market_changed');
    }
    
    // ================================================================
    // PLACE NEW ORDER AT CURRENT ASK (FAST FILL)
    // ================================================================
    
    const tokenId = buySide === 'UP' ? market.upTokenId : market.downTokenId;
    
    console.log(`[Rebalancer] 🎯 PLACING REBALANCE ORDER`);
    console.log(`[Rebalancer]    ${targetQty.toFixed(0)} ${buySide} @ $${targetPrice.toFixed(3)} (ask+${(REBALANCER_CONFIG.priceOffsetFromAsk * 100).toFixed(1)}¢)`);
    
    if (config.dryRun) {
      console.log(`[Rebalancer] [DRY RUN] Would place order`);
      return { attempted: true, hedged: false, reason: 'dry_run' };
    }
    
    try {
      // Place order AT ask + offset for immediate fill
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: targetPrice,
        size: targetQty,
        orderType: 'GTC',
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
        is_emergency: isEmergency,
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
    expectedQty: number
  ): Promise<RebalanceResult> {
    const cached = this.cachedOrder!;
    const now = Date.now();
    
    // If the side changed (market flipped), cancel and re-evaluate
    if (cached.side !== expectedSide) {
      console.log(`[Rebalancer] 🔄 Side changed: ${cached.side} → ${expectedSide}, cancelling`);
      await this.cancelCachedOrder('side_changed');
      return { attempted: true, hedged: false, reason: 'side_changed' };
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
      console.log(`[Rebalancer] 🎉 ORDER FILLED! ${cached.qty.toFixed(0)} ${cached.side} @ $${cached.price.toFixed(3)} (waited ${(waitTimeMs/1000).toFixed(1)}s)`);
      
      // UPDATE MARKET STATE IMMEDIATELY
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
      
      // Set cooldown timestamp
      this.lastFillMs = now;
      console.log(`[Rebalancer] ⏱️ Post-fill cooldown started (${REBALANCER_CONFIG.postFillCooldownMs}ms)`);
      
      await this.logEvent(`rebalance_filled`, market, {
        side: cached.side,
        qty: cached.qty,
        price: cached.price,
        wait_time_ms: waitTimeMs,
        up_qty: market.upQty,
        down_qty: market.downQty,
      });
      
      this.cachedOrder = null;
      
      return {
        attempted: true,
        hedged: true,
        hedgeSide: cached.side,
        hedgeQty: cached.qty,
        hedgePrice: cached.price,
        stateUpdated: true,
        updatedUpQty: market.upQty,
        updatedDownQty: market.downQty,
      };
    }
    
    // ================================
    // CHECK FOR PARTIAL FILL
    // ================================
    const originalSize = stillOpen.originalSize || cached.qty;
    const remainingSize = stillOpen.size || 0;
    const partialFilledQty = Math.max(0, originalSize - remainingSize);
    
    if (partialFilledQty > 0 && partialFilledQty < cached.qty) {
      const newlyFilled = cached.qty - remainingSize;
      const filledCost = newlyFilled * cached.price;
      
      if (cached.side === 'UP') {
        market.upQty = (market.upQty || 0) + newlyFilled;
        market.upCost = (market.upCost || 0) + filledCost;
      } else {
        market.downQty = (market.downQty || 0) + newlyFilled;
        market.downCost = (market.downCost || 0) + filledCost;
      }
      
      console.log(`[Rebalancer] ✓ Partial fill: ${partialFilledQty.toFixed(0)}/${originalSize.toFixed(0)} filled, ${remainingSize.toFixed(0)} remaining`);
      console.log(`[Rebalancer] 📊 STATE: UP=${market.upQty.toFixed(0)} DOWN=${market.downQty.toFixed(0)}`);
      cached.qty = remainingSize;
    }
    
    // ================================
    // V35.10.0: FOLLOW THE ASK
    // ================================
    // If ask moved DOWN significantly, update our order to match
    // This keeps us competitive in the book
    const holdTimeElapsed = (now - cached.placedAt) >= REBALANCER_CONFIG.orderHoldTimeMs;
    const priceDiff = cached.price - currentAsk;
    
    if (holdTimeElapsed && priceDiff > 0.01) {
      // Our order is MORE than 1¢ above current ask - we overpaid, update
      console.log(`[Rebalancer] 📉 Ask dropped: $${currentAsk.toFixed(3)} (our order at $${cached.price.toFixed(3)})`);
      console.log(`[Rebalancer]    Updating order to follow ask...`);
      await this.cancelCachedOrder('follow_ask');
      return { attempted: true, hedged: false, reason: 'following_ask' };
    }
    
    if (holdTimeElapsed && currentAsk > cached.price + 0.02) {
      // Ask moved UP significantly - our order is now too low, update
      console.log(`[Rebalancer] 📈 Ask rose: $${currentAsk.toFixed(3)} (our order at $${cached.price.toFixed(3)})`);
      console.log(`[Rebalancer]    Updating order to catch up...`);
      await this.cancelCachedOrder('catch_ask');
      return { attempted: true, hedged: false, reason: 'catching_ask' };
    }
    
    // ================================
    // STILL WAITING
    // ================================
    const waitingSecs = ((now - cached.placedAt) / 1000).toFixed(0);
    console.log(`[Rebalancer] ⏳ Waiting: ${cached.qty.toFixed(0)} ${cached.side} @ $${cached.price.toFixed(3)} | Ask: $${currentAsk.toFixed(3)} | ${waitingSecs}s`);
    
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
  if (instance) {
    instance.clearForNewMarket();
  }
}
