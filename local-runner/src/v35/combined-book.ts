// ============================================================
// V36 COMBINED BOOK - PROFESSIONAL MARKET MAKING
// ============================================================
// Version: V36.0.0 - "Professional Market Making"
//
// CORE INSIGHT: UP + DOWN outcomes are ONE COMBINED BOOK
// - If I buy 1 UP @ $0.48 AND 1 DOWN @ $0.47, total cost = $0.95
// - At settlement, one side pays $1.00 → guaranteed $0.05 profit
// - This is the EDGE: 1.00 - combinedAsk
//
// This module:
// 1. Parses FULL orderbook depth (all levels, not just top-of-book)
// 2. Treats UP/DOWN as a single combined orderbook
// 3. Calculates real edge from combined ask prices
// 4. Determines optimal quote sizing based on available liquidity
// ============================================================

import type { V35Market, V35OrderbookLevel, V35Asset, V35Side } from './types.js';

// ============================================================
// COMBINED BOOK TYPES
// ============================================================

export interface DepthLevel {
  price: number;
  size: number;
  cumulativeSize: number;  // Total size at this level and better
  cumulativeCost: number;  // Total $ to fill up to this size
}

export interface SideBook {
  bids: DepthLevel[];  // Sorted by price DESC (best first)
  asks: DepthLevel[];  // Sorted by price ASC (best first)
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  spreadPct: number;
}

export interface CombinedBook {
  up: SideBook;
  down: SideBook;
  
  // Combined metrics (the key insight)
  combinedBestAsk: number;     // upBestAsk + downBestAsk
  combinedBestBid: number;     // upBestBid + downBestBid
  edge: number;                // 1.00 - combinedBestAsk (profit per paired share)
  edgePct: number;             // Edge as percentage
  hasEdge: boolean;            // combinedBestAsk < 1.00
  
  // Depth-aware metrics
  maxPairableShares: number;   // How many shares we can pair at current depth
  avgCombinedAskAt10: number;  // Avg combined ask for 10 shares
  avgCombinedAskAt25: number;  // Avg combined ask for 25 shares
  avgCombinedAskAt50: number;  // Avg combined ask for 50 shares
  
  // Optimal entry points
  optimalUpBid: number;        // Best price to bid for UP
  optimalDownBid: number;      // Best price to bid for DOWN
  
  // Market state
  isLiquid: boolean;           // Both sides have reasonable depth
  isBalanced: boolean;         // Prices roughly symmetric (each ~$0.50)
  timestamp: number;
}

export interface DepthAnalysis {
  sizeAvailable: number;       // How many shares available at this price or better
  avgPrice: number;            // VWAP to fill this size
  worstPrice: number;          // Worst price level touched
  levels: number;              // How many levels needed
}

// ============================================================
// RAW DEPTH PARSING
// ============================================================

/**
 * Parse raw CLOB depth data into structured levels
 * Handles both array format [price, size] and object format {price, size}
 */
export function parseDepthLevels(rawLevels: any[], ascending: boolean): DepthLevel[] {
  const levels: DepthLevel[] = [];
  
  for (const level of rawLevels) {
    let price: number;
    let size: number;
    
    if (Array.isArray(level)) {
      price = parseFloat(level[0]);
      size = parseFloat(level[1]);
    } else if (level && typeof level === 'object') {
      price = parseFloat(level.price ?? level.p ?? 0);
      size = parseFloat(level.size ?? level.s ?? level.quantity ?? level.q ?? 0);
    } else {
      continue;
    }
    
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
      continue;
    }
    
    levels.push({
      price,
      size,
      cumulativeSize: 0,  // Will be calculated after sorting
      cumulativeCost: 0,
    });
  }
  
  // Sort: ascending for asks (lowest first), descending for bids (highest first)
  levels.sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
  
  // Calculate cumulative values
  let cumSize = 0;
  let cumCost = 0;
  for (const level of levels) {
    cumSize += level.size;
    cumCost += level.size * level.price;
    level.cumulativeSize = cumSize;
    level.cumulativeCost = cumCost;
  }
  
  return levels;
}

