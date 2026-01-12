import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ChainlinkTick {
  symbol: string;
  timestamp: number; // milliseconds
  value: number;
}

interface MarketToTrack {
  slug: string;
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP';
  eventStartTime: number; // seconds (Unix)
  eventEndTime: number; // seconds (Unix)
  needsOpenPrice: boolean;
  needsClosePrice: boolean;
}

// Chainlink feed IDs for Polygon (verified from data.chain.link)
const CHAINLINK_FEEDS: Record<string, string> = {
  'BTC': '0xc907E116054Ad103354f2D350FD2514433D57F6f', // BTC/USD on Polygon
  'ETH': '0xF9680D99D6C9589e2a93a78A04A279e509205945', // ETH/USD on Polygon
  'SOL': '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC', // SOL/USD on Polygon (verified)
  'XRP': '0x785ba89291f676b5386652eB12b30cF361020694', // XRP/USD on Polygon (verified)
};

// Parse timestamp from market slug like btc-updown-15m-1766485800
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

// Fetch current price from Polymarket RTDS (same source they use for settlement)
async function fetchPolymarketChainlinkPrice(asset: string): Promise<{ price: number; timestamp: number } | null> {
  try {
    // Use Polymarket's data API which exposes their Chainlink prices
    const assetLower = asset.toLowerCase();
    const response = await fetch(`https://data-api.polymarket.com/prices?assets=${assetLower}`);
    
    if (!response.ok) {
      console.log(`[polymarket] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const price = data?.[assetLower];
    
    if (typeof price === 'number' && price > 0) {
      console.log(`[polymarket] ${asset} price: $${price.toFixed(6)}`);
      return { price, timestamp: Date.now() };
    }
    
    return null;
  } catch (e) {
    console.error(`[polymarket] Error fetching ${asset}:`, e);
    return null;
  }
}

// Fallback: Fetch current price from Chainlink via public RPC
async function fetchChainlinkPrice(asset: string): Promise<{ price: number; timestamp: number } | null> {
  const feedAddress = CHAINLINK_FEEDS[asset];
  if (!feedAddress) {
    console.log(`[chainlink] No feed for ${asset}`);
    return null;
  }

  try {
    // ABI for latestRoundData: returns (roundId, answer, startedAt, updatedAt, answeredInRound)
    const data = '0xfeaf968c'; // function signature for latestRoundData()
    
    const response = await fetch('https://polygon-rpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{
          to: feedAddress,
          data: data
        }, 'latest'],
        id: 1
      })
    });

    if (!response.ok) {
      console.log(`[chainlink] RPC error: ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (result.error) {
      console.log(`[chainlink] RPC error:`, result.error);
      return null;
    }

    // Parse the response - each value is 32 bytes (64 hex chars)
    const hex = result.result.slice(2); // remove 0x
    const answerHex = hex.slice(64, 128); // second 32-byte slot (answer)
    const updatedAtHex = hex.slice(192, 256); // fourth 32-byte slot (updatedAt)
    
    const answer = BigInt('0x' + answerHex);
    const updatedAt = Number(BigInt('0x' + updatedAtHex));
    
    // Chainlink uses 8 decimals for most feeds
    const price = Number(answer) / 1e8;
    
    console.log(`[chainlink] ${asset} price: $${price.toFixed(6)} at ${new Date(updatedAt * 1000).toISOString()}`);
    return { price, timestamp: updatedAt * 1000 };
  } catch (e) {
    console.error(`[chainlink] Error fetching ${asset}:`, e);
    return null;
  }
}

// Get price from best available source (prefer Polymarket's source)
async function getPrice(asset: string): Promise<{ price: number; timestamp: number; source: string } | null> {
  // Try Polymarket first (this is what they use for settlement)
  const pmPrice = await fetchPolymarketChainlinkPrice(asset);
  if (pmPrice) {
    return { ...pmPrice, source: 'polymarket_api' };
  }
  
  // Fallback to direct Chainlink RPC
  const clPrice = await fetchChainlinkPrice(asset);
  if (clPrice) {
    return { ...clPrice, source: 'chainlink_rpc' };
  }
  
  return null;
}

// Generate all active 15m market slugs deterministically based on time
function generateActiveMarketSlugs(): string[] {
  const now = Math.floor(Date.now() / 1000);
  const intervalSecs = 15 * 60; // 15 minutes
  const currentIntervalStart = Math.floor(now / intervalSecs) * intervalSecs;
  
  const slugs: string[] = [];
  
  // Check current interval, previous interval, and 2 intervals back (and 3 for late close prices)
  for (const offset of [0, -1, -2, -3]) {
    const intervalTs = currentIntervalStart + (offset * intervalSecs);
    
    // Include all V26 assets: BTC, ETH, SOL, XRP
    for (const asset of ['btc', 'eth', 'sol', 'xrp']) {
      slugs.push(`${asset}-updown-15m-${intervalTs}`);
    }
  }
  
  console.log(`Generated ${slugs.length} deterministic slugs for all assets (BTC, ETH, SOL, XRP)`);
  return slugs;
}

// Get markets that need prices based on deterministic slug generation
async function getMarketsNeedingPrices(supabase: any): Promise<MarketToTrack[]> {
  const now = Date.now();
  const slugs = generateActiveMarketSlugs();
  
  interface ExistingPrice {
    market_slug: string;
    open_price: number | null;
    open_timestamp: number | null;
    close_price: number | null;
    close_timestamp: number | null;
    quality: string | null;
  }
  
  const { data: existingPrices, error } = await supabase
    .from('strike_prices')
    .select('market_slug, open_price, open_timestamp, close_price, close_timestamp, quality')
    .in('market_slug', slugs);
  
  if (error) {
    console.error('Error fetching existing prices:', error);
  }
  
  const priceMap = new Map<string, ExistingPrice>((existingPrices || []).map((p: ExistingPrice) => [p.market_slug, p]));
  
  const marketsNeeding: MarketToTrack[] = [];
  
  for (const slug of slugs) {
    const eventStartTime = parseTimestampFromSlug(slug);
    if (!eventStartTime) continue;
    
    const eventEndTime = eventStartTime + 15 * 60;
    const eventStartMs = eventStartTime * 1000;
    const eventEndMs = eventEndTime * 1000;
    
    // Extended collection windows (15 minutes instead of 10 for more reliability)
    const openWindowEnd = eventStartMs + 15 * 60 * 1000;
    const closeWindowEnd = eventEndMs + 15 * 60 * 1000;
    
    const existing = priceMap.get(slug);
    const hasOpenPrice = existing?.open_price != null;
    const hasClosePrice = existing?.close_price != null;
    
    // Need open price if market started and within window
    const needsOpenPrice = !hasOpenPrice && now >= eventStartMs && now <= openWindowEnd;
    
    // Need close price if market ended and within window
    const needsClosePrice = !hasClosePrice && now >= eventEndMs && now <= closeWindowEnd;
    
    if (needsOpenPrice || needsClosePrice) {
      const slugLower = slug.toLowerCase();
      const asset: 'BTC' | 'ETH' | 'SOL' | 'XRP' = 
        slugLower.includes('btc') ? 'BTC' : 
        slugLower.includes('sol') ? 'SOL' :
        slugLower.includes('xrp') ? 'XRP' : 'ETH';
      
      marketsNeeding.push({
        slug,
        asset,
        eventStartTime,
        eventEndTime,
        needsOpenPrice,
        needsClosePrice
      });
      
      console.log(`[${asset}] Market ${slug}: start=${new Date(eventStartMs).toISOString()}, end=${new Date(eventEndMs).toISOString()}, needsOpen=${needsOpenPrice}, needsClose=${needsClosePrice}`);
    }
  }
  
  console.log(`Total: ${marketsNeeding.length} markets need prices (${marketsNeeding.filter(m => m.needsOpenPrice).length} open, ${marketsNeeding.filter(m => m.needsClosePrice).length} close)`);
  return marketsNeeding;
}

// Determine quality based on time difference
function determineQuality(tickTimestamp: number, targetTimeMs: number): string {
  const diffMs = Math.abs(tickTimestamp - targetTimeMs);
  if (diffMs <= 5000) return 'exact';
  if (diffMs <= 60000) return 'late';
  return 'estimated';
}

// Store strike prices in database using best available price source
async function storePrices(
  supabase: any, 
  markets: MarketToTrack[]
): Promise<{ openStored: number; closeStored: number }> {
  let openStored = 0;
  let closeStored = 0;
  
  // Fetch current prices for all needed assets (prefer Polymarket's source)
  const assetsNeeded = [...new Set(markets.map(m => m.asset))];
  const currentPrices: Record<string, { price: number; timestamp: number; source: string }> = {};
  
  for (const asset of assetsNeeded) {
    const result = await getPrice(asset);
    if (result) {
      currentPrices[asset] = result;
    }
  }
  
  const now = Date.now();
  
  for (const market of markets) {
    const priceData = currentPrices[market.asset];
    if (!priceData) {
      console.log(`No Chainlink price for ${market.asset}, skipping ${market.slug}`);
      continue;
    }
    
    // Get existing data to preserve
    const { data: existing } = await supabase
      .from('strike_prices')
      .select('*')
      .eq('market_slug', market.slug)
      .maybeSingle();
    
    const updates: any = {
      market_slug: market.slug,
      asset: market.asset,
      event_start_time: new Date(market.eventStartTime * 1000).toISOString(),
      source: 'chainlink_rpc',
      chainlink_timestamp: Math.floor(priceData.timestamp / 1000)
    };
    
    // Preserve existing prices
    if (existing?.open_price) {
      updates.open_price = existing.open_price;
      updates.open_timestamp = existing.open_timestamp;
      updates.strike_price = existing.strike_price || existing.open_price;
      updates.quality = existing.quality;
    }
    if (existing?.close_price) {
      updates.close_price = existing.close_price;
      updates.close_timestamp = existing.close_timestamp;
    }
    
    // Handle open price
    if (market.needsOpenPrice && !existing?.open_price) {
      const targetOpenTime = market.eventStartTime * 1000;
      // Only use current price if we're close to the event start
      const timeSinceStart = now - targetOpenTime;
      
      if (timeSinceStart <= 10 * 60 * 1000) { // Within 10 minutes of start
        // Keep 6 decimal places for precision - XRP can have 4-5 decimal differences
        updates.open_price = Math.round(priceData.price * 1000000) / 1000000;
        updates.open_timestamp = priceData.timestamp;
        updates.strike_price = updates.open_price;
        updates.quality = determineQuality(priceData.timestamp, targetOpenTime);
        openStored++;
        console.log(`✅ Open price for ${market.slug}: $${updates.open_price} (${updates.quality})`);
      }
    }
    
    // Handle close price
    if (market.needsClosePrice && !existing?.close_price) {
      const targetCloseTime = market.eventEndTime * 1000;
      // Only use current price if we're close to the event end
      const timeSinceEnd = now - targetCloseTime;
      
      if (timeSinceEnd >= 0 && timeSinceEnd <= 10 * 60 * 1000) { // 0-10 minutes after end
        // Keep 6 decimal places for precision - XRP can have 4-5 decimal differences
        updates.close_price = Math.round(priceData.price * 1000000) / 1000000;
        updates.close_timestamp = priceData.timestamp;
        closeStored++;
        console.log(`✅ Close price for ${market.slug}: $${updates.close_price}`);
      }
    }
    
    // Only upsert if we have something to store
    if (updates.open_price || updates.close_price) {
      const { error } = await supabase
        .from('strike_prices')
        .upsert(updates, { onConflict: 'market_slug' });
      
      if (error) {
        console.error(`Error storing price for ${market.slug}:`, error);
      }
    }
  }
  
  return { openStored, closeStored };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('=== Starting Chainlink price collector (RPC-based) ===');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 1. Get markets that need prices
    const marketsNeeding = await getMarketsNeedingPrices(supabase);
    console.log(`Found ${marketsNeeding.length} markets needing prices`);
    
    if (marketsNeeding.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No markets need prices right now',
        marketsProcessed: 0,
        openPricesStored: 0,
        closePricesStored: 0
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // 2. Fetch prices and store them
    const { openStored, closeStored } = await storePrices(supabase, marketsNeeding);
    
    // 3. Return summary
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      marketsNeeding: marketsNeeding.length,
      marketsProcessed: marketsNeeding.map(m => ({
        slug: m.slug,
        asset: m.asset,
        eventStartTime: new Date(m.eventStartTime * 1000).toISOString(),
        eventEndTime: new Date(m.eventEndTime * 1000).toISOString(),
        needsOpenPrice: m.needsOpenPrice,
        needsClosePrice: m.needsClosePrice
      })),
      openPricesStored: openStored,
      closePricesStored: closeStored
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    
  } catch (error) {
    console.error('Error in chainlink-price-collector:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      success: false, 
      error: errorMessage 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
