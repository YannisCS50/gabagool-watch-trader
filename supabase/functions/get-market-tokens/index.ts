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
  marketType: 'price_above' | 'price_target' | '1hour' | '15min' | '5min' | '4hour' | 'other';
  strikePrice?: number | null;
  openPrice?: number | null;
  previousClosePrice?: number | null;
}

/**
 * Parse clobTokenIds which can be a string, array, or JSON string
 */
function parseClobTokenIds(raw: any): string[] {
  if (!raw) return [];
  
  if (Array.isArray(raw)) {
    return raw.filter(id => typeof id === 'string' && id.length > 10);
  }
  
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(id => typeof id === 'string' && id.length > 10);
      }
    } catch {
      if (raw.length > 10) return [raw];
    }
  }
  
  return [];
}

/**
 * Determine market type from slug
 */
function getMarketType(slug: string): MarketToken['marketType'] {
  const slugLower = slug.toLowerCase();
  
  // Check for time-based patterns in slug
  if (slugLower.includes('-5m-') || slugLower.includes('5min')) return '5min';
  if (slugLower.includes('-15m-') || slugLower.includes('15min')) return '15min';
  if (slugLower.includes('-4h-') || slugLower.includes('4hour')) return '4hour';
  if (slugLower.includes('-1h-')) return '1hour';
  
  // Hourly human-readable slugs like "bitcoin-up-or-down-january-1-2am-et"
  if (slugLower.includes('up-or-down') && (slugLower.includes('am-et') || slugLower.includes('pm-et'))) {
    return '1hour';
  }
  
  if (slugLower.includes('above')) return 'price_above';
  
  return 'other';
}

/**
 * Check if a market is currently active (not expired)
 */
function isMarketActive(endTimeStr: string): boolean {
  const endTime = new Date(endTimeStr).getTime();
  const now = Date.now();
  // Must end in the future (with 1min buffer for processing)
  return endTime > (now - 60000);
}

/**
 * Fetch a specific market by slug from Gamma API
 */
async function fetchMarketBySlug(slug: string): Promise<MarketToken | null> {
  try {
    const response = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) {
      console.log(`[Gamma] Failed to fetch slug ${slug}: ${response.status}`);
      return null;
    }
    
    const markets = await response.json();
    
    if (!Array.isArray(markets) || markets.length === 0) {
      return null;
    }
    
    const market = markets[0];
    const conditionId = market.conditionId || '';
    const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
    const question = market.question || market.title || '';
    const outcomes = market.outcomes || ['Yes', 'No'];
    
    if (clobTokenIds.length < 2) {
      console.log(`[Gamma] Not enough valid token IDs for slug: ${slug}`);
      return null;
    }
    
    // Determine asset type
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
    
    // Get market type
    const marketType = getMarketType(slug);
    
    // Determine which token is Up/Yes vs Down/No
    const outcome1 = (outcomes[0] || '').toLowerCase();
    let upTokenId = clobTokenIds[0];
    let downTokenId = clobTokenIds[1];
    
    if (outcome1 === 'no' || outcome1 === 'down') {
      upTokenId = clobTokenIds[1];
      downTokenId = clobTokenIds[0];
    }
    
    // Get event times
    const eventStartTime = market.startDate || market.gameStartTime || new Date().toISOString();
    const eventEndTime = market.endDate || market.endDateIso || new Date(Date.now() + 60 * 60000).toISOString();
    
    // Filter: Only return if market is still active
    if (!isMarketActive(eventEndTime)) {
      console.log(`[Gamma] Skipping expired market: ${slug} (ends ${eventEndTime})`);
      return null;
    }
    
    console.log(`[Gamma] ✓ Active market: ${asset} ${marketType} - ${slug} (ends ${eventEndTime})`);
    
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
      strikePrice: null,
      openPrice: null,
    };
    
  } catch (error) {
    console.error(`[Gamma] Error fetching slug ${slug}:`, error);
    return null;
  }
}

/**
 * Search for active 1-hour crypto markets (v6.0 - Fixed filtering)
 */
