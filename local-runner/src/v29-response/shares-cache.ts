/**
 * REALTIME SHARES CACHE
 * 
 * Tracks available shares per tokenId via WebSocket events.
 * This is the SINGLE SOURCE OF TRUTH for "how many shares can we sell?"
 * 
 * CRITICAL: This cache is updated INSTANTLY via UserChannel WebSocket,
 * so it's always ahead of any API polling.
 * 
 * The exit flow should use getAvailableShares() to know the exact
 * sellable amount WITHOUT making any blocking API calls.
 */

interface SharePosition {
  tokenId: string;
  shares: number;
  avgPrice: number;
  lastUpdated: number;
  // Track source of last update for debugging
  lastUpdateSource: 'ws_buy' | 'ws_sell' | 'api_sync' | 'entry_fill' | 'exit_fill' | 'manual';
}

// Main cache: tokenId -> SharePosition
const sharesCache = new Map<string, SharePosition>();

// Secondary index: asset+direction -> tokenId (for fast lookup)
const assetDirectionIndex = new Map<string, string>();

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [SharesCache] ${msg}`);
}

// ============================================
// REGISTRATION
// ============================================

/**
 * Register a market's tokens for tracking.
 * Call this when markets are loaded.
 */
export function registerToken(
  asset: string,
  direction: 'UP' | 'DOWN',
  tokenId: string
): void {
  const key = `${asset}-${direction}`;
  assetDirectionIndex.set(key, tokenId);
  
  // Initialize cache entry if not exists
  if (!sharesCache.has(tokenId)) {
    sharesCache.set(tokenId, {
      tokenId,
      shares: 0,
      avgPrice: 0,
      lastUpdated: 0,
      lastUpdateSource: 'manual',
    });
  }
}

/**
 * Get tokenId for an asset+direction
 */
export function getTokenId(asset: string, direction: 'UP' | 'DOWN'): string | undefined {
  return assetDirectionIndex.get(`${asset}-${direction}`);
}

// ============================================
// CACHE UPDATES (called by WebSocket handlers and entry/exit flows)
// ============================================

/**
 * Record a BUY fill - adds shares to cache
 */
export function onBuyFill(
  tokenId: string,
  shares: number,
  price: number,
  source: 'ws_buy' | 'entry_fill' = 'ws_buy'
): void {
  const existing = sharesCache.get(tokenId);
  const now = Date.now();
  
  if (existing && existing.shares > 0) {
    // Average in the new shares
    const totalShares = existing.shares + shares;
    const newAvgPrice = (existing.shares * existing.avgPrice + shares * price) / totalShares;
    
    existing.shares = totalShares;
    existing.avgPrice = newAvgPrice;
    existing.lastUpdated = now;
    existing.lastUpdateSource = source;
    
    log(`+BUY: ${tokenId.slice(0, 12)}... | +${shares.toFixed(2)} @ ${(price * 100).toFixed(1)}¢ → total ${totalShares.toFixed(2)} @ avg ${(newAvgPrice * 100).toFixed(1)}¢`);
  } else {
    // New position
    sharesCache.set(tokenId, {
      tokenId,
      shares,
      avgPrice: price,
      lastUpdated: now,
      lastUpdateSource: source,
    });
    log(`+BUY (new): ${tokenId.slice(0, 12)}... | ${shares.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
  }
}

/**
 * Record a SELL fill - removes shares from cache
 */
export function onSellFill(
  tokenId: string,
  shares: number,
  source: 'ws_sell' | 'exit_fill' = 'ws_sell'
): void {
  const existing = sharesCache.get(tokenId);
  const now = Date.now();
  
  if (existing) {
    const newShares = Math.max(0, existing.shares - shares);
    existing.shares = newShares;
    existing.lastUpdated = now;
    existing.lastUpdateSource = source;
    
    log(`-SELL: ${tokenId.slice(0, 12)}... | -${shares.toFixed(2)} → remaining ${newShares.toFixed(2)}`);
    
    // Clean up if zero
    if (newShares < 0.01) {
      log(`🧹 Position cleared: ${tokenId.slice(0, 12)}...`);
    }
  } else {
    log(`⚠️ SELL for unknown token: ${tokenId.slice(0, 12)}... (${shares} shares)`);
  }
}