/**
 * Build a SideBook from raw bid/ask arrays
 */
export function buildSideBook(rawBids: any[], rawAsks: any[]): SideBook {
  const bids = parseDepthLevels(rawBids, false);  // DESC
  const asks = parseDepthLevels(rawAsks, true);   // ASC
  
  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const bestAsk = asks.length > 0 ? asks[0].price : 1;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;
  
  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    spreadPct,
  };
}

// ============================================================
// COMBINED BOOK CONSTRUCTION
// ============================================================

/**
 * Build a combined book view from UP and DOWN orderbooks
 * This is the core of professional market making:
 * - Treat both outcomes as ONE book
 * - Find edge when combined ask < $1.00
 */
export function buildCombinedBook(
  upBids: any[],
  upAsks: any[],
  downBids: any[],
  downAsks: any[]
): CombinedBook {
  const up = buildSideBook(upBids, upAsks);
  const down = buildSideBook(downBids, downAsks);
  
  const combinedBestAsk = up.bestAsk + down.bestAsk;
  const combinedBestBid = up.bestBid + down.bestBid;
  const edge = 1.0 - combinedBestAsk;
  const edgePct = edge * 100;
  const hasEdge = edge > 0;
  
  // Calculate depth-aware metrics
  const depth10 = analyzeDepthForPairing(up.asks, down.asks, 10);
  const depth25 = analyzeDepthForPairing(up.asks, down.asks, 25);
  const depth50 = analyzeDepthForPairing(up.asks, down.asks, 50);
  
  // Find max pairable shares (where combined ask still < $1.00)
  const maxPairableShares = findMaxPairableShares(up.asks, down.asks);
  
  // Optimal bid prices: where we want to place our orders
  // Strategy: bid just below the current best ask to get maker fills
  const optimalUpBid = Math.max(0.01, up.bestAsk - 0.01);
  const optimalDownBid = Math.max(0.01, down.bestAsk - 0.01);
  
  // Market state checks
  const isLiquid = up.bids.length >= 3 && up.asks.length >= 3 && 
                   down.bids.length >= 3 && down.asks.length >= 3;
  const isBalanced = Math.abs(up.midPrice - 0.5) < 0.15 && 
                     Math.abs(down.midPrice - 0.5) < 0.15;
  
  return {
    up,
    down,
    combinedBestAsk,
    combinedBestBid,
    edge,
    edgePct,
    hasEdge,
    maxPairableShares,
    avgCombinedAskAt10: depth10.avgCombinedCost,
    avgCombinedAskAt25: depth25.avgCombinedCost,
    avgCombinedAskAt50: depth50.avgCombinedCost,
    optimalUpBid,
    optimalDownBid,
    isLiquid,
    isBalanced,
    timestamp: Date.now(),
  };
}

// ============================================================
// DEPTH ANALYSIS FOR PAIRING
// ============================================================

interface PairingAnalysis {
  pairableShares: number;
  avgUpAsk: number;
  avgDownAsk: number;
  avgCombinedCost: number;
  edge: number;
}

/**
 * Analyze how much we can pair at depth, and at what combined cost
 */
function analyzeDepthForPairing(
  upAsks: DepthLevel[],
  downAsks: DepthLevel[],
  targetShares: number
): PairingAnalysis {
  if (upAsks.length === 0 || downAsks.length === 0) {
    return {
      pairableShares: 0,
      avgUpAsk: 1,
      avgDownAsk: 1,
      avgCombinedCost: 2,
      edge: -1,
    };
  }
  
  // Find how many shares available on each side at cumulative depth
  const upAvailable = upAsks[upAsks.length - 1]?.cumulativeSize ?? 0;
  const downAvailable = downAsks[downAsks.length - 1]?.cumulativeSize ?? 0;
  
  // We can only pair the minimum of both sides
  const pairableShares = Math.min(targetShares, upAvailable, downAvailable);
  
  if (pairableShares === 0) {
    return {
      pairableShares: 0,
      avgUpAsk: 1,
      avgDownAsk: 1,
      avgCombinedCost: 2,
      edge: -1,
    };
  }
  
  // Calculate VWAP for each side at this depth
  const avgUpAsk = calculateVWAP(upAsks, pairableShares);
  const avgDownAsk = calculateVWAP(downAsks, pairableShares);
  const avgCombinedCost = avgUpAsk + avgDownAsk;
  const edge = 1.0 - avgCombinedCost;
  
  return {
    pairableShares,
    avgUpAsk,
    avgDownAsk,
    avgCombinedCost,
    edge,
  };
}

