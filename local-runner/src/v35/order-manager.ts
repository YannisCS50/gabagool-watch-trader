// ============================================================
// V35 ORDER MANAGER
// ============================================================
// Handles order placement, cancellation, and sync with target grid.
// Uses the existing polymarket.ts client for CLOB operations.
//
// OPTIMIZED: Places all orders in parallel for maximum speed.
// ============================================================

import { getV35Config } from './config.js';
import type { V35Market, V35Order, V35Quote, V35Side } from './types.js';
import { getOrderbookDepth, placeOrder, cancelOrder } from '../polymarket.js';

interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  price?: number;
  size?: number;
}

// Concurrency limit for parallel order placement
const MAX_CONCURRENT_ORDERS = 10;

/**
 * Sync orders for one side of a market to match target quotes
 * OPTIMIZED: Places all new orders in parallel batches
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
  let cancelled = 0;
  
  // 1. Cancel orders that are no longer in target (parallel)
  const ordersToCancel = [...currentOrders.entries()]
    .filter(([_, order]) => !targetPrices.has(order.price));
  
  if (ordersToCancel.length > 0) {
    const cancelPromises = ordersToCancel.map(async ([orderId, _]) => {
      if (dryRun) {
        return { orderId, success: true };
      }
      try {
        const res = await cancelOrder(orderId);
        return { orderId, success: res?.success ?? false, error: res?.error };
      } catch (err: any) {
        return { orderId, success: false, error: err?.message };
      }
    });
    
    const cancelResults = await Promise.all(cancelPromises);
    for (const result of cancelResults) {
      if (result.success) {
        currentOrders.delete(result.orderId);
        cancelled++;
      } else {
        console.warn(`[OrderManager] Cancel failed for ${result.orderId}: ${result.error}`);
      }
    }
  }
  
  // 2. Find quotes that need new orders
  const currentPrices = new Set([...currentOrders.values()].map(o => o.price));
  const quotesToPlace = targetQuotes.filter(q => !currentPrices.has(q.price));
  
  if (quotesToPlace.length === 0) {
    return { placed: 0, cancelled };
  }
  
  // 3. Place all new orders in parallel batches
  console.log(`[OrderManager] 🚀 Placing ${quotesToPlace.length} ${side} orders in parallel...`);
  
  let placed = 0;
  
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < quotesToPlace.length; i += MAX_CONCURRENT_ORDERS) {
    const batch = quotesToPlace.slice(i, i + MAX_CONCURRENT_ORDERS);
    
    const placePromises = batch.map(quote => 
      placeOrderWithRetry(tokenId, quote.price, quote.size, market.slug, side, dryRun)
    );
    
    const results = await Promise.all(placePromises);
    
    for (const result of results) {
      if (result.success && result.orderId) {
        const newOrder: V35Order = {
          orderId: result.orderId,
          price: result.price!,
          size: result.size!,
          side,
          placedAt: new Date(),
        };
        currentOrders.set(result.orderId, newOrder);
        placed++;
      }
    }
  }
  
  console.log(`[OrderManager] ✅ Placed ${placed}/${quotesToPlace.length} ${side} orders`);
  
  return { placed, cancelled };
}

/**
 * Place an order with basic retry logic
 * Returns price/size for tracking after parallel placement
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
    return { success: true, orderId, price, size };
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
      console.log(`[OrderManager] ✓ ${side} ${size} @ $${price.toFixed(2)} → ${result.orderId.slice(0, 8)}...`);
      return { success: true, orderId: result.orderId, price, size };
    }
    
    return { success: false, error: result.error || 'Unknown error', price, size };
  } catch (err: any) {
    console.error(`[OrderManager] Place failed @ $${price.toFixed(2)}:`, err?.message?.slice(0, 50));
    return { success: false, error: err?.message, price, size };
  }
}

/**
 * Cancel all orders for a market
 * OPTIMIZED: Cancels all orders in parallel
 */
export async function cancelAllOrders(market: V35Market, dryRun: boolean): Promise<number> {
  const allOrderIds = [
    ...([...market.upOrders.keys()].map(id => ({ id, side: 'UP' as const }))),
    ...([...market.downOrders.keys()].map(id => ({ id, side: 'DOWN' as const }))),
  ];
  
  if (allOrderIds.length === 0) {
    return 0;
  }
  
  if (dryRun) {
    market.upOrders.clear();
    market.downOrders.clear();
    return allOrderIds.length;
  }
  
  console.log(`[OrderManager] 🗑️ Cancelling ${allOrderIds.length} orders in parallel...`);
  
  const cancelPromises = allOrderIds.map(async ({ id, side }) => {
    try {
      const res = await cancelOrder(id);
      return { id, side, success: res?.success ?? false, error: res?.error };
    } catch (err: any) {
      return { id, side, success: false, error: err?.message };
    }
  });
  
  const results = await Promise.all(cancelPromises);
  let cancelled = 0;
  
  for (const result of results) {
    if (result.success) {
      if (result.side === 'UP') {
        market.upOrders.delete(result.id);
      } else {
        market.downOrders.delete(result.id);
      }
      cancelled++;
    } else {
      console.warn(`[OrderManager] CancelAll ${result.side} failed for ${result.id}: ${result.error}`);
    }
  }
  
  console.log(`[OrderManager] ✅ Cancelled ${cancelled}/${allOrderIds.length} orders`);
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
