// ============================================================
// V35 QUOTING ENGINE - HEDGE-FIRST STRATEGY
// ============================================================
// Version: V35.4.2 - "Per-Level Hedge-First"
//
// KEY INSIGHT: The bot only profits when positions are PAIRED.
// Unpaired shares are pure directional risk that can lose 100%.
//
// V35.4.2 SOLUTION: Evaluate hedge viability PER PRICE LEVEL.
// For each grid price, check if (bidPrice + oppositeAsk) < 0.98.
// This allows cheaper bids to be placed even when the opposite
// side is expensive, maximizing fill opportunities.
//
// RULE: Only quote at prices where hedge is profitable.
// ============================================================

import { getV35Config, V35_VERSION, type V35Config } from './config.js';
import type { V35Market, V35Quote, V35Side, V35Asset } from './types.js';
import { logV35GuardEvent } from './backend.js';
import { getV35SidePricing } from './market-pricing.js';
import { getCircuitBreaker } from './circuit-breaker.js';

// Maximum combined cost we'll accept (leaves 2% profit margin)
const MAX_COMBINED_COST = 0.98;

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
    // V35.4.2 HEDGE-FIRST CHECK: Per-price-level evaluation
    // =========================================================================
    // Instead of blocking ALL quotes based on average grid price, we now
    // evaluate each price level individually. This allows the bot to quote
    // on cheaper price levels even when the opposite side is expensive.
    // The per-level check happens in the quote generation loop below.
    // =========================================================================
    const oppositeAsk = side === 'UP' ? market.downBestAsk : market.upBestAsk;
    
    // Log the opposite ask for visibility, but don't block globally
    if (oppositeAsk > 0) {
      console.log(`[QuotingEngine] 📊 ${side} hedge check: opposite ask $${oppositeAsk.toFixed(3)}, will filter per-price-level`);
    }
    
    // =========================================================================
    // EMERGENCY STOP: Block all quoting at extreme imbalance
    // =========================================================================
    if (imbalance >= config.maxUnpairedShares) {
      const reason = `EMERGENCY: ${imbalance.toFixed(0)} share imbalance >= ${config.maxUnpairedShares} max`;
      console.log(`[QuotingEngine] 🚨 ${reason}`);
      
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
    
    // =========================================================================
    // V35.3.7 HEDGE-VIABILITY IS KING
    // =========================================================================
    // We removed STRICT_BALANCE because it was too aggressive.
    // If the opposite side is CHEAP to hedge (combined < 98c), we should
    // absolutely keep buying on the leading side - that's free money!
    // 
    // Example: UP at 65c, DOWN at 10c = 75c combined = 25c profit per pair
    // The HEDGE_FIRST guard above already blocks when hedging is too expensive.
    // =========================================================================
    // (No additional blocking here - HEDGE_FIRST handles affordability)
    
    // =========================================================================
    // EXPENSIVE SIDE LEADS RULE (from V35.1.0)
    // Allow expensive side to have more shares (positive EV bias)
    // Cheap side must stay within ratio of expensive side
    // =========================================================================
    if (side === cheapSide) {
      const maxCheapQty = expensiveQty * config.maxExpensiveBias;
      
      if (cheapQty >= maxCheapQty && expensiveQty > 0) {
        const reason = `Cheap side (${side}) at limit: ${cheapQty.toFixed(0)} >= ${maxCheapQty.toFixed(0)} (${config.maxExpensiveBias}x expensive)`;
        console.log(`[QuotingEngine] 🛡️ ${reason}`);
        
        logV35GuardEvent({
          marketSlug: market.slug,
          asset: market.asset,
          guardType: 'EXPENSIVE_BIAS',
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
    if (currentQty > oppositeQty) {
      // We're already leading - very limited budget
      maxNewOrderQty = config.maxUnpairedShares - imbalance - existingOpenQty;
    } else {
      // We're trailing - we have more room
      maxNewOrderQty = config.maxUnpairedShares + imbalance - existingOpenQty;
    }
    
    // Clamp to non-negative
    maxNewOrderQty = Math.max(0, maxNewOrderQty);
    
    console.log(`[QuotingEngine] 📊 BURST-CAP: ${side} budget=${maxNewOrderQty.toFixed(0)} (existing=${existingOpenQty.toFixed(0)}, imbalance=${imbalance.toFixed(0)}, leading=${currentQty > oppositeQty})`);
    
    if (maxNewOrderQty < config.sharesPerLevel) {
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
    
    // =========================================================================
    // GENERATE QUOTES - Capped by burst budget
    // PRIORITY: 35c-55c range first (lowest combined cost = highest profit)
    // =========================================================================
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Sort grid prices: prioritize 0.35-0.55 range first (sweet spot)
    const sortedPrices = this.getPrioritizedPrices();
    
    let totalQuotedQty = 0;
    
    for (const price of sortedPrices) {
      // =========================================================================
      // V35.4.2 PER-LEVEL HEDGE-FIRST CHECK
      // =========================================================================
      // For this specific bid price, check if hedging would be profitable.
      // Combined cost = our bid price + opposite ask
      // Only quote if combined < MAX_COMBINED_COST (0.98)
      // =========================================================================
      if (oppositeAsk > 0) {
        const projectedCombined = price + oppositeAsk;
        if (projectedCombined > MAX_COMBINED_COST) {
          // Skip this price level - hedge would not be profitable
          continue;
        }
      }
      
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