/**
 * Calculate volume-weighted average price for a given size
 */
function calculateVWAP(levels: DepthLevel[], targetSize: number): number {
  let remainingSize = targetSize;
  let totalCost = 0;
  
  for (const level of levels) {
    if (remainingSize <= 0) break;
    
    const fillSize = Math.min(remainingSize, level.size);
    totalCost += fillSize * level.price;
    remainingSize -= fillSize;
  }
  
  const filledSize = targetSize - remainingSize;
  return filledSize > 0 ? totalCost / filledSize : levels[0]?.price ?? 1;
}

/**
 * Find maximum shares that can be paired while combined ask < $1.00
 */
function findMaxPairableShares(upAsks: DepthLevel[], downAsks: DepthLevel[]): number {
  if (upAsks.length === 0 || downAsks.length === 0) return 0;
  
  // Binary search for max shares where edge > 0
  let low = 1;
  let high = Math.min(
    upAsks[upAsks.length - 1]?.cumulativeSize ?? 0,
    downAsks[downAsks.length - 1]?.cumulativeSize ?? 0
  );
  
  if (high === 0) return 0;
  
  let maxProfitable = 0;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const analysis = analyzeDepthForPairing(upAsks, downAsks, mid);
    
    if (analysis.edge > 0) {
      maxProfitable = mid;
      low = mid + 1;  // Try to find more
    } else {
      high = mid - 1;  // Too much, reduce
    }
  }
  
  return maxProfitable;
}

// ============================================================
// QUOTE GENERATION FROM COMBINED BOOK
// ============================================================

export interface CombinedQuote {
  side: V35Side;
  price: number;
  size: number;
  expectedEdge: number;  // Edge if this order fills and we can hedge
  priority: number;      // Higher = more important
}

export interface QuotingDecision {
  upQuotes: CombinedQuote[];
  downQuotes: CombinedQuote[];
  totalUpSize: number;
  totalDownSize: number;
  reasoning: string;
  blocked: boolean;
  blockReason: string | null;
}

/**
 * Generate quotes based on combined book analysis
 * Only quote when there's edge (combined ask < $1.00)
 */
