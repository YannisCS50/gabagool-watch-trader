import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TokenPrice {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  price: number | null;
  timestamp: number;
  bidLevels: number;
  askLevels: number;
}

interface PriceResponse {
  success: boolean;
  timestamp: string;
  durationMs: number;
  prices: Record<string, TokenPrice>;
}

type Level = { price: number; size: number };

/**
 * Parse levels from Polymarket book format
 * Returns sorted levels: bids DESC (highest first), asks ASC (lowest first)
 */
function parseLevels(raw: unknown, type: 'bids' | 'asks'): Level[] {
  if (!Array.isArray(raw)) return [];
  
  const levels: Level[] = [];
  
  for (const lvl of raw) {
    if (!lvl || typeof lvl !== 'object') continue;
    
    // Polymarket format: { price: "0.52", size: "123" }
    const priceVal = (lvl as Record<string, unknown>).price;
    const sizeVal = (lvl as Record<string, unknown>).size;
    
    const price = parseFloat(String(priceVal));
    const size = parseFloat(String(sizeVal));
    
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (price <= 0 || size <= 0) continue;
    
    levels.push({ price, size });
  }
  
  // Sort: bids DESC (highest first), asks ASC (lowest first)
  if (type === 'bids') {
    levels.sort((a, b) => b.price - a.price);
  } else {
    levels.sort((a, b) => a.price - b.price);
  }
  
  return levels;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch order book for a token from CLOB API with correct sorting
 */
async function fetchTokenBook(tokenId: string): Promise<TokenPrice | null> {
  try {
    const response = await fetchWithTimeout(
      `https://clob.polymarket.com/book?token_id=${tokenId}`,
      { headers: { 'Accept': 'application/json' } },
      5000 // 5 second timeout per request
    );
    
    if (!response.ok) {
      console.log(`[CLOB] Book fetch failed for ${tokenId.slice(0, 16)}...: ${response.status}`);
      return null;
    }
    
    const book = await response.json();
    
    // Parse and sort levels correctly
    const bids = parseLevels(book?.bids, 'bids');
    const asks = parseLevels(book?.asks, 'asks');
    
    // Best bid = highest bid (first after DESC sort)
    // Best ask = lowest ask (first after ASC sort)
    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;
    
    // Calculate mid and spread
    const mid = (bestBid !== null && bestAsk !== null) 
      ? (bestBid + bestAsk) / 2 
      : null;
    const spread = (bestBid !== null && bestAsk !== null)
      ? bestAsk - bestBid
      : null;
    
    // Price is mid if available, otherwise best ask or best bid
    const price = mid ?? bestAsk ?? bestBid ?? null;
    
    console.log(`[CLOB] ${tokenId.slice(0, 16)}... bid=${bestBid?.toFixed(2)} ask=${bestAsk?.toFixed(2)} mid=${mid?.toFixed(3)} spread=${spread?.toFixed(3)} (${bids.length}b/${asks.length}a)`);
    
    return {
      tokenId,
      bestBid,
      bestAsk,
      mid,
      spread,
      price,
      timestamp: Date.now(),
      bidLevels: bids.length,
      askLevels: asks.length,
    };
    
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.log(`[CLOB] Timeout for ${tokenId.slice(0, 16)}...`);
    } else {
      console.error(`[CLOB] Error fetching book for ${tokenId.slice(0, 16)}...:`, error);
    }
    return null;
  }
}

/**
 * Fetch with concurrency limit
 */
async function fetchWithLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number = 8
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  });
  
  await Promise.all(workers);
  return results;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== CLOB PRICES v2 ===');

  try {
    const body = await req.json();
    const tokenIds: string[] = body.tokenIds || [];
    
    if (tokenIds.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        prices: {}
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    console.log(`[CLOB] Fetching ${tokenIds.length} tokens (no slice limit)`);
    
    // Create fetch tasks for ALL tokens (no more slice(0,20))
    const tasks = tokenIds.map(tokenId => async () => {
      return { tokenId, result: await fetchTokenBook(tokenId) };
    });
    
    // Fetch with concurrency limit of 10
    const results = await fetchWithLimit(tasks, 10);
    
    const prices: Record<string, TokenPrice> = {};
    for (const { tokenId, result } of results) {
      if (result) {
        prices[tokenId] = result;
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`=== Fetched ${Object.keys(prices).length}/${tokenIds.length} prices in ${duration}ms ===`);

    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs: duration,
      prices
    } as PriceResponse), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: Date.now() - startTime,
      prices: {}
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
