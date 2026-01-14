/**
 * V29 Trading Functions
 * 
 * Uses pre-signed orders for maximum speed (same as v28)
 * Orders are signed during idle time and instantly posted when signals fire
 */

import { getClient } from '../polymarket.js';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import type { SignedOrder } from '@polymarket/order-utils';
import type { Asset } from './config.js';
import { logFillsBatch, type FillRecord } from './db.js';

// Global context for fill logging (set by caller)
let currentFillContext: {
  runId: string;
  signalId?: string;
  marketSlug: string;
} | null = null;

export function setFillContext(ctx: { runId: string; signalId?: string; marketSlug: string }): void {
  currentFillContext = ctx;
}

export function clearFillContext(): void {
  currentFillContext = null;
}

function log(msg: string): void {
  console.log(`[V29:Trade] ${msg}`);
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  latencyMs: number;
}

// ============================================
// PRE-SIGNED ORDER CACHE
// ============================================

interface PreSignedOrder {
  signedOrder: SignedOrder;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  signedAt: number;
  asset: Asset;
  direction: 'UP' | 'DOWN';
}

interface MarketOrderSet {
  upToken: Map<string, PreSignedOrder>;    // key: `${price}-${size}`
  downToken: Map<string, PreSignedOrder>;  // key: `${price}-${size}`
  upTokenId: string;
  downTokenId: string;
  lastRefresh: number;
}

// Cache of pre-signed orders by asset
const orderCache = new Map<Asset, MarketOrderSet>();

// Configuration
const PRE_SIGN_CONFIG = {
  // Price levels to pre-sign (full range 30-75¢)
  priceLevels: [
    0.30, 0.32, 0.34, 0.36, 0.38, 0.40, 0.42, 0.44, 0.46, 0.48,
    0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.64, 0.66, 0.68,
    0.70, 0.72, 0.74, 0.75
  ],
  // Share sizes to pre-sign (just 5 for V29 simple strategy)
  shareSizes: [5],
  // Refresh every 2 minutes for fresher orders
  refreshIntervalMs: 2 * 60 * 1000,
  // Max age before order is considered stale
  maxOrderAgeMs: 10 * 60 * 1000,
};

let isInitialized = false;
let refreshInterval: NodeJS.Timeout | null = null;
let clobClient: ClobClient | null = null;

// Stats
const stats = {
  cacheHits: 0,
  cacheMisses: 0,
  avgSignTimeMs: 0,
};
const signTimes: number[] = [];

// ============================================
// PRE-SIGNING FUNCTIONS
// ============================================

async function preSignOrder(
  client: ClobClient,
  tokenId: string,
  side: 'BUY' | 'SELL',
  price: number,
  size: number,
  asset: Asset,
  direction: 'UP' | 'DOWN'
): Promise<PreSignedOrder | null> {
  const startTime = Date.now();
  
  try {
    if (!Number.isFinite(price) || price < 0.01 || price > 0.99) return null;
    if (!Number.isFinite(size) || size < 1) return null;
    
    // Sign order WITHOUT posting
    const signedOrder = await client.createOrder(
      {
        tokenID: tokenId,
        price: price,
        size: size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      },
      {
        tickSize: '0.01',
        negRisk: false,
      }
    );
    
    const signTime = Date.now() - startTime;
    signTimes.push(signTime);
    if (signTimes.length > 100) signTimes.shift();
    stats.avgSignTimeMs = signTimes.reduce((a, b) => a + b, 0) / signTimes.length;
    
    return {
      signedOrder,
      tokenId,
      side,
      price,
      size,
      signedAt: Date.now(),
      asset,
      direction,
    };
  } catch (err) {
    log(`❌ Pre-sign failed ${asset} ${direction} ${side} ${size}@${price}: ${err}`);
    return null;
  }
}

