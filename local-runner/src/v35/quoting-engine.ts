// ============================================================
// V35 QUOTING ENGINE - PASSIVE GABAGOOL STRATEGY
// ============================================================
// Version: V35.5.6 - "Trailing Side Burst-Cap Exemption"
//
// V35.5.6 KEY FIX: Trailing side is EXEMPT from burst-cap!
// The burst-cap was blocking the trailing side even when it
// MUST quote to hedge. This caused unrecoverable imbalances.
//
// The trailing side (fewer shares) is ALWAYS allowed to quote
// because filling it REDUCES imbalance, not increases it.
//
// CHEAP-SIDE SKIP:
// Only buy the cheap side if the expensive side already leads.
// But if the cheap side IS trailing (fewer shares), allow it anyway.
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
    // V35.5.1 SMART CHEAP-SIDE SKIP - RELAXED FOR HEDGING
    // =========================================================================
    // The cheap side usually loses (market prices in expected outcome).
    // HOWEVER: If we're trying to HEDGE (balance the position), we MUST
    // allow buying the cheap side even if we already have more of it!
    //
    // NEW LOGIC: Only skip cheap side if:
    //   1. We're NOT imbalanced (no need to hedge)
    //   2. Cheap side already leads significantly
    //
    // If there's an imbalance, we NEED to buy the trailing side to hedge,
    // regardless of which side is "cheap"!
    // =========================================================================
    const trailingSide = market.upQty < market.downQty ? 'UP' : 'DOWN';
    const isTrailing = side === trailingSide;
    
    // Only apply cheap-skip if we're NOT the trailing side (not hedging)
    if (side === cheapSide && expensiveQty > 0 && !isTrailing) {
      // We're quoting on the cheap side but we're NOT trailing - block it
      if (cheapQty >= expensiveQty) {
        const reason = `CHEAP-SKIP: ${side} is cheap and NOT trailing (${cheapQty.toFixed(0)} >= ${expensiveQty.toFixed(0)})`;
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
    }
    
    // If we're trailing, we MUST quote to hedge - no cheap-skip applies
    if (isTrailing) {
      console.log(`[QuotingEngine] ✅ ${side} is TRAILING (${currentQty.toFixed(0)} < ${oppositeQty.toFixed(0)}) - quoting to HEDGE`);
    } else if (side === cheapSide && expensiveQty > cheapQty) {
      console.log(`[QuotingEngine] ✅ ${side} is cheap but expensive leads (${expensiveQty.toFixed(0)} > ${cheapQty.toFixed(0)}) - quoting to balance`);
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
    
    // =========================================================================
    // V35.5.6 KEY FIX: TRAILING SIDE IS EXEMPT FROM BURST-CAP
    // =========================================================================
    // The trailing side (fewer shares) MUST be able to quote to hedge.
    // Filling the trailing side REDUCES imbalance, so burst-cap doesn't apply.
    // Only the leading side needs burst-cap protection.
    // =========================================================================
    if (maxNewOrderQty < config.sharesPerLevel) {
      if (isTrailing) {
        // V35.5.6: Allow trailing side to quote even with budget exhausted
        // Set a reasonable fallback budget (enough for 5 levels)
        maxNewOrderQty = config.sharesPerLevel * 5;
        console.log(`[QuotingEngine] 🔓 BURST-CAP OVERRIDE: ${side} is TRAILING - allowing ${maxNewOrderQty} shares for hedging`);
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
