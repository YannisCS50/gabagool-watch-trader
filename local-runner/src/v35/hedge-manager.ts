// ============================================================
// V35 HEDGE MANAGER - ACTIVE HEDGING
// ============================================================
// Version: V35.8.0 - "Rebalancing Cost Limits"
// 
// KEY INSIGHT: Gabagool's edge comes from ACTIVE HEDGING, not passive MM.
// When filled on one side → IMMEDIATELY hedge the other side.
//
// V35.8.0: Added flexible maxCombinedCost limits.
// - Standard mode: Accept up to $1.02 combined cost (2% loss OK)
// - Emergency mode: Accept up to $1.05 combined cost (5% loss OK)
// This prevents the bot from getting stuck with unhedged exposure
// in wide-spread markets where profitable hedges are impossible.
// ============================================================

import { EventEmitter } from 'events';
import { getV35Config, V35_VERSION } from './config.js';
import type { V35Market, V35Fill, V35Side, V35Asset } from './types.js';
import { placeOrder, cancelOrder, getOpenOrders } from '../polymarket.js';
import { saveBotEvent, type BotEvent } from '../backend.js';
import { getErrorMessage, safeStringify } from './utils.js';

// ============================================================
// TYPES
// ============================================================

export interface HedgeViability {
  viable: boolean;
  reason: string | null;
  maxPrice: number;
  expectedEdge?: number;
  combinedCost?: number;
  minNotionalRequired?: number;
}

export interface HedgeResult {
  hedged: boolean;
  reason?: string;
  combinedCost?: number;
  edge?: number;
  filledQty?: number;
  avgPrice?: number;
}

// ============================================================
// HEDGE MANAGER CLASS
// ============================================================

export class HedgeManager extends EventEmitter {
  private pendingHedges = new Map<string, boolean>();
  
  constructor() {
    super();
  }

