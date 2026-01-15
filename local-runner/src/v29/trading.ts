/**
 * V29 Trading Functions
 * 
 * Uses pre-signed orders for maximum speed (same as v28)
 * Orders are signed during idle time and instantly posted when signals fire
 */

// CRITICAL: Import HTTP agent FIRST to ensure axios is configured before SDK
import './http-agent.js';

import util from 'node:util';

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

function asErrorMessage(err: unknown): string {
  const candidates: unknown[] = [
    err,
    (err as any)?.cause,
    (err as any)?.error,
    (err as any)?.originalError,
  ].filter(Boolean);

  for (const c of candidates) {
    // Strings
    if (typeof c === 'string' && c.trim()) return c;

    const anyC = c as any;

    // Axios-like error shapes (what clob-client uses under the hood)
    const status = anyC?.response?.status;
    const statusText = anyC?.response?.statusText;
    const data = anyC?.response?.data ?? anyC?.data;

    // Common API error fields
    const apiMsg =
      (typeof data === 'string' && data) ||
      (typeof data?.message === 'string' && data.message) ||
      (typeof data?.error === 'string' && data.error) ||
      (typeof data?.msg === 'string' && data.msg) ||
      (typeof data?.detail === 'string' && data.detail) ||
      (typeof data?.reason === 'string' && data.reason) ||
      (typeof data?.code === 'string' && data.code) ||
      (typeof data?.errors?.[0]?.message === 'string' && data.errors[0].message) ||
      (typeof data?.errors?.[0]?.msg === 'string' && data.errors[0].msg);

    if (apiMsg) {
      return status ? `HTTP ${status}${statusText ? ` ${statusText}` : ''} - ${apiMsg}` : apiMsg;
    }

    if (status) {
      // If there's a structured payload, include a short inspected snippet for debugging.
      if (data && typeof data === 'object') {
        try {
          const snippet = util.inspect(data, {
            depth: 2,
            breakLength: 120,
            maxStringLength: 240,
            maxArrayLength: 20,
          });
          return `HTTP ${status}${statusText ? ` ${statusText}` : ''} - ${snippet}`;
        } catch {
          // ignore
        }
      }
      return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
    }

    // Native Error - but skip circular JSON errors
    if (c instanceof Error) {
      const msg = c.message;
      if (msg && !msg.includes('Converting circular structure to JSON')) return msg;
    }

    // Fallback: safe inspection (handles circular refs)
    try {
      const inspected = util.inspect(anyC, {
        depth: 2,
        breakLength: 120,
        maxStringLength: 240,
        maxArrayLength: 20,
      });
      if (inspected && inspected !== '[object Object]' && !inspected.includes('TLSSocket')) return inspected;
    } catch {
      // ignore
    }
  }

  return 'Unknown error';
}

interface OrderResult {
  success: boolean;
  orderId?: string;
  avgPrice?: number;
  filledSize?: number;
  error?: string;
  latencyMs: number;
  // Detailed latency breakdown
  signLatencyMs?: number;   // Time to sign order
  postLatencyMs?: number;   // Time to post to exchange
  fillLatencyMs?: number;   // Time from post to fill confirmed
  usedCache?: boolean;      // Whether pre-signed cache was used
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
  upTokenBuy: Map<string, PreSignedOrder>;    // key: `${price}-${size}`
  downTokenBuy: Map<string, PreSignedOrder>;  // key: `${price}-${size}`
  upTokenSell: Map<string, PreSignedOrder>;   // key: `${price}-${size}`
  downTokenSell: Map<string, PreSignedOrder>; // key: `${price}-${size}`
  upTokenId: string;
  downTokenId: string;
  lastRefresh: number;
}

// Cache of pre-signed orders by asset
const orderCache = new Map<Asset, MarketOrderSet>();

