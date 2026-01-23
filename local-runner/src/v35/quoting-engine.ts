// ============================================================
// V35 QUOTING ENGINE
// ============================================================
// Generates inventory-aware quotes for passive market making.
// Places BUY orders on a grid from gridMin to gridMax.
// Adjusts sizing based on current inventory skew.
// ============================================================

import { getV35Config, type V35Config } from './config.js';
import type { V35Market, V35Quote, V35Side } from './types.js';

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
   */
  generateQuotes(side: V35Side, market: V35Market): V35Quote[] {
    const config = getV35Config();
    const quotes: V35Quote[] = [];
    
    // Determine current inventory for this side
    const currentCost = side === 'UP' ? market.upCost : market.downCost;
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    // Calculate skew (positive = more UP than DOWN)
    const skew = market.upQty - market.downQty;
    const unpaired = Math.abs(skew);
    
    // Check imbalance limit - stop quoting overweight side
    if (unpaired > config.maxUnpairedImbalance) {
      if ((side === 'UP' && skew > 0) || (side === 'DOWN' && skew < 0)) {
        // This side is overweight, don't quote
        return [];
      }
    }
    
    // Generate quotes at each grid level
    for (const price of this.gridPrices) {
      // Skip if our bid would cross the ask (we'd become taker)
      if (price >= bestAsk - 0.01) {
        continue;
      }
      
      // Calculate size with skew adjustment
      const size = this.calculateSize(side, price, market, currentCost, config);
      
      // Only include if size is meaningful (>= 5 shares)
      if (size >= 5) {
        quotes.push({ price, size });
      }
    }
    
    return quotes;
  }
  
  /**
   * Calculate position size for a quote with inventory awareness
   */
  private calculateSize(
    side: V35Side,
    price: number,
    market: V35Market,
    currentCost: number,
    config: V35Config
  ): number {
    let size = config.baseSize;
    const skew = market.upQty - market.downQty;
    
    // Skew adjustment: reduce overweight side, boost underweight side
    if (side === 'UP') {
      if (skew > config.skewThreshold) {
        // Too much UP, reduce
        size *= config.skewReduceFactor;
      } else if (skew < -config.skewThreshold) {
        // Too little UP, boost
        size *= config.skewBoostFactor;
      }
    } else {
      if (skew > config.skewThreshold) {
        // Too little DOWN, boost
        size *= config.skewBoostFactor;
      } else if (skew < -config.skewThreshold) {
        // Too much DOWN, reduce
        size *= config.skewReduceFactor;
      }
    }
    
    // Notional limit: don't exceed max per market
    const remaining = config.maxNotionalPerMarket - currentCost;
    const maxByNotional = remaining / price;
    size = Math.min(size, maxByNotional);
    
    return Math.max(0, Math.floor(size));
  }
  
  /**
   * Get the current grid prices
   */
  getGridPrices(): number[] {
    return [...this.gridPrices];
  }
}