export function generateCombinedQuotes(
  book: CombinedBook,
  config: {
    minEdge: number;           // Minimum edge to quote (e.g., 0.02 = 2%)
    maxSharesPerSide: number;  // Max shares to quote per side
    numLevels: number;         // Number of price levels
    levelStep: number;         // Step between levels (e.g., 0.01)
    minSharesPerLevel: number; // Minimum shares per level
  }
): QuotingDecision {
  const { minEdge, maxSharesPerSide, numLevels, levelStep, minSharesPerLevel } = config;
  
  // Check if there's any edge
  if (!book.hasEdge || book.edge < minEdge) {
    return {
      upQuotes: [],
      downQuotes: [],
      totalUpSize: 0,
      totalDownSize: 0,
      reasoning: `No edge: combined ask $${book.combinedBestAsk.toFixed(3)} (edge: ${(book.edge * 100).toFixed(1)}¢ < min ${(minEdge * 100).toFixed(0)}¢)`,
      blocked: true,
      blockReason: 'NO_EDGE',
    };
  }
  
  // Check liquidity
  if (!book.isLiquid) {
    return {
      upQuotes: [],
      downQuotes: [],
      totalUpSize: 0,
      totalDownSize: 0,
      reasoning: 'Market not liquid enough',
      blocked: true,
      blockReason: 'LOW_LIQUIDITY',
    };
  }
  
  const upQuotes: CombinedQuote[] = [];
  const downQuotes: CombinedQuote[] = [];
  
  // Calculate how many shares we can profitably buy based on depth
  const profitableShares = Math.min(book.maxPairableShares, maxSharesPerSide);
  
  if (profitableShares < minSharesPerLevel) {
    return {
      upQuotes: [],
      downQuotes: [],
      totalUpSize: 0,
      totalDownSize: 0,
      reasoning: `Insufficient profitable depth: ${profitableShares} shares`,
      blocked: true,
      blockReason: 'LOW_DEPTH',
    };
  }
  
  // Distribute shares across levels
  const sharesPerLevel = Math.max(minSharesPerLevel, Math.floor(profitableShares / numLevels));
  
  // Generate UP quotes: bid below the current best ask
  for (let i = 0; i < numLevels; i++) {
    const price = Math.round((book.optimalUpBid - i * levelStep) * 100) / 100;
    if (price < 0.05 || price > 0.95) continue;
    
    // Calculate expected edge if we fill at this price
    const expectedCombinedCost = price + book.down.bestAsk;
    const expectedEdge = 1.0 - expectedCombinedCost;
    
    if (expectedEdge < minEdge) continue;  // Skip if no edge at this price
    
    upQuotes.push({
      side: 'UP',
      price,
      size: sharesPerLevel,
      expectedEdge,
      priority: expectedEdge * 100,  // Higher edge = higher priority
    });
  }
  
  // Generate DOWN quotes: bid below the current best ask
  for (let i = 0; i < numLevels; i++) {
    const price = Math.round((book.optimalDownBid - i * levelStep) * 100) / 100;
    if (price < 0.05 || price > 0.95) continue;
    
    // Calculate expected edge if we fill at this price
    const expectedCombinedCost = book.up.bestAsk + price;
    const expectedEdge = 1.0 - expectedCombinedCost;
    
    if (expectedEdge < minEdge) continue;
    
    downQuotes.push({
      side: 'DOWN',
      price,
      size: sharesPerLevel,
      expectedEdge,
      priority: expectedEdge * 100,
    });
  }
  
  const totalUpSize = upQuotes.reduce((sum, q) => sum + q.size, 0);
  const totalDownSize = downQuotes.reduce((sum, q) => sum + q.size, 0);
  
  return {
    upQuotes,
    downQuotes,
    totalUpSize,
    totalDownSize,
    reasoning: `Edge ${(book.edge * 100).toFixed(1)}¢ | Quoting ${upQuotes.length} UP + ${downQuotes.length} DOWN levels | ${profitableShares} profitable shares`,
    blocked: false,
    blockReason: null,
  };
}

// ============================================================
// LOGGING HELPERS
// ============================================================

export function logCombinedBook(book: CombinedBook, asset: string): void {
  const edgeColor = book.hasEdge ? '🟢' : '🔴';
  
  console.log(`\n${edgeColor} [CombinedBook] ${asset} @ ${new Date(book.timestamp).toISOString().slice(11, 19)}`);
  console.log(`   UP:   bid $${book.up.bestBid.toFixed(2)} / ask $${book.up.bestAsk.toFixed(2)} | spread ${(book.up.spreadPct).toFixed(1)}%`);
  console.log(`   DOWN: bid $${book.down.bestBid.toFixed(2)} / ask $${book.down.bestAsk.toFixed(2)} | spread ${(book.down.spreadPct).toFixed(1)}%`);
  console.log(`   COMBINED: ask $${book.combinedBestAsk.toFixed(3)} | EDGE: ${(book.edge * 100).toFixed(1)}¢ (${(book.edgePct).toFixed(2)}%)`);
  console.log(`   DEPTH: ${book.maxPairableShares} profitable shares | Liquid: ${book.isLiquid} | Balanced: ${book.isBalanced}`);
  console.log(`   VWAP@10: $${book.avgCombinedAskAt10.toFixed(3)} | @25: $${book.avgCombinedAskAt25.toFixed(3)} | @50: $${book.avgCombinedAskAt50.toFixed(3)}`);
}
