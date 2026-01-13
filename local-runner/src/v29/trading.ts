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
  // Price levels to pre-sign (likely buy prices)
  priceLevels: [0.38, 0.40, 0.42, 0.44, 0.46, 0.48, 0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62],
  // Share sizes to pre-sign
  shareSizes: [3, 5, 10, 15],
  // Refresh every 5 minutes
  refreshIntervalMs: 5 * 60 * 1000,
  // Max age before order is considered stale
  maxOrderAgeMs: 30 * 60 * 1000,
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

/**
 * Place a BUY order - uses pre-signed cache for speed
 * Falls back to real-time signing if no cache hit
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
    const roundedPrice = Math.round(price * 100) / 100;
    const roundedShares = Math.floor(shares);
    
    if (roundedShares < 1) {
      return { success: false, error: 'Shares < 1', latencyMs: Date.now() - start };
    }
    
    let signedOrder: SignedOrder;
    let usedCache = false;
    
    // Try to get pre-signed order from cache
    if (asset && direction) {
      const cached = getPreSignedOrder(asset, direction, roundedPrice, roundedShares);
      if (cached) {
        signedOrder = cached.signedOrder;
        usedCache = true;
        log(`⚡ Cache hit: ${asset} ${direction} ${roundedShares}@${roundedPrice}`);
      }
    }
    
    // Fallback to real-time signing
    if (!usedCache) {
      log(`📝 Real-time sign: ${roundedShares}@${roundedPrice}`);
      signedOrder = await client.createOrder(
        { tokenID: tokenId, price: roundedPrice, size: roundedShares, side: Side.BUY },
        { tickSize: '0.01', negRisk: false }
      );
    }
    
    // POST the order (this is the only network call if cached)
    const response = await client.postOrder(signedOrder!, OrderType.GTC);
    
    const latencyMs = Date.now() - start;
    
    if (response.success) {
      log(`✅ Order placed: ${response.orderID ?? 'no-id'} (${latencyMs}ms, cache=${usedCache})`);
      return {
        success: true,
        orderId: response.orderID,
        avgPrice: roundedPrice,
        filledSize: roundedShares,
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
