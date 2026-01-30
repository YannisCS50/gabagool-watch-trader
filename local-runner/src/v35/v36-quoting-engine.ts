// ============================================================
// V36 QUOTING ENGINE - PROFESSIONAL MARKET MAKING
// ============================================================
// Version: V36.0.0 - "Professional Market Making"
//
// KEY DIFFERENCES FROM V35:
// 1. Treats UP + DOWN as ONE combined orderbook
// 2. Only quotes when combined ask < $1.00 (edge exists)
// 3. Uses full depth analysis, not just top-of-book
// 4. Sizes orders based on available liquidity at each level
// 5. Prioritizes balance: never let either side get too far ahead
//
// CORE STRATEGY:
// - Identify edge: when askUp + askDown < $1.00
// - Place passive bids on BOTH sides
// - When one fills, immediately hedge on the other side
// - Profit = $1.00 - (avgUp + avgDown)
// ============================================================

import type { V35Market, V35Quote, V35Side, V35Asset } from './types.js';
import { 
  CombinedBook, 
  CombinedQuote, 
  QuotingDecision,
  buildCombinedBook,
  generateCombinedQuotes,
  logCombinedBook,
} from './combined-book.js';
import { getV35Config } from './config.js';
import { logV35GuardEvent } from './backend.js';
import { 
  checkCapWithEffectiveExposure, 
  getEffectiveExposure,
  EXPOSURE_CAP_CONFIG,
} from '../exposure-ledger.js';

// ============================================================
// CONFIGURATION
// ============================================================

export interface V36QuotingConfig {
  // Edge requirements
  minEdgeToQuote: number;        // Minimum edge (e.g., 0.02 = 2¢)
  minEdgeToHedge: number;        // Minimum edge for hedge (e.g., 0.00 = break-even OK)
  
  // Sizing
  maxSharesPerSide: number;      // Maximum shares per side (hard cap)
  sharesPerLevel: number;        // Base shares per level
  numLevels: number;             // Number of price levels to quote
  levelStep: number;             // Step between levels (e.g., 0.01 = 1¢)
  
  // Risk limits
  maxImbalance: number;          // Max allowed imbalance
  stopQuotingImbalance: number;  // Stop quoting leading side at this imbalance
  
  // Depth requirements
  minDepthToQuote: number;       // Minimum depth on both sides
  minLiquidLevels: number;       // Minimum levels on each side
}

const DEFAULT_V36_CONFIG: V36QuotingConfig = {
  minEdgeToQuote: 0.02,          // 2¢ minimum edge to quote
  minEdgeToHedge: 0.00,          // Break-even hedges OK
  maxSharesPerSide: 100,         // Hard cap
  sharesPerLevel: 5,             // 5 shares per level
  numLevels: 4,                  // 4 price levels
  levelStep: 0.01,               // 1¢ between levels
  maxImbalance: 20,              // Max 20 share imbalance
  stopQuotingImbalance: 5,       // Stop leading side at 5 shares
  minDepthToQuote: 20,           // Need 20 shares depth
  minLiquidLevels: 3,            // Need 3 levels on each side
};

// ============================================================
// V36 QUOTING ENGINE
// ============================================================

export class V36QuotingEngine {
  private config: V36QuotingConfig;
  
  // Cached orderbook depth for each market
  private bookCache: Map<string, {
    upBids: any[];
    upAsks: any[];
    downBids: any[];
    downAsks: any[];
    lastUpdate: number;
  }> = new Map();
  
  constructor(config: Partial<V36QuotingConfig> = {}) {
    this.config = { ...DEFAULT_V36_CONFIG, ...config };
  }
  
  /**
   * Update orderbook depth for a market
   * Called from WebSocket handler when book events arrive
   */
  updateDepth(
    marketSlug: string,
    side: 'UP' | 'DOWN',
    bids: any[],
    asks: any[]
  ): void {
    let cached = this.bookCache.get(marketSlug);
    if (!cached) {
      cached = {
        upBids: [],
        upAsks: [],
        downBids: [],
        downAsks: [],
        lastUpdate: Date.now(),
      };
      this.bookCache.set(marketSlug, cached);
    }
    
    if (side === 'UP') {
      cached.upBids = bids;
      cached.upAsks = asks;
    } else {
      cached.downBids = bids;
      cached.downAsks = asks;
    }
    cached.lastUpdate = Date.now();
  }
  
