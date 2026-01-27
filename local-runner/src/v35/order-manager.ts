// ============================================================
// V35 ORDER MANAGER
// ============================================================
// Handles order placement, cancellation, and sync with target grid.
// Uses the existing polymarket.ts client for CLOB operations.
// ============================================================

import { getV35Config } from './config.js';
import type { V35Market, V35Order, V35Quote, V35Side } from './types.js';
import { getOrderbookDepth, placeOrder, cancelOrder } from '../polymarket.js';

interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
}

/**
 * Sync orders for one side of a market to match target quotes
 */
export async function syncOrders(
  market: V35Market,
  side: V35Side,
  targetQuotes: V35Quote[],
  dryRun: boolean
): Promise<{ placed: number; cancelled: number }> {
  const currentOrders = side === 'UP' ? market.upOrders : market.downOrders;
  const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
  
  const targetPrices = new Set(targetQuotes.map(q => q.price));
  let placed = 0;
  let cancelled = 0;
  
  // 1. Cancel orders that are no longer in target
  for (const [orderId, order] of currentOrders.entries()) {
    if (!targetPrices.has(order.price)) {
      if (dryRun) {
        currentOrders.delete(orderId);
        cancelled++;
        continue;
      }

      try {
        const res = await cancelOrder(orderId);

        // CRITICAL: only delete from local state if we actually cancelled.
        // If we delete on failure, fills can still happen on Polymarket but we'll never match them.
        if (res?.success) {
          currentOrders.delete(orderId);
          cancelled++;
        } else {
          console.warn(
            `[OrderManager] Cancel returned failure for ${orderId} (keeping in map so fills still match):`,
            res?.error || 'unknown error'
          );
        }
      } catch (err: any) {
        console.warn(
          `[OrderManager] Cancel threw for ${orderId} (keeping in map so fills still match):`,
          err?.message
        );
      }
    }
  }
  
  // 2. Place new orders for prices not covered
  const currentPrices = new Set([...currentOrders.values()].map(o => o.price));
  
  for (const quote of targetQuotes) {
    if (currentPrices.has(quote.price)) {
      continue; // Already have order at this price
    }
    
    const result = await placeOrderWithRetry(tokenId, quote.price, quote.size, market.slug, side, dryRun);
    
    if (result.success && result.orderId) {
      const newOrder: V35Order = {
        orderId: result.orderId,
        price: quote.price,
        size: quote.size,
        side,
        placedAt: new Date(),
      };
      currentOrders.set(result.orderId, newOrder);
      placed++;
    }
  }
  
  return { placed, cancelled };
}

/**
 * Place an order with basic retry logic
 */
async function placeOrderWithRetry(
  tokenId: string,
  price: number,
  size: number,
  marketSlug: string,
  side: V35Side,
  dryRun: boolean
): Promise<PlaceOrderResult> {
  if (dryRun) {
    const orderId = `DRY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[DRY] Place ${side} ${size} @ $${price.toFixed(2)} on ${marketSlug.slice(-25)}`);
    return { success: true, orderId };
  }
  
  try {
    const result = await placeOrder({
      tokenId,
      side: 'BUY', // V35 always places BUY orders
      price,
      size,
      orderType: 'GTC',
    });
    
    if (result.success && result.orderId) {
      console.log(`[OrderManager] Placed ${side} ${size} @ $${price.toFixed(2)} → ${result.orderId.slice(0, 12)}...`);
      return { success: true, orderId: result.orderId };
    }
    
    return { success: false, error: result.error || 'Unknown error' };
  } catch (err: any) {
    console.error(`[OrderManager] Place failed:`, err?.message);
    return { success: false, error: err?.message };
  }
}

/**
 * Cancel all orders for a market
 */
export async function cancelAllOrders(market: V35Market, dryRun: boolean): Promise<number> {
  let cancelled = 0;

  // NOTE: Only remove from local state if cancellation succeeded.
  // If cancel fails, keep the order so a subsequent fill can still be detected + persisted.
  for (const orderId of [...market.upOrders.keys()]) {
    if (dryRun) {
      market.upOrders.delete(orderId);
      cancelled++;
      continue;
    }
    try {
      const res = await cancelOrder(orderId);
      if (res?.success) {
        market.upOrders.delete(orderId);
        cancelled++;
      } else {
        console.warn(`[OrderManager] CancelAll UP failed for ${orderId}:`, res?.error || 'unknown error');
      }
    } catch (err: any) {
      console.warn(`[OrderManager] CancelAll UP threw for ${orderId}:`, err?.message);
    }
  }

  for (const orderId of [...market.downOrders.keys()]) {
    if (dryRun) {
      market.downOrders.delete(orderId);
      cancelled++;
      continue;
    }
    try {
      const res = await cancelOrder(orderId);
      if (res?.success) {
        market.downOrders.delete(orderId);
        cancelled++;
      } else {
        console.warn(`[OrderManager] CancelAll DOWN failed for ${orderId}:`, res?.error || 'unknown error');
      }
    } catch (err: any) {
      console.warn(`[OrderManager] CancelAll DOWN threw for ${orderId}:`, err?.message);
    }
  }
  
  return cancelled;
}

/**
 * Update orderbook data for a market
 */
export async function updateOrderbook(market: V35Market, dryRun: boolean): Promise<void> {
  if (dryRun) {
    // Simulate orderbook in dry run
    market.upBestBid = 0.48;
    market.upBestAsk = 0.52;
    market.downBestBid = 0.48;
    market.downBestAsk = 0.52;
    return;
  }
  
  try {
    const upDepth = await getOrderbookDepth(market.upTokenId);
    if (upDepth.topBid !== null) market.upBestBid = upDepth.topBid;
    if (upDepth.topAsk !== null) market.upBestAsk = upDepth.topAsk;
    
    const downDepth = await getOrderbookDepth(market.downTokenId);
    if (downDepth.topBid !== null) market.downBestBid = downDepth.topBid;
    if (downDepth.topAsk !== null) market.downBestAsk = downDepth.topAsk;
    
    market.lastUpdated = new Date();
  } catch (err: any) {
    console.warn(`[OrderManager] Orderbook update failed:`, err?.message);
  }
}
