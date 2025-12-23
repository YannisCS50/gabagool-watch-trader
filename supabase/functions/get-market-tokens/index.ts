import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MarketToken {
  slug: string;
  question: string;
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP';
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: 'price_above' | 'price_target' | '15min' | 'other';
}

/**
 * Fetch market by slug directly from Gamma API
 */
/**
 * Parse clobTokenIds which can be a string, array, or JSON string
 */
function parseClobTokenIds(raw: any): string[] {
  if (!raw) return [];
  
  // Already an array
  if (Array.isArray(raw)) {
    return raw.filter(id => typeof id === 'string' && id.length > 10);
  }
  
  // JSON string - parse it
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(id => typeof id === 'string' && id.length > 10);
      }
    } catch {
      // Not valid JSON, might be a single token ID
      if (raw.length > 10) return [raw];
    }
  }
  
  return [];
}

async function fetchMarketBySlug(slug: string): Promise<MarketToken | null> {
  try {
    console.log(`[Gamma] Fetching market by slug: ${slug}`);
    
    const response = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) {
      console.log(`[Gamma] Failed to fetch slug ${slug}: ${response.status}`);
      return null;
    }
    
    const markets = await response.json();
    
    if (!Array.isArray(markets) || markets.length === 0) {
      console.log(`[Gamma] No market found for slug: ${slug}`);
      return null;
    }
    
    const market = markets[0];
    const conditionId = market.conditionId || '';
    
    // Parse clobTokenIds properly - can be string or array
    const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
    
    const question = market.question || market.title || '';
    const outcomes = market.outcomes || ['Yes', 'No'];
    
    console.log(`[Gamma] Found market: ${question.slice(0, 50)}...`);
    console.log(`[Gamma] conditionId: ${conditionId}`);
    console.log(`[Gamma] Raw clobTokenIds type: ${typeof market.clobTokenIds}`);
    console.log(`[Gamma] Raw clobTokenIds: ${JSON.stringify(market.clobTokenIds)?.slice(0, 100)}`);
    console.log(`[Gamma] Parsed clobTokenIds: ${clobTokenIds.length} tokens`);
    
    if (clobTokenIds.length >= 2) {
      console.log(`[Gamma] Token 0: ${clobTokenIds[0].slice(0, 30)}...`);
      console.log(`[Gamma] Token 1: ${clobTokenIds[1].slice(0, 30)}...`);
    }
    
    if (clobTokenIds.length < 2) {
      console.log(`[Gamma] Not enough valid token IDs for slug: ${slug}`);
      return null;
    }
    
    // Determine asset type from slug
    const slugLower = slug.toLowerCase();
    let asset: 'BTC' | 'ETH' | 'SOL' | 'XRP' = 'BTC';
    if (slugLower.includes('eth')) asset = 'ETH';
    else if (slugLower.includes('sol')) asset = 'SOL';
    else if (slugLower.includes('xrp')) asset = 'XRP';
    
    // Determine market type
    const is15Min = slugLower.includes('15m') || slugLower.includes('updown');
    const marketType = is15Min ? '15min' : 'price_above';
    
    // Determine which token is Up/Yes vs Down/No
    const outcome1 = (outcomes[0] || '').toLowerCase();
    let upTokenId = clobTokenIds[0];
    let downTokenId = clobTokenIds[1];
    
    // If first outcome is "no" or "down", swap
    if (outcome1 === 'no' || outcome1 === 'down') {
      upTokenId = clobTokenIds[1];
      downTokenId = clobTokenIds[0];
    }
    
    console.log(`[Gamma] UP token: ${upTokenId.slice(0, 30)}...`);
    console.log(`[Gamma] DOWN token: ${downTokenId.slice(0, 30)}...`);
    
    return {
      slug,
      question,
      asset,
      conditionId,
      upTokenId,
      downTokenId,
      eventStartTime: market.startDate || market.gameStartTime || new Date().toISOString(),
      eventEndTime: market.endDate || market.endDateIso || new Date(Date.now() + 15 * 60000).toISOString(),
      marketType,
    };
    
  } catch (error) {
    console.error(`[Gamma] Error fetching slug ${slug}:`, error);
    return null;
  }
}

/**
 * Search for active 15-minute crypto markets
 */
