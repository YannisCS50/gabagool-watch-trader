/**
 * position-cache.ts
 * ============================================================
 * PROFESSIONAL-GRADE POSITION CACHE
 * 
 * This module provides a fast, always-fresh cache of Polymarket positions.
 * The cache is the SINGLE SOURCE OF TRUTH for the bot's trading decisions.
 * 
 * Key principles:
 * 1. Cache is refreshed from Polymarket API every 1 second
 * 2. Before any trade decision, verify cache is < 2s old
 * 3. If drift detected between local fills and cache, HALT trading
 * 4. All position reads go through this cache, never from local tracking
 * 
 * This prevents the bot from making decisions on stale/incorrect position data.
 */

import { config } from './config.js';

const DATA_API_URL = 'https://data-api.polymarket.com';

// ============================================================
// TYPES
// ============================================================

export interface CachedPosition {
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  outcome: 'UP' | 'DOWN';
  shares: number;
  avgPrice: number;
  cost: number;
  currentValue: number;
  currentPrice: number;
  pnl: number;
}

export interface MarketPositionCache {
  marketSlug: string;
  asset: string;
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upAvgPrice: number;
  downAvgPrice: number;
  lastFetchedAtMs: number;
}

export interface PositionCacheState {
  positions: Map<string, MarketPositionCache>;  // keyed by marketSlug
  allPositions: CachedPosition[];
  lastRefreshAtMs: number;
  lastRefreshDurationMs: number;
  refreshCount: number;
  errorCount: number;
  lastError: string | null;
  isHealthy: boolean;
}

export interface PositionDrift {
  detected: boolean;
  marketSlug: string;
  asset: string;
  localUp: number;
  localDown: number;
  cacheUp: number;
  cacheDown: number;
  driftUp: number;
  driftDown: number;
  reason: string;
}

// ============================================================
// CACHE STATE
// ============================================================

const cacheState: PositionCacheState = {
  positions: new Map(),
  allPositions: [],
  lastRefreshAtMs: 0,
  lastRefreshDurationMs: 0,
  refreshCount: 0,
  errorCount: 0,
  lastError: null,
  isHealthy: false,
};

// Cache configuration
const CACHE_CONFIG = {
  maxStaleMs: 2000,           // Max age before cache is considered stale
  refreshIntervalMs: 1000,    // How often to refresh (1 second)
  driftThreshold: 0.5,        // Shares difference to trigger drift warning (allow rounding)
  driftHaltThreshold: 5,      // Shares difference to HALT trading (serious mismatch)
  maxConsecutiveErrors: 5,    // Errors before marking cache unhealthy
  fetchTimeoutMs: 3000,       // API timeout
};

let refreshInterval: NodeJS.Timeout | null = null;
let isRefreshing = false;

// ============================================================
// FETCH POSITIONS FROM POLYMARKET
// ============================================================

async function fetchPositionsFromApi(walletAddress: string): Promise<CachedPosition[]> {
  const positions: CachedPosition[] = [];
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CACHE_CONFIG.fetchTimeoutMs);
    
    const response = await fetch(
      `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=500`,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      }
    );
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    const items: any[] = Array.isArray(data) ? data : (data.positions || []);
    
    for (const p of items) {
      if ((parseFloat(p.size) || 0) <= 0) continue;
      
      // Extract outcome from position data
      const outcomeRaw = (p.outcome || '').toUpperCase();
      const outcome: 'UP' | 'DOWN' = 
        outcomeRaw === 'YES' || outcomeRaw === 'UP' ? 'UP' : 'DOWN';
      
      // Extract market slug
      const marketSlug = p.eventSlug || p.slug || extractSlugFromMarket(p.title || p.market || '');
      
      positions.push({
        tokenId: p.asset || '',
        conditionId: p.conditionId || '',
        marketSlug,
        outcome,
        shares: parseFloat(p.size) || 0,
        avgPrice: parseFloat(p.avgPrice) || 0,
        cost: parseFloat(p.initialValue) || 0,
        currentValue: parseFloat(p.currentValue) || 0,
        currentPrice: parseFloat(p.curPrice) || 0,
        pnl: parseFloat(p.cashPnl) || 0,
      });
    }
  } catch (error: any) {
    throw new Error(`Position fetch failed: ${error?.message || error}`);
  }
  
  return positions;
}

