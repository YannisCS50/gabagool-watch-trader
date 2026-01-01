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
  marketType: 'price_above' | 'price_target' | '1hour' | '15min' | 'other';
  strikePrice?: number | null; // Legacy alias for openPrice
  openPrice?: number | null;   // The "Price to Beat"
  previousClosePrice?: number | null; // Previous bet's close price (= next bet's target)
}

// Parse timestamp from slug (e.g., btc-updown-1h-1766485800 -> 1766485800)
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
    
    // Determine asset type from slug or question
    const slugLower = slug.toLowerCase();
    const questionLower = question.toLowerCase();
    let asset: 'BTC' | 'ETH' | 'SOL' | 'XRP' = 'BTC';
    if (slugLower.includes('eth') || slugLower.includes('ethereum') || questionLower.includes('ethereum')) {
      asset = 'ETH';
    } else if (slugLower.includes('sol') || questionLower.includes('solana')) {
      asset = 'SOL';
    } else if (slugLower.includes('xrp') || questionLower.includes('xrp')) {
      asset = 'XRP';
    }
    
    // Determine market type - "up-or-down" = hourly markets
    const isUpDown = slugLower.includes('up-or-down') || questionLower.includes('up or down');
    const is15Min = slugLower.includes('15m') || slugLower.includes('15min');
    const marketType = isUpDown ? '1hour' : is15Min ? '15min' : 'price_above';
    
    // Determine which token is Up/Yes vs Down/No
    const outcome1 = (outcomes[0] || '').toLowerCase();
    let upTokenId = clobTokenIds[0];
    let downTokenId = clobTokenIds[1];
    
    // If first outcome is "no" or "down", swap
    if (outcome1 === 'no' || outcome1 === 'down') {
      upTokenId = clobTokenIds[1];
      downTokenId = clobTokenIds[0];
    }
    
    // Get event times from the market API response
    const eventStartTime = market.startDate || market.gameStartTime || new Date().toISOString();
    const eventEndTime = market.endDate || market.endDateIso || new Date(Date.now() + 60 * 60000).toISOString();
    
    console.log(`[Gamma] Parsed market: ${asset} ${marketType} - ends ${eventEndTime}`);
    
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
 * Search for active 1-hour crypto markets (v5.1.0 - Real Polymarket slugs)
 * Polymarket uses slugs like: bitcoin-up-or-down-january-1-2am-et
 */
async function searchActive1hMarkets(): Promise<string[]> {
  const slugs: string[] = [];
  
  try {
    // Search events for "up or down" patterns (hourly crypto markets)
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
      
      // Real Polymarket 1-hour market patterns:
      // "bitcoin-up-or-down-january-1-2am-et" 
      // "ethereum-up-or-down-january-1-1pm-et"
      const isUpDown = eventSlug.includes('up-or-down') || 
                       title.includes('up or down');
      
      const isCrypto = eventSlug.includes('bitcoin') || 
                      eventSlug.includes('ethereum') ||
                      eventSlug.includes('btc') ||
                      eventSlug.includes('eth') ||
                      title.includes('bitcoin') ||
                      title.includes('ethereum');
      
      if (isUpDown && isCrypto) {
        console.log(`[Gamma] Found hourly crypto event: ${eventSlug}`);
        
        // Get markets from the event
        const markets = event.markets || [];
        for (const market of markets) {
          if (market.slug) {
            slugs.push(market.slug);
            console.log(`[Gamma] Added market slug: ${market.slug}`);
          }
        }
        
        // Also add the event slug itself
        if (event.slug && !slugs.includes(event.slug)) {
          slugs.push(event.slug);
        }
      }
    }
    
    // Also search markets directly for up-or-down patterns
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
        
        const isUpDown = marketSlug.includes('up-or-down') ||
                        question.includes('up or down');
        
        const isCrypto = marketSlug.includes('bitcoin') ||
                        marketSlug.includes('ethereum') ||
                        question.includes('bitcoin') ||
                        question.includes('ethereum');
        
        if (isUpDown && isCrypto && market.slug) {
          if (!slugs.includes(market.slug)) {
            slugs.push(market.slug);
            console.log(`[Gamma] Added market from direct search: ${market.slug}`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('[Gamma] Error searching markets:', error);
  }
  
  console.log(`[Gamma] Total hourly crypto slugs found: ${slugs.length}`);
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
      // v5.0.0: Search for 1-hour markets first
      const slugs = await searchActive1hMarkets();
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
    
    // Sort: 1-hour markets first, then 15min, then by end time
    markets.sort((a, b) => {
      if (a.marketType === '1hour' && b.marketType !== '1hour') return -1;
      if (a.marketType !== '1hour' && b.marketType === '1hour') return 1;
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
    
    // Also get previous interval close prices for fallback (1-hour intervals)
    const previousSlugs: string[] = [];
    for (const market of markets) {
      const slugTs = parseTimestampFromSlug(market.slug);
      if (slugTs) {
        // For 1-hour markets: previous interval is 1 hour ago
        const prevTs1h = slugTs - 60 * 60;
        // For 15-min markets: previous interval is 15 min ago
        const prevTs15m = slugTs - 15 * 60;
        const slugParts = market.slug.replace(/\d{10}$/, '');
        previousSlugs.push(`${slugParts}${prevTs1h}`);
        previousSlugs.push(`${slugParts}${prevTs15m}`);
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
      
      // Get previous close price for context (try both 1h and 15m intervals)
      let previousClosePrice: number | null = null;
      const slugTs = parseTimestampFromSlug(m.slug);
      if (slugTs) {
        const slugParts = m.slug.replace(/\d{10}$/, '');
        
        // Try 1-hour previous first, then 15-min
        const prevTs1h = slugTs - 60 * 60;
        const prevTs15m = slugTs - 15 * 60;
        previousClosePrice = prevPriceMap.get(`${slugParts}${prevTs1h}`) ?? 
                            prevPriceMap.get(`${slugParts}${prevTs15m}`) ?? null;
        
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