async function searchActive15mMarkets(): Promise<string[]> {
  const slugs: string[] = [];
  
  try {
    // First, try to get active events with crypto/15m patterns
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200',
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) {
      console.log('[Gamma] Failed to fetch events:', response.status);
      return slugs;
    }
    
    const events = await response.json();
    console.log(`[Gamma] Fetched ${events.length} active events`);
    
    for (const event of events) {
      const eventSlug = (event.slug || '').toLowerCase();
      const title = (event.title || '').toLowerCase();
      
      // Look for 15-minute patterns: "15m", "updown", "up-down"
      const is15MinEvent = eventSlug.includes('15m') || 
                          eventSlug.includes('updown') ||
                          title.includes('15 min') ||
                          title.includes('15-min');
      
      // Check if it's crypto related
      const isCrypto = eventSlug.includes('btc') || 
                      eventSlug.includes('eth') ||
                      eventSlug.includes('bitcoin') ||
                      eventSlug.includes('ethereum') ||
                      title.includes('bitcoin') ||
                      title.includes('ethereum');
      
      if (is15MinEvent && isCrypto) {
        console.log(`[Gamma] Found 15m event: ${event.slug}`);
        
        // Get market slugs from the event
        const markets = event.markets || [];
        for (const market of markets) {
          if (market.slug) {
            slugs.push(market.slug);
          }
        }
        
        // Also add event slug as a potential market slug
        if (event.slug) {
          slugs.push(event.slug);
        }
      }
    }
    
    // Also search markets directly for 15m patterns
    const marketsResponse = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200',
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (marketsResponse.ok) {
      const markets = await marketsResponse.json();
      console.log(`[Gamma] Fetched ${markets.length} active markets`);
      
      for (const market of markets) {
        const marketSlug = (market.slug || '').toLowerCase();
        const question = (market.question || '').toLowerCase();
        
        const is15MinMarket = marketSlug.includes('15m') ||
                             marketSlug.includes('updown') ||
                             question.includes('15 min');
        
        const isCrypto = marketSlug.includes('btc') ||
                        marketSlug.includes('eth') ||
                        question.includes('bitcoin') ||
                        question.includes('ethereum');
        
        if (is15MinMarket && isCrypto && market.slug) {
          if (!slugs.includes(market.slug)) {
            console.log(`[Gamma] Found 15m market: ${market.slug}`);
            slugs.push(market.slug);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Gamma] Error searching markets:', error);
  }
  
  // Also try known slug patterns for current time
  const now = Date.now();
  const intervals = [0, 1, 2, 3, 4]; // Check current and next few 15-min intervals
  
  for (const offset of intervals) {
    // 15-minute intervals: round to nearest 15 min
    const intervalMs = 15 * 60 * 1000;
    const intervalTime = Math.floor((now + offset * intervalMs) / intervalMs) * intervalMs;
    const intervalSecs = Math.floor(intervalTime / 1000);
    
    // Try different slug patterns
    const patterns = [
      `btc-updown-15m-${intervalSecs}`,
      `eth-updown-15m-${intervalSecs}`,
      `btc-15m-${intervalSecs}`,
      `eth-15m-${intervalSecs}`,
    ];
    
    for (const pattern of patterns) {
      if (!slugs.includes(pattern)) {
        slugs.push(pattern);
      }
    }
  }
  
  console.log(`[Gamma] Total slugs to check: ${slugs.length}`);
  return [...new Set(slugs)]; // Dedupe
}

/**
 * Fetch crypto price markets ("Bitcoin above X on date Y")
 */
async function fetchPriceMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  
  try {
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100',
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) return results;
    
    const markets = await response.json();
    
    for (const market of markets) {
      const question = (market.question || '').toLowerCase();
      const slug = market.slug || '';
      
      // Match "bitcoin above" or "ethereum above" markets
      const isBtcAbove = question.includes('bitcoin') && question.includes('above');
      const isEthAbove = question.includes('ethereum') && question.includes('above');
      
      if (!isBtcAbove && !isEthAbove) continue;
      
      const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
      if (clobTokenIds.length < 2) continue;
      
      const outcomes = market.outcomes || ['Yes', 'No'];
      const outcome1 = (outcomes[0] || '').toLowerCase();
      
      let upTokenId = clobTokenIds[0];
      let downTokenId = clobTokenIds[1];
      
      if (outcome1 === 'no') {
        upTokenId = clobTokenIds[1];
        downTokenId = clobTokenIds[0];
      }
      
      console.log(`[Gamma] Found price market: ${question.slice(0, 60)}...`);
      console.log(`[Gamma] UP: ${upTokenId.slice(0, 30)}... DOWN: ${downTokenId.slice(0, 30)}...`);
      
      results.push({
        slug,
        question: market.question || '',
        asset: isBtcAbove ? 'BTC' : 'ETH',
        conditionId: market.conditionId || '',
        upTokenId,
        downTokenId,
        eventStartTime: market.startDate || new Date().toISOString(),
        eventEndTime: market.endDate || new Date(Date.now() + 24 * 60 * 60000).toISOString(),
        marketType: 'price_above',
      });
    }
    
  } catch (error) {
    console.error('[Gamma] Error fetching price markets:', error);
  }
  
  return results.slice(0, 10); // Limit to 10 price markets
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== Fetching market tokens ===');

  try {
    // Parse request body for optional slug parameter
    let requestedSlug: string | null = null;
    try {
      const body = await req.json();
      requestedSlug = body.slug || null;
    } catch {
      // No body or invalid JSON - that's fine
    }
    
    const markets: MarketToken[] = [];
    
    if (requestedSlug) {
      // Fetch specific market by slug
      console.log(`[Get Tokens] Fetching specific slug: ${requestedSlug}`);
      const market = await fetchMarketBySlug(requestedSlug);
      if (market) {
        markets.push(market);
      }
    } else {
      // Search for active 15m markets
      const slugs = await searchActive15mMarkets();
      
      // Fetch each slug in parallel (limit to first 10)
      const slugsToFetch = slugs.slice(0, 10);
      const fetchPromises = slugsToFetch.map(slug => fetchMarketBySlug(slug));
      const fetchResults = await Promise.all(fetchPromises);
      
      for (const result of fetchResults) {
        if (result) {
          markets.push(result);
        }
      }
      
      // Also fetch some price markets as fallback
      const priceMarkets = await fetchPriceMarkets();
      for (const pm of priceMarkets) {
        // Don't add duplicates
        if (!markets.find(m => m.slug === pm.slug)) {
          markets.push(pm);
        }
      }
    }
    
    // Sort: 15min markets first, then by end time
    markets.sort((a, b) => {
      if (a.marketType === '15min' && b.marketType !== '15min') return -1;
      if (a.marketType !== '15min' && b.marketType === '15min') return 1;
      return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
    });
    
    const duration = Date.now() - startTime;
    console.log(`=== Found ${markets.length} markets in ${duration}ms ===`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs: duration,
      markets
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
      markets: []
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