  /**
   * Get the cached combined book for a market
   */
  getCombinedBook(marketSlug: string): CombinedBook | null {
    const cached = this.bookCache.get(marketSlug);
    if (!cached) return null;
    
    return buildCombinedBook(
      cached.upBids,
      cached.upAsks,
      cached.downBids,
      cached.downAsks
    );
  }
  
  /**
   * Generate quotes for a market using combined book analysis
   */
  generateQuotes(market: V35Market): {
    upQuotes: V35Quote[];
    downQuotes: V35Quote[];
    combinedBook: CombinedBook | null;
    decision: QuotingDecision | null;
    blockedReason: string | null;
  } {
    const book = this.getCombinedBook(market.slug);
    
    // If we don't have depth data, return empty
    if (!book) {
      return {
        upQuotes: [],
        downQuotes: [],
        combinedBook: null,
        decision: null,
        blockedReason: 'NO_DEPTH_DATA',
      };
    }
    
    // Log combined book for visibility
    logCombinedBook(book, market.asset);
    
    // Check imbalance constraints
    const imbalance = Math.abs(market.upQty - market.downQty);
    const leadingSide = market.upQty > market.downQty ? 'UP' : 'DOWN';
    
    // Hard exposure cap check
    const upExposure = getEffectiveExposure(market.conditionId, market.asset);
    const downExposure = getEffectiveExposure(market.conditionId, market.asset);
    
    // Generate quotes using combined book analysis
    const decision = generateCombinedQuotes(book, {
      minEdge: this.config.minEdgeToQuote,
      maxSharesPerSide: this.config.maxSharesPerSide,
      numLevels: this.config.numLevels,
      levelStep: this.config.levelStep,
      minSharesPerLevel: 3,  // Polymarket minimum
    });
    
    if (decision.blocked) {
      return {
        upQuotes: [],
        downQuotes: [],
        combinedBook: book,
        decision,
        blockedReason: decision.blockReason,
      };
    }
    
    // Convert to V35Quote format
    let upQuotes: V35Quote[] = decision.upQuotes.map(q => ({
      price: q.price,
      size: q.size,
    }));
    
    let downQuotes: V35Quote[] = decision.downQuotes.map(q => ({
      price: q.price,
      size: q.size,
    }));
    
    // Apply imbalance constraints
    if (imbalance >= this.config.stopQuotingImbalance) {
      if (leadingSide === 'UP') {
        console.log(`[V36] 🛑 Blocking UP quotes: imbalance ${imbalance.toFixed(0)} >= ${this.config.stopQuotingImbalance}`);
        upQuotes = [];
        
        logV35GuardEvent({
          marketSlug: market.slug,
          asset: market.asset,
          guardType: 'V36_IMBALANCE_BLOCK',
          blockedSide: 'UP',
          upQty: market.upQty,
          downQty: market.downQty,
          expensiveSide: 'UP',
          reason: `UP leads by ${imbalance.toFixed(0)} shares`,
        }).catch(() => {});
      } else {
        console.log(`[V36] 🛑 Blocking DOWN quotes: imbalance ${imbalance.toFixed(0)} >= ${this.config.stopQuotingImbalance}`);
        downQuotes = [];
        
        logV35GuardEvent({
          marketSlug: market.slug,
          asset: market.asset,
          guardType: 'V36_IMBALANCE_BLOCK',
          blockedSide: 'DOWN',
          upQty: market.upQty,
          downQty: market.downQty,
          expensiveSide: 'DOWN',
          reason: `DOWN leads by ${imbalance.toFixed(0)} shares`,
        }).catch(() => {});
      }
    }
    
    // Apply hard cap constraints
    const upRemaining = this.config.maxSharesPerSide - upExposure.effectiveUp;
    const downRemaining = this.config.maxSharesPerSide - downExposure.effectiveDown;
    
    if (upRemaining <= 0) {
      console.log(`[V36] 🔒 UP at hard cap: ${upExposure.effectiveUp.toFixed(0)}/${this.config.maxSharesPerSide}`);
      upQuotes = [];
    }
    
    if (downRemaining <= 0) {
      console.log(`[V36] 🔒 DOWN at hard cap: ${downExposure.effectiveDown.toFixed(0)}/${this.config.maxSharesPerSide}`);
      downQuotes = [];
    }
    
    // Cap sizes to remaining capacity
    upQuotes = this.capQuotesToLimit(upQuotes, upRemaining);
    downQuotes = this.capQuotesToLimit(downQuotes, downRemaining);
    
    const totalUp = upQuotes.reduce((s, q) => s + q.size, 0);
    const totalDown = downQuotes.reduce((s, q) => s + q.size, 0);
    
    console.log(`[V36] ✅ Quotes: UP ${upQuotes.length} levels (${totalUp} shares) | DOWN ${downQuotes.length} levels (${totalDown} shares)`);
    console.log(`[V36] 📊 Edge: ${(book.edge * 100).toFixed(1)}¢ | Combined ask: $${book.combinedBestAsk.toFixed(3)}`);
    
    return {
      upQuotes,
      downQuotes,
      combinedBook: book,
      decision,
      blockedReason: null,
    };
  }
  
