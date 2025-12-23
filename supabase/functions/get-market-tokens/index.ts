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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Fetching 15-min market token IDs from Gamma API...');
    
    // Fetch active events from Gamma API
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
      throw new Error(`Gamma API error: ${response.status}`);
    }
    
    const events = await response.json();
    const markets: MarketToken[] = [];
    
    console.log(`Fetched ${events.length} events from Gamma`);
    
    // Filter for 15-min crypto markets
    for (const event of events) {
      const title = (event.title || '').toLowerCase();
      const slug = event.slug || '';
      
      // Check for 15-minute markets (various naming patterns)
      const is15Min = title.includes('15') || slug.includes('15m') || slug.includes('15-m');
      const isBTC = title.includes('bitcoin') || title.includes('btc') || slug.includes('btc');
      const isETH = title.includes('ethereum') || title.includes('eth') || slug.includes('eth');
      
      if (!is15Min || (!isBTC && !isETH)) {
        continue;
      }
      
      const asset: 'BTC' | 'ETH' = isBTC ? 'BTC' : 'ETH';
      
      // Get token IDs from markets array
      if (event.markets && event.markets.length >= 1) {
        let upTokenId = '';
        let downTokenId = '';
        
        for (const market of event.markets) {
          const outcome = (market.outcome || '').toLowerCase();
          const groupItemTitle = (market.groupItemTitle || '').toLowerCase();
          const tokenIds = market.clobTokenIds || [];
          
          // Check for Up/Yes outcome
          if (outcome.includes('up') || outcome.includes('yes') || groupItemTitle.includes('up')) {
            upTokenId = tokenIds[0] || market.clobTokenId || '';
          } 
          // Check for Down/No outcome
          else if (outcome.includes('down') || outcome.includes('no') || groupItemTitle.includes('down')) {
            downTokenId = tokenIds[0] || market.clobTokenId || '';
          }
          
          // If there's only one market with two tokens, assume [0]=Yes/Up, [1]=No/Down
          if (tokenIds.length === 2 && !upTokenId && !downTokenId) {
            upTokenId = tokenIds[0];
            downTokenId = tokenIds[1];
          }
        }
        
        // Also try to get from the first market if it has two tokens
        if ((!upTokenId || !downTokenId) && event.markets[0]?.clobTokenIds?.length === 2) {
          upTokenId = event.markets[0].clobTokenIds[0];
          downTokenId = event.markets[0].clobTokenIds[1];
        }
        
        if (upTokenId && downTokenId) {
          console.log(`Found market: ${slug} (${asset}) - Up: ${upTokenId.slice(0, 20)}...`);
          markets.push({
            slug,
            asset,
            upTokenId,
            downTokenId,
            eventStartTime: event.startDate || new Date().toISOString(),
            eventEndTime: event.endDate || new Date().toISOString()
          });
        }
      }
    }
    
    console.log(`Found ${markets.length} 15-min markets with token IDs`);
    
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
