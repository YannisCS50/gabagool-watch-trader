/**
 * v7.4.0: Stale Order Cleanup
 * 
 * Periodically fetches placed orders that have been resting too long
 * and cancels them to prevent surprise exposure in the orderbook.
 */

import { fetchStalePlacedOrders, updateOrder, saveBotEvent, StalePlacedOrder } from './backend.js';
import { cancelOrder } from './polymarket.js';
import { onCancelOpen } from './exposure-ledger.js';

// Configuration
export const STALE_CLEANUP_CONFIG = {
  // How often to check for stale orders (ms)
  intervalMs: 3_000,
  // TTL for entry-type orders
  entryTtlMs: 20_000,
  // TTL for hedge-type orders (more aggressive)
  hedgeTtlMs: 10_000,
  // Max cancel attempts per order
  maxCancelAttempts: 3,
  // Enable cleanup
  enabled: true,
};

// Track cancel attempts per order
const cancelAttempts = new Map<string, number>();

// Stats
let totalCancelled = 0;
let totalCancelFailed = 0;

export function getStaleCleanupStats() {
  return {
    totalCancelled,
    totalCancelFailed,
    pendingCancelAttempts: cancelAttempts.size,
  };
}

/**
 * Process a single stale order - attempt to cancel it
 */
async function processStaleOrder(order: StalePlacedOrder, runId: string): Promise<boolean> {
  const attempts = (cancelAttempts.get(order.id) ?? 0) + 1;
  cancelAttempts.set(order.id, attempts);

  const ageMs = order.executed_at 
    ? Date.now() - new Date(order.executed_at).getTime() 
    : 0;

  console.log(`🕐 [v7.4.0] STALE_ORDER_DETECTED: ${order.asset} ${order.outcome} ${order.shares}@${(order.price * 100).toFixed(0)}¢ (age: ${Math.floor(ageMs / 1000)}s, attempt ${attempts})`);

  // Log the detection event
  await saveBotEvent({
    event_type: 'ORDER_STALE_DETECTED',
    asset: order.asset,
    market_id: order.market_slug,
    run_id: runId,
    data: {
      orderQueueId: order.id,
      exchangeOrderId: order.order_id,
      outcome: order.outcome,
      shares: order.shares,
      price: order.price,
      intentType: order.intent_type,
      ageMs,
      cancelAttempt: attempts,
    },
    ts: Date.now(),
  });

  // Attempt cancellation
  console.log(`🚫 [v7.4.0] ORDER_CANCEL_ATTEMPT: ${order.order_id}`);
  
  const cancelResult = await cancelOrder(order.order_id);

  if (cancelResult.success) {
    console.log(`✅ [v7.4.0] ORDER_CANCELLED: ${order.order_id}`);
    totalCancelled++;

    // Update order_queue status
    await updateOrder(order.id, 'cancelled', { error: 'Stale order auto-cancelled' });

    // Release exposure from ledger
    onCancelOpen(order.market_slug, order.asset, order.outcome as 'UP' | 'DOWN', order.shares);

    // Log success event
    await saveBotEvent({
      event_type: 'ORDER_CANCELLED',
      asset: order.asset,
      market_id: order.market_slug,
      run_id: runId,
      reason_code: 'STALE_CLEANUP',
      data: {
        orderQueueId: order.id,
        exchangeOrderId: order.order_id,
        ageMs,
      },
      ts: Date.now(),
    });

    // Clean up tracking
    cancelAttempts.delete(order.id);
    return true;
  } else {
    console.error(`❌ [v7.4.0] ORDER_CANCEL_FAILED: ${order.order_id} - ${cancelResult.error}`);
    totalCancelFailed++;

    // Log failure event
    await saveBotEvent({
      event_type: 'ORDER_CANCEL_FAILED',
      asset: order.asset,
      market_id: order.market_slug,
      run_id: runId,
      reason_code: cancelResult.error?.slice(0, 50) || 'UNKNOWN',
      data: {
        orderQueueId: order.id,
        exchangeOrderId: order.order_id,
        error: cancelResult.error,
        attempt: attempts,
        maxAttempts: STALE_CLEANUP_CONFIG.maxCancelAttempts,
      },
      ts: Date.now(),
    });

    // If max attempts reached, mark as failed and stop retrying
    if (attempts >= STALE_CLEANUP_CONFIG.maxCancelAttempts) {
      console.error(`🚨 [v7.4.0] MAX_CANCEL_ATTEMPTS: Giving up on ${order.order_id}`);
      await updateOrder(order.id, 'failed', { error: `Cancel failed after ${attempts} attempts: ${cancelResult.error}` });
      cancelAttempts.delete(order.id);
    }

    return false;
  }
}

/**
 * Run one cleanup cycle - fetch stale orders and cancel them
 */
export async function runStaleCleanupCycle(runId: string): Promise<void> {
  if (!STALE_CLEANUP_CONFIG.enabled) return;

  try {
    const staleOrders = await fetchStalePlacedOrders(
      STALE_CLEANUP_CONFIG.entryTtlMs,
      STALE_CLEANUP_CONFIG.hedgeTtlMs
    );

    if (staleOrders.length === 0) return;

    console.log(`🕐 [v7.4.0] STALE_CLEANUP: Found ${staleOrders.length} stale orders to cancel`);

    for (const order of staleOrders) {
      await processStaleOrder(order, runId);
      // Small delay between cancellations to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (error: any) {
    console.error(`❌ [v7.4.0] Stale cleanup cycle error: ${error?.message || error}`);
  }
}

// Interval handle for cleanup
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the stale order cleanup loop
 */
export function startStaleCleanupLoop(runId: string): void {
  if (cleanupInterval) {
    console.warn('[v7.4.0] Stale cleanup loop already running');
    return;
  }

  console.log(`🧹 [v7.4.0] Starting stale order cleanup loop (interval: ${STALE_CLEANUP_CONFIG.intervalMs}ms)`);
  
  cleanupInterval = setInterval(() => {
    runStaleCleanupCycle(runId).catch(err => {
      console.error('[v7.4.0] Stale cleanup error:', err);
    });
  }, STALE_CLEANUP_CONFIG.intervalMs);
}

/**
 * Stop the stale order cleanup loop
 */
export function stopStaleCleanupLoop(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🧹 [v7.4.0] Stale order cleanup loop stopped');
  }
}
