// ============================================================
// V35 MARKET DISCOVERY
// ============================================================
// Automatically find active 15-minute up/down markets via Gamma API.
// Uses candidate slug generation (epoch-based) for reliable discovery.
// ============================================================

import type { V35Asset } from './types.js';

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const SUPPORTED_ASSETS: V35Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];

export interface DiscoveredMarket {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  asset: V35Asset;
  expiry: Date;
}

/**
 * Generate candidate slugs based on 15-min epoch timestamps
 * Format: {asset}-updown-15m-{epoch}
 */
function generateCandidateSlugs(): string[] {
  const slugs: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const intervalSec = 15 * 60; // 15 minutes
  const baseSec = Math.floor(nowSec / intervalSec) * intervalSec;

  // Cover window around "now" to catch current/next/previous markets
  const offsets = [-2, -1, 0, 1, 2, 3, 4];
  const assets = ['btc', 'eth', 'sol', 'xrp'];

  for (const asset of assets) {
    for (const off of offsets) {
      const ts = baseSec + off * intervalSec;
      slugs.push(`${asset}-updown-15m-${ts}`);
    }
  }

  return slugs;
}

/**
 * Fetch a single market by slug - try both /markets and /events endpoints
 */
async function fetchMarketBySlug(slug: string): Promise<any | null> {
  // Try /markets/{slug} first
  try {
    const response = await fetch(`${GAMMA_URL}/markets/${slug}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data && !data.closed) return data;
    }
  } catch {}
  
  // Try /events/{slug} as fallback (returns event with markets array)
  try {
    const response = await fetch(`${GAMMA_URL}/events/${slug}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    
    if (response.ok) {
      const event = await response.json();
      // Event has markets array, return the first active market
      if (event?.markets?.length > 0) {
        const market = event.markets[0];
        return { ...market, tokens: event.markets.flatMap((m: any) => m.tokens || []) };
      }
    }
  } catch {}
  
  return null;
}

/**
 * Fetch active markets from search endpoint
 */
async function fetchActiveMarkets(): Promise<any[]> {
  const allMarkets: any[] = [];
  
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) {
    try {
      const url = `${GAMMA_URL}/markets?closed=false&active=true&tag=${asset}-updown`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      
      if (response.ok) {
        const markets = await response.json();
        if (Array.isArray(markets)) {
          console.log(`[MarketDiscovery] ${asset.toUpperCase()}: found ${markets.length} from tag search`);
          allMarkets.push(...markets);
        }
      }
    } catch (e) {
      console.log(`[MarketDiscovery] Tag search failed for ${asset}: ${e}`);
    }
  }
  
  return allMarkets;
}

/**
 * Extract asset from slug
 */
function extractAsset(slug: string): V35Asset | null {
  const lower = slug.toLowerCase();
  if (lower.startsWith('btc-') || lower.includes('-btc-')) return 'BTC';
  if (lower.startsWith('eth-') || lower.includes('-eth-')) return 'ETH';
  if (lower.startsWith('sol-') || lower.includes('-sol-')) return 'SOL';
  if (lower.startsWith('xrp-') || lower.includes('-xrp-')) return 'XRP';
  return null;
}

/**
 * Find all active 15-minute up/down markets using multiple discovery methods
 */
