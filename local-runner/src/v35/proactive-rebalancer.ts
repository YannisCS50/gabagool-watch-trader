// ============================================================
// V35 PROACTIVE REBALANCER
// ============================================================
// Version: V35.3.3 - "Proactive Hedging"
//
// This module periodically checks for unhedged positions and
// attempts to hedge them if market conditions have improved.
//
// KEY INSIGHT: The reactive HedgeManager only hedges immediately
// after a fill. If the hedge side was too expensive at that moment,
// the position remains unhedged. This module scans for those
// opportunities and hedges them when prices improve.
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

// ============================================================
// PROACTIVE REBALANCER CLASS
// ============================================================

export class ProactiveRebalancer {
  private lastRebalanceAttempt = 0;
  private rebalanceCooldownMs = 2000; // Check every 2 seconds for faster response to reversals
  private hedgeOrderWaitMs = 1500; // Wait 1.5 seconds for hedge order to fill
  
  // Track best opportunity seen - helps recognize reversals
  private bestOpportunity: { ts: number; combinedCost: number; hedgeSide: V35Side } | null = null;
  
  constructor() {}

  /**
   * Called periodically from the main runner loop.
   * Checks if there's an unhedged position that can now be profitably hedged.
   */
  async checkAndRebalance(market: V35Market): Promise<RebalanceResult> {
    const config = getV35Config();
    const now = Date.now();
    
    // Cooldown check
    if (now - this.lastRebalanceAttempt < this.rebalanceCooldownMs) {
      return { attempted: false, hedged: false, reason: 'cooldown' };
    }
    this.lastRebalanceAttempt = now;
    
    // Calculate imbalance
    const upQty = market.upQty || 0;
    const downQty = market.downQty || 0;
    const gap = Math.abs(upQty - downQty);
    
    // Only attempt if there's meaningful imbalance (> 5 shares)
    if (gap < 5) {
      return { attempted: false, hedged: false, reason: 'balanced' };
    }
    
    // Determine which side needs hedging (the side with FEWER shares)
    const needsMore: V35Side = upQty < downQty ? 'UP' : 'DOWN';
    const hedgeQty = gap;
    
    // Get current prices
    const hedgeAsk = needsMore === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // CRITICAL FIX: We need the average cost of the LEADING side (the one we have MORE of)
    // because that's what we're trying to hedge against!
    // If we have more UP, we need to buy DOWN to hedge, so we compare:
    //   - UP avg (what we paid for the leading side)
    //   - DOWN ask (what we'd pay for the hedge)
    const leadingAvg = needsMore === 'UP' 
      ? (market.downQty > 0 ? market.downCost / market.downQty : 0)  // DOWN leads, use DOWN avg
      : (market.upQty > 0 ? market.upCost / market.upQty : 0);       // UP leads, use UP avg
    
    if (hedgeAsk <= 0 || hedgeAsk >= 1) {
      return { attempted: false, hedged: false, reason: 'no_liquidity' };
    }
    
    // Check if hedging now would be profitable
    // Combined cost = leading side avg + hedge side ask
    const projectedCombined = leadingAvg + hedgeAsk;
    const projectedEdge = 1 - projectedCombined;
    
    // Track the best opportunity we've seen (for reversal detection)
    if (!this.bestOpportunity || projectedCombined < this.bestOpportunity.combinedCost) {
      const improved = this.bestOpportunity 
        ? `(improved from $${this.bestOpportunity.combinedCost.toFixed(3)})` 
        : '(first check)';
      console.log(`[Rebalancer] 📊 New best opportunity: combined $${projectedCombined.toFixed(3)} ${improved}`);
      this.bestOpportunity = { ts: Date.now(), combinedCost: projectedCombined, hedgeSide: needsMore };
    }
    
    // Log current state every check - helps track reversals
    const leadingSide = needsMore === 'UP' ? 'DOWN' : 'UP';
    console.log(`[Rebalancer] 📈 Monitoring: UP=${upQty.toFixed(0)} DOWN=${downQty.toFixed(0)} | Gap=${gap.toFixed(0)} | ${leadingSide} avg=$${leadingAvg.toFixed(3)} + ${needsMore} ask=$${hedgeAsk.toFixed(3)} = Combined=$${projectedCombined.toFixed(3)} | Edge=${(projectedEdge * 100).toFixed(2)}%`);
    
    if (projectedEdge < config.minEdgeAfterHedge) {
      // Still log but CONTINUE MONITORING - don't give up!
      console.log(`[Rebalancer] ⏳ Waiting for better price... need combined < $${(1 - config.minEdgeAfterHedge).toFixed(3)}`);
      return { 
        attempted: true, 
        hedged: false, 
        reason: `waiting_for_reversal: combined $${projectedCombined.toFixed(3)}`,
        hedgeSide: needsMore,
        hedgeQty,
        combinedCost: projectedCombined,
        edge: projectedEdge,
      };
    }
    
    // Max price with slippage buffer
    const maxPrice = Math.min(
      hedgeAsk + config.maxHedgeSlippage,
      1 - leadingAvg - config.minEdgeAfterHedge,
      0.95
    );
    
    // Check minimum notional
    const minNotional = config.minHedgeNotional || 1.50;
    const orderNotional = hedgeQty * maxPrice;
    
    if (orderNotional < minNotional) {
      return { 
        attempted: true, 
        hedged: false, 
        reason: `below_min_notional: $${orderNotional.toFixed(2)}`,
        hedgeSide: needsMore,
        hedgeQty,
      };
    }
    
    console.log(`[Rebalancer] 🎯 PROACTIVE HEDGE OPPORTUNITY!`);
    console.log(`[Rebalancer]    Gap: ${gap.toFixed(0)} shares (UP: ${upQty.toFixed(0)}, DOWN: ${downQty.toFixed(0)})`);
    console.log(`[Rebalancer]    Need: ${hedgeQty.toFixed(0)} ${needsMore} @ max $${maxPrice.toFixed(3)}`);
    console.log(`[Rebalancer]    Projected: combined $${projectedCombined.toFixed(3)}, edge ${(projectedEdge * 100).toFixed(2)}%`);
    
    // Log the attempt
    await this.logRebalanceEvent('proactive_hedge_attempt', market, {
      hedge_side: needsMore,
      hedge_qty: hedgeQty,
      max_price: maxPrice,
      existing_avg: existingAvg,
      hedge_ask: hedgeAsk,
      projected_combined: projectedCombined,
      projected_edge: projectedEdge,
      dry_run: config.dryRun,
    });
    
    if (config.dryRun) {
      console.log(`[Rebalancer] [DRY RUN] Would place proactive hedge`);
      return { 
        attempted: true, 
        hedged: true, 
        reason: 'dry_run',
        hedgeSide: needsMore,
        hedgeQty,
        hedgePrice: hedgeAsk,
        combinedCost: projectedCombined,
        edge: projectedEdge,
      };
    }
    
    // Execute the hedge
    const tokenId = needsMore === 'UP' ? market.upTokenId : market.downTokenId;
    
    try {
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: maxPrice,
        size: hedgeQty,
        orderType: 'GTC',
      });
      