/**
 * Sync from API - overwrites cache with authoritative data.
 * Only call this during startup or periodic reconciliation.
 */
export function syncFromApi(
  tokenId: string,
  shares: number,
  avgPrice: number
): void {
  const existing = sharesCache.get(tokenId);
  const now = Date.now();
  
  // If WebSocket updated more recently (within 2s), trust WebSocket
  if (existing && (now - existing.lastUpdated) < 2000 && 
      (existing.lastUpdateSource === 'ws_buy' || existing.lastUpdateSource === 'ws_sell')) {
    log(`API sync skipped for ${tokenId.slice(0, 12)}... - WS update is fresher (${now - existing.lastUpdated}ms ago)`);
    return;
  }
  
  const oldShares = existing?.shares ?? 0;
  
  sharesCache.set(tokenId, {
    tokenId,
    shares,
    avgPrice,
    lastUpdated: now,
    lastUpdateSource: 'api_sync',
  });
  
  if (Math.abs(oldShares - shares) > 0.01) {
    log(`API sync: ${tokenId.slice(0, 12)}... | ${oldShares.toFixed(2)} → ${shares.toFixed(2)} shares`);
  }
}

// ============================================
// CACHE READS (used by exit flow)
// ============================================

/**
 * Get available shares for a tokenId.
 * This is the FAST, NON-BLOCKING way to check shares before selling.
 */
export function getAvailableShares(tokenId: string): number {
  const position = sharesCache.get(tokenId);
  return position?.shares ?? 0;
}

/**
 * Get available shares by asset and direction.
 * Convenience method that looks up tokenId first.
 */
export function getAvailableSharesByAsset(asset: string, direction: 'UP' | 'DOWN'): number {
  const tokenId = getTokenId(asset, direction);
  if (!tokenId) return 0;
  return getAvailableShares(tokenId);
}

/**
 * Check if we can sell a specific amount.
 * Returns { canSell, available, shortfall }
 */
export function canSellShares(
  tokenId: string,
  wantedShares: number
): { canSell: boolean; available: number; shortfall: number } {
  const available = getAvailableShares(tokenId);
  const shortfall = Math.max(0, wantedShares - available);
  
  return {
    canSell: available >= wantedShares - 0.01, // Allow tiny tolerance
    available,
    shortfall,
  };
}

/**
 * Get the full cache position (for debugging)
 */
export function getPosition(tokenId: string): SharePosition | undefined {
  return sharesCache.get(tokenId);
}

/**
 * Get all cached positions (for dashboard/debugging)
 */
export function getAllPositions(): Map<string, SharePosition> {
  return new Map(sharesCache);
}

/**
 * Get cache stats
 */
export function getCacheStats(): {
  positionCount: number;
  totalShares: number;
  positions: Array<{ tokenId: string; shares: number; ageMs: number; source: string }>;
} {
  const now = Date.now();
  const positions: Array<{ tokenId: string; shares: number; ageMs: number; source: string }> = [];
  let totalShares = 0;
  
  for (const [tokenId, pos] of sharesCache) {
    if (pos.shares > 0.01) {
      positions.push({
        tokenId: tokenId.slice(0, 12) + '...',
        shares: pos.shares,
        ageMs: now - pos.lastUpdated,
        source: pos.lastUpdateSource,
      });
      totalShares += pos.shares;
    }
  }
  
  return {
    positionCount: positions.length,
    totalShares,
    positions,
  };
}

/**
 * Clear all cached positions (for shutdown/reset)
 */
export function clearCache(): void {
  sharesCache.clear();
  log('Cache cleared');
}

/**
 * Log current cache state
 */
export function logCacheState(): void {
  const stats = getCacheStats();
  log(`📊 Cache: ${stats.positionCount} positions, ${stats.totalShares.toFixed(2)} total shares`);
  for (const pos of stats.positions) {
    log(`   ${pos.tokenId} | ${pos.shares.toFixed(2)} shares | updated ${pos.ageMs}ms ago (${pos.source})`);
  }
}
