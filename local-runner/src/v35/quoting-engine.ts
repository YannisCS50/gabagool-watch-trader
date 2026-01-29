// ============================================================
// V35 QUOTING ENGINE - GABAGOOL MODE
// ============================================================
// Version: V35.6.1 - "Balanced Start Fix"
//
// V35.6.1 FIX:
// - FIXED: Fresh market (both sides = 0) now quotes BOTH sides equally
// - ADDED: isBalanced check (imbalance < 1 share = balanced state)
// - FIXED: Trailing/leading only applies when actual imbalance exists
//
// V35.6.0 SIMPLIFICATION (kept):
// - REMOVED: EXPENSIVE_BIAS guard
// - SIMPLIFIED: CHEAP_SIDE_SKIP (only at 25+ shares)
// - KEPT: EMERGENCY_STOP, BURST_CAP
//
// CORE PRINCIPLE: Quote both sides equally, let the market balance.
// ============================================================

import { getV35Config, V35_VERSION, type V35Config } from './config.js';
import type { V35Market, V35Quote, V35Side, V35Asset } from './types.js';
import { logV35GuardEvent } from './backend.js';
import { getV35SidePricing } from './market-pricing.js';

interface QuoteDecision {
  quotes: V35Quote[];
  blocked: boolean;
  blockReason: string | null;
}

export class QuotingEngine {
  private gridPrices: number[] = [];
  
  constructor() {
    this.updateGrid();
  }
  
  /**
   * Regenerate grid prices from current config
   */
  updateGrid(): void {
    const config = getV35Config();
    this.gridPrices = [];
    
    let price = config.gridMin;
    while (price <= config.gridMax + 0.001) {
      this.gridPrices.push(Math.round(price * 100) / 100);
      price += config.gridStep;
    }
    
    console.log(`[QuotingEngine] Grid updated: ${this.gridPrices.length} levels from $${config.gridMin} to $${config.gridMax}`);
  }
  
  /**
   * Generate quotes for one side of a market
   * BURST-SAFE: Caps total order qty to risk budget
   */
  generateQuotes(side: V35Side, market: V35Market): V35Quote[] {
    const decision = this.generateQuotesWithReason(side, market);
    
    if (decision.blocked) {
      console.log(`[QuotingEngine] ⛔ ${side} blocked: ${decision.blockReason}`);
    }
    
    return decision.quotes;
  }
  
