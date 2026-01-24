// ============================================================
// V35 QUOTING ENGINE - ENHANCED
// ============================================================
// Generates inventory-aware quotes for passive market making.
// Places BUY orders on a grid from gridMin to gridMax.
// Adjusts sizing based on current inventory skew.
//
// CRITICAL FIXES:
// 1. Momentum filter - don't quote against the trend
// 2. Stricter imbalance limits - stop earlier
// 3. Ratio-based checks - max UP:DOWN ratio
// 4. Stop loss integration
// ============================================================

import { getV35Config, type V35Config } from './config.js';
import type { V35Market, V35Quote, V35Side, V35Asset } from './types.js';
import { getBinanceFeed, type BinancePriceFeed } from './binance-feed.js';

interface QuoteDecision {
  quotes: V35Quote[];
  blocked: boolean;
  blockReason: string | null;
}

export class QuotingEngine {
  private gridPrices: number[] = [];
  private binanceFeed: BinancePriceFeed;
  
  constructor() {
    this.binanceFeed = getBinanceFeed();
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
   * Generate quotes for one side of a market with all safety checks
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
   */
  generateQuotesWithReason(side: V35Side, market: V35Market): QuoteDecision {
    const config = getV35Config();
    const quotes: V35Quote[] = [];
    
    // =========================================================================
    // CHECK 1: MOMENTUM FILTER
    // Don't quote against the trend - we become exit liquidity
    // =========================================================================
    if (config.enableMomentumFilter) {
      const canQuote = this.binanceFeed.shouldQuote(market.asset, side);
      if (!canQuote) {
        const trend = this.binanceFeed.getTrendDirection(market.asset);
        const momentum = this.binanceFeed.getMomentum(market.asset);
        return {
          quotes: [],
          blocked: true,
          blockReason: `Momentum filter: ${market.asset} trending ${trend} (${momentum.toFixed(3)}%) - skipping ${side}`,
        };
      }
    }
    
    // =========================================================================
    // CHECK 2: ABSOLUTE IMBALANCE LIMIT (STRICT)
    // =========================================================================
    const skew = market.upQty - market.downQty;
    const unpaired = Math.abs(skew);
    
    if (unpaired > config.maxUnpairedImbalance) {
      // This side is overweight, don't quote
      if ((side === 'UP' && skew > 0) || (side === 'DOWN' && skew < 0)) {
        return {
          quotes: [],
          blocked: true,
          blockReason: `Imbalance limit: ${unpaired.toFixed(0)} shares unpaired (max ${config.maxUnpairedImbalance})`,
        };
      }
    }
    
    // =========================================================================
    // CHECK 3: RATIO-BASED IMBALANCE (NEW)
    // Max allowed ratio is 1.3:1 or 1.5:1 depending on mode
    // =========================================================================
    if (market.upQty >= 10 && market.downQty >= 10) {
      const ratio = market.upQty > market.downQty 
        ? market.upQty / market.downQty 
        : market.downQty / market.upQty;
      
      if (ratio > config.maxImbalanceRatio) {
        // Stop quoting the overweight side
        const overweightSide = market.upQty > market.downQty ? 'UP' : 'DOWN';
        if (side === overweightSide) {
          return {
            quotes: [],
            blocked: true,
            blockReason: `Ratio limit: ${ratio.toFixed(2)}:1 (max ${config.maxImbalanceRatio}:1) - stop ${side}`,
          };
        }
      }
    }
    
    // =========================================================================
    // CHECK 4: ONE-SIDED POSITION (CRITICAL)
    // If we have 10+ shares on one side and 0 on the other, STOP immediately
    // =========================================================================
    if ((side === 'UP' && market.upQty >= 10 && market.downQty === 0) ||
        (side === 'DOWN' && market.downQty >= 10 && market.upQty === 0)) {
      return {
        quotes: [],
        blocked: true,
        blockReason: `One-sided position: ${market.upQty.toFixed(0)} UP vs ${market.downQty.toFixed(0)} DOWN - STOP ${side}`,
      };
    }
    
    // =========================================================================
    // CHECK 5: STOP LOSS
    // =========================================================================
    if (config.enableStopLoss) {
      const unrealizedLoss = this.calculateUnrealizedPnL(market);
      if (unrealizedLoss < -config.maxLossPerMarket) {
        return {
          quotes: [],
          blocked: true,
          blockReason: `Stop loss: Unrealized P&L $${unrealizedLoss.toFixed(2)} (max -$${config.maxLossPerMarket})`,
        };
      }
    }
    
    // =========================================================================
    // GENERATE QUOTES
    // =========================================================================
    const currentCost = side === 'UP' ? market.upCost : market.downCost;
    const bestAsk = side === 'UP' ? market.upBestAsk : market.downBestAsk;
    
    for (const price of this.gridPrices) {
      // Skip if our bid would cross the ask (we'd become taker)
      if (bestAsk > 0 && price >= bestAsk - 0.01) {
        continue;
      }
      
      // Calculate size with skew adjustment
      const size = this.calculateSize(side, price, market, currentCost, config);
      
      // Only include if size is meaningful (>= 5 shares)
      if (size >= 5) {
        quotes.push({ price, size });
      }
    }
    
    return {
      quotes,
      blocked: false,
      blockReason: null,
    };
  }
  
  /**
   * Calculate unrealized P&L for stop loss check
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
        // Too much UP, reduce significantly
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
        // Too much DOWN, reduce significantly
        size *= config.skewReduceFactor;
      }
    }
    
    // Additional reduction based on how close we are to imbalance limit
    const unpaired = Math.abs(skew);
    const imbalancePct = unpaired / config.maxUnpairedImbalance;
    if (imbalancePct > 0.5) {
      // More than 50% to limit - start reducing
      const reductionFactor = 1 - (imbalancePct - 0.5);
      size *= Math.max(0.2, reductionFactor);
    }
    
    // Notional limit: don't exceed max per market
    const remaining = config.maxNotionalPerMarket - currentCost;
    const maxByNotional = remaining / price;
    size = Math.min(size, maxByNotional);
    
    return Math.max(0, Math.floor(size));
  }
  
  /**
   * Check if a market should be actively quoted at all
   */
  shouldQuoteMarket(market: V35Market): { shouldQuote: boolean; reason: string } {
    const config = getV35Config();
    
    // Check total exposure
    const totalCost = market.upCost + market.downCost;
    if (totalCost >= config.maxNotionalPerMarket * 0.95) {
      return { shouldQuote: false, reason: 'Max notional reached' };
    }
    
    // Check stop loss
    if (config.enableStopLoss) {
      const pnl = this.calculateUnrealizedPnL(market);
      if (pnl < -config.maxLossPerMarket) {
        return { shouldQuote: false, reason: `Stop loss triggered: $${pnl.toFixed(2)}` };
      }
    }
    
    return { shouldQuote: true, reason: 'OK' };
  }
  
  /**
   * Get current momentum state for logging
   */
  getMomentumState(asset: V35Asset): {
    price: number;
    momentum: number;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    isTrending: boolean;
  } {
    return {
      price: this.binanceFeed.getPrice(asset),
      momentum: this.binanceFeed.getMomentum(asset),
      direction: this.binanceFeed.getTrendDirection(asset),
      isTrending: this.binanceFeed.isTrending(asset),
    };
  }
  
  /**
   * Get the current grid prices
   */
  getGridPrices(): number[] {
    return [...this.gridPrices];
  }
}
