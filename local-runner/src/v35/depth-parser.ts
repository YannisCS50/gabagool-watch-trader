// ============================================================
// V36 DEPTH PARSER - FULL ORDERBOOK EXTRACTION
// ============================================================
// Version: V36.0.0 - "Professional Market Making"
//
// Extracts FULL orderbook depth from CLOB WebSocket events.
// Previously we only used bestBid/bestAsk, now we parse all levels.
//
// The CLOB WebSocket sends 'book' events with this structure:
// {
//   event_type: 'book',
//   asset_id: 'token-id',
//   bids: [[price, size], ...],  // or [{price, size}, ...]
//   asks: [[price, size], ...],
// }
// ============================================================

import type { V35OrderbookLevel } from './types.js';

// ============================================================
// TYPES
// ============================================================

export interface ParsedDepth {
  bids: V35OrderbookLevel[];  // Sorted DESC (best first)
  asks: V35OrderbookLevel[];  // Sorted ASC (best first)
  bestBid: number;
  bestAsk: number;
  bidDepth: number;           // Total bid size
  askDepth: number;           // Total ask size
  levels: number;             // Total number of levels
}

export interface ClobBookEvent {
  event_type: 'book';
  asset_id: string;
  hash?: string;
  timestamp?: number;
  bids?: any[];
  asks?: any[];
}

// ============================================================
// PARSING
// ============================================================

/**
 * Parse a single level from CLOB data
 * Handles multiple formats:
 * - Array: [price, size]
 * - Object: {price, size} or {p, s}
 */
function parseLevel(raw: any): V35OrderbookLevel | null {
  if (!raw) return null;
  
  let price: number;
  let size: number;
  
  if (Array.isArray(raw)) {
    // Format: [price, size]
    price = parseFloat(raw[0]);
    size = parseFloat(raw[1]);
  } else if (typeof raw === 'object') {
    // Format: {price, size} or {p, s}
    price = parseFloat(raw.price ?? raw.p ?? 0);
    size = parseFloat(raw.size ?? raw.s ?? raw.quantity ?? raw.q ?? 0);
  } else {
    return null;
  }
  
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
    return null;
  }
  
  return { price, size };
}

/**
 * Parse full orderbook depth from CLOB 'book' event
 */
export function parseBookEvent(event: ClobBookEvent): ParsedDepth {
  const rawBids = event.bids || [];
  const rawAsks = event.asks || [];
  
  // Parse and filter valid levels
  const bids: V35OrderbookLevel[] = [];
  const asks: V35OrderbookLevel[] = [];
  
  for (const raw of rawBids) {
    const level = parseLevel(raw);
    if (level) bids.push(level);
  }
  
  for (const raw of rawAsks) {
    const level = parseLevel(raw);
    if (level) asks.push(level);
  }
  
  // Sort: bids DESC (highest first), asks ASC (lowest first)
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  
  // Extract best prices
  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const bestAsk = asks.length > 0 ? asks[0].price : 1;
  
  // Calculate total depth
  const bidDepth = bids.reduce((sum, l) => sum + l.size, 0);
  const askDepth = asks.reduce((sum, l) => sum + l.size, 0);
  
  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    bidDepth,
    askDepth,
    levels: bids.length + asks.length,
  };
}

/**
 * Extract only the best N levels for efficiency
 */
export function getTopLevels(depth: ParsedDepth, n: number): ParsedDepth {
  return {
    ...depth,
    bids: depth.bids.slice(0, n),
    asks: depth.asks.slice(0, n),
    levels: Math.min(n, depth.bids.length) + Math.min(n, depth.asks.length),
  };
}

/**
 * Calculate depth available at a given price or better
 */
export function getDepthAtPrice(levels: V35OrderbookLevel[], targetPrice: number, isBid: boolean): number {
  let total = 0;
  
  for (const level of levels) {
    if (isBid) {
      // For bids, count levels >= targetPrice
      if (level.price >= targetPrice) {
        total += level.size;
      }
    } else {
      // For asks, count levels <= targetPrice
      if (level.price <= targetPrice) {
        total += level.size;
      }
    }
  }
  
  return total;
}

/**
 * Calculate VWAP (Volume Weighted Average Price) for a target size
 */
export function calculateVWAPForSize(levels: V35OrderbookLevel[], targetSize: number): {
  vwap: number;
  filledSize: number;
  levelsUsed: number;
  worstPrice: number;
} {
  let remaining = targetSize;
  let totalCost = 0;
  let levelsUsed = 0;
  let worstPrice = levels[0]?.price ?? 0;
  
  for (const level of levels) {
    if (remaining <= 0) break;
    
    const fillSize = Math.min(remaining, level.size);
    totalCost += fillSize * level.price;
    remaining -= fillSize;
    levelsUsed++;
    worstPrice = level.price;
  }
  
  const filledSize = targetSize - remaining;
  const vwap = filledSize > 0 ? totalCost / filledSize : 0;
  
  return { vwap, filledSize, levelsUsed, worstPrice };
}

/**
 * Log depth summary for debugging
 */
export function logDepthSummary(tokenId: string, side: string, depth: ParsedDepth): void {
  const topBids = depth.bids.slice(0, 3).map(l => `$${l.price.toFixed(2)}:${l.size.toFixed(0)}`).join(' ');
  const topAsks = depth.asks.slice(0, 3).map(l => `$${l.price.toFixed(2)}:${l.size.toFixed(0)}`).join(' ');
  
  console.log(`[Depth] ${side} | Bids: ${topBids} | Asks: ${topAsks} | Total: ${depth.levels} levels`);
}