export async function discoverMarkets(minSecondsToExpiry: number = 180): Promise<DiscoveredMarket[]> {
  const markets: DiscoveredMarket[] = [];
  const seenSlugs = new Set<string>();
  
  // Method 1: Try tag-based search first (more reliable)
  console.log(`[MarketDiscovery] Trying tag-based search...`);
  const tagMarkets = await fetchActiveMarkets();
  
  for (const m of tagMarkets) {
    if (!m || m.closed || !m.active) continue;
    
    const slug = m.slug || m.market_slug || '';
    if (!slug.includes('-updown-15m-')) continue;
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    
    const parsed = parseMarket(m, slug, minSecondsToExpiry);
    if (parsed) markets.push(parsed);
  }
  
  // Method 2: Try candidate slugs if tag search found nothing
  if (markets.length === 0) {
    const candidateSlugs = generateCandidateSlugs();
    console.log(`[MarketDiscovery] Tag search found 0, checking ${candidateSlugs.length} candidate slugs...`);
    
    // Fetch in parallel (batched to avoid rate limits)
    const batchSize = 8;
    for (let i = 0; i < candidateSlugs.length; i += batchSize) {
      const batch = candidateSlugs.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(slug => fetchMarketBySlug(slug)));
      
      for (let j = 0; j < results.length; j++) {
        const m = results[j];
        if (!m) continue;
        
        const slug = batch[j];
        if (seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);
        
        const parsed = parseMarket(m, slug, minSecondsToExpiry);
        if (parsed) markets.push(parsed);
      }
    }
  }
  
  console.log(`[MarketDiscovery] Found ${markets.length} active 15m up/down markets`);
  return markets;
}

/**
 * Parse a market response into DiscoveredMarket
 */
function parseMarket(m: any, slug: string, minSecondsToExpiry: number): DiscoveredMarket | null {
  const asset = extractAsset(slug);
  if (!asset) return null;
  
  // Extract token IDs
  const tokens = m.tokens || m.clobTokenIds || [];
  if (tokens.length < 2 && !m.clobTokenIds) return null;
  
  let upTokenId: string | null = null;
  let downTokenId: string | null = null;
  
  // Handle tokens array format
  if (Array.isArray(tokens) && tokens.length >= 2) {
    for (const t of tokens) {
      if (typeof t === 'string') {
        // clobTokenIds format - first is usually "up", second is "down"
        if (!upTokenId) upTokenId = t;
        else if (!downTokenId) downTokenId = t;
      } else {
        const outcome = (t.outcome || '').toLowerCase();
        if (outcome === 'up' || outcome === 'yes') {
          upTokenId = t.token_id || t.tokenId;
        } else if (outcome === 'down' || outcome === 'no') {
          downTokenId = t.token_id || t.tokenId;
        }
      }
    }
  }
  
  // Try clobTokenIds array
  if ((!upTokenId || !downTokenId) && m.clobTokenIds?.length >= 2) {
    upTokenId = m.clobTokenIds[0];
    downTokenId = m.clobTokenIds[1];
  }
  
  if (!upTokenId || !downTokenId) {
    console.log(`[MarketDiscovery] ${slug}: missing token IDs`);
    return null;
  }
  
  // Parse expiry from endDate or slug
  let expiry: Date;
  const endDateIso = m.end_date_iso || m.endDate || m.endDateIso || '';
  
  if (endDateIso) {
    try {
      expiry = new Date(endDateIso.replace('Z', '+00:00'));
    } catch {
      return null;
    }
  } else {
    // Derive from slug timestamp + 15 min
    const match = slug.match(/-15m-(\d+)$/);
    if (!match) return null;
    const startSec = parseInt(match[1], 10);
    expiry = new Date((startSec + 900) * 1000);
  }
  
  if (isNaN(expiry.getTime())) return null;
  
  // Skip if too close to expiry or already expired
  const secondsToExpiry = (expiry.getTime() - Date.now()) / 1000;
  if (secondsToExpiry < minSecondsToExpiry) {
    console.log(`[MarketDiscovery] ${slug}: ${Math.round(secondsToExpiry)}s to expiry (min: ${minSecondsToExpiry})`);
    return null;
  }
  
  console.log(`[MarketDiscovery] ✅ ${slug}: ${Math.round(secondsToExpiry)}s to expiry, tokens: ${upTokenId.slice(0,8)}.../${downTokenId.slice(0,8)}...`);
  
  return {
    slug,
    conditionId: m.condition_id || m.conditionId || '',
    upTokenId,
    downTokenId,
    asset,
    expiry,
  };
}

/**
 * Filter markets by asset
 */
export function filterByAssets(markets: DiscoveredMarket[], assets: V35Asset[]): DiscoveredMarket[] {
  return markets.filter(m => assets.includes(m.asset));
}
