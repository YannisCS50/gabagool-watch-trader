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
 * Fetch a single market by slug
 */
async function fetchMarketBySlug(slug: string): Promise<any | null> {
  try {
    const response = await fetch(`${GAMMA_URL}/markets/${slug}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
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
 * Find all active 15-minute up/down markets using candidate slug approach
 */
export async function discoverMarkets(minSecondsToExpiry: number = 180): Promise<DiscoveredMarket[]> {
  const markets: DiscoveredMarket[] = [];
  const candidateSlugs = generateCandidateSlugs();
  
  console.log(`[MarketDiscovery] Checking ${candidateSlugs.length} candidate slugs...`);
  
  // Fetch in parallel (batched to avoid rate limits)
  const batchSize = 8;
  for (let i = 0; i < candidateSlugs.length; i += batchSize) {
    const batch = candidateSlugs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(slug => fetchMarketBySlug(slug)));
    
    for (let j = 0; j < results.length; j++) {
      const m = results[j];
      if (!m || m.closed || !m.active) continue;
      
      const slug = batch[j];
      const asset = extractAsset(slug);
      if (!asset) continue;
      
      // Extract token IDs
      const tokens = m.tokens || [];
      if (tokens.length < 2) continue;
      
      let upTokenId: string | null = null;
      let downTokenId: string | null = null;
      
      for (const t of tokens) {
        const outcome = (t.outcome || '').toLowerCase();
        if (outcome === 'up' || outcome === 'yes') {
          upTokenId = t.token_id;
        } else if (outcome === 'down' || outcome === 'no') {
          downTokenId = t.token_id;
        }
      }
      
      if (!upTokenId || !downTokenId) continue;
      
      // Parse expiry
      const endDateIso = m.end_date_iso || m.endDate || '';
      let expiry: Date;
      try {
        expiry = new Date(endDateIso.replace('Z', '+00:00'));
        if (isNaN(expiry.getTime())) continue;
      } catch {
        continue;
      }
      
      // Skip if too close to expiry or already expired
      const secondsToExpiry = (expiry.getTime() - Date.now()) / 1000;
      if (secondsToExpiry < minSecondsToExpiry) continue;
      
      markets.push({
        slug,
        conditionId: m.condition_id || m.conditionId || '',
        upTokenId,
        downTokenId,
        asset,
        expiry,
      });
    }
  }
  
  console.log(`[MarketDiscovery] Found ${markets.length} active 15m up/down markets`);
  return markets;
}

/**
 * Filter markets by asset
 */
export function filterByAssets(markets: DiscoveredMarket[], assets: V35Asset[]): DiscoveredMarket[] {
  return markets.filter(m => assets.includes(m.asset));
}
