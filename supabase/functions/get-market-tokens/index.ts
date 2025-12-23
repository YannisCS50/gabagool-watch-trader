import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  strikePrice?: number | null; // Legacy alias for openPrice
  openPrice?: number | null;   // The "Price to Beat"
  previousClosePrice?: number | null; // Previous bet's close price (= next bet's target)
}

// Parse timestamp from slug (e.g., btc-updown-15m-1766485800 -> 1766485800)
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  return match ? parseInt(match[1], 10) : null;
}

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
    
    // Derive event times from slug for 15m markets (slug = truth)
    const slugTimestamp = parseTimestampFromSlug(slug);
    let eventStartTime: string;
    let eventEndTime: string;
    
    if (slugTimestamp && is15Min) {
      // Slug is truth - derive times from it
      eventStartTime = new Date(slugTimestamp * 1000).toISOString();
      eventEndTime = new Date((slugTimestamp + 15 * 60) * 1000).toISOString();
    } else {
      // Fallback to Gamma API times
      eventStartTime = market.startDate || market.gameStartTime || new Date().toISOString();
      eventEndTime = market.endDate || market.endDateIso || new Date(Date.now() + 15 * 60000).toISOString();
    }
    
    return {
      slug,
      question,
      asset,
      conditionId,
      upTokenId,
      downTokenId,
      eventStartTime,
      eventEndTime,
      marketType,
      strikePrice: null, // Will be populated from oracle data
      openPrice: null,
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
      
      // Look for 15-minute patterns
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
        const markets = event.markets || [];
        for (const market of markets) {
          if (market.slug) {
            slugs.push(market.slug);
          }
        }
        if (event.slug) {
          slugs.push(event.slug);
        }
      }
    }
    
    // Also search markets directly
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
  const intervals = [0, 1, 2, 3, 4];
  
  for (const offset of intervals) {
    const intervalMs = 15 * 60 * 1000;
    const intervalTime = Math.floor((now + offset * intervalMs) / intervalMs) * intervalMs;
    const intervalSecs = Math.floor(intervalTime / 1000);
    
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
  return [...new Set(slugs)];
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
        strikePrice: null,
        openPrice: null,
      });
    }
    
  } catch (error) {
    console.error('[Gamma] Error fetching price markets:', error);
  }
  
  return results.slice(0, 10);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== Fetching market tokens ===');

  try {
    let requestedSlug: string | null = null;
    try {
      const body = await req.json();
      requestedSlug = body.slug || null;
    } catch {
      // No body or invalid JSON
    }
    
    const markets: MarketToken[] = [];
    
    if (requestedSlug) {
      const market = await fetchMarketBySlug(requestedSlug);
      if (market) {
        markets.push(market);
      }
    } else {
      const slugs = await searchActive15mMarkets();
      const slugsToFetch = slugs.slice(0, 10);
      const fetchPromises = slugsToFetch.map(slug => fetchMarketBySlug(slug));
      const fetchResults = await Promise.all(fetchPromises);
      
      for (const result of fetchResults) {
        if (result) {
          markets.push(result);
        }
      }
      
      const priceMarkets = await fetchPriceMarkets();
      for (const pm of priceMarkets) {
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
    
    // Connect to Supabase for oracle prices
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const marketSlugs = markets.map(m => m.slug);
    
    // Fetch oracle prices from strike_prices (the reliable source)
    const { data: strikePrices } = await supabase
      .from('strike_prices')
      .select('market_slug, open_price, strike_price, close_price')
      .in('market_slug', marketSlugs);
    
    // Map prices
    interface StrikePriceData {
      market_slug: string;
      open_price: number | null;
      strike_price: number | null;
      close_price: number | null;
    }
    const strikePriceMap = new Map<string, StrikePriceData>();
    if (strikePrices) {
      for (const sp of strikePrices) {
        strikePriceMap.set(sp.market_slug, sp);
      }
    }
    
    // Also get previous interval close prices for fallback
    const previousSlugs: string[] = [];
    for (const market of markets) {
      const slugTs = parseTimestampFromSlug(market.slug);
      if (slugTs) {
        const prevTs = slugTs - 15 * 60;
        const slugParts = market.slug.replace(/\d{10}$/, '');
        previousSlugs.push(`${slugParts}${prevTs}`);
      }
    }
    
    const { data: prevPrices } = await supabase
      .from('strike_prices')
      .select('market_slug, close_price')
      .in('market_slug', previousSlugs);
    
    const prevPriceMap = new Map<string, number>();
    if (prevPrices) {
      for (const pp of prevPrices) {
        if (pp.close_price) {
          prevPriceMap.set(pp.market_slug, pp.close_price);
        }
      }
    }
    
    // Add open_price to markets - priority: current oracle > previous close
    const marketsWithPrice = markets.map(m => {
      const oracleData = strikePriceMap.get(m.slug);
      
      // Primary: current market's open_price from oracle
      let openPrice = oracleData?.open_price ?? oracleData?.strike_price ?? null;
      
      // Get previous close price for context
      let previousClosePrice: number | null = null;
      const slugTs = parseTimestampFromSlug(m.slug);
      if (slugTs) {
        const prevTs = slugTs - 15 * 60;
        const slugParts = m.slug.replace(/\d{10}$/, '');
        const prevSlug = `${slugParts}${prevTs}`;
        previousClosePrice = prevPriceMap.get(prevSlug) ?? null;
        
        // Fallback: previous interval's close_price (price to beat = prev close)
        if (openPrice === null && previousClosePrice) {
          openPrice = previousClosePrice;
          console.log(`[Price] Using prev close for ${m.slug}: $${openPrice}`);
        }
      }
      
      return {
        ...m,
        openPrice,
        strikePrice: openPrice, // Legacy alias
        previousClosePrice, // Expose for UI context
      };
    });
    
    const duration = Date.now() - startTime;
    console.log(`=== Found ${markets.length} markets in ${duration}ms ===`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs: duration,
      markets: marketsWithPrice
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