      if (!result.success || !result.orderId) {
        await this.logRebalanceEvent('proactive_hedge_failed', market, {
          hedge_side: needsMore,
          hedge_qty: hedgeQty,
          reason: result.error || 'order_placement_failed',
        });
        return { 
          attempted: true, 
          hedged: false, 
          reason: result.error || 'order_placement_failed',
          hedgeSide: needsMore,
          hedgeQty,
        };
      }
      
      console.log(`[Rebalancer] ✓ Proactive hedge order placed: ${result.orderId.slice(0, 8)}...`);
      console.log(`[Rebalancer]    Waiting ${this.hedgeOrderWaitMs}ms for fill...`);
      
      // Wait longer for the order to work - passive orders need time
      await sleep(this.hedgeOrderWaitMs);
      
      const { orders, error } = await getOpenOrders();
      if (error) {
        // Don't cancel on error - let it sit
        console.log(`[Rebalancer] ⚠️ Could not check order status: ${error}`);
        return { attempted: true, hedged: false, reason: `status_unknown: ${error}` };
      }
      
      const open = orders.find(o => o.orderId === result.orderId);
      if (!open) {
        // Order filled completely
        console.log(`[Rebalancer] 🎉 PROACTIVE HEDGE COMPLETE!`);
        
        await this.logRebalanceEvent('proactive_hedge_success', market, {
          hedge_side: needsMore,
          hedge_qty: hedgeQty,
          hedge_price: hedgeAsk,
          combined_cost: projectedCombined,
          edge: projectedEdge,
        });
        
        return { 
          attempted: true, 
          hedged: true,
          hedgeSide: needsMore,
          hedgeQty,
          hedgePrice: hedgeAsk,
          combinedCost: projectedCombined,
          edge: projectedEdge,
        };
      }
      
      // Check for partial fill
      const originalSize = open.originalSize || hedgeQty;
      const remainingSize = open.size || 0;
      const filledQty = Math.max(0, originalSize - remainingSize);
      
      if (filledQty > 0) {
        // Partial fill - keep the order open for more fills
        console.log(`[Rebalancer] ✓ Partial hedge: ${filledQty.toFixed(0)} of ${hedgeQty.toFixed(0)} filled, keeping order open`);
        
        await this.logRebalanceEvent('proactive_hedge_partial', market, {
          hedge_side: needsMore,
          intended_qty: hedgeQty,
          filled_qty: filledQty,
          remaining_qty: remainingSize,
          hedge_price: hedgeAsk,
          order_kept_open: true,
        });
        
        // Don't cancel - let it continue to work
        return { 
          attempted: true, 
          hedged: true,
          reason: 'partial_fill_order_open',
          hedgeSide: needsMore,
          hedgeQty: filledQty,
          hedgePrice: hedgeAsk,
        };
      }
      
      // No fill after wait - keep order open anyway, market may improve
      console.log(`[Rebalancer] ⏳ No fill yet, keeping hedge order open to work`);
      return { attempted: true, hedged: false, reason: 'no_fill_order_open' };
      
    } catch (error) {
      const errMsg = getErrorMessage(error);
      console.error(`[Rebalancer] Hedge order error:`, errMsg);
      
      await this.logRebalanceEvent('proactive_hedge_error', market, {
        hedge_side: needsMore,
        hedge_qty: hedgeQty,
        error: errMsg,
      });
      
      return { attempted: true, hedged: false, reason: `error: ${errMsg}` };
    }
  }
  
  /**
   * Log rebalance events to bot_events for visibility
   */
  private async logRebalanceEvent(
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let rebalancerInstance: ProactiveRebalancer | null = null;

export function getProactiveRebalancer(): ProactiveRebalancer {
  if (!rebalancerInstance) {
    rebalancerInstance = new ProactiveRebalancer();
  }
  return rebalancerInstance;
}

export function resetProactiveRebalancer(): void {
  rebalancerInstance = null;
}

/**
 * Reset opportunity tracking when entering a new market
 * This ensures we start fresh and don't carry over stale data
 */
export function resetOpportunityTracking(): void {
  if (rebalancerInstance) {
    (rebalancerInstance as any).bestOpportunity = null;
  }
}