  /**
   * Generate quotes with detailed reasoning
   * BURST-SAFE VERSION: Limits total open order qty
   */
  generateQuotesWithReason(side: V35Side, market: V35Market): QuoteDecision {
    const config = getV35Config();
    const quotes: V35Quote[] = [];
    
    const {
      expensiveSide,
      cheapSide,
      expensiveQty,
      cheapQty,
    } = getV35SidePricing(market);
    
    const currentQty = side === 'UP' ? market.upQty : market.downQty;
    const oppositeQty = side === 'UP' ? market.downQty : market.upQty;
    const imbalance = Math.abs(market.upQty - market.downQty);
    
    // =========================================================================
    // V35.6.1 BALANCED START FIX
    // =========================================================================
    // GABAGOOL MODE: We quote BOTH sides equally by default.
    // 
    // CRITICAL FIX: When both sides have 0 shares (fresh market), BOTH sides
    // should be allowed to quote equally. Neither is "trailing" or "leading".
    // Only apply trailing/leading logic when there's actual imbalance.
    // =========================================================================
    const isBalanced = imbalance < 1; // Less than 1 share difference = balanced
    const trailingSide = market.upQty < market.downQty ? 'UP' : 'DOWN';
    const isTrailing = !isBalanced && side === trailingSide;
    const isLeading = !isBalanced && side !== trailingSide;
    
    // V35.6.0: Only block cheap side if we have 25+ MORE cheap shares than expensive
    // This is a safety net, not the primary balancing mechanism
    const CHEAP_SIDE_EXTREME_THRESHOLD = 25;
    if (side === cheapSide && isLeading && cheapQty > expensiveQty + CHEAP_SIDE_EXTREME_THRESHOLD) {
      const reason = `CHEAP-SKIP: ${side} has ${(cheapQty - expensiveQty).toFixed(0)} more than expensive (threshold: ${CHEAP_SIDE_EXTREME_THRESHOLD})`;
      console.log(`[QuotingEngine] 🛡️ ${reason}`);
      
      logV35GuardEvent({
        marketSlug: market.slug,
        asset: market.asset,
        guardType: 'CHEAP_SIDE_SKIP',
        blockedSide: side,
        upQty: market.upQty,
        downQty: market.downQty,
        expensiveSide,
        reason,
      }).catch(() => {});
      
      return { quotes: [], blocked: true, blockReason: reason };
    }
    
    // =========================================================================
    // EMERGENCY STOP: Block NEW quoting at extreme imbalance
    // V35.5.4 FIX: But ALLOW trailing side to quote (for hedging)
    // =========================================================================
    if (imbalance >= config.maxUnpairedShares) {
      // V35.5.4: If we're the trailing side, we MUST be able to quote to hedge
      if (isTrailing) {
        console.log(`[QuotingEngine] 🚨 EMERGENCY but ${side} is TRAILING - allowing hedge quotes`);
      } else {
        // Only block the LEADING side
        const reason = `EMERGENCY: ${imbalance.toFixed(0)} share imbalance >= ${config.maxUnpairedShares} max`;
        console.log(`[QuotingEngine] 🚨 ${reason} - blocking LEADING side ${side}`);
        
        logV35GuardEvent({
          marketSlug: market.slug,
          asset: market.asset,
          guardType: 'EMERGENCY_STOP',
          blockedSide: side,
          upQty: market.upQty,
          downQty: market.downQty,
          expensiveSide,
          reason,
        }).catch(() => {});
        
        return { quotes: [], blocked: true, blockReason: reason };
      }
    }
    
    // =========================================================================
    // V35.6.0: EXPENSIVE_BIAS GUARD REMOVED
    // =========================================================================
    // This guard was causing the imbalances! By forcing the cheap side to stay
    // under a ratio of the expensive side, we were creating one-sided positions.
    // 
    // GABAGOOL MODE: Both sides quote equally. Balance comes from market flow.
    // =========================================================================
    
    // =========================================================================
    // 🚨 BURST-CAP: THE CRITICAL FIX
    // =========================================================================
    // Calculate how many NEW shares we can safely add to this side.
    // Risk Budget = maxUnpairedShares - current imbalance (if we're the leading side)
    //             = maxUnpairedShares + current imbalance (if we're the trailing side)
    //
    // But we must also account for EXISTING open orders on this side.
    // Those could also fill, adding to our position.
    // =========================================================================
    
    // Count existing open order qty on this side
    const existingOpenOrders = side === 'UP' ? market.upOrders : market.downOrders;
    let existingOpenQty = 0;
    for (const order of existingOpenOrders.values()) {
      existingOpenQty += order.size;
    }
    
    // Calculate burst-safe budget
    // If this side fills, we ADD to currentQty
    // Worst case after fill: currentQty + openOrderQty + newOrderQty
    // We want: |newTotal - oppositeQty| <= maxUnpairedShares
    //
    // If currentQty > oppositeQty (we're leading):
    //   newTotal - oppositeQty <= maxUnpairedShares
    //   currentQty + existingOpen + newQty - oppositeQty <= maxUnpairedShares
    //   newQty <= maxUnpairedShares - (currentQty - oppositeQty) - existingOpen
    //   newQty <= maxUnpairedShares - imbalance - existingOpen
    //
    // If currentQty <= oppositeQty (we're trailing):
    //   oppositeQty - newTotal <= maxUnpairedShares (if we're still trailing)
    //   OR newTotal - oppositeQty <= maxUnpairedShares (if we become leading)
    //   Safe approach: just check worst case where we become maximally leading
    //   newQty <= maxUnpairedShares + (oppositeQty - currentQty) - existingOpen
    //   newQty <= maxUnpairedShares + imbalance - existingOpen
    
    let maxNewOrderQty: number;
    
    // =========================================================================
    // V35.6.1 BALANCED START FIX
    // =========================================================================
    // When balanced (both sides ~equal), BOTH sides get full budget.
    // This ensures a fresh market can quote symmetrically on both sides.
    // =========================================================================
    if (isBalanced) {
      // Both sides equal - each gets full budget minus their own open orders
      maxNewOrderQty = config.maxUnpairedShares - existingOpenQty;
      console.log(`[QuotingEngine] ⚖️ BALANCED: ${side} gets full budget ${maxNewOrderQty.toFixed(0)} (maxUnpaired=${config.maxUnpairedShares}, existing=${existingOpenQty.toFixed(0)})`);
    } else if (currentQty > oppositeQty) {
      // We're already leading - very limited budget
      maxNewOrderQty = config.maxUnpairedShares - imbalance - existingOpenQty;
    } else {
      // We're trailing - we have more room
      maxNewOrderQty = config.maxUnpairedShares + imbalance - existingOpenQty;
    }
    
    // Clamp to non-negative
    maxNewOrderQty = Math.max(0, maxNewOrderQty);
    
    console.log(`[QuotingEngine] 📊 BURST-CAP: ${side} budget=${maxNewOrderQty.toFixed(0)} (existing=${existingOpenQty.toFixed(0)}, imbalance=${imbalance.toFixed(0)}, balanced=${isBalanced}, leading=${isLeading})`);
    
    // =========================================================================
    // V35.6.1 BALANCED/TRAILING EXEMPTION
    // =========================================================================
    // - BALANCED: Both sides quote freely (fresh market start)
    // - TRAILING: Can always quote to hedge back to balance
    // - LEADING: Restricted by burst-cap to prevent runaway imbalance
    // =========================================================================
    if (maxNewOrderQty < config.sharesPerLevel) {
      if (isBalanced) {
        // Balanced but somehow still blocked? Give minimum quoting ability
        maxNewOrderQty = config.sharesPerLevel * 4; // 4 levels = 20 shares
        console.log(`[QuotingEngine] ⚖️ BALANCED OVERRIDE: ${side} gets minimum ${maxNewOrderQty.toFixed(0)} shares`);
      } else if (isTrailing) {
        // V35.5.7: Allow trailing side to quote, but ONLY what's needed to balance
        const neededToBalance = imbalance;
        const buffer = config.sharesPerLevel; // One extra level as buffer
        maxNewOrderQty = Math.max(config.sharesPerLevel, neededToBalance + buffer);
        console.log(`[QuotingEngine] 🔓 TRAILING OVERRIDE: ${side} allowing ${maxNewOrderQty.toFixed(0)} shares (need ${neededToBalance.toFixed(0)} + ${buffer} buffer)`);
      } else {
        const reason = `BURST-CAP: ${side} budget exhausted (${maxNewOrderQty.toFixed(0)} < ${config.sharesPerLevel} min)`;
        console.log(`[QuotingEngine] 🛡️ ${reason}`);
        
        logV35GuardEvent({
          marketSlug: market.slug,
          asset: market.asset,
          guardType: 'BURST_CAP',
          blockedSide: side,
          upQty: market.upQty,
          downQty: market.downQty,
          expensiveSide,
          reason,
        }).catch(() => {});
        
        return { quotes: [], blocked: true, blockReason: reason };
      }
    }
    
    // =========================================================================
    // GENERATE QUOTES - Capped by burst budget
    // PRIORITY: 35c-55c range first (lowest combined cost = highest profit)
    // =========================================================================
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Sort grid prices: prioritize 0.35-0.55 range first (sweet spot)
    const sortedPrices = this.getPrioritizedPrices();
    
    let totalQuotedQty = 0;
    
    for (const price of sortedPrices) {
      // V35.4.4: No per-level hedge check - CHEAP_SIDE_SKIP handles this smarter
      
      // Skip if our bid would cross the ask (we'd become taker)
      // V35.4.1: Reduced margin from 0.5¢ to 0.2¢ for tighter quoting
      if (bestAsk > 0 && price >= bestAsk - 0.002) {
        continue;
      }
      
      // Calculate minimum shares to meet Polymarket notional requirement
      const minSharesForNotional = Math.ceil(1.0 / price);
      const shares = Math.max(config.sharesPerLevel, minSharesForNotional);
      
      // Check if adding this quote would exceed our burst budget
      if (totalQuotedQty + shares > maxNewOrderQty) {
        // We've hit the burst cap - stop adding more quotes
        console.log(`[QuotingEngine] 🛡️ BURST-CAP reached at ${totalQuotedQty.toFixed(0)}/${maxNewOrderQty.toFixed(0)} shares - stopping`);
        break;
      }
      
      quotes.push({ price, size: shares });
      totalQuotedQty += shares;
    }
    
    if (quotes.length > 0) {
      console.log(`[QuotingEngine] ✅ Generated ${quotes.length} ${side} quotes, total=${totalQuotedQty.toFixed(0)} shares (budget=${maxNewOrderQty.toFixed(0)})`);
    }
    
    return {
      quotes,
      blocked: false,
      blockReason: null,
    };
  }
  