async function searchActive1hMarkets(): Promise<string[]> {
  const slugs: string[] = [];
  const now = Date.now();
  
  try {
    // Method 1: Search events with tag_slug filter for crypto
    const cryptoTags = ['bitcoin', 'ethereum'];
    
    for (const tag of cryptoTags) {
      try {
        const response = await fetch(
          `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&tag_slug=${tag}`,
          { headers: { 'Accept': 'application/json' } }
        );
        
        if (response.ok) {
          const events = await response.json();
          console.log(`[Gamma] Fetched ${events.length} events for tag: ${tag}`);
          
          for (const event of events) {
            const eventSlug = (event.slug || '').toLowerCase();
            const title = (event.title || '').toLowerCase();
            
            // Only consider "up or down" hourly patterns - NOT 5m/15m/4h
            const isUpDown = eventSlug.includes('up-or-down') || title.includes('up or down');
            const is5min = eventSlug.includes('-5m-') || eventSlug.includes('5min');
            const is15min = eventSlug.includes('-15m-') || eventSlug.includes('15min');
            const is4hour = eventSlug.includes('-4h-') || eventSlug.includes('4hour');
            
            // Skip non-1hour markets
            if (!isUpDown || is5min || is15min || is4hour) continue;
            
            // Check if event is active (endDate > now)
            const eventEndDate = event.endDate || event.endDateIso;
            if (eventEndDate && new Date(eventEndDate).getTime() < now) {
              continue; // Skip expired events
            }
            
            console.log(`[Gamma] Found 1h event: ${eventSlug}`);
            
            // Add markets from this event
            const markets = event.markets || [];
            for (const market of markets) {
              const marketSlug = market.slug || '';
              const marketEnd = market.endDate || market.endDateIso;
              
              // Double-check market is active
              if (marketEnd && new Date(marketEnd).getTime() < now) continue;
              
              if (marketSlug && !slugs.includes(marketSlug)) {
                slugs.push(marketSlug);
              }
            }
            
            if (event.slug && !slugs.includes(event.slug)) {
              slugs.push(event.slug);
            }
          }
        }
      } catch (e) {
        console.log(`[Gamma] Tag search failed for ${tag}:`, e);
      }
    }
    
    // Method 2: Search all active events (broader search)
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200',
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (response.ok) {
      const events = await response.json();
      console.log(`[Gamma] Fetched ${events.length} active events (broad search)`);
      
      for (const event of events) {
        const eventSlug = (event.slug || '').toLowerCase();
        const title = (event.title || '').toLowerCase();
        
        const isUpDown = eventSlug.includes('up-or-down') || 
                         eventSlug.includes('updown') ||
                         title.includes('up or down') ||
                         title.includes('up/down');
        
        const isCrypto = eventSlug.includes('bitcoin') || 
                        eventSlug.includes('ethereum') ||
                        eventSlug.includes('btc-updown') ||
                        eventSlug.includes('eth-updown') ||
                        title.includes('bitcoin') ||
                        title.includes('ethereum');
        
        // Skip 5m/15m/4h markets - we only want 1h
        const is5min = eventSlug.includes('-5m-') || eventSlug.includes('5min');
        const is15min = eventSlug.includes('-15m-') || eventSlug.includes('15min');
        const is4hour = eventSlug.includes('-4h-') || eventSlug.includes('4hour');
        
        if (!isUpDown || !isCrypto || is5min || is15min || is4hour) continue;
        
        // Check if event is active
        const eventEndDate = event.endDate || event.endDateIso;
        if (eventEndDate && new Date(eventEndDate).getTime() < now) {
          continue;
        }
        
        console.log(`[Gamma] Matched hourly crypto: ${eventSlug}`);
        
        const markets = event.markets || [];
        for (const market of markets) {
          const marketSlug = market.slug || '';
          const marketEnd = market.endDate || market.endDateIso;
          
          if (marketEnd && new Date(marketEnd).getTime() < now) continue;
          
          if (marketSlug && !slugs.includes(marketSlug)) {
            slugs.push(marketSlug);
          }
        }
        if (event.slug && !slugs.includes(event.slug)) {
          slugs.push(event.slug);
        }
      }
    }
    
    // Method 3: Generate known slug patterns for current time window
    const currentDate = new Date();
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 
                   'july', 'august', 'september', 'october', 'november', 'december'];
    
    // Check current and next 3 hours in ET timezone
    for (let hourOffset = -1; hourOffset <= 3; hourOffset++) {
      const targetTime = new Date(now + hourOffset * 60 * 60 * 1000);
      
      // Convert to ET (rough approximation - EST is UTC-5, EDT is UTC-4)
      const etOffset = -5; // EST
      const etDate = new Date(targetTime.getTime() + etOffset * 60 * 60 * 1000);
      
      const month = months[etDate.getUTCMonth()];
      const day = etDate.getUTCDate();
      let hour = etDate.getUTCHours();
      const ampm = hour >= 12 ? 'pm' : 'am';
      hour = hour % 12 || 12;
      
      const patterns = [
        `bitcoin-up-or-down-${month}-${day}-${hour}${ampm}-et`,
        `ethereum-up-or-down-${month}-${day}-${hour}${ampm}-et`,
      ];
      
      for (const pattern of patterns) {
        if (!slugs.includes(pattern)) {
          slugs.push(pattern);
        }
      }
    }
    
  } catch (error) {
    console.error('[Gamma] Error searching markets:', error);
  }
  
  console.log(`[Gamma] Total hourly crypto slugs to check: ${slugs.length}`);
  return [...new Set(slugs)];
}

