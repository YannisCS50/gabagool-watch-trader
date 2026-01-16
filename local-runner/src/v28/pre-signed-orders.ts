/**
 * Pre-Signed Orders Cache - V28 Speed Optimization
 * 
 * Pre-signs orders during idle time so they can be instantly posted when a spike is detected.
 * Eliminates ~50-100ms EIP-712 signing latency from the critical trading path.
 * 
 * CRITICAL INSIGHT:
 * - Polymarket orders use nonce="0" and expiration="0" (never expires)
 * - The signature is stateless - valid indefinitely
 * - We can pre-sign orders and cache them for instant posting
 * 
 * ORDER GUARD: Only v29-response is authorized to place real orders.
 */

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import type { SignedOrder } from '@polymarket/order-utils';
import { getClient } from '../polymarket.js';
import { Asset } from './config.js';
import { guardOrderPlacement, logBlockedOrder } from '../order-guard.js';

// ============================================
// TYPES
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
  marketSlug: string;
}

interface MarketOrderSet {
  upToken: Map<string, PreSignedOrder>;    // key: `${price}-${size}`
  downToken: Map<string, PreSignedOrder>;  // key: `${price}-${size}`
  marketSlug: string;
  upTokenId: string;
  downTokenId: string;
  lastRefresh: number;
}

interface PreSignConfig {
  // Price levels to pre-sign (0.01 = 1 cent increments)
  priceLevels: number[];
  // Share sizes to pre-sign
  shareSizes: number[];
  // How often to refresh pre-signed orders (ms)
  refreshIntervalMs: number;
  // Max age before order is considered stale and should be re-signed
  maxOrderAgeMs: number;
  // Enable/disable cache
  enabled: boolean;
}

// ============================================
// STATE
// ============================================

// Cache of pre-signed orders by asset
const orderCache = new Map<Asset, MarketOrderSet>();

// Configuration
const DEFAULT_CONFIG: PreSignConfig = {
  // Pre-sign at these price levels (likely buy prices)
  priceLevels: [0.40, 0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.56, 0.58, 0.60],
  // Pre-sign these share amounts
  shareSizes: [3, 5, 10],
  // Refresh every 5 minutes
  refreshIntervalMs: 5 * 60 * 1000,
  // Orders older than 30 minutes should be re-signed (safety margin)
  maxOrderAgeMs: 30 * 60 * 1000,
  // Enabled by default
  enabled: true,
};

let config = { ...DEFAULT_CONFIG };
let isInitialized = false;
let refreshInterval: NodeJS.Timeout | null = null;
let client: ClobClient | null = null;

// Telemetry
interface CacheStats {
  totalPreSigned: number;
  cacheHits: number;
  cacheMisses: number;
  avgSignTimeMs: number;
  lastRefreshTime: number;
  ordersPerAsset: Record<Asset, number>;
}

const stats: CacheStats = {
  totalPreSigned: 0,
  cacheHits: 0,
  cacheMisses: 0,
  avgSignTimeMs: 0,
  lastRefreshTime: 0,
  ordersPerAsset: { BTC: 0, ETH: 0, SOL: 0, XRP: 0 },
};

const signTimes: number[] = [];

// ============================================
// LOGGING
// ============================================

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [PreSign] ${msg}`);
}

function logError(msg: string, err?: unknown): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [PreSign] ❌ ${msg}`, err || '');
}

// ============================================
// ORDER SIGNING
// ============================================

/**
 * Pre-sign a single order for later use
 */