// Configuration
const PRE_SIGN_CONFIG = {
  // Price levels to pre-sign (extended range 10-90¢ with 2¢ steps)
  priceLevels: [
    0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28,
    0.30, 0.32, 0.34, 0.36, 0.38, 0.40, 0.42, 0.44, 0.46, 0.48,
    0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.64, 0.66, 0.68,
    0.70, 0.72, 0.74, 0.76, 0.78, 0.80, 0.82, 0.84, 0.86, 0.88, 0.90
  ],
  // Share sizes to pre-sign (multiple for burst orders)
  shareSizes: [2, 5],
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
    upTokenBuy: new Map(),
    downTokenBuy: new Map(),
    upTokenSell: new Map(),
    downTokenSell: new Map(),
    upTokenId,
    downTokenId,
    lastRefresh: Date.now(),
  };
  
  let signedCount = 0;
  
  // Pre-sign BUY and SELL orders for both UP and DOWN tokens
  for (const direction of ['UP', 'DOWN'] as const) {
    const tokenId = direction === 'UP' ? upTokenId : downTokenId;
    const buyMap = direction === 'UP' ? orderSet.upTokenBuy : orderSet.downTokenBuy;
    const sellMap = direction === 'UP' ? orderSet.upTokenSell : orderSet.downTokenSell;
    
    for (const price of PRE_SIGN_CONFIG.priceLevels) {
      for (const size of PRE_SIGN_CONFIG.shareSizes) {
        const key = `${price.toFixed(2)}-${size}`;
        
        // Pre-sign BUY order
        const buyOrder = await preSignOrder(
          client, tokenId, 'BUY', price, size, asset, direction
        );
        if (buyOrder) {
          buyMap.set(key, buyOrder);
          signedCount++;
        }
        
        // Pre-sign SELL order at same price level
        const sellOrder = await preSignOrder(
          client, tokenId, 'SELL', price, size, asset, direction
        );
        if (sellOrder) {
          sellMap.set(key, sellOrder);
          signedCount++;
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  
  const duration = Date.now() - startTime;
  log(`${asset}: Pre-signed ${signedCount} orders (BUY+SELL) in ${duration}ms`);
  
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
  side: 'BUY' | 'SELL',
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
  
  // Select appropriate map based on direction and side
  let tokenMap: Map<string, PreSignedOrder>;
  if (direction === 'UP') {
    tokenMap = side === 'BUY' ? orderSet.upTokenBuy : orderSet.upTokenSell;
  } else {
    tokenMap = side === 'BUY' ? orderSet.downTokenBuy : orderSet.downTokenSell;
  }
  
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
    
    // For BUY: prefer price >= targetPrice (willing to pay more)
    // For SELL: prefer price <= targetPrice (willing to accept less)
    if (side === 'BUY' && order.price >= targetPrice) {
      const priceDiff = order.price - targetPrice;
      if (priceDiff < bestPriceDiff) {
        bestPriceDiff = priceDiff;
        bestMatch = order;
      }
    } else if (side === 'SELL' && order.price <= targetPrice) {
      const priceDiff = targetPrice - order.price;
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
  // Number of parallel orders to fire (3x burst)
  burstCount: 3,
  // Shares per order (total = burstCount * sharesPerOrder = 6 shares max)
  sharesPerOrder: 2,
  // Price step between orders (1¢) - spread across 3¢ range
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
    const { burstCount, priceStepCents, fillCheckDelayMs, totalTimeoutMs } = BURST_FILL_CONFIG;
    
    // DYNAMIC SHARES: Each burst order must be ≥ $1 (Polymarket minimum)
    const MIN_ORDER_VALUE = 1.0; // $1 minimum
    const sharesPerOrder = Math.max(BURST_FILL_CONFIG.sharesPerOrder, Math.ceil(MIN_ORDER_VALUE / price));
    
    log(`🚀 Burst fill: ${asset} ${direction} firing ${burstCount}x${sharesPerOrder} shares starting @ ${(price * 100).toFixed(1)}¢`);
    
    // Generate price levels for burst orders
    const priceLevels: number[] = [];
    let currentPrice = Math.round(price * 100) / 100;
    for (let i = 0; i < burstCount; i++) {
      priceLevels.push(Math.max(currentPrice, 0.01));
      currentPrice -= priceStepCents;
    }
    
    // Fire all orders in parallel with a timeout
    const ORDER_TIMEOUT_MS = 5000; // 5 second max per order attempt
    
    const orderPromises = priceLevels.map(async (orderPrice, idx) => {
      const orderStart = Date.now();
      try {
        // Try cache first
        let signedOrder: SignedOrder | undefined;
        let usedCache = false;
        
        if (asset && direction) {
          const cached = getPreSignedOrder(asset, direction, 'BUY', orderPrice, sharesPerOrder);
          if (cached) {
            signedOrder = cached.signedOrder;
            usedCache = true;
          }
        }
        
        // Fallback to real-time signing with timeout
        if (!usedCache) {
          const signPromise = client.createOrder(
            { tokenID: tokenId, price: orderPrice, size: sharesPerOrder, side: Side.BUY },
            { tickSize: '0.01', negRisk: false }
          );
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Sign timeout')), ORDER_TIMEOUT_MS)
          );
          signedOrder = await Promise.race([signPromise, timeoutPromise]);
        }
        
        // Post order with timeout
        const postPromise = client.postOrder(signedOrder!, OrderType.FOK);
        const postTimeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Post timeout')), ORDER_TIMEOUT_MS)
        );
        const response = await Promise.race([postPromise, postTimeoutPromise]);
        
        const elapsed = Date.now() - orderStart;
        log(`📤 Order ${idx + 1}: ${usedCache ? '⚡cache' : '🔧sign'} @ ${(orderPrice * 100).toFixed(0)}¢ → ${response.success ? '✅' : '❌'} (${elapsed}ms)`);

        return {
          idx,
          price: orderPrice,
          orderId: response.orderID,
          success: response.success,
          error: response.success ? undefined : asErrorMessage((response as any).errorMsg ?? response),
          usedCache,
        };
      } catch (err: any) {
        const elapsed = Date.now() - orderStart;
        const errMsg = asErrorMessage(err);
        log(`⚠️ Order ${idx + 1} @ ${(orderPrice * 100).toFixed(0)}¢ failed: ${errMsg} (${elapsed}ms)`);
        return {
          idx,
          price: orderPrice,
          orderId: null,
          success: false,
          error: errMsg,
          usedCache: false,
        };
      }
    });
    
    // Wait for all orders with overall timeout
    const TOTAL_TIMEOUT_MS = 8000; // 8 seconds max for entire burst
    const allOrdersPromise = Promise.all(orderPromises);
    const totalTimeoutPromise = new Promise<typeof orderPromises extends Promise<infer R>[] ? R[] : never>((resolve) => 
      setTimeout(() => {
        log(`⚠️ Burst timeout after ${TOTAL_TIMEOUT_MS}ms - returning partial results`);
        resolve([]);
      }, TOTAL_TIMEOUT_MS)
    );
    
    const orderResults = await Promise.race([allOrdersPromise, totalTimeoutPromise]);
    const placedOrders = orderResults.filter(o => o.success && o.orderId);
    
    if (placedOrders.length === 0) {
      // If we timed out waiting for order results, say so explicitly (otherwise this looks like an API failure).
      if (orderResults.length === 0) {
        log(`❌ Burst failed: timeout/no results`);
        return { success: false, error: 'Burst timeout/no results', latencyMs: Date.now() - start };
      }

      const errors = orderResults
        .map(o => o.error)
        .filter((e): e is string => Boolean(e && e.trim()))
        .join(', ');
      const errorMsg = errors || 'Unknown error';
      log(`❌ All burst orders failed: ${errorMsg}`);
      return { success: false, error: `All burst orders failed: ${errorMsg}`, latencyMs: Date.now() - start };
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
      
      // Calculate how many used cache
      const cachedCount = placedOrders.filter(o => o.usedCache).length;
      
      return {
        success: true,
        orderId: filledOrders[0]?.orderId || placedOrders[0].orderId,
        avgPrice: avgFillPrice,
        filledSize: totalFilled,
        latencyMs,
        usedCache: cachedCount > 0,
        signLatencyMs: cachedCount > 0 ? 0 : undefined,
        postLatencyMs: latencyMs,
        fillLatencyMs: 0, // Fill was immediate
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
      
      const cachedCount = placedOrders.filter(o => o.usedCache).length;
      const postTime = Date.now() - start - (totalTimeoutMs - fillCheckDelayMs);
      
      return {
        success: true,
        orderId: finalFilledOrders[0]?.orderId || placedOrders[0].orderId,
        avgPrice: finalAvgPrice,
        filledSize: totalFilled,
        latencyMs: finalLatencyMs,
        usedCache: cachedCount > 0,
        postLatencyMs: postTime,
        fillLatencyMs: totalTimeoutMs - fillCheckDelayMs,
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
    const msg = asErrorMessage(err);
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
      const cached = getPreSignedOrder(asset, direction, 'BUY', roundedPrice, shares);
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
      const msg = asErrorMessage(response.errorMsg) || 'Order rejected';
      log(`❌ Order failed: ${msg}`);
      return { success: false, error: msg, latencyMs };
    }
  } catch (err) {
    const msg = asErrorMessage(err);
    log(`❌ Order error: ${msg}`);
    return { success: false, error: msg, latencyMs: Date.now() - start };
  }
}

/**
 * Place a SELL order with aggressive pricing, caching, and fill checking
 * 
 * RETRY STRATEGY:
 * 1. Try FOK at bestBid - aggressiveDiscount (default 2¢)
 * 2. If FOK fails, retry at bestBid - 4¢ 
 * 3. If still fails, use GTC order at bestBid - 5¢ and wait for fill
 */
export async function placeSellOrder(
  tokenId: string,
  price: number,
  shares: number,
  asset?: Asset,
  direction?: 'UP' | 'DOWN',
  aggressiveDiscountCents: number = 2
): Promise<OrderResult> {
  const start = Date.now();
  const FILL_CHECK_INTERVAL_MS = 150;
  const MAX_FILL_WAIT_MS = 3000;
  
  // Retry config: each attempt uses more aggressive pricing
  const RETRY_DISCOUNTS = [aggressiveDiscountCents, 4, 5];
  const USE_GTC_ON_LAST_RETRY = true;

  try {
    const client = await getClient();
    const roundedShares = Math.floor(shares);

    if (roundedShares < 1) {
      return { success: false, error: 'Shares < 1', latencyMs: Date.now() - start };
    }
    
    let lastError = '';
    
    // Try each discount level
    for (let attempt = 0; attempt < RETRY_DISCOUNTS.length; attempt++) {
      const discountCents = RETRY_DISCOUNTS[attempt];
      const isLastAttempt = attempt === RETRY_DISCOUNTS.length - 1;
      const useGtc = isLastAttempt && USE_GTC_ON_LAST_RETRY;
      
      const aggressivePrice = Math.max(0.01, price - (discountCents / 100));
      const roundedPrice = Math.round(aggressivePrice * 100) / 100;
      
      if (attempt === 0) {
        log(`📤 SELL ${roundedShares} shares @ ${(roundedPrice * 100).toFixed(1)}¢ (aggressive: -${discountCents}¢ from ${(price * 100).toFixed(1)}¢)`);
      } else {
        log(`🔄 SELL RETRY #${attempt + 1}: ${roundedShares} @ ${(roundedPrice * 100).toFixed(1)}¢ (-${discountCents}¢) ${useGtc ? '[GTC]' : '[FOK]'}`);
      }
      
      // Try to use cached pre-signed order first
      let signedOrder: SignedOrder | null = null;
      let usedCache = false;
      
      if (asset && direction) {
        const cached = getPreSignedOrder(asset, direction, 'SELL', roundedPrice, roundedShares);
        if (cached) {
          signedOrder = cached.signedOrder;
          usedCache = true;
        }
      }
      
      // Fallback to real-time signing
      if (!signedOrder) {
        try {
          signedOrder = await client.createOrder(
            { tokenID: tokenId, price: roundedPrice, size: roundedShares, side: Side.SELL },
            { tickSize: '0.01', negRisk: false }
          );
        } catch (signErr) {
          lastError = asErrorMessage(signErr);
          log(`⚠️ Sign failed: ${lastError}`);
          continue; // Try next discount level
        }
      }
      
      // Post order: FOK for fast fill, GTC on last retry for guaranteed placement
      const orderType = useGtc ? OrderType.GTC : OrderType.FOK;
      
      let response;
      try {
        response = await client.postOrder(signedOrder, orderType);
      } catch (postErr) {
        lastError = asErrorMessage(postErr);
        log(`⚠️ Post failed (${useGtc ? 'GTC' : 'FOK'}): ${lastError}`);
        continue; // Try next discount level
      }
      
      const orderId = response.orderID;
      
      if (!response.success || !orderId) {
        lastError = asErrorMessage(response.errorMsg) || 'Sell rejected';
        log(`⚠️ Order rejected: ${lastError}`);
        continue; // Try next discount level
      }
      
      const postLatency = Date.now() - start;
      log(`📤 Sell order posted (${usedCache ? 'cached' : 'signed'}, ${useGtc ? 'GTC' : 'FOK'}): ${orderId} in ${postLatency}ms`);
      
      // For FOK orders, check immediate fill
      if (!useGtc) {
        // FOK either fills immediately or is cancelled
        const status = await getOrderStatus(orderId);
        if (status.filledSize >= roundedShares) {
          const latencyMs = Date.now() - start;
          log(`✅ Sell FILLED (FOK): ${status.filledSize} shares (${latencyMs}ms)`);
          return {
            success: true,
            orderId,
            avgPrice: roundedPrice,
            filledSize: status.filledSize,
            latencyMs,
          };
        }
        // FOK didn't fill, try next discount
        lastError = `FOK not filled at ${(roundedPrice * 100).toFixed(1)}¢`;
        continue;
      }
      
      // GTC order - wait for fill with polling
      let filledSize = 0;
      let attempts = 0;
      const maxAttempts = Math.ceil(MAX_FILL_WAIT_MS / FILL_CHECK_INTERVAL_MS);
      
      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, FILL_CHECK_INTERVAL_MS));
        const status = await getOrderStatus(orderId);
        filledSize = status.filledSize;
        
        if (status.filled || filledSize >= roundedShares) {
          const latencyMs = Date.now() - start;
          log(`✅ Sell FILLED (GTC): ${filledSize} shares (${latencyMs}ms)`);
          return {
            success: true,
            orderId,
            avgPrice: roundedPrice,
            filledSize,
            latencyMs,
          };
        }
        
        if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
          break;
        }
        
        attempts++;
      }
      
      // Partial or no fill - cancel remaining
      if (filledSize < roundedShares && orderId) {
        log(`⚠️ Sell partial: ${filledSize}/${roundedShares}, cancelling remainder`);
        await cancelOrder(orderId);
      }
      
      if (filledSize > 0) {
        return {
          success: true,
          orderId,
          avgPrice: roundedPrice,
          filledSize,
          latencyMs: Date.now() - start,
        };
      }
      
      lastError = `GTC timeout: 0/${roundedShares} filled at ${(roundedPrice * 100).toFixed(1)}¢`;
    }
    
    // All retries failed
    return { 
      success: false, 
      error: lastError || 'All sell attempts failed', 
      latencyMs: Date.now() - start 
    };
  } catch (err) {
    const msg = asErrorMessage(err);
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
    const msg = asErrorMessage(err);
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
    log(`⚠️ Get order status failed: ${asErrorMessage(err)}`);
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
 * Place a TAKE-PROFIT sell order as GTC (Good Till Cancelled)
 * This order sits on the book waiting to be filled when price reaches target
 */
export async function placeTakeProfitSellOrder(
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
    const roundedPrice = Math.round(price * 100) / 100;
    
    if (roundedShares < 1) {
      return { success: false, error: 'Shares < 1', latencyMs: Date.now() - start };
    }
    
    if (roundedPrice <= 0.01 || roundedPrice >= 0.99) {
      return { success: false, error: `Invalid price ${roundedPrice}`, latencyMs: Date.now() - start };
    }
    
    // Try to use cached pre-signed order first
    let signedOrder: SignedOrder | null = null;
    let usedCache = false;
    
    if (asset && direction) {
      const cached = getPreSignedOrder(asset, direction, 'SELL', roundedPrice, roundedShares);
      if (cached) {
        signedOrder = cached.signedOrder;
        usedCache = true;
        log(`⚡ TP Cache hit: ${asset} ${direction} SELL ${roundedShares}@${roundedPrice}`);
      }
    }
    
    // Fallback to real-time signing
    if (!signedOrder) {
      log(`📝 TP Real-time sign: SELL ${roundedShares}@${roundedPrice}`);
      signedOrder = await client.createOrder(
        { tokenID: tokenId, price: roundedPrice, size: roundedShares, side: Side.SELL },
        { tickSize: '0.01', negRisk: false }
      );
    }
    
    // Post as GTC - order stays on book until filled or cancelled
    const response = await client.postOrder(signedOrder, OrderType.GTC);
    
    const latencyMs = Date.now() - start;
    
    if (response.success && response.orderID) {
      log(`✅ TP order placed: ${response.orderID} @ ${(roundedPrice * 100).toFixed(1)}¢ (${latencyMs}ms, cache=${usedCache})`);
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize: 0, // Not filled yet - it's a limit order
        latencyMs,
        usedCache,
      };
    } else {
      const msg = asErrorMessage(response.errorMsg) || 'TP order rejected';
      log(`❌ TP order failed: ${msg}`);
      return { success: false, error: msg, latencyMs };
    }
  } catch (err) {
    const msg = asErrorMessage(err);
    log(`❌ TP order error: ${msg}`);
    return { success: false, error: msg, latencyMs: Date.now() - start };
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