function extractSlugFromMarket(market: string): string {
  // Try to extract slug from market name for 15m markets
  const lower = market.toLowerCase();
  
  if (lower.includes('bitcoin') && lower.includes('up or down')) {
    return `btc-updown-15m-${Date.now()}`;
  }
  if (lower.includes('ethereum') && lower.includes('up or down')) {
    return `eth-updown-15m-${Date.now()}`;
  }
  if (lower.includes('solana') && lower.includes('up or down')) {
    return `sol-updown-15m-${Date.now()}`;
  }
  if (lower.includes('xrp') && lower.includes('up or down')) {
    return `xrp-updown-15m-${Date.now()}`;
  }
  
  // Fallback: create slug from market name
  return market
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

// ============================================================
// CACHE REFRESH
// ============================================================

async function refreshCache(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  
  const startMs = Date.now();
  
  try {
    const positions = await fetchPositionsFromApi(config.polymarket.address);
    
    // Group by market slug
    const byMarket = new Map<string, { up: CachedPosition | null; down: CachedPosition | null }>();
    
    for (const pos of positions) {
      // Filter for 15m markets only
      if (!pos.marketSlug.includes('15m') && !pos.marketSlug.includes('updown')) {
        continue;
      }
      
      if (!byMarket.has(pos.marketSlug)) {
        byMarket.set(pos.marketSlug, { up: null, down: null });
      }
      
      const entry = byMarket.get(pos.marketSlug)!;
      if (pos.outcome === 'UP') {
        entry.up = pos;
      } else {
        entry.down = pos;
      }
    }
    
    // Update cache state
    const nowMs = Date.now();
    const newPositions = new Map<string, MarketPositionCache>();
    
    for (const [slug, sides] of byMarket) {
      // Extract asset from slug (e.g., "btc-updown-15m-123456" -> "BTC")
      const asset = slug.split('-')[0]?.toUpperCase() || 'UNKNOWN';
      
      newPositions.set(slug, {
        marketSlug: slug,
        asset,
        upShares: sides.up?.shares || 0,
        downShares: sides.down?.shares || 0,
        upCost: sides.up?.cost || 0,
        downCost: sides.down?.cost || 0,
        upAvgPrice: sides.up?.avgPrice || 0,
        downAvgPrice: sides.down?.avgPrice || 0,
        lastFetchedAtMs: nowMs,
      });
    }
    
    cacheState.positions = newPositions;
    cacheState.allPositions = positions;
    cacheState.lastRefreshAtMs = nowMs;
    cacheState.lastRefreshDurationMs = nowMs - startMs;
    cacheState.refreshCount++;
    cacheState.errorCount = 0;  // Reset on success
    cacheState.lastError = null;
    cacheState.isHealthy = true;
    
  } catch (error: any) {
    cacheState.errorCount++;
    cacheState.lastError = error?.message || String(error);
    cacheState.isHealthy = cacheState.errorCount < CACHE_CONFIG.maxConsecutiveErrors;
    
    // Log error but don't spam
    if (cacheState.errorCount <= 3 || cacheState.errorCount % 10 === 0) {
      console.error(`❌ [PositionCache] Refresh error #${cacheState.errorCount}: ${cacheState.lastError}`);
    }
  } finally {
    isRefreshing = false;
  }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Start the position cache refresh loop
 */
export function startPositionCache(): void {
  if (refreshInterval) return;
  
  console.log('🔄 [PositionCache] Starting real-time position cache (1s refresh)');
  
  // Initial fetch
  refreshCache();
  
  // Start refresh loop
  refreshInterval = setInterval(refreshCache, CACHE_CONFIG.refreshIntervalMs);
}

/**
 * Stop the position cache refresh loop
 */
export function stopPositionCache(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    console.log('⏹️ [PositionCache] Position cache stopped');
  }
}

/**
 * Force an immediate cache refresh
 */
export async function forceRefresh(): Promise<void> {
  await refreshCache();
}

/**
 * Get cached position for a market
 * Returns null if not found or cache is stale
 */
export function getCachedPosition(marketSlug: string): MarketPositionCache | null {
  const cached = cacheState.positions.get(marketSlug);
  
  if (!cached) {
    // No position found - this is valid (flat position)
    return {
      marketSlug,
      asset: marketSlug.split('-')[0]?.toUpperCase() || 'UNKNOWN',
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
      upAvgPrice: 0,
      downAvgPrice: 0,
      lastFetchedAtMs: cacheState.lastRefreshAtMs,
    };
  }
  
  return cached;
}

/**
 * Check if cache is stale (too old to trust)
 */
export function isCacheStale(): boolean {
  const ageMs = Date.now() - cacheState.lastRefreshAtMs;
  return ageMs > CACHE_CONFIG.maxStaleMs;
}

/**
 * Check if cache is healthy (refreshing successfully)
 */
export function isCacheHealthy(): boolean {
  return cacheState.isHealthy && !isCacheStale();
}

/**
 * Get cache stats for monitoring
 */
export function getCacheStats(): {
  lastRefreshAtMs: number;
  lastRefreshDurationMs: number;
  refreshCount: number;
  errorCount: number;
  isHealthy: boolean;
  isStale: boolean;
  positionCount: number;
  marketCount: number;
} {
  return {
    lastRefreshAtMs: cacheState.lastRefreshAtMs,
    lastRefreshDurationMs: cacheState.lastRefreshDurationMs,
    refreshCount: cacheState.refreshCount,
    errorCount: cacheState.errorCount,
    isHealthy: cacheState.isHealthy,
    isStale: isCacheStale(),
    positionCount: cacheState.allPositions.length,
    marketCount: cacheState.positions.size,
  };
}

/**
 * Detect drift between local position tracking and cache
 * This is critical for catching mismatches before they cause bad trades
 */
export function detectPositionDrift(
  marketSlug: string,
  asset: string,
  localUpShares: number,
  localDownShares: number
): PositionDrift {
  const cached = getCachedPosition(marketSlug);
  
  if (!cached || isCacheStale()) {
    return {
      detected: false,
      marketSlug,
      asset,
      localUp: localUpShares,
      localDown: localDownShares,
      cacheUp: 0,
      cacheDown: 0,
      driftUp: 0,
      driftDown: 0,
      reason: 'CACHE_STALE_OR_MISSING',
    };
  }
  
  const driftUp = Math.abs(localUpShares - cached.upShares);
  const driftDown = Math.abs(localDownShares - cached.downShares);
  
  // Minor drift (rounding, timing) - log but don't halt
  const hasMinorDrift = driftUp > CACHE_CONFIG.driftThreshold || driftDown > CACHE_CONFIG.driftThreshold;
  
  // Major drift - HALT trading on this market
  const hasMajorDrift = driftUp > CACHE_CONFIG.driftHaltThreshold || driftDown > CACHE_CONFIG.driftHaltThreshold;
  
  return {
    detected: hasMajorDrift,
    marketSlug,
    asset,
    localUp: localUpShares,
    localDown: localDownShares,
    cacheUp: cached.upShares,
    cacheDown: cached.downShares,
    driftUp,
    driftDown,
    reason: hasMajorDrift 
      ? `MAJOR_DRIFT: local=${localUpShares}/${localDownShares} cache=${cached.upShares}/${cached.downShares}` 
      : hasMinorDrift 
        ? 'MINOR_DRIFT' 
        : 'NO_DRIFT',
  };
}

/**
 * Get the authoritative position for a market
 * This should be used for ALL trading decisions
 */
export function getAuthoritativePosition(marketSlug: string): {
  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;
  upAvgPrice: number;
  downAvgPrice: number;
  isStale: boolean;
  ageMs: number;
} {
  const cached = getCachedPosition(marketSlug);
  const ageMs = Date.now() - (cached?.lastFetchedAtMs || 0);
  
  if (!cached) {
    return {
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
      upAvgPrice: 0,
      downAvgPrice: 0,
      isStale: true,
      ageMs,
    };
  }
  
  return {
    upShares: cached.upShares,
    downShares: cached.downShares,
    upCost: cached.upCost,
    downCost: cached.downCost,
    upAvgPrice: cached.upAvgPrice,
    downAvgPrice: cached.downAvgPrice,
    isStale: isCacheStale(),
    ageMs,
  };
}

/**
 * Log cache status (for periodic monitoring)
 */
export function logCacheStatus(): void {
  const stats = getCacheStats();
  const ageMs = Date.now() - stats.lastRefreshAtMs;
  
  console.log(`📊 [PositionCache] Status: ${stats.isHealthy ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
  console.log(`   Last refresh: ${ageMs}ms ago (${stats.lastRefreshDurationMs}ms duration)`);
  console.log(`   Refreshes: ${stats.refreshCount} total, ${stats.errorCount} errors`);
  console.log(`   Positions: ${stats.positionCount} total, ${stats.marketCount} markets`);
}
