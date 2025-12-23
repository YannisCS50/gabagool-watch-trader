import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TokenPrice {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  price: number | null;
  timestamp: number;
}

interface PriceResponse {
  success: boolean;
  timestamp: string;
  prices: Record<string, TokenPrice>;
}

/**
 * Fetch order book for a token from CLOB API
 */
async function fetchTokenBook(tokenId: string): Promise<TokenPrice | null> {
  try {
    const response = await fetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) {
      console.log(`[CLOB] Book fetch failed for ${tokenId.slice(0, 20)}...: ${response.status}`);
      return null;
    }
    
    const book = await response.json();
    
    // Extract best bid and ask
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : null;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;
    
    // Price is typically the midpoint or best ask for buying
    const price = bestAsk ?? bestBid ?? null;
    
    console.log(`[CLOB] Token ${tokenId.slice(0, 20)}...: bid=${bestBid}, ask=${bestAsk}`);
    
    return {
      tokenId,
      bestBid,
      bestAsk,
      price,
      timestamp: Date.now(),
    };
    
  } catch (error) {
    console.error(`[CLOB] Error fetching book for ${tokenId.slice(0, 20)}...:`, error);
    return null;
  }
}

/**
 * Alternative: Fetch price from prices endpoint
 */
async function fetchTokenPrice(tokenId: string): Promise<TokenPrice | null> {
  try {
    const response = await fetch(
      `https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    const price = parseFloat(data.price);
    
    if (isNaN(price)) return null;
    
    return {
      tokenId,
      bestBid: null,
      bestAsk: price,
      price,
      timestamp: Date.now(),
    };
    
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== Fetching CLOB prices ===');

  try {
    const body = await req.json();
    const tokenIds: string[] = body.tokenIds || [];
    
    if (tokenIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        prices: {}
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    console.log(`[CLOB] Fetching prices for ${tokenIds.length} tokens`);
    
    // Fetch all books in parallel (limit to 20 to avoid rate limiting)
    const tokensToFetch = tokenIds.slice(0, 20);
    const fetchPromises = tokensToFetch.map(async (tokenId) => {
      // Try book endpoint first, fall back to price endpoint
      let result = await fetchTokenBook(tokenId);
      if (!result || result.price === null) {
        result = await fetchTokenPrice(tokenId);
      }
      return { tokenId, result };
    });
    
    const results = await Promise.all(fetchPromises);
    
    const prices: Record<string, TokenPrice> = {};
    for (const { tokenId, result } of results) {
      if (result) {
        prices[tokenId] = result;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`=== Fetched ${Object.keys(prices).length} prices in ${duration}ms ===`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs: duration,
      prices
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
      prices: {}
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
