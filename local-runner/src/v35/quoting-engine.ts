// ============================================================
// V35 QUOTING ENGINE - GABAGOOL MODE
// ============================================================
// Version: V35.10.0 - "Smart Spread Following"
//
// V35.10.0 MAJOR CHANGES:
// ================================================================
// PROBLEM: Fixed grid (35-55c) placed orders FAR from market ask,
//          reducing fill probability significantly.
//
// SOLUTION: "Smart Spread" quoting - place orders NEAR the current
//           best bid, not on fixed grid levels. This maximizes
//           fill probability while still being a maker (not taker).
//
// NEW STRATEGY:
// 1. Get current best bid for each side
// 2. Place orders at: bestBid, bestBid - 1¢, bestBid - 2¢, etc.
// 3. This keeps us competitive in the book
// 4. Still respect BURST-CAP to prevent excessive exposure
// ================================================================
//
// V35.6.1 FIX (kept):
// - Fresh market (both sides = 0) now quotes BOTH sides equally
// - BALANCED/TRAILING exemptions for burst-cap
//
// CORE PRINCIPLE: Quote competitively near the spread to maximize fills.
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

// V35.10.0: Smart spread configuration
const SMART_SPREAD_CONFIG = {
  numLevels: 4,           // How many price levels to quote (4 levels = 20 shares at 5/level)
  levelStep: 0.01,        // Step between levels (1¢)
  minBidFromAsk: 0.002,   // Minimum distance from ask (0.2¢ anti-crossing margin)
};

export class QuotingEngine {
  private gridPrices: number[] = [];
  
  constructor() {
    this.updateGrid();
  }
  