  /**
   * CORE FUNCTION: Called on every fill
   * This is the gabagool secret sauce
   * @param isEmergency - If true, use emergency cost limits (higher tolerance)
   */
  async onFill(fill: V35Fill, market: V35Market, isEmergency: boolean = false): Promise<HedgeResult> {
    const config = getV35Config();
    const ts = Date.now();
    
    // V35.8.0: Use emergency limits if flagged or if imbalance is critical
    const unpaired = Math.abs(market.upQty - market.downQty);
    const useEmergencyLimits = isEmergency || unpaired >= config.criticalUnpairedShares;
    
    console.log(`[HedgeManager] 📦 V35.8.0 processing fill: ${fill.side} ${fill.size.toFixed(0)} @ $${fill.price.toFixed(3)}${useEmergencyLimits ? ' [EMERGENCY MODE]' : ''}`);
    
    if (!config.enableActiveHedge) {
      console.log('[HedgeManager] ⚠️ Active hedge DISABLED - running in legacy mode');
      await this.logHedgeEvent('hedge_disabled', fill, market, { reason: 'config_disabled' });
      return { hedged: false, reason: 'disabled' };
    }

    const hedgeSide: V35Side = fill.side === 'UP' ? 'DOWN' : 'UP';
    const hedgeQty = fill.size;
    
    console.log(`[HedgeManager] 📥 Fill received: ${fill.side} ${fill.size.toFixed(0)} @ $${fill.price.toFixed(3)}`);
    console.log(`[HedgeManager] 🎯 Need to hedge: ${hedgeQty.toFixed(0)} ${hedgeSide} shares`);
    
    // Check if hedge is viable (using emergency limits if needed)
    const viability = this.calculateHedgeViability(fill, market, hedgeSide, useEmergencyLimits);
    
    // Log viability check
    await this.logHedgeEvent('hedge_viability', fill, market, {
      viable: viability.viable,
      reason: viability.reason,
      hedge_side: hedgeSide,
      hedge_qty: hedgeQty,
      max_price: viability.maxPrice,
      expected_edge: viability.expectedEdge,
      combined_cost: viability.combinedCost,
      min_notional_required: viability.minNotionalRequired,
      fill_price: fill.price,
      hedge_ask: hedgeSide === 'UP' ? market.upBestAsk : market.downBestAsk,
      version: V35_VERSION,
    });
    
    if (!viability.viable) {
      console.log(`[HedgeManager] ⚠️ Hedge NOT viable: ${viability.reason}`);
      console.log(`[HedgeManager] 🛑 Emitting cancel signal for ${fill.side} side`);
      
      // Emit event to cancel orders on the filled side (prevent more exposure)
      this.emit('cancelSide', { marketSlug: market.slug, side: fill.side });
      
      return { hedged: false, reason: viability.reason };
    }

    console.log(`[HedgeManager] ✅ Hedge viable: combined $${viability.combinedCost?.toFixed(3)}, edge ${((viability.expectedEdge || 0) * 100).toFixed(2)}%`);
    console.log(`[HedgeManager] 📤 Placing IOC hedge order: ${hedgeQty.toFixed(0)} ${hedgeSide} @ max $${viability.maxPrice.toFixed(3)}`);
    
    // Log hedge attempt
    await this.logHedgeEvent('hedge_attempt', fill, market, {
      hedge_side: hedgeSide,
      hedge_qty: hedgeQty,
      max_price: viability.maxPrice,
      dry_run: config.dryRun,
    });
    
    // Place aggressive IOC order for hedge
    const hedgeResult = await this.placeHedgeOrder(
      market,
      hedgeSide,
      hedgeQty,
      viability.maxPrice
    );

    if (hedgeResult.filled) {
      const actualCombined = fill.price + hedgeResult.avgPrice!;
      const actualEdge = 1 - actualCombined;
      
      console.log(`[HedgeManager] 🎉 HEDGE COMPLETE!`);
      console.log(`[HedgeManager]    ${fill.side} @ $${fill.price.toFixed(3)} + ${hedgeSide} @ $${hedgeResult.avgPrice!.toFixed(3)}`);
      console.log(`[HedgeManager]    Combined: $${actualCombined.toFixed(3)} | Edge: ${(actualEdge * 100).toFixed(2)}%`);
      console.log(`[HedgeManager]    Locked profit: $${(hedgeQty * actualEdge).toFixed(3)}`);
      
      // Log successful hedge
      await this.logHedgeEvent('hedge_success', fill, market, {
        hedge_side: hedgeSide,
        hedge_qty: hedgeResult.filledQty,
        hedge_price: hedgeResult.avgPrice,
        combined_cost: actualCombined,
        edge: actualEdge,
        locked_profit: hedgeQty * actualEdge,
        fill_side: fill.side,
        fill_price: fill.price,
      });
      
      return { 
        hedged: true, 
        combinedCost: actualCombined,
        edge: actualEdge,
        filledQty: hedgeResult.filledQty,
        avgPrice: hedgeResult.avgPrice,
      };
    } else {
      console.log(`[HedgeManager] ❌ HEDGE FAILED - ${hedgeResult.reason}`);
      console.log(`[HedgeManager] 🛑 Emitting cancel signal for ${fill.side} side`);
      
      // Log failed hedge
      await this.logHedgeEvent('hedge_failed', fill, market, {
        hedge_side: hedgeSide,
        hedge_qty: hedgeQty,
        max_price: viability.maxPrice,
        reason: hedgeResult.reason,
      });
      
      this.emit('cancelSide', { marketSlug: market.slug, side: fill.side });
      
      return { hedged: false, reason: hedgeResult.reason };
    }
  }
  
