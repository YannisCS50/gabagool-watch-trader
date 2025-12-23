import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MarketToken {
  slug: string;
  question: string;
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
  marketType: 'price_above' | 'price_target' | '15min' | 'other';
}

/**
 * Fetch active crypto markets from Gamma API
 * Focus on "Bitcoin above X" and "Ethereum above X" markets
 */
async function fetchActiveMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  
  try {
    // Query active events - look for crypto price markets
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100',
      {
        headers: {
          'Accept': 'application/json',
        }
      }
    );
    
    if (!response.ok) {
      console.log('Gamma API failed:', response.status);
      return results;
    }
    
    const events = await response.json();
    console.log(`Gamma returned ${events.length} active events`);
    
    for (const event of events) {
      const title = (event.title || '').toLowerCase();
      const slug = event.slug || '';
      
      // Match crypto price markets
      const isBTC = title.includes('bitcoin') || slug.includes('bitcoin') || slug.includes('btc');
      const isETH = title.includes('ethereum') || slug.includes('ethereum') || slug.includes('eth');
      const isSOL = title.includes('solana') || slug.includes('solana') || slug.includes('sol');
      const isXRP = title.includes('xrp') || slug.includes('xrp');
      
      if (!isBTC && !isETH && !isSOL && !isXRP) {
        continue;
      }
      
      // Check for price-based markets ("above", "hit", "reach")
      const isPriceMarket = title.includes('above') || 
                           title.includes('hit') || 
                           title.includes('reach') ||
                           title.includes('price');
      
      // Also include 15-minute markets
      const is15Min = title.includes('15') || slug.includes('15');
      
      if (!isPriceMarket && !is15Min) {
        continue;
      }
      
      const asset: 'BTC' | 'ETH' | 'SOL' | 'XRP' = isBTC ? 'BTC' : isETH ? 'ETH' : isSOL ? 'SOL' : 'XRP';
      const marketType = is15Min ? '15min' : 'price_above';
      const markets = event.markets || [];
      
      console.log(`Found crypto event: "${title}" (${slug}) with ${markets.length} markets`);
      
      for (const market of markets) {
        const clobTokenIds = market.clobTokenIds || [];
        const outcomes = market.outcomes || ['Yes', 'No'];
        const question = market.question || event.title || '';
        
        if (clobTokenIds.length >= 2) {
          // Determine which token is Yes vs No
          const outcome1 = (outcomes[0] || '').toLowerCase();
          
          let upTokenId = clobTokenIds[0];
          let downTokenId = clobTokenIds[1];
          
          // If first outcome is "no", swap
          if (outcome1 === 'no') {
            upTokenId = clobTokenIds[1];
            downTokenId = clobTokenIds[0];
          }
          
          console.log(`  Market: "${question.slice(0, 50)}..." Yes=${upTokenId.slice(0, 20)}...`);
          
          results.push({
            slug: market.conditionId || slug,
            question: question,
            asset,
            upTokenId,
            downTokenId,
            eventStartTime: event.startDate || new Date().toISOString(),
            eventEndTime: event.endDate || new Date(Date.now() + 24 * 60 * 60000).toISOString(),
            marketType,
          });
        }
      }
    }
    
    // Sort: 15min markets first, then by end time (soonest first)
    results.sort((a, b) => {
      if (a.marketType === '15min' && b.marketType !== '15min') return -1;
      if (a.marketType !== '15min' && b.marketType === '15min') return 1;
      return new Date(a.eventEndTime).getTime() - new Date(b.eventEndTime).getTime();
    });
    
    // Limit to first 20 markets
    return results.slice(0, 20);
    
  } catch (error) {
    console.error('Gamma fetch error:', error);
    return results;
  }
}

/**
 * Alternative: Try CLOB API directly
 */
async function fetchClobMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  
  try {
    const response = await fetch(
      'https://clob.polymarket.com/markets?limit=100&active=true',
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) return results;
    
    const data = await response.json();
    const markets = Array.isArray(data) ? data : (data.data || []);
    console.log(`CLOB returned ${markets.length} markets`);
    
    for (const market of markets) {
      const question = (market.question || market.title || '').toLowerCase();
      const tokens = market.tokens || [];
      
      // Match crypto markets
      const isBTC = question.includes('bitcoin') || question.includes('btc');
      const isETH = question.includes('ethereum') || question.includes('eth');
      const isSOL = question.includes('solana') || question.includes('sol');
      const isXRP = question.includes('xrp');
      
      if (!isBTC && !isETH && !isSOL && !isXRP) continue;
      
      // Check for price-based markets
      const isPriceMarket = question.includes('above') || 
                           question.includes('hit') || 
                           question.includes('reach') ||
                           question.includes('price');
      const is15Min = question.includes('15') && (question.includes('min') || question.includes('minute'));
      
      if (!isPriceMarket && !is15Min) continue;
      
      const asset: 'BTC' | 'ETH' | 'SOL' | 'XRP' = isBTC ? 'BTC' : isETH ? 'ETH' : isSOL ? 'SOL' : 'XRP';
      const marketType = is15Min ? '15min' : 'price_above';
      
      // Extract token IDs
      let upTokenId = '';
      let downTokenId = '';
      
      if (tokens.length >= 2) {
        const t0 = tokens[0];
        const t1 = tokens[1];
        // Token with outcome "Yes" is upTokenId
        if (t0?.outcome?.toLowerCase() === 'yes') {
          upTokenId = t0?.token_id || '';
          downTokenId = t1?.token_id || '';
        } else {
          upTokenId = t1?.token_id || '';
          downTokenId = t0?.token_id || '';
        }
      }
      
      if (upTokenId && downTokenId) {
        console.log(`CLOB market: "${(market.question || '').slice(0, 50)}..."`);
        results.push({
          slug: market.condition_id || market.id || '',
          question: market.question || '',
          asset,
          upTokenId,
          downTokenId,
          eventStartTime: market.game_start_time || new Date().toISOString(),
          eventEndTime: market.end_date_iso || new Date(Date.now() + 24 * 60 * 60000).toISOString(),
          marketType,
        });
      }
    }
    
    return results;
  } catch (error) {
    console.error('CLOB fetch error:', error);
    return results;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== Fetching market tokens ===');

  try {
    // Try both APIs in parallel for speed
    const [gammaMarkets, clobMarkets] = await Promise.all([
      fetchActiveMarkets(),
      fetchClobMarkets()
    ]);
    
    // Combine and dedupe by slug
    const marketsMap = new Map<string, MarketToken>();
    
    // Prefer Gamma results (more reliable token IDs)
    for (const m of gammaMarkets) {
      marketsMap.set(m.slug, m);
    }
    
    // Add CLOB results if not already present
    for (const m of clobMarkets) {
      if (!marketsMap.has(m.slug)) {
        marketsMap.set(m.slug, m);
      }
    }
    
    const markets = Array.from(marketsMap.values());
    const duration = Date.now() - startTime;
    
    console.log(`=== Found ${markets.length} crypto markets in ${duration}ms ===`);

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
