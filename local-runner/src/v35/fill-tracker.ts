// ============================================================
// V35 FILL TRACKER
// ============================================================
// Tracks fills from Polymarket WebSocket or polling.
// Updates market inventory when fills occur.
//
// NOTE: FillSyncTracker DISABLED per gabagool strategy:
// "NEVER filter based on momentum - reduces fills"
// "ALWAYS quote both sides - temporary imbalance is OK"
// ============================================================

import type { V35Market, V35Fill, V35Side, V35Asset } from './types.js';
import { sendHeartbeat } from '../backend.js';

type FillCallback = (fill: V35Fill) => void;

/**
 * Process a fill event and update market inventory
 */
export function processFill(
  fill: V35Fill,
  markets: Map<string, V35Market>
): boolean {
  // Find the market by token ID
  for (const market of markets.values()) {
    if (fill.tokenId === market.upTokenId) {
      market.upQty += fill.size;
      market.upCost += fill.size * fill.price;
      market.upFills++;
      
      // FillSyncTracker DISABLED - gabagool strategy says to always quote both sides
      // fillSyncTracker.recordFill('UP', fill.size, fill.price, market.slug);
      
      console.log(`📥 FILL: UP ${fill.size.toFixed(0)} @ $${fill.price.toFixed(2)} in ${market.slug.slice(-25)} | Total: ${market.upQty.toFixed(0)} UP`);
      return true;
    }
    
    if (fill.tokenId === market.downTokenId) {
      market.downQty += fill.size;
      market.downCost += fill.size * fill.price;
      market.downFills++;
      
      // FillSyncTracker DISABLED - gabagool strategy says to always quote both sides
      // fillSyncTracker.recordFill('DOWN', fill.size, fill.price, market.slug);
      
      console.log(`📥 FILL: DOWN ${fill.size.toFixed(0)} @ $${fill.price.toFixed(2)} in ${market.slug.slice(-25)} | Total: ${market.downQty.toFixed(0)} DOWN`);
      return true;
    }
  }
  
  console.warn(`[FillTracker] Unknown token ID: ${fill.tokenId.slice(0, 20)}...`);
  return false;
}

/**
 * Simulate a fill for dry run mode
 */
export function simulateFill(
  market: V35Market,
  side: V35Side,
  price: number,
  size: number
): V35Fill {
  const fill: V35Fill = {
    orderId: `SIM_${Date.now()}`,
    tokenId: side === 'UP' ? market.upTokenId : market.downTokenId,
    side,
    price,
    size,
    timestamp: new Date(),
    marketSlug: market.slug,
    asset: market.asset,
  };
  
  // Update inventory
  if (side === 'UP') {
    market.upQty += size;
    market.upCost += size * price;
    market.upFills++;
  } else {
    market.downQty += size;
    market.downCost += size * price;
    market.downFills++;
  }
  
  return fill;
}

/**
 * Calculate market metrics for logging
 */
export function logMarketFillStats(market: V35Market): void {
  const paired = Math.min(market.upQty, market.downQty);
  const unpaired = Math.abs(market.upQty - market.downQty);
  
  const avgUp = market.upQty > 0 ? market.upCost / market.upQty : 0;
  const avgDown = market.downQty > 0 ? market.downCost / market.downQty : 0;
  const combined = (market.upQty > 0 && market.downQty > 0) ? avgUp + avgDown : 0;
  
  const profit = combined > 0 && combined < 1 ? paired * (1 - combined) : 0;
  
  console.log(
    `📊 ${market.slug.slice(-25)} | ` +
    `UP:${market.upQty.toFixed(0)} DOWN:${market.downQty.toFixed(0)} | ` +
    `Paired:${paired.toFixed(0)} | ` +
    `Combined:$${combined.toFixed(3)} | ` +
    `Locked:$${profit.toFixed(2)}`
  );
}