  /**
   * Log hedge events to bot_events table for UI visibility
   * V35.3.1: Uses safeStringify to prevent circular JSON errors
   */
  private async logHedgeEvent(
    eventType: string,
    fill: V35Fill,
    market: V35Market,
    data: Record<string, unknown>
  ): Promise<void> {
    try {
      // Safely extract reason - could be a complex error object
      let reasonCode: string | undefined;
      if (typeof data.reason === 'string') {
        reasonCode = data.reason.slice(0, 200);
      } else if (data.reason) {
        reasonCode = getErrorMessage(data.reason);
      }
      
      // Build safe data object (avoid circular refs from any nested errors)
      const safeData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === 'reason' && typeof value !== 'string') {
          // Already handled above
          safeData[key] = reasonCode;
        } else if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
          // Safely stringify complex objects
          safeData[key] = safeStringify(value, 300);
        } else {
          safeData[key] = value;
        }
      }
      
      const event: BotEvent = {
        event_type: eventType,
        asset: fill.asset,
        market_id: market.slug,
        reason_code: reasonCode,
        ts: Date.now(),
        data: {
          ...safeData,
          order_id: fill.orderId,
          up_qty: market.upQty,
          down_qty: market.downQty,
        },
      };
      await saveBotEvent(event);
    } catch (err) {
      // Use safe stringify for error logging too
      console.error('[HedgeManager] Failed to log hedge event:', getErrorMessage(err));
    }
  }

  /**
   * Check if hedge is viable BEFORE placing order
   * V35.8.0: Uses maxCombinedCost instead of minEdge for flexibility
   * @param useEmergencyLimits - If true, use higher cost tolerance
   */
  private calculateHedgeViability(
    fill: V35Fill, 
    market: V35Market, 
    hedgeSide: V35Side,
    useEmergencyLimits: boolean = false
  ): HedgeViability {
    const config = getV35Config();
    
    // V35.8.0: Select cost limit based on mode
    const maxCombinedCost = useEmergencyLimits 
      ? config.maxCombinedCostEmergency 
      : config.maxCombinedCost;
    
    // Get current best ask on hedge side
    const hedgeAsk = hedgeSide === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    if (hedgeAsk <= 0 || hedgeAsk >= 1) {
      return { viable: false, reason: 'no_liquidity_on_hedge_side', maxPrice: 0 };
    }

    // ---------------------------------------------------------------------
    // V35.8.0: Use maxCombinedCost as the primary constraint
    // This allows small losses (e.g., 2%) for risk reduction
    // ---------------------------------------------------------------------
    // Max hedge price = maxCombinedCost - fill.price
    // e.g., fill=0.47, maxCombinedCost=1.02 -> maxHedge=0.55
    const priceCapFromCombined = maxCombinedCost - fill.price;
    
    if (priceCapFromCombined <= 0) {
      return { 
        viable: false, 
        reason: `fill_price_too_high: fill=${fill.price.toFixed(3)} >= maxCC=${maxCombinedCost.toFixed(3)}`, 
        maxPrice: 0 
      };
    }

    // Max price = min(ask + slippage, price cap from combined cost, hard safety cap)
    const maxPrice = Math.min(
      hedgeAsk + config.maxHedgeSlippage, 
      priceCapFromCombined, 
      0.95
    );

    // If we cannot even match the current ask, skip
    if (maxPrice < hedgeAsk - 1e-9) {
      return {
        viable: false,
        reason: `hedge_ask_above_cap: ask=${hedgeAsk.toFixed(3)} > cap=${maxPrice.toFixed(3)} (maxCC=${maxCombinedCost.toFixed(2)})`,
        maxPrice,
        combinedCost: fill.price + hedgeAsk,
        expectedEdge: 1 - (fill.price + hedgeAsk),
      };
    }
    
    // Calculate expected outcome
    const expectedCombined = fill.price + hedgeAsk;
    const expectedEdge = 1 - expectedCombined;
    
    // Log if we're accepting a loss
    if (expectedEdge < 0) {
      console.log(`[HedgeManager] ⚠️ Accepting loss hedge: combined=$${expectedCombined.toFixed(3)} (loss ${(-expectedEdge * 100).toFixed(1)}%)`);
    }
    
    return { 
      viable: true, 
      reason: null, 
      maxPrice,
      combinedCost: expectedCombined,
      expectedEdge,
    };
  }

  /**
   * Place aggressive IOC (Immediate-Or-Cancel) order for hedge
   * V35.3.0: Improved minimum notional check
   */
  private async placeHedgeOrder(
    market: V35Market,
    side: V35Side,
    quantity: number,
    maxPrice: number
  ): Promise<{ filled: boolean; filledQty?: number; avgPrice?: number; reason?: string }> {
    const config = getV35Config();
    const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;

    // V35.3.0 FIX: Use configurable min notional (default $1.50)
    const minNotional = config.minHedgeNotional || 1.50;
    const orderNotional = quantity * maxPrice;
    
    if (orderNotional < minNotional) {
      return {
        filled: false,
        reason: `below_min_notional: $${orderNotional.toFixed(2)} < $${minNotional.toFixed(2)}`,
      };
    }
    
    if (config.dryRun) {
      console.log(`[HedgeManager] [DRY RUN] Would place IOC order: ${quantity.toFixed(0)} ${side} @ $${maxPrice.toFixed(3)}`);
      // Simulate successful fill at best ask
      const simulatedPrice = side === 'UP' ? market.upBestAsk : market.downBestAsk;
      return { filled: true, filledQty: quantity, avgPrice: simulatedPrice };
    }
    
    try {
       // Place market-taking order at maxPrice.
       // Polymarket doesn't support IOC directly, so we place GTC and then
       // verify quickly + cancel if still open.
      const result = await placeOrder({
        tokenId,
        side: 'BUY',
        price: maxPrice,
        size: quantity,
        orderType: 'GTC',
      });
      
      if (!result.success || !result.orderId) {
        return { filled: false, reason: result.error || 'order_placement_failed' };
      }

       console.log(`[HedgeManager] ✓ Hedge order placed: ${result.orderId.slice(0, 8)}... @ $${maxPrice.toFixed(3)} (IOC emulation)`);

       // Wait briefly, then check if the order is still open.
       const checkDelayMs = Math.min(Math.max(150, Math.floor(config.hedgeTimeoutMs / 4)), 500);
       await sleep(checkDelayMs);

       const { orders, error } = await getOpenOrders();
       if (error) {
         // If we can't check, do NOT claim a fill; force-cancel to avoid drifting exposure.
         try { await cancelOrder(result.orderId); } catch {}
         return { filled: false, reason: `ioc_status_unknown: ${error}` };
       }

       const open = orders.find(o => o.orderId === result.orderId);
       if (!open) {
         // Not open anymore -> assume filled (or cancelled externally). In practice, this is the best signal we have.
         const estimatedPrice = side === 'UP' ? market.upBestAsk : market.downBestAsk;
         return { filled: true, filledQty: quantity, avgPrice: estimatedPrice };
       }

       const filledQty = Math.max(0, Math.min(quantity, open.sizeMatched));
       // Cancel remaining (IOC behavior)
       try { await cancelOrder(result.orderId); } catch {}

       if (filledQty <= 0) {
         return { filled: false, reason: 'ioc_no_fill' };
       }

       const estimatedPrice = side === 'UP' ? market.upBestAsk : market.downBestAsk;
       return {
         filled: true,
         filledQty,
         avgPrice: estimatedPrice,
         reason: filledQty < quantity ? 'partial_fill' : undefined,
       };
       
    } catch (error: any) {
      const errMsg = getErrorMessage(error);
      console.error(`[HedgeManager] Hedge order error:`, errMsg);
      return { filled: false, reason: `order_error: ${errMsg}` };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let hedgeManagerInstance: HedgeManager | null = null;

export function getHedgeManager(): HedgeManager {
  if (!hedgeManagerInstance) {
    hedgeManagerInstance = new HedgeManager();
  }
  return hedgeManagerInstance;
}

export function resetHedgeManager(): void {
  if (hedgeManagerInstance) {
    hedgeManagerInstance.removeAllListeners();
  }
  hedgeManagerInstance = null;
}
