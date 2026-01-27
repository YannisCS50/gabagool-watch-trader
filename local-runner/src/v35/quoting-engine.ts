// ============================================================
// V35 QUOTING ENGINE - GABAGOOL STRATEGY
// ============================================================
// Generates passive limit BUY orders on a grid for market making.
// Places orders on BOTH UP and DOWN sides simultaneously.
//
// KEY PRINCIPLES (from gabagool strategy document):
// 1. NEVER filter based on momentum - reduces fills
// 2. ALWAYS quote both sides - temporary imbalance is OK
// 3. Trust the mathematics - combined cost < $1 = profit
//
// The grid naturally balances over time as prices move.
// Temporary imbalance is EXPECTED and should be tolerated.
// ============================================================

import { getV35Config, type V35Config } from './config.js';
import type { V35Market, V35Quote, V35Side, V35Asset } from './types.js';

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
   * Per gabagool strategy: minimal filtering, trust the grid
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
   * SIMPLIFIED per gabagool strategy - minimal guards
   */
  generateQuotesWithReason(side: V35Side, market: V35Market): QuoteDecision {
    const config = getV35Config();
    const quotes: V35Quote[] = [];
    
    // =========================================================================
    // GABAGOOL PHILOSOPHY: ALWAYS QUOTE BOTH SIDES
    // =========================================================================
    // Per user request: Remove all blocking guards. The strategy relies on
    // volume and statistical averaging to achieve balance. Restricting quotes
    // based on imbalance is counterproductive - it stops the bot exactly when
    // it should continue to capture mean-reversion opportunities.
    //
    // OLD GUARDS (now disabled):
    // - maxUnpairedShares: Was blocking overweight side
    // - maxImbalanceRatio: Was blocking when ratio exceeded threshold
    // - maxLossPerMarket: Was blocking all quotes on unrealized loss
    //
    // NEW BEHAVIOR: Log warnings but NEVER block quotes
    // =========================================================================
    
    const skew = market.upQty - market.downQty;
    const unpaired = Math.abs(skew);
    const unrealizedPnL = this.calculateUnrealizedPnL(market);
    
    // Log warnings for monitoring, but don't block
    if (unpaired > config.maxUnpairedShares) {
      console.log(`[QuotingEngine] ⚠️ HIGH SKEW: ${unpaired.toFixed(0)} unpaired shares (threshold: ${config.maxUnpairedShares}) - continuing to quote ${side}`);
    }
    
    if (market.upQty >= 10 && market.downQty >= 10) {
      const ratio = market.upQty > market.downQty 
        ? market.upQty / market.downQty 
        : market.downQty / market.upQty;
      if (ratio > config.maxImbalanceRatio) {
        console.log(`[QuotingEngine] ⚠️ HIGH RATIO: ${ratio.toFixed(2)}:1 (threshold: ${config.maxImbalanceRatio}:1) - continuing to quote ${side}`);
      }
    }
    
    if (unrealizedPnL < -config.maxLossPerMarket) {
      console.log(`[QuotingEngine] ⚠️ UNREALIZED LOSS: $${unrealizedPnL.toFixed(2)} (threshold: -$${config.maxLossPerMarket}) - continuing to quote ${side}`);
    }
    
    // =========================================================================
    // GENERATE QUOTES - Simple grid, uniform sizing
    // Per gabagool: sharesPerLevel is constant, no skew adjustments
    // PRIORITY: 35c-55c range first (lowest combined cost = highest profit)
    // =========================================================================
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Sort grid prices: prioritize 0.35-0.55 range first (sweet spot)
    const sortedPrices = this.getPrioritizedPrices();
    
    for (const price of sortedPrices) {
      // Skip if our bid would cross the ask (we'd become taker)
      if (bestAsk > 0 && price >= bestAsk - 0.01) {
        continue;
      }
      
      // Calculate minimum shares to meet Polymarket notional requirement
      const minSharesForNotional = Math.ceil(1.0 / price);
      const shares = Math.max(config.sharesPerLevel, minSharesForNotional);
      
      quotes.push({ price, size: shares });
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
