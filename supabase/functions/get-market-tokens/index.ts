import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface MarketToken {
  slug: string;
  asset: 'BTC' | 'ETH';
  upTokenId: string;
  downTokenId: string;
  eventStartTime: string;
  eventEndTime: string;
}

// Known 15-minute market slugs to try
const MARKET_SLUGS = [
  'will-bitcoin-go-up-15-minutes',
  'will-bitcoin-go-down-15-minutes', 
  'will-ethereum-go-up-15-minutes',
  'will-ethereum-go-down-15-minutes',
  'btc-15m-up',
  'btc-15m-down',
  'eth-15m-up', 
  'eth-15m-down',
];

// Fetch markets directly from Gamma API by active events
async function fetchActiveMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  
  try {
    // Query active events with 15-minute in name
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50',
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
      
      // Match 15-minute crypto markets (various formats)
      const is15Min = title.includes('15') || 
                      title.includes('fifteen') ||
                      slug.includes('15');
                      
      const isBTC = title.includes('bitcoin') || 
                    title.includes('btc') || 
                    slug.includes('bitcoin') ||
                    slug.includes('btc');
                    
      const isETH = title.includes('ethereum') || 
                    title.includes('eth') || 
                    slug.includes('ethereum') ||
                    slug.includes('eth');
      
      if (!is15Min || (!isBTC && !isETH)) {
        continue;
      }
      
      const asset: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
      const markets = event.markets || [];
      
      // Log match for debugging
      console.log(`Found 15-min event: "${title}" (${slug}) with ${markets.length} markets`);
      
      for (const market of markets) {
        const clobTokenIds = market.clobTokenIds || [];
        const outcomes = market.outcomes || ['Yes', 'No'];
        
        if (clobTokenIds.length >= 2) {
          // Determine which token is Up/Yes vs Down/No
          const outcome1 = (outcomes[0] || '').toLowerCase();
          
          let upTokenId = clobTokenIds[0];
          let downTokenId = clobTokenIds[1];
          
          // If first outcome is "no" or "down", swap
          if (outcome1 === 'no' || outcome1 === 'down') {
            upTokenId = clobTokenIds[1];
            downTokenId = clobTokenIds[0];
          }
          
          console.log(`  Market: Up=${upTokenId.slice(0, 25)}... Down=${downTokenId.slice(0, 25)}...`);
          
          results.push({
            slug: market.conditionId || slug,
            asset,
            upTokenId,
            downTokenId,
            eventStartTime: event.startDate || new Date().toISOString(),
            eventEndTime: event.endDate || new Date(Date.now() + 15 * 60000).toISOString()
          });
        }
      }
    }
    
    return results;
  } catch (error) {
    console.error('Gamma fetch error:', error);
    return results;
  }
}

// Alternative: Try CLOB API with broader search
async function fetchClobMarkets(): Promise<MarketToken[]> {
  const results: MarketToken[] = [];
  
  try {
    const response = await fetch(
      'https://clob.polymarket.com/markets?limit=500&active=true',
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
      
      // Broader matching
      const is15Min = question.includes('15') && 
                     (question.includes('min') || question.includes('minute'));
      const isBTC = question.includes('bitcoin') || question.includes('btc');
      const isETH = question.includes('ethereum') || question.includes('eth');
      
      if (!is15Min || (!isBTC && !isETH)) continue;
      
      const asset: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
      
      // Extract token IDs
      let upTokenId = '';
      let downTokenId = '';
      
      if (tokens.length >= 2) {
        upTokenId = tokens[0]?.token_id || '';
        downTokenId = tokens[1]?.token_id || '';
      }
      
      if (upTokenId && downTokenId) {
        console.log(`CLOB 15-min: ${question.slice(0, 50)}...`);
        results.push({
          slug: market.condition_id || market.id || '',
          asset,
          upTokenId,
          downTokenId,
          eventStartTime: market.game_start_time || new Date().toISOString(),
          eventEndTime: market.end_date_iso || new Date(Date.now() + 15 * 60000).toISOString()
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
    
    // Combine and dedupe by asset
    const marketsMap = new Map<string, MarketToken>();
    
    // Prefer Gamma results (more reliable token IDs)
    for (const m of gammaMarkets) {
      const key = `${m.asset}-${m.slug}`;
      marketsMap.set(key, m);
    }
    
    // Add CLOB results if not already present
    for (const m of clobMarkets) {
      const key = `${m.asset}-${m.slug}`;
      if (!marketsMap.has(key)) {
        marketsMap.set(key, m);
      }
    }
    
    const markets = Array.from(marketsMap.values());
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
