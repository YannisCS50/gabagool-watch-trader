// ============================================================
// V35 MARKET DISCOVERY
// ============================================================
// Automatically find active 15-minute up/down markets via Gamma API.
// Filters for BTC, ETH, SOL, XRP assets.
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
 * Extract asset from market slug
 */
function extractAsset(slug: string): V35Asset | null {
  const lower = slug.toLowerCase();
  
  if (lower.includes('btc') || lower.includes('bitcoin')) return 'BTC';
  if (lower.includes('eth') || lower.includes('ethereum')) return 'ETH';
  if (lower.includes('sol') || lower.includes('solana')) return 'SOL';
  if (lower.includes('xrp')) return 'XRP';
  
  return null;
}

/**
 * Check if slug indicates a 15-minute up/down market
 */
function is15mUpDownMarket(slug: string): boolean {
  const lower = slug.toLowerCase();
  return lower.includes('updown-15m') || 
         lower.includes('up-or-down') ||
         (lower.includes('15') && lower.includes('minute') && (lower.includes('up') || lower.includes('down')));
}

/**
 * Find all active 15-minute up/down markets
 */
export async function discoverMarkets(minSecondsToExpiry: number = 180): Promise<DiscoveredMarket[]> {
  const markets: DiscoveredMarket[] = [];
  
  try {
    const response = await fetch(`${GAMMA_URL}/markets?active=true&closed=false`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      console.error(`[MarketDiscovery] Gamma API error: ${response.status}`);
      return [];
    }
    
    const data = await response.json();
    
    for (const m of data) {
      const slug = m.slug || '';
      
      // Filter for 15-min up/down markets
      if (!is15mUpDownMarket(slug)) {
        continue;
      }
      
      // Check asset
      const asset = extractAsset(slug);
      if (!asset || !SUPPORTED_ASSETS.includes(asset)) {
        continue;
      }
      
      // Extract token IDs
      const tokens = m.tokens || [];
      if (tokens.length < 2) {
        continue;
      }
      
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
      
      if (!upTokenId || !downTokenId) {
        continue;
      }
      
      // Parse expiry
      const endDateIso = m.end_date_iso || m.endDate || '';
      let expiry: Date;
      try {
        expiry = new Date(endDateIso.replace('Z', '+00:00'));
        if (isNaN(expiry.getTime())) {
          continue;
        }
      } catch {
        continue;
      }
      
      // Skip if too close to expiry or already expired
      const secondsToExpiry = (expiry.getTime() - Date.now()) / 1000;
      if (secondsToExpiry < minSecondsToExpiry) {
        continue;
      }
      
      markets.push({
        slug,
        conditionId: m.condition_id || m.conditionId || '',
        upTokenId,
        downTokenId,
        asset,
        expiry,
      });
    }
    
    console.log(`[MarketDiscovery] Found ${markets.length} active 15m up/down markets`);
    
  } catch (error: any) {
    console.error(`[MarketDiscovery] Error fetching markets:`, error?.message || error);
  }
  
  return markets;
}

/**
 * Filter markets by asset
 */
export function filterByAssets(markets: DiscoveredMarket[], assets: V35Asset[]): DiscoveredMarket[] {
  return markets.filter(m => assets.includes(m.asset));
}