  /**
   * Calculate unrealized P&L for loss limit check
   */
  private calculateUnrealizedPnL(market: V35Market): number {
    // Current value if we sold everything at bid prices
    const upValue = market.upQty * (market.upBestBid || 0);
    const downValue = market.downQty * (market.downBestBid || 0);
    const currentValue = upValue + downValue;
    
    // Total cost
    const totalCost = market.upCost + market.downCost;
    
    return currentValue - totalCost;
  }
  
  /**
   * Calculate locked profit (guaranteed at settlement)
   * This is the core metric - paired shares × (1 - combined cost)
   */
  calculateLockedProfit(market: V35Market): { 
    pairedShares: number; 
    combinedCost: number; 
    lockedProfit: number;
    profitPct: number;
  } {
    const pairedShares = Math.min(market.upQty, market.downQty);
    
    if (pairedShares === 0) {
      return { pairedShares: 0, combinedCost: 0, lockedProfit: 0, profitPct: 0 };
    }
    
    // Calculate average costs
    const avgUpCost = market.upCost / market.upQty;
    const avgDownCost = market.downCost / market.downQty;
    const combinedCost = avgUpCost + avgDownCost;
    
    // Locked profit = paired shares × (1 - combined cost)
    const lockedProfit = pairedShares * (1 - combinedCost);
    const profitPct = (1 - combinedCost) * 100;
    
    return { pairedShares, combinedCost, lockedProfit, profitPct };
  }
  