  /**
   * Cap quotes to a maximum total size
   */
  private capQuotesToLimit(quotes: V35Quote[], maxTotal: number): V35Quote[] {
    if (maxTotal <= 0) return [];
    
    let remaining = maxTotal;
    const capped: V35Quote[] = [];
    
    for (const quote of quotes) {
      if (remaining <= 0) break;
      
      const size = Math.min(quote.size, remaining);
      if (size >= 3) {  // Polymarket minimum
        capped.push({ price: quote.price, size });
        remaining -= size;
      }
    }
    
    return capped;
  }
  
  /**
   * Calculate if a hedge would be profitable
   */
  canHedgeProfitably(
    market: V35Market,
    fillSide: V35Side,
    fillPrice: number
  ): { canHedge: boolean; hedgePrice: number; combinedCost: number; edge: number } {
    const book = this.getCombinedBook(market.slug);
    if (!book) {
      return { canHedge: false, hedgePrice: 1, combinedCost: 2, edge: -1 };
    }
    
    // Find the hedge side's best ask
    const hedgeSide = fillSide === 'UP' ? 'DOWN' : 'UP';
    const hedgeAsk = hedgeSide === 'UP' ? book.up.bestAsk : book.down.bestAsk;
    
    // Calculate combined cost
    const combinedCost = fillPrice + hedgeAsk;
    const edge = 1.0 - combinedCost;
    
    const canHedge = edge >= this.config.minEdgeToHedge;
    
    console.log(`[V36] Hedge check: ${fillSide} filled @ $${fillPrice.toFixed(2)} | ${hedgeSide} ask $${hedgeAsk.toFixed(2)} | Combined $${combinedCost.toFixed(3)} | Edge ${(edge * 100).toFixed(1)}¢ | Can hedge: ${canHedge}`);
    
    return { canHedge, hedgePrice: hedgeAsk, combinedCost, edge };
  }
  
  /**
   * Get current edge for a market
   */
  getCurrentEdge(marketSlug: string): number | null {
    const book = this.getCombinedBook(marketSlug);
    return book ? book.edge : null;
  }
  
  /**
   * Check if market has tradeable edge
   */
  hasTradeableEdge(marketSlug: string): boolean {
    const book = this.getCombinedBook(marketSlug);
    return book ? book.hasEdge && book.edge >= this.config.minEdgeToQuote : false;
  }
  
  /**
   * Get market status summary
   */
  getMarketStatus(market: V35Market): string {
    const book = this.getCombinedBook(market.slug);
    if (!book) return 'No depth data';
    
    const imbalance = Math.abs(market.upQty - market.downQty);
    const paired = Math.min(market.upQty, market.downQty);
    const avgUp = market.upQty > 0 ? market.upCost / market.upQty : 0;
    const avgDown = market.downQty > 0 ? market.downCost / market.downQty : 0;
    const combinedCost = avgUp + avgDown;
    const lockedProfit = paired * (1.0 - combinedCost);
    
    return `UP:${market.upQty.toFixed(0)} DOWN:${market.downQty.toFixed(0)} | ` +
           `Edge:${(book.edge * 100).toFixed(1)}¢ | ` +
           `Combined:$${combinedCost.toFixed(3)} | ` +
           `Locked:$${lockedProfit.toFixed(2)}`;
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let v36Engine: V36QuotingEngine | null = null;

export function getV36QuotingEngine(): V36QuotingEngine {
  if (!v36Engine) {
    v36Engine = new V36QuotingEngine();
  }
  return v36Engine;
}

export function resetV36QuotingEngine(): void {
  v36Engine = null;
}