/**
 * Generate candidate slugs for active 15-minute crypto markets.
 *
 * Polymarket often uses epoch-based slugs like:
 *   btc-updown-15m-<unix_seconds>
 */
async function searchActive15mMarkets(): Promise<string[]> {
  const slugs: string[] = [];

  const nowSec = Math.floor(Date.now() / 1000);
  const intervalSec = 15 * 60;
  const baseSec = Math.floor(nowSec / intervalSec) * intervalSec;

  // Cover a small window around "now" to catch current/next/previous markets
  const offsets = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
  const assets = ['btc', 'eth'];

  for (const asset of assets) {
    for (const off of offsets) {
      const ts = baseSec + off * intervalSec;
      slugs.push(`${asset}-updown-15m-${ts}`);
    }
  }

  console.log(`[Gamma] Generated ${slugs.length} candidate 15m slugs (base=${baseSec})`);
  return [...new Set(slugs)];
}

/**
 * Fetch crypto price markets ("Bitcoin above X on date Y")
 */
async function fetchPriceMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  const now = Date.now();
  
  try {
    const response = await fetch(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100',
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (!response.ok) return results;
    
    const markets = await response.json();
    
    for (const market of markets) {
      const question = (market.question || '').toLowerCase();
      const slug = market.slug || '';
      
      const isBtcAbove = question.includes('bitcoin') && question.includes('above');
      const isEthAbove = question.includes('ethereum') && question.includes('above');
      
      if (!isBtcAbove && !isEthAbove) continue;
      
      // Check if market is active
      const endDate = market.endDate || market.endDateIso;
      if (endDate && new Date(endDate).getTime() < now) continue;
      
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
  console.log('=== Fetching market tokens (v6.0) ===');

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
      // Prefer 15-minute markets (user requested)
      const slugs15m = await searchActive15mMarkets();
      console.log(`[Gamma] Checking ${slugs15m.length} potential 15m slugs...`);

      const slugsToFetch15m = slugs15m.slice(0, 20);
      const fetch15m = await Promise.all(slugsToFetch15m.map((slug) => fetchMarketBySlug(slug)));

      for (const m of fetch15m) {
        if (m && m.marketType === '15min') markets.push(m);
      }

      console.log(`[Gamma] Found ${markets.length} active 15m markets`);

      // Fallback to 1-hour markets if no 15m markets found
      if (markets.length === 0) {
        const slugs = await searchActive1hMarkets();
        console.log(`[Gamma] Checking ${slugs.length} potential 1h slugs...`);

        // Fetch first 15 slugs in parallel
        const slugsToFetch = slugs.slice(0, 15);
        const fetchPromises = slugsToFetch.map(slug => fetchMarketBySlug(slug));
        const fetchResults = await Promise.all(fetchPromises);

        for (const result of fetchResults) {
          if (result && result.marketType === '1hour') {
            markets.push(result);
          }
        }

        console.log(`[Gamma] Found ${markets.length} active 1h markets`);
      }

      // Also add price markets if needed
      if (markets.length < 5) {
        const priceMarkets = await fetchPriceMarkets();
        for (const pm of priceMarkets) {
          if (!markets.find(m => m.slug === pm.slug)) {
            markets.push(pm);
          }
        }
      }
    }

    // Sort: 15m first, then 1h, then soonest end time
    const priority = (t: MarketToken['marketType']) => (t === '15min' ? 0 : t === '1hour' ? 1 : 2);
    markets.sort((a, b) => {
      const pa = priority(a.marketType);
      const pb = priority(b.marketType);
      if (pa !== pb) return pa - pb;
      return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
    });
    
    // Connect to Supabase for oracle prices
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const marketSlugs = markets.map(m => m.slug);
    
    // Fetch oracle prices from strike_prices
    const { data: strikePrices } = await supabase
      .from('strike_prices')
      .select('market_slug, open_price, strike_price, close_price')
      .in('market_slug', marketSlugs);
    
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
    
    // Add open_price to markets
    const marketsWithPrice = markets.map(m => {
      const oracleData = strikePriceMap.get(m.slug);
      const openPrice = oracleData?.open_price ?? oracleData?.strike_price ?? null;
      
      return {
        ...m,
        openPrice,
        strikePrice: openPrice,
        previousClosePrice: null,
      };
    });
    
    const duration = Date.now() - startTime;
    console.log(`=== Found ${markets.length} active markets in ${duration}ms ===`);

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
