/**
 * ORDER GUARD - Central authorization for real order placement
 * 
 * ONLY v29-response (V29R) is authorized to place real orders.
 * All other runners can log, monitor, and simulate, but cannot spend real money.
 */

// Runners authorized to place real orders
const AUTHORIZED_RUNNERS = ['v29-response', 'v35'];

// Current runner context - must be set at startup
let currentRunner: string | null = null;

/**
 * Set the current runner identity. Must be called at runner startup.
 */
export function setRunnerIdentity(runnerId: string): void {
  currentRunner = runnerId;
  console.log(`[ORDER-GUARD] Runner identity set to: ${runnerId}`);
  if (!AUTHORIZED_RUNNERS.includes(runnerId)) {
    console.log(`[ORDER-GUARD] ⚠️  WARNING: This runner (${runnerId}) is NOT authorized to place real orders!`);
    console.log(`[ORDER-GUARD] ⚠️  Only ${AUTHORIZED_RUNNERS.join(', ')} can execute trades. Orders will be BLOCKED.`);
  } else {
    console.log(`[ORDER-GUARD] ✅ This runner is authorized to place real orders.`);
  }
}

/**
 * Check if the current runner is authorized to place real orders.
 * Returns true only for v29-response.
 */
export function isOrderAuthorized(): boolean {
  return currentRunner !== null && AUTHORIZED_RUNNERS.includes(currentRunner);
}

/**
 * Get the current runner identity
 */
export function getRunnerIdentity(): string | null {
  return currentRunner;
}

/**
 * Guard function to call before any order placement.
 * Throws an error if the runner is not authorized.
 * 
 * @param orderDetails - Description of the order for logging
 * @returns true if authorized, throws otherwise
 */
export function guardOrderPlacement(orderDetails: string): boolean {
  if (!currentRunner) {
    console.error(`[ORDER-GUARD] ❌ BLOCKED: No runner identity set! Cannot place order.`);
    console.error(`[ORDER-GUARD] Order details: ${orderDetails}`);
    throw new Error('ORDER_GUARD: Runner identity not set. Call setRunnerIdentity() at startup.');
  }
  
  if (!AUTHORIZED_RUNNERS.includes(currentRunner)) {
    console.log(`[ORDER-GUARD] 🚫 BLOCKED ORDER from ${currentRunner}:`);
    console.log(`[ORDER-GUARD]    ${orderDetails}`);
    console.log(`[ORDER-GUARD]    Only ${AUTHORIZED_RUNNERS.join(', ')} can place real orders.`);
    throw new Error(`ORDER_GUARD: Runner '${currentRunner}' is not authorized to place orders. Only ${AUTHORIZED_RUNNERS.join(', ')} can trade.`);
  }
  
  return true;
}

/**
 * Log an order that would have been placed (for shadow/simulation modes)
 */
export function logBlockedOrder(orderDetails: string): void {
  console.log(`[ORDER-GUARD] 📝 SHADOW ORDER (not executed):`);
  console.log(`[ORDER-GUARD]    Runner: ${currentRunner ?? 'unknown'}`);
  console.log(`[ORDER-GUARD]    ${orderDetails}`);
}