  /**
   * Regenerate grid prices from current config
   * NOTE: V35.10.0 uses smart spread, but grid is kept for fallback
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
   * V35.10.0: Uses SMART SPREAD placement near current bid
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
   * V35.10.0: SMART SPREAD - quotes near current bid, not fixed grid
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
    // BALANCED STATE DETECTION
    // =========================================================================
    const isBalanced = imbalance < 1;
    const trailingSide = market.upQty < market.downQty ? 'UP' : 'DOWN';
    const isTrailing = !isBalanced && side === trailingSide;
    const isLeading = !isBalanced && side !== trailingSide;
    
    // =========================================================================
    // CHEAP SIDE EXTREME BLOCK (25+ shares lead)
    // =========================================================================
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
    // EMERGENCY STOP AT EXTREME IMBALANCE
    // =========================================================================
    if (imbalance >= config.maxUnpairedShares) {
      if (isTrailing) {
        console.log(`[QuotingEngine] 🚨 EMERGENCY but ${side} is TRAILING - allowing hedge quotes`);
      } else {
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
    // BURST-CAP CALCULATION
    // =========================================================================
    const existingOpenOrders = side === 'UP' ? market.upOrders : market.downOrders;
    let existingOpenQty = 0;
    for (const order of existingOpenOrders.values()) {
      existingOpenQty += order.size;
    }
    
    let maxNewOrderQty: number;
    
    if (isBalanced) {
      maxNewOrderQty = config.maxUnpairedShares - existingOpenQty;
      console.log(`[QuotingEngine] ⚖️ BALANCED: ${side} gets full budget ${maxNewOrderQty.toFixed(0)}`);
    } else if (currentQty > oppositeQty) {
      maxNewOrderQty = config.maxUnpairedShares - imbalance - existingOpenQty;
    } else {
      maxNewOrderQty = config.maxUnpairedShares + imbalance - existingOpenQty;
    }
    
    maxNewOrderQty = Math.max(0, maxNewOrderQty);
    
    console.log(`[QuotingEngine] 📊 BURST-CAP: ${side} budget=${maxNewOrderQty.toFixed(0)} (existing=${existingOpenQty.toFixed(0)}, imbalance=${imbalance.toFixed(0)})`);
    
    // =========================================================================
    // TRAILING/BALANCED EXEMPTION
    // =========================================================================
    if (maxNewOrderQty < config.sharesPerLevel) {
      if (isBalanced) {
        maxNewOrderQty = config.sharesPerLevel * SMART_SPREAD_CONFIG.numLevels;
        console.log(`[QuotingEngine] ⚖️ BALANCED OVERRIDE: ${side} gets minimum ${maxNewOrderQty.toFixed(0)} shares`);
      } else if (isTrailing) {
        const neededToBalance = imbalance;
        const buffer = config.sharesPerLevel;
        maxNewOrderQty = Math.max(config.sharesPerLevel, neededToBalance + buffer);
        console.log(`[QuotingEngine] 🔓 TRAILING OVERRIDE: ${side} allowing ${maxNewOrderQty.toFixed(0)} shares`);
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
    // V35.10.0: SMART SPREAD QUOTE GENERATION
    // =========================================================================
    // Instead of fixed grid, place orders NEAR the current best bid
    // This keeps us competitive and increases fill probability
    // =========================================================================
    
    const bestBid = side === 'UP' ? market.upBestBid : market.downBestBid;
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // If no market data, fall back to mid-range prices
    const fallbackPrice = 0.50;
    const startingBid = bestBid > 0 ? bestBid : fallbackPrice;
    
    let totalQuotedQty = 0;
    
    for (let level = 0; level < SMART_SPREAD_CONFIG.numLevels; level++) {
      // Calculate price for this level (starting at best bid, stepping down)
      const levelPrice = Math.round((startingBid - (level * SMART_SPREAD_CONFIG.levelStep)) * 100) / 100;
      
      // Skip if price is too low or too high
      if (levelPrice < config.gridMin || levelPrice > config.gridMax) {
        continue;
      }
      
      // Anti-crossing check: don't bid too close to ask
      if (bestAsk > 0 && levelPrice >= bestAsk - SMART_SPREAD_CONFIG.minBidFromAsk) {
        console.log(`[QuotingEngine] ⚠️ Level ${level} ($${levelPrice.toFixed(2)}) too close to ask ($${bestAsk.toFixed(2)}), skipping`);
        continue;
      }
      
      // Calculate shares for this level
      const minSharesForNotional = Math.ceil(1.0 / levelPrice);
      const shares = Math.max(config.sharesPerLevel, minSharesForNotional);
      
      // Check burst cap
      if (totalQuotedQty + shares > maxNewOrderQty) {
        console.log(`[QuotingEngine] 🛡️ BURST-CAP reached at ${totalQuotedQty.toFixed(0)}/${maxNewOrderQty.toFixed(0)} shares`);
        break;
      }
      
      quotes.push({ price: levelPrice, size: shares });
      totalQuotedQty += shares;
    }
    
    if (quotes.length > 0) {
      const priceRange = quotes.length > 1 
        ? `$${quotes[quotes.length - 1].price.toFixed(2)}-$${quotes[0].price.toFixed(2)}`
        : `$${quotes[0].price.toFixed(2)}`;
      console.log(`[QuotingEngine] ✅ Generated ${quotes.length} ${side} quotes @ ${priceRange}, total=${totalQuotedQty.toFixed(0)} shares (bid=$${startingBid.toFixed(2)})`);
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
    const upValue = market.upQty * (market.upBestBid || 0);
    const downValue = market.downQty * (market.downBestBid || 0);
    const currentValue = upValue + downValue;
    const totalCost = market.upCost + market.downCost;
    return currentValue - totalCost;
  }
  
  /**
   * Calculate locked profit (guaranteed at settlement)
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
    
    const avgUpCost = market.upCost / market.upQty;
    const avgDownCost = market.downCost / market.downQty;
    const combinedCost = avgUpCost + avgDownCost;
    
    const lockedProfit = pairedShares * (1 - combinedCost);
    const profitPct = (1 - combinedCost) * 100;
    
    return { pairedShares, combinedCost, lockedProfit, profitPct };
  }
  
  /**
   * Check if a market should be actively quoted at all
   */
  shouldQuoteMarket(market: V35Market): { shouldQuote: boolean; reason: string } {
    const config = getV35Config();
    
    const pnl = this.calculateUnrealizedPnL(market);
    if (pnl < -config.maxLossPerMarket) {
      return { shouldQuote: false, reason: `Loss limit triggered: $${pnl.toFixed(2)}` };
    }
    
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
   * Get the current grid prices (for fallback)
   */
  getGridPrices(): number[] {
    return [...this.gridPrices];
  }
}