async function preSignMarketOrders(
  client: ClobClient,
  asset: Asset,
  upTokenId: string,
  downTokenId: string
): Promise<MarketOrderSet> {
  const startTime = Date.now();
  
  const orderSet: MarketOrderSet = {
    upToken: new Map(),
    downToken: new Map(),
    upTokenId,
    downTokenId,
    lastRefresh: Date.now(),
  };
  
  let signedCount = 0;
  
  for (const direction of ['UP', 'DOWN'] as const) {
    const tokenId = direction === 'UP' ? upTokenId : downTokenId;
    const tokenMap = direction === 'UP' ? orderSet.upToken : orderSet.downToken;
    
    for (const price of PRE_SIGN_CONFIG.priceLevels) {
      for (const size of PRE_SIGN_CONFIG.shareSizes) {
        const key = `${price.toFixed(2)}-${size}`;
        
        const preSignedOrder = await preSignOrder(
          client, tokenId, 'BUY', price, size, asset, direction
        );
        
        if (preSignedOrder) {
          tokenMap.set(key, preSignedOrder);
          signedCount++;
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  
  const duration = Date.now() - startTime;
  log(`${asset}: Pre-signed ${signedCount} orders in ${duration}ms`);
  
  return orderSet;
}

// ============================================
// CACHE INITIALIZATION
// ============================================

export async function initPreSignedCache(
  markets: Array<{
    asset: Asset;
    upTokenId: string;
    downTokenId: string;
  }>
): Promise<void> {
  log(`🔐 Initializing pre-signed cache for ${markets.length} markets...`);
  const startTime = Date.now();
  
  try {
    clobClient = await getClient();
    
    for (const market of markets) {
      const orderSet = await preSignMarketOrders(
        clobClient,
        market.asset,
        market.upTokenId,
        market.downTokenId
      );
      orderCache.set(market.asset, orderSet);
    }
    
    const duration = Date.now() - startTime;
    log(`✅ Pre-signed cache ready in ${duration}ms (avg ${stats.avgSignTimeMs.toFixed(1)}ms/order)`);
    
    isInitialized = true;
    startBackgroundRefresh();
  } catch (err) {
    log(`❌ Failed to init pre-signed cache: ${err}`);
  }
}

function startBackgroundRefresh(): void {
  if (refreshInterval) clearInterval(refreshInterval);
  
  refreshInterval = setInterval(async () => {
    if (!clobClient) return;
    
    log('🔄 Background refresh of pre-signed orders...');
    
    for (const [asset, orderSet] of orderCache) {
      try {
        const newOrderSet = await preSignMarketOrders(
          clobClient,
          asset,
          orderSet.upTokenId,
          orderSet.downTokenId
        );
        orderCache.set(asset, newOrderSet);
      } catch (err) {
        log(`❌ Refresh failed for ${asset}: ${err}`);
      }
    }
  }, PRE_SIGN_CONFIG.refreshIntervalMs);
}

export function stopPreSignedCache(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  orderCache.clear();
  isInitialized = false;
  log('Pre-signed cache stopped');
}

/**
 * Update cache for a specific asset when market changes
 * This is called when a new market is detected for an asset
 */
export async function updateMarketCache(
  asset: Asset,
  upTokenId: string,
  downTokenId: string
): Promise<void> {
  if (!clobClient) {
    log(`⚠️ Cannot update cache for ${asset}: no client`);
    return;
  }
  
  log(`🔐 Updating pre-signed cache for ${asset}...`);
  
  try {
    const orderSet = await preSignMarketOrders(
      clobClient,
      asset,
      upTokenId,
      downTokenId
    );
    orderCache.set(asset, orderSet);
    log(`✅ ${asset} cache updated with new market tokens`);
  } catch (err) {
    log(`❌ Failed to update cache for ${asset}: ${err}`);
  }
}

// ============================================
// FAST ORDER POSTING
// ============================================

function getPreSignedOrder(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  targetPrice: number,
  targetSize: number
): PreSignedOrder | null {
  if (!isInitialized) {
    stats.cacheMisses++;
    return null;
  }
  
  const orderSet = orderCache.get(asset);
  if (!orderSet) {
    stats.cacheMisses++;
    return null;
  }
  
  const tokenMap = direction === 'UP' ? orderSet.upToken : orderSet.downToken;
  
  // Try exact match first
  const exactKey = `${targetPrice.toFixed(2)}-${targetSize}`;
  const exactMatch = tokenMap.get(exactKey);
  
  if (exactMatch) {
    const age = Date.now() - exactMatch.signedAt;
    if (age < PRE_SIGN_CONFIG.maxOrderAgeMs) {
      stats.cacheHits++;
      return exactMatch;
    }
  }
  
  // Try to find closest price match with same or larger size
  let bestMatch: PreSignedOrder | null = null;
  let bestPriceDiff = Infinity;
  
  for (const [_key, order] of tokenMap) {
    if (order.size < targetSize) continue;
    
    const age = Date.now() - order.signedAt;
    if (age >= PRE_SIGN_CONFIG.maxOrderAgeMs) continue;
    
    if (order.price >= targetPrice) {
      const priceDiff = order.price - targetPrice;
      if (priceDiff < bestPriceDiff) {
        bestPriceDiff = priceDiff;
        bestMatch = order;
      }
    }
  }
  
  if (bestMatch) {
    stats.cacheHits++;
    return bestMatch;
  }
  
  stats.cacheMisses++;
  return null;
}

// ============================================
// BURST FILL CONFIGURATION
// ============================================

const BURST_FILL_CONFIG = {
  // Enable burst fill mode (parallel limit orders at different prices)
  enabled: true,
  // Number of parallel orders to fire
  burstCount: 3,
  // Shares per order (total = burstCount * sharesPerOrder)
  sharesPerOrder: 2,
  // Price step between orders (1¢)
  priceStepCents: 0.01,
  // How long to wait before checking fills (ms)
  fillCheckDelayMs: 50,
  // How long to wait for fill before canceling unfilled orders (ms)
  totalTimeoutMs: 200,
};

/**
 * Place a BUY order - uses BURST FILL mode for faster execution
 * 
 * BURST FILL MODE:
 * 1. Fire 3 parallel limit orders at different price levels:
 *    - Order 1: 2 shares @ bestAsk
 *    - Order 2: 2 shares @ bestAsk - 1¢
 *    - Order 3: 2 shares @ bestAsk - 2¢
 * 2. Wait ~50ms for fills
 * 3. Cancel any unfilled orders
 * 4. Return total filled shares
 * 
 * Benefits: ~40ms per order (parallel) vs 500ms market order delay
 * Risk: All 3 might fill = 6 shares, but that's acceptable
 */
export async function placeBuyOrder(
  tokenId: string,
  price: number,
  shares: number,
  asset?: Asset,
  direction?: 'UP' | 'DOWN'
): Promise<OrderResult> {
  const start = Date.now();
  
  try {
    const client = await getClient();
    const roundedShares = Math.floor(shares);
    
    if (roundedShares < 1) {
      return { success: false, error: 'Shares < 1', latencyMs: Date.now() - start };
    }
    
    // If burst fill is disabled, use simple order
    if (!BURST_FILL_CONFIG.enabled) {
      return await placeSingleBuyOrder(client, tokenId, price, roundedShares, asset, direction, start);
    }
    
    // BURST FILL MODE
    const { burstCount, sharesPerOrder, priceStepCents, fillCheckDelayMs, totalTimeoutMs } = BURST_FILL_CONFIG;
    
    log(`🚀 Burst fill: ${asset} ${direction} firing ${burstCount}x${sharesPerOrder} shares starting @ ${(price * 100).toFixed(1)}¢`);
    
    // Generate price levels for burst orders
    const priceLevels: number[] = [];
    let currentPrice = Math.round(price * 100) / 100;
    for (let i = 0; i < burstCount; i++) {
      priceLevels.push(Math.max(currentPrice, 0.01));
      currentPrice -= priceStepCents;
    }
    
    // Fire all orders in parallel
    const orderPromises = priceLevels.map(async (orderPrice, idx) => {
      try {
        // Try cache first
        let signedOrder: SignedOrder;
        let usedCache = false;
        
        if (asset && direction) {
          const cached = getPreSignedOrder(asset, direction, orderPrice, sharesPerOrder);
          if (cached) {
            signedOrder = cached.signedOrder;
            usedCache = true;
          }
        }
        
        // Fallback to real-time signing
        if (!usedCache) {
          signedOrder = await client.createOrder(
            { tokenID: tokenId, price: orderPrice, size: sharesPerOrder, side: Side.BUY },
            { tickSize: '0.01', negRisk: false }
          );
        }
        
        const response = await client.postOrder(signedOrder!, OrderType.GTC);
        
        return {
          idx,
          price: orderPrice,
          orderId: response.orderID,
          success: response.success,
          error: response.errorMsg,
          usedCache,
        };
      } catch (err) {
        return {
          idx,
          price: orderPrice,
          orderId: null,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          usedCache: false,
        };
      }
    });
    
    // Wait for all orders to be placed
    const orderResults = await Promise.all(orderPromises);
    const placedOrders = orderResults.filter(o => o.success && o.orderId);
    
    if (placedOrders.length === 0) {
      const errors = orderResults.map(o => o.error).join(', ');
      log(`❌ All burst orders failed: ${errors}`);
      return { success: false, error: `All burst orders failed: ${errors}`, latencyMs: Date.now() - start };
    }
    
    log(`📤 Burst: ${placedOrders.length}/${burstCount} orders placed in ${Date.now() - start}ms`);
    
    // Wait for fills
    await new Promise(resolve => setTimeout(resolve, fillCheckDelayMs));
    
    // Check fill status of all orders
    const statusChecks = await Promise.all(
      placedOrders.map(async (order) => {
        const status = await getOrderStatus(order.orderId!);
        return {
          ...order,
          filled: status.filled,
          filledSize: status.filledSize || 0,
        };
      })
    );
    
    // Calculate total filled
    let totalFilled = 0;
    let weightedPriceSum = 0;
    const filledOrders = statusChecks.filter(o => o.filledSize > 0);
    
    for (const order of filledOrders) {
      totalFilled += order.filledSize;
      weightedPriceSum += order.price * order.filledSize;
    }
    
    const avgFillPrice = totalFilled > 0 ? weightedPriceSum / totalFilled : price;
    
    // Cancel unfilled orders (fire and forget for speed)
    const unfilledOrders = statusChecks.filter(o => !o.filled && o.filledSize === 0);
    if (unfilledOrders.length > 0) {
      log(`🗑️ Cancelling ${unfilledOrders.length} unfilled orders...`);
      Promise.all(
        unfilledOrders.map(o => 
          client.cancelOrder(o.orderId!).catch(() => {/* ignore cancel errors */})
        )
      );
    }
    
    const latencyMs = Date.now() - start;
    
    if (totalFilled > 0) {
      log(`✅ Burst fill SUCCESS: ${totalFilled} shares @ avg ${(avgFillPrice * 100).toFixed(1)}¢ (${latencyMs}ms, ${filledOrders.length}/${burstCount} orders filled)`);
      
      // LOG EACH FILL SEPARATELY
      if (currentFillContext && asset && direction) {
        const fillRecords: FillRecord[] = filledOrders.map(o => ({
          signalId: currentFillContext!.signalId,
          runId: currentFillContext!.runId,
          asset,
          direction,
          marketSlug: currentFillContext!.marketSlug,
          orderId: o.orderId || undefined,
          price: o.price,
          shares: o.filledSize,
          costUsd: o.price * o.filledSize,
          fillTs: Date.now(),
        }));
        void logFillsBatch(fillRecords);
      }
      
      return {
        success: true,
        orderId: filledOrders[0]?.orderId || placedOrders[0].orderId,
        avgPrice: avgFillPrice,
        filledSize: totalFilled,
        latencyMs,
      };
    }
    
    // No fills yet - wait a bit more and check again
    log(`⏳ No fills yet, waiting ${totalTimeoutMs - fillCheckDelayMs}ms more...`);
    await new Promise(resolve => setTimeout(resolve, totalTimeoutMs - fillCheckDelayMs));
    
    // Final fill check
    const finalChecks = await Promise.all(
      placedOrders.map(async (order) => {
        const status = await getOrderStatus(order.orderId!);
        return {
          ...order,
          filled: status.filled,
          filledSize: status.filledSize || 0,
        };
      })
    );
    
    totalFilled = 0;
    weightedPriceSum = 0;
    const finalFilledOrders = finalChecks.filter(o => o.filledSize > 0);
    
    for (const order of finalFilledOrders) {
      totalFilled += order.filledSize;
      weightedPriceSum += order.price * order.filledSize;
    }
    
    const finalAvgPrice = totalFilled > 0 ? weightedPriceSum / totalFilled : price;
    const finalLatencyMs = Date.now() - start;
    
    // Cancel any remaining unfilled orders
    const finalUnfilled = finalChecks.filter(o => !o.filled && o.filledSize === 0);
    if (finalUnfilled.length > 0) {
      Promise.all(
        finalUnfilled.map(o => 
          client.cancelOrder(o.orderId!).catch(() => {})
        )
      );
    }
    
    if (totalFilled > 0) {
      log(`✅ Burst fill (delayed): ${totalFilled} shares @ avg ${(finalAvgPrice * 100).toFixed(1)}¢ (${finalLatencyMs}ms)`);
      
      // LOG EACH FILL SEPARATELY
      if (currentFillContext && asset && direction) {
        const fillRecords: FillRecord[] = finalFilledOrders.map(o => ({
          signalId: currentFillContext!.signalId,
          runId: currentFillContext!.runId,
          asset,
          direction,
          marketSlug: currentFillContext!.marketSlug,
          orderId: o.orderId || undefined,
          price: o.price,
          shares: o.filledSize,
          costUsd: o.price * o.filledSize,
          fillTs: Date.now(),
        }));
        void logFillsBatch(fillRecords);
      }
      
      return {
        success: true,
        orderId: finalFilledOrders[0]?.orderId || placedOrders[0].orderId,
        avgPrice: finalAvgPrice,
        filledSize: totalFilled,
        latencyMs: finalLatencyMs,
      };
    }
    
    // All orders unfilled after timeout - report failure
    log(`⚠️ Burst fill timeout: no fills after ${finalLatencyMs}ms`);
    return {
      success: false,
      error: `No fills after ${finalLatencyMs}ms (${placedOrders.length} orders placed)`,
      latencyMs: finalLatencyMs,
    };
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`❌ Burst order error: ${msg}`);
    return { success: false, error: msg, latencyMs: Date.now() - start };
  }
}

/**
 * Place a single limit buy order (original simple logic)
 */
async function placeSingleBuyOrder(
  client: ClobClient,
  tokenId: string,
  price: number,
  shares: number,
  asset?: Asset,
  direction?: 'UP' | 'DOWN',
  startTime?: number
): Promise<OrderResult> {
  const start = startTime ?? Date.now();
  const roundedPrice = Math.round(price * 100) / 100;
  
  try {
    let signedOrder: SignedOrder;
    let usedCache = false;
    
    // Try to get pre-signed order from cache
    if (asset && direction) {
      const cached = getPreSignedOrder(asset, direction, roundedPrice, shares);
      if (cached) {
        signedOrder = cached.signedOrder;
        usedCache = true;
        log(`⚡ Cache hit: ${asset} ${direction} ${shares}@${roundedPrice}`);
      }
    }
    
    // Fallback to real-time signing
    if (!usedCache) {
      log(`📝 Real-time sign: ${shares}@${roundedPrice}`);
      signedOrder = await client.createOrder(
        { tokenID: tokenId, price: roundedPrice, size: shares, side: Side.BUY },
        { tickSize: '0.01', negRisk: false }
      );
    }
    
    // POST the order
    const response = await client.postOrder(signedOrder!, OrderType.GTC);
    
    const latencyMs = Date.now() - start;
    
    if (response.success) {
      log(`✅ Order placed: ${response.orderID ?? 'no-id'} (${latencyMs}ms, cache=${usedCache})`);
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize: shares,
        latencyMs,
      };
    } else {
      log(`❌ Order failed: ${response.errorMsg ?? 'unknown'}`);
      return { success: false, error: response.errorMsg ?? 'Order rejected', latencyMs };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`❌ Order error: ${msg}`);
    return { success: false, error: msg, latencyMs: Date.now() - start };
  }
}

/**
 * Place a SELL order to close a position
 */
export async function placeSellOrder(
  tokenId: string,
  price: number,
  shares: number
): Promise<OrderResult> {
  const start = Date.now();
  
  try {
    const client = await getClient();
    const roundedPrice = Math.round(price * 100) / 100;
    const roundedShares = Math.floor(shares);
    
    if (roundedShares < 1) {
      return { success: false, error: 'Shares < 1', latencyMs: Date.now() - start };
    }
    
    log(`📤 SELL ${roundedShares} shares @ ${(roundedPrice * 100).toFixed(1)}¢`);
    
    const signedOrder = await client.createOrder(
      { tokenID: tokenId, price: roundedPrice, size: roundedShares, side: Side.SELL },
      { tickSize: '0.01', negRisk: false }
    );
    
    const response = await client.postOrder(signedOrder, OrderType.GTC);
    const latencyMs = Date.now() - start;
    
    if (response.success) {
      log(`✅ Sell order: ${response.orderID ?? 'no-id'} (${latencyMs}ms)`);
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize: roundedShares,
        latencyMs,
      };
    } else {
      return { success: false, error: response.errorMsg ?? 'Sell rejected', latencyMs };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg, latencyMs: Date.now() - start };
  }
}

/**
 * Cancel an order by ID
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const client = await getClient();
    // CLOB SDK expects cancelOrder({ orderID: string }) not a raw string
    await client.cancelOrder({ orderID: orderId });
    log(`🗑️ Order cancelled: ${orderId}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`⚠️ Cancel failed: ${msg}`);
    return false;
  }
}

/**
 * Get order status to check if filled
 */
export async function getOrderStatus(orderId: string): Promise<{ filled: boolean; filledSize: number; status: string }> {
  try {
    const client = await getClient();
    const order = await client.getOrder(orderId);
    
    const filledSize = parseFloat(order?.size_matched ?? '0') || 0;
    const totalSize = parseFloat(order?.original_size ?? '0') || 0;
    const status = order?.status ?? 'unknown';
    
    return {
      filled: filledSize >= totalSize && totalSize > 0,
      filledSize,
      status,
    };
  } catch (err) {
    log(`⚠️ Get order status failed: ${err}`);
    return { filled: false, filledSize: 0, status: 'error' };
  }
}

/**
 * Get current wallet balance
 */
export async function getBalance(): Promise<number> {
  try {
    const client = await getClient();
    const result = await (client as any).getBalanceAllowance({ asset_type: 'COLLATERAL' });
    const balance = result?.balance ?? result;
    return typeof balance === 'number' ? balance : parseFloat(String(balance)) || 0;
  } catch (err) {
    log(`⚠️ Balance fetch failed: ${err}`);
    return 0;
  }
}

/**
 * Get cache stats for monitoring
 */
export function getCacheStats() {
  return {
    ...stats,
    isInitialized,
    cachedAssets: Array.from(orderCache.keys()),
  };
}