  /**
   * Check if a market should be actively quoted at all
   */
  shouldQuoteMarket(market: V35Market): { shouldQuote: boolean; reason: string } {
    const config = getV35Config();
    
    // Check loss limit
    const pnl = this.calculateUnrealizedPnL(market);
    if (pnl < -config.maxLossPerMarket) {
      return { shouldQuote: false, reason: `Loss limit triggered: $${pnl.toFixed(2)}` };
    }
    
    // Check if asset is enabled
    if (!config.enabledAssets.includes(market.asset)) {
      return { shouldQuote: false, reason: `Asset ${market.asset} not in enabled list` };
    }
    
    return { shouldQuote: true, reason: 'OK' };
  }
  
  /**
   * Get market status summary for logging
   */
  getMarketStatus(market: V35Market): string {
    const { pairedShares, combinedCost, lockedProfit, profitPct } = this.calculateLockedProfit(market);
    const skew = market.upQty - market.downQty;
    const unpaired = Math.abs(skew);
    
    return `UP:${market.upQty.toFixed(0)} DOWN:${market.downQty.toFixed(0)} | ` +
           `Paired:${pairedShares.toFixed(0)} Unpaired:${unpaired.toFixed(0)} | ` +
           `Combined:$${combinedCost.toFixed(4)} | ` +
           `Locked:$${lockedProfit.toFixed(2)} (${profitPct.toFixed(2)}%)`;
  }
  
  /**
   * Get the current grid prices
   */
  getGridPrices(): number[] {
    return [...this.gridPrices];
  }
  
  /**
   * Get grid prices sorted by priority (sweet spot 35c-55c first)
   * This ensures the most profitable price levels are quoted first
   */
  private getPrioritizedPrices(): number[] {
    const sweetSpotMin = 0.35;
    const sweetSpotMax = 0.55;
    
    // Separate into sweet spot and outer prices
    const sweetSpot: number[] = [];
    const outer: number[] = [];
    
    for (const price of this.gridPrices) {
      if (price >= sweetSpotMin && price <= sweetSpotMax) {
        sweetSpot.push(price);
      } else {
        outer.push(price);
      }
    }
    
    // Sort sweet spot by distance from center (0.45 is optimal)
    sweetSpot.sort((a, b) => Math.abs(a - 0.45) - Math.abs(b - 0.45));
    
    // Return sweet spot first, then outer prices
    return [...sweetSpot, ...outer];
  }
}