async function preSignOrder(
  clobClient: ClobClient,
  tokenId: string,
  side: 'BUY' | 'SELL',
  price: number,
  size: number,
  asset: Asset,
  direction: 'UP' | 'DOWN',
  marketSlug: string
): Promise<PreSignedOrder | null> {
  const startTime = Date.now();
  
  try {
    // Validate inputs
    if (!Number.isFinite(price) || price < 0.01 || price > 0.99) {
      return null;
    }
    if (!Number.isFinite(size) || size < 1) {
      return null;
    }
    
    // Use createOrder to get a signed order WITHOUT posting it
    // This is the key - we sign now, post later
    const signedOrder = await clobClient.createOrder(
      {
        tokenID: tokenId,
        price: price,
        size: size,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      },
      {
        tickSize: '0.01', // Standard tick size
        negRisk: false,
      }
    );
    
    const signTime = Date.now() - startTime;
    signTimes.push(signTime);
    if (signTimes.length > 100) signTimes.shift(); // Keep last 100
    
    // Update avg sign time
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
      marketSlug,
    };
  } catch (err) {
    logError(`Failed to pre-sign ${asset} ${direction} ${side} ${size}@${price}`, err);
    return null;
  }
}

/**
 * Pre-sign all orders for a single market
 */
async function preSignMarketOrders(
  clobClient: ClobClient,
  asset: Asset,
  upTokenId: string,
  downTokenId: string,
  marketSlug: string
): Promise<MarketOrderSet> {
  const startTime = Date.now();
  
  const orderSet: MarketOrderSet = {
    upToken: new Map(),
    downToken: new Map(),
    marketSlug,
    upTokenId,
    downTokenId,
    lastRefresh: Date.now(),
  };
  
  let signedCount = 0;
  
  // Pre-sign for both UP and DOWN tokens
  for (const direction of ['UP', 'DOWN'] as const) {
    const tokenId = direction === 'UP' ? upTokenId : downTokenId;
    const tokenMap = direction === 'UP' ? orderSet.upToken : orderSet.downToken;
    
    // Pre-sign BUY orders at all price/size combinations
    for (const price of config.priceLevels) {
      for (const size of config.shareSizes) {
        const key = `${price.toFixed(2)}-${size}`;
        
        const preSignedOrder = await preSignOrder(
          clobClient,
          tokenId,
          'BUY',
          price,
          size,
          asset,
          direction,
          marketSlug
        );
        
        if (preSignedOrder) {
          tokenMap.set(key, preSignedOrder);
          signedCount++;
        }
        
        // Small delay to avoid rate limiting during bulk signing
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  
  const duration = Date.now() - startTime;
  log(`${asset}: Pre-signed ${signedCount} orders in ${duration}ms (${(duration / signedCount).toFixed(1)}ms/order)`);
  
  stats.ordersPerAsset[asset] = signedCount;
  stats.totalPreSigned += signedCount;
  
  return orderSet;
}

// ============================================
// CACHE MANAGEMENT
// ============================================

/**
 * Initialize the pre-signed orders cache for given markets
 */
export async function initPreSignedCache(
  markets: Array<{
    asset: Asset;
    upTokenId: string;
    downTokenId: string;
    marketSlug: string;
  }>,
  customConfig?: Partial<PreSignConfig>
): Promise<void> {
  if (customConfig) {
    config = { ...config, ...customConfig };
  }
  
  if (!config.enabled) {
    log('Pre-signed orders cache is DISABLED');
    return;
  }
  
  log(`Initializing pre-signed orders cache for ${markets.length} markets...`);
  const startTime = Date.now();
  
  try {
    // Get CLOB client
    client = await getClient();
    
    // Pre-sign orders for each market
    for (const market of markets) {
      const orderSet = await preSignMarketOrders(
        client,
        market.asset,
        market.upTokenId,
        market.downTokenId,
        market.marketSlug
      );
      
      orderCache.set(market.asset, orderSet);
    }
    
    const duration = Date.now() - startTime;
    log(`✅ Cache initialized: ${stats.totalPreSigned} orders in ${duration}ms`);
    log(`   Average sign time: ${stats.avgSignTimeMs.toFixed(1)}ms`);
    
    stats.lastRefreshTime = Date.now();
    isInitialized = true;
    
    // Start background refresh
    startBackgroundRefresh();
  } catch (err) {
    logError('Failed to initialize pre-signed cache', err);
  }
}

/**
 * Start background refresh of pre-signed orders
 */
function startBackgroundRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
  
  refreshInterval = setInterval(async () => {
    if (!config.enabled || !client) return;
    
    log('Background refresh of pre-signed orders...');
    
    for (const [asset, orderSet] of orderCache) {
      try {
        const newOrderSet = await preSignMarketOrders(
          client,
          asset,
          orderSet.upTokenId,
          orderSet.downTokenId,
          orderSet.marketSlug
        );
        
        orderCache.set(asset, newOrderSet);
      } catch (err) {
        logError(`Background refresh failed for ${asset}`, err);
      }
    }
    
    stats.lastRefreshTime = Date.now();
  }, config.refreshIntervalMs);
}

/**
 * Update cache for a specific market (e.g., when markets rotate)
 */
export async function updateMarketCache(
  asset: Asset,
  upTokenId: string,
  downTokenId: string,
  marketSlug: string
): Promise<void> {
  if (!config.enabled || !client) return;
  
  log(`Updating cache for ${asset}...`);
  
  try {
    const orderSet = await preSignMarketOrders(
      client,
      asset,
      upTokenId,
      downTokenId,
      marketSlug
    );
    
    orderCache.set(asset, orderSet);
  } catch (err) {
    logError(`Failed to update cache for ${asset}`, err);
  }
}

/**
 * Clear cache for a specific asset
 */
export function clearAssetCache(asset: Asset): void {
  orderCache.delete(asset);
  stats.ordersPerAsset[asset] = 0;
  log(`Cleared cache for ${asset}`);
}

/**
 * Clear entire cache
 */
export function clearAllCache(): void {
  orderCache.clear();
  stats.totalPreSigned = 0;
  stats.ordersPerAsset = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
  log('Cleared all pre-signed orders cache');
}

/**
 * Stop background refresh and cleanup
 */
export function stopPreSignedCache(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  clearAllCache();
  isInitialized = false;
  log('Pre-signed orders cache stopped');
}

// ============================================
// ORDER RETRIEVAL - THE FAST PATH
// ============================================

/**
 * Get a pre-signed order for immediate posting
 * This is the FAST PATH - should return in <1ms
 * 
 * Returns null if no suitable pre-signed order is found (cache miss)
 */
export function getPreSignedOrder(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  targetPrice: number,
  targetSize: number
): PreSignedOrder | null {
  if (!config.enabled || !isInitialized) {
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
    // Check if order is not too old
    const age = Date.now() - exactMatch.signedAt;
    if (age < config.maxOrderAgeMs) {
      stats.cacheHits++;
      return exactMatch;
    }
  }
  
  // Try to find closest price match with same or larger size
  let bestMatch: PreSignedOrder | null = null;
  let bestPriceDiff = Infinity;
  
  for (const [_key, order] of tokenMap) {
    // Only consider orders with sufficient size
    if (order.size < targetSize) continue;
    
    // Check age
    const age = Date.now() - order.signedAt;
    if (age >= config.maxOrderAgeMs) continue;
    
    // Find closest price that is >= target (we want to pay at least target)
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

/**
 * Get the best available pre-signed order for a given market state
 * More flexible matching - finds any order within price bounds
 */
export function getBestPreSignedOrder(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  minPrice: number,
  maxPrice: number,
  minSize: number
): PreSignedOrder | null {
  if (!config.enabled || !isInitialized) {
    stats.cacheMisses++;
    return null;
  }
  
  const orderSet = orderCache.get(asset);
  if (!orderSet) {
    stats.cacheMisses++;
    return null;
  }
  
  const tokenMap = direction === 'UP' ? orderSet.upToken : orderSet.downToken;
  
  // Find any order within bounds
  for (const [_key, order] of tokenMap) {
    if (order.size < minSize) continue;
    if (order.price < minPrice || order.price > maxPrice) continue;
    
    const age = Date.now() - order.signedAt;
    if (age >= config.maxOrderAgeMs) continue;
    
    stats.cacheHits++;
    return order;
  }
  
  stats.cacheMisses++;
  return null;
}

// ============================================
// POST PRE-SIGNED ORDER
// ============================================

/**
 * Post a pre-signed order immediately
 * This is THE FAST PATH - only does the HTTP POST, no signing!
 * 
 * @returns orderId if successful, null if failed
 */
export async function postPreSignedOrder(
  preSignedOrder: PreSignedOrder,
  orderType: 'GTC' | 'FOK' = 'FOK'
): Promise<{ success: boolean; orderId?: string; avgPrice?: number; filledSize?: number; error?: string }> {
  if (!client) {
    return { success: false, error: 'CLOB client not initialized' };
  }
  
  // ORDER GUARD: Only authorized runners can place real orders
  try {
    guardOrderPlacement(`${preSignedOrder.side} ${preSignedOrder.size}@${(preSignedOrder.price * 100).toFixed(0)}¢ ${preSignedOrder.asset} ${preSignedOrder.direction}`);
  } catch (err) {
    logBlockedOrder(`${preSignedOrder.side} ${preSignedOrder.size}@${(preSignedOrder.price * 100).toFixed(0)}¢ ${preSignedOrder.asset} ${preSignedOrder.direction}`);
    return { success: false, error: 'ORDER_BLOCKED: Runner not authorized' };
  }
  
  const startTime = Date.now();
  
  try {
    log(`⚡ FAST POST: ${preSignedOrder.asset} ${preSignedOrder.direction} ${preSignedOrder.size}@${(preSignedOrder.price * 100).toFixed(0)}¢`);
    
    // Use postOrder with the already-signed order
    // This ONLY does the HTTP POST - no EIP-712 signing!
    const clobOrderType = orderType === 'FOK' ? OrderType.FOK : OrderType.GTC;
    const response = await client.postOrder(preSignedOrder.signedOrder, clobOrderType);
    
    const postTime = Date.now() - startTime;
    log(`⚡ POST completed in ${postTime}ms (vs ~100ms+ with signing)`);
    
    // Parse response
    const resp: any = (response as any)?.data ?? response;
    
    if (resp == null || (typeof resp === 'object' && Object.keys(resp).length === 0)) {
      return { success: false, error: 'Empty response from API' };
    }
    
    if (resp?.success === false || resp?.error || resp?.errorMsg) {
      return { success: false, error: resp?.error || resp?.errorMsg || 'Order failed' };
    }
    
    const orderId = resp?.orderID || resp?.orderId || resp?.order_id || resp?.id;
    const avgPrice = resp?.averagePrice ?? resp?.avg_price ?? resp?.avgPrice;
    const filledSize = resp?.size_matched ?? resp?.sizeMatched ?? resp?.filledSize ?? resp?.filled ?? 0;
    
    if (!orderId) {
      return { success: false, error: 'No order ID in response' };
    }
    
    return {
      success: true,
      orderId,
      avgPrice: avgPrice ? parseFloat(avgPrice) : undefined,
      filledSize: filledSize ? parseFloat(filledSize) : undefined,
    };
  } catch (err: any) {
    const postTime = Date.now() - startTime;
    logError(`POST failed after ${postTime}ms`, err);
    return { success: false, error: err?.message || String(err) };
  }
}

// ============================================
// DYNAMIC ORDER CREATION WITH CACHE FALLBACK
// ============================================

/**
 * Ultra-fast order execution:
 * 1. Try to find a pre-signed order (instant)
 * 2. If found, post it immediately (HTTP only)
 * 3. If not found, fall back to regular createAndPostOrder
 */
export async function executeOrderFast(
  asset: Asset,
  direction: 'UP' | 'DOWN',
  tokenId: string,
  price: number,
  size: number,
  orderType: 'GTC' | 'FOK' = 'FOK'
): Promise<{ success: boolean; orderId?: string; avgPrice?: number; filledSize?: number; error?: string; usedPreSigned: boolean; latencyMs: number }> {
  const startTime = Date.now();
  
  // Try cache first
  const preSignedOrder = getPreSignedOrder(asset, direction, price, size);
  
  if (preSignedOrder) {
    // FAST PATH - use pre-signed order
    log(`⚡ CACHE HIT: ${asset} ${direction} - using pre-signed order`);
    
    const result = await postPreSignedOrder(preSignedOrder, orderType);
    const latencyMs = Date.now() - startTime;
    
    return {
      ...result,
      usedPreSigned: true,
      latencyMs,
    };
  }
  
  // SLOW PATH - fall back to regular order creation
  log(`📦 CACHE MISS: ${asset} ${direction} - signing new order...`);
  
  if (!client) {
    client = await getClient();
  }
  
  try {
    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      {
        tickSize: '0.01',
        negRisk: false,
      },
      orderType === 'FOK' ? OrderType.FOK : OrderType.GTC
    );
    
    const latencyMs = Date.now() - startTime;
    
    // Parse response
    const resp: any = (response as any)?.data ?? response;
    
    if (resp == null) {
      return { success: false, error: 'Empty response', usedPreSigned: false, latencyMs };
    }
    
    const orderId = resp?.orderID || resp?.orderId || resp?.order_id || resp?.id;
    const avgPrice = resp?.averagePrice ?? resp?.avg_price ?? resp?.avgPrice;
    const filledSize = resp?.size_matched ?? resp?.sizeMatched ?? resp?.filledSize ?? resp?.filled ?? 0;
    
    return {
      success: !!orderId,
      orderId,
      avgPrice: avgPrice ? parseFloat(avgPrice) : undefined,
      filledSize: filledSize ? parseFloat(filledSize) : undefined,
      usedPreSigned: false,
      latencyMs,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    return { success: false, error: err?.message || String(err), usedPreSigned: false, latencyMs };
  }
}

// ============================================
// TELEMETRY & STATS
// ============================================

/**
 * Get cache statistics
 */
export function getCacheStats(): CacheStats & {
  hitRate: number;
  cacheAge: number;
  isInitialized: boolean;
  enabled: boolean;
} {
  const total = stats.cacheHits + stats.cacheMisses;
  const hitRate = total > 0 ? (stats.cacheHits / total) * 100 : 0;
  const cacheAge = stats.lastRefreshTime > 0 ? Date.now() - stats.lastRefreshTime : 0;
  
  return {
    ...stats,
    hitRate,
    cacheAge,
    isInitialized,
    enabled: config.enabled,
  };
}

/**
 * Log cache stats
 */
export function logCacheStats(): void {
  const stats = getCacheStats();
  log(`┌────────────────────────────────────────────────────`);
  log(`│ Pre-Signed Orders Cache Statistics`);
  log(`├────────────────────────────────────────────────────`);
  log(`│ Enabled:        ${stats.enabled ? '✅ YES' : '❌ NO'}`);
  log(`│ Initialized:    ${stats.isInitialized ? '✅ YES' : '❌ NO'}`);
  log(`│ Total Orders:   ${stats.totalPreSigned}`);
  log(`│ Cache Hits:     ${stats.cacheHits}`);
  log(`│ Cache Misses:   ${stats.cacheMisses}`);
  log(`│ Hit Rate:       ${stats.hitRate.toFixed(1)}%`);
  log(`│ Avg Sign Time:  ${stats.avgSignTimeMs.toFixed(1)}ms`);
  log(`│ Cache Age:      ${Math.round(stats.cacheAge / 1000)}s`);
  log(`│ Orders/Asset:`);
  for (const [asset, count] of Object.entries(stats.ordersPerAsset)) {
    log(`│   ${asset}: ${count}`);
  }
  log(`└────────────────────────────────────────────────────`);
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Update cache configuration
 */
export function updateConfig(newConfig: Partial<PreSignConfig>): void {
  config = { ...config, ...newConfig };
  log(`Config updated: ${JSON.stringify(newConfig)}`);
}

/**
 * Get current configuration
 */
export function getConfig(): PreSignConfig {
  return { ...config };
}

/**
 * Enable/disable the cache
 */
export function setEnabled(enabled: boolean): void {
  config.enabled = enabled;
  log(`Pre-signed orders cache ${enabled ? 'ENABLED' : 'DISABLED'}`);
  
  if (!enabled) {
    stopPreSignedCache();
  }
}

// ============================================
// EXPORTS
// ============================================

export {
  PreSignedOrder,
  PreSignConfig,
  CacheStats,
};
