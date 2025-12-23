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

// Fetch markets from Polymarket CLOB API
async function fetchClobMarkets(): Promise<MarketToken[]> {
  console.log('Fetching 15-min market tokens from CLOB API...');
  
  try {
    // CLOB API markets endpoint
    const response = await fetch(
      'https://clob.polymarket.com/markets?limit=200',
      {
        headers: {
          'Accept': 'application/json',
        }
      }
    );
    
    if (!response.ok) {
      console.log('CLOB API status:', response.status);
      return [];
    }
    
    const data = await response.json();
    const markets = data.data || data || [];
    console.log(`CLOB API returned ${markets.length} markets`);
    
    const results: MarketToken[] = [];
    const now = Date.now();
    
    for (const market of markets) {
      // Filter for 15-minute crypto markets
      const question = (market.question || '').toLowerCase();
      const tokens = market.tokens || [];
      
      // Match 15-minute BTC/ETH up/down markets
      const is15Min = question.includes('15') && (
        question.includes('minute') || 
        question.includes('min') ||
        question.includes(':00') ||
        question.includes(':15') ||
        question.includes(':30') ||
        question.includes(':45')
      );
      const isBTC = question.includes('bitcoin') || question.includes('btc');
      const isETH = question.includes('ethereum') || question.includes('eth');
      const isUpDown = question.includes('up') || question.includes('down');
      
      if (!is15Min || !isUpDown || (!isBTC && !isETH)) {
        continue;
      }
      
      // Parse tokens - typically [Yes/Up=0, No/Down=1]
      let upTokenId = '';
      let downTokenId = '';
      
      for (const token of tokens) {
        const outcome = (token.outcome || '').toLowerCase();
        const tokenId = token.token_id || '';
        
        if (outcome === 'yes' || outcome === 'up') {
          upTokenId = tokenId;
        } else if (outcome === 'no' || outcome === 'down') {
          downTokenId = tokenId;
        }
      }
      
      // Default assumption: first token is Yes/Up, second is No/Down
      if (!upTokenId && !downTokenId && tokens.length === 2) {
        upTokenId = tokens[0]?.token_id || '';
        downTokenId = tokens[1]?.token_id || '';
      }
      
      if (upTokenId && downTokenId) {
        const asset: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
        const conditionId = market.condition_id || '';
        const endTime = market.end_date_iso || new Date(now + 15 * 60 * 1000).toISOString();
        const startTime = market.game_start_time || new Date(now).toISOString();
        
        console.log(`Found CLOB market: ${question.slice(0, 60)}...`);
        console.log(`  Token IDs: Up=${upTokenId.slice(0, 20)}... Down=${downTokenId.slice(0, 20)}...`);
        
        results.push({
          slug: conditionId,
          asset,
          upTokenId,
          downTokenId,
          eventStartTime: startTime,
          eventEndTime: endTime
        });
      }
    }
    
    console.log(`Found ${results.length} 15-min markets with token IDs`);
    return results;
  } catch (error) {
    console.error('CLOB API error:', error);
    return [];
  }
}

// Alternative: fetch from Gamma API (older approach)
async function fetchGammaMarkets(): Promise<MarketToken[]> {
  console.log('Fallback: Fetching from Gamma API...');
  
  try {
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100',
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Lovable-Bot/1.0'
        }
      }
    );
    
    if (!response.ok) {
      console.log('Gamma API status:', response.status);
      return [];
    }
    
    const events = await response.json();
    const results: MarketToken[] = [];
    
    for (const event of events) {
      const title = (event.title || '').toLowerCase();
      const slug = event.slug || '';
      
      // Check for 15-minute crypto markets
      const is15Min = title.includes('15') || slug.includes('15m') || slug.includes('15-m');
      const isBTC = title.includes('bitcoin') || title.includes('btc') || slug.includes('btc');
      const isETH = title.includes('ethereum') || title.includes('eth') || slug.includes('eth');
      const isUpDown = title.includes('up') || title.includes('down');
      
      if (!is15Min || !isUpDown || (!isBTC && !isETH)) {
        continue;
      }
      
      const asset: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
      const markets = event.markets || [];
      
      for (const market of markets) {
        const clobTokenIds = market.clobTokenIds || [];
        
        if (clobTokenIds.length === 2) {
          console.log(`Found Gamma market: ${slug} with tokens`);
          results.push({
            slug,
            asset,
            upTokenId: clobTokenIds[0],
            downTokenId: clobTokenIds[1],
            eventStartTime: event.startDate || new Date().toISOString(),
            eventEndTime: event.endDate || new Date().toISOString()
          });
        }
      }
    }
    
    console.log(`Gamma found ${results.length} markets`);
    return results;
  } catch (error) {
    console.error('Gamma API error:', error);
    return [];
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('=== Fetching 15-min market token IDs ===');
    
    // Try CLOB API first (more accurate token IDs)
    let markets = await fetchClobMarkets();
    
    // Fallback to Gamma API if CLOB returns nothing
    if (markets.length === 0) {
      markets = await fetchGammaMarkets();
    }
    
    console.log(`=== Returning ${markets.length} markets ===`);
    
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      markets
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error fetching market tokens:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      success: false, 
      error: errorMessage,
      markets: []
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
