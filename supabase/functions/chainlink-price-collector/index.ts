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
  asset: 'BTC' | 'ETH';
  eventStartTime: number; // seconds (Unix)
  eventEndTime: number; // seconds (Unix)
  needsOpenPrice: boolean;
  needsClosePrice: boolean;
}

// Parse timestamp from market slug like btc-updown-15m-1766485800
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

// Generate all active 15m market slugs deterministically based on time
function generateActiveMarketSlugs(): string[] {
  const now = Math.floor(Date.now() / 1000);
  const intervalSecs = 15 * 60; // 15 minutes
  const currentIntervalStart = Math.floor(now / intervalSecs) * intervalSecs;
  
  const slugs: string[] = [];
  
  // Check current interval, previous interval, and 2 intervals back
  for (const offset of [0, -1, -2]) {
    const intervalTs = currentIntervalStart + (offset * intervalSecs);
    
    for (const asset of ['btc', 'eth']) {
      slugs.push(`${asset}-updown-15m-${intervalTs}`);
    }
  }
  
  console.log(`Generated ${slugs.length} deterministic slugs for collection`);
  return slugs;
}

// Get markets that need prices based on deterministic slug generation
async function getMarketsNeedingPrices(supabase: any): Promise<MarketToTrack[]> {
  const now = Date.now();
  const slugs = generateActiveMarketSlugs();
  
  // Check existing strike prices
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
    
    const eventEndTime = eventStartTime + 15 * 60; // 15 minutes later
    const eventStartMs = eventStartTime * 1000;
    const eventEndMs = eventEndTime * 1000;
    
    // Collection windows:
    // - For open_price: market started <= 5 minutes ago
    // - For close_price: market ended <= 5 minutes ago
    const openWindowEnd = eventStartMs + 5 * 60 * 1000;
    const closeWindowEnd = eventEndMs + 5 * 60 * 1000;
    
    const existing = priceMap.get(slug);
    const hasExactOpenPrice = existing?.quality === 'exact' && existing?.open_price != null;
    const hasClosePrice = existing?.close_price != null;
    
    // Need open price if market just started (within 5 min) and we don't have exact one
    const needsOpenPrice = !hasExactOpenPrice && now >= eventStartMs && now <= openWindowEnd;
    
    // Need close price if market just ended (within 5 min) and we don't have one
    const needsClosePrice = !hasClosePrice && now >= eventEndMs && now <= closeWindowEnd;
    
    if (needsOpenPrice || needsClosePrice) {
      const slugLower = slug.toLowerCase();
      const asset: 'BTC' | 'ETH' = slugLower.includes('btc') ? 'BTC' : 'ETH';
      
      marketsNeeding.push({
        slug,
        asset,
        eventStartTime,
        eventEndTime,
        needsOpenPrice,
        needsClosePrice
      });
      
      console.log(`Market ${slug}: start=${new Date(eventStartMs).toISOString()}, end=${new Date(eventEndMs).toISOString()}, needsOpen=${needsOpenPrice}, needsClose=${needsClosePrice}`);
    }
  }
  
  return marketsNeeding;
}

// Connect to Polymarket RTDS WebSocket and collect Chainlink ticks
async function collectChainlinkTicks(
  durationMs: number = 30000
): Promise<Map<string, ChainlinkTick[]>> {
  return new Promise((resolve, reject) => {
    const ticksBySymbol = new Map<string, ChainlinkTick[]>();
    ticksBySymbol.set('BTC', []);
    ticksBySymbol.set('ETH', []);
    
    const timeout = setTimeout(() => {
      console.log(`Collection complete. BTC ticks: ${ticksBySymbol.get('BTC')?.length}, ETH ticks: ${ticksBySymbol.get('ETH')?.length}`);
      ws.close();
      resolve(ticksBySymbol);
    }, durationMs);
    
    const ws = new WebSocket('wss://rtds.polymarket.com');
    
    ws.onopen = () => {
      console.log('Connected to Polymarket RTDS for tick collection');
      
      // Subscribe to Chainlink prices
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: ''
        }]
      }));
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.topic === 'crypto_prices_chainlink' && data.payload) {
          const payload = data.payload;
          const symbol = payload.symbol?.toUpperCase().replace('/USD', '') || '';
          
          if (symbol === 'BTC' || symbol === 'ETH') {
            const tick: ChainlinkTick = {
              symbol,
              timestamp: payload.timestamp || Date.now(),
              value: payload.value
            };
            
            ticksBySymbol.get(symbol)?.push(tick);
            console.log(`RTDS tick: ${symbol} $${tick.value} at ${new Date(tick.timestamp).toISOString()}`);
          }
        }
      } catch (e) {
        console.error('Error parsing RTDS message:', e);
      }
    };
    
    ws.onerror = (error) => {
      console.error('RTDS WebSocket error:', error);
      clearTimeout(timeout);
      reject(error);
    };
    
    ws.onclose = () => {
      console.log('RTDS WebSocket closed');
      clearTimeout(timeout);
      resolve(ticksBySymbol);
    };
  });
}

// Find the first tick with timestamp >= targetTime
function findFirstTickAfter(ticks: ChainlinkTick[], targetTimeMs: number): ChainlinkTick | null {
  // Sort ticks by timestamp
  const sorted = [...ticks].sort((a, b) => a.timestamp - b.timestamp);
  
  // Find first tick at or after target time
  for (const tick of sorted) {
    if (tick.timestamp >= targetTimeMs) {
      return tick;
    }
  }
  
  // If no tick after target, return the closest one before (within 10 seconds)
  const ticksBefore = sorted.filter(t => t.timestamp < targetTimeMs);
  if (ticksBefore.length > 0) {
    const lastBefore = ticksBefore[ticksBefore.length - 1];
    const diff = targetTimeMs - lastBefore.timestamp;
    if (diff <= 10000) {
      return lastBefore;
    }
  }
  
  return null;
}

// Determine quality based on time difference
function determineQuality(tickTimestamp: number, targetTimeMs: number): string {
  const diffMs = Math.abs(tickTimestamp - targetTimeMs);
  if (diffMs <= 5000) return 'exact'; // within 5 seconds
  if (diffMs <= 60000) return 'late'; // within 1 minute
  return 'estimated';
}

// Store strike prices in database
async function storePrices(
  supabase: any, 
  markets: MarketToTrack[], 
  ticksBySymbol: Map<string, ChainlinkTick[]>
): Promise<{ openStored: number; closeStored: number }> {
  let openStored = 0;
  let closeStored = 0;
  
  for (const market of markets) {
    const ticks = ticksBySymbol.get(market.asset) || [];
    if (ticks.length === 0) {
      console.log(`No ticks for ${market.asset}, skipping ${market.slug}`);
      continue;
    }
    
    const updates: any = {
      market_slug: market.slug,
      asset: market.asset,
      event_start_time: new Date(market.eventStartTime * 1000).toISOString(),
      source: 'polymarket_rtds'
    };
    
    // Handle open price (price to beat)
    if (market.needsOpenPrice) {
      const openTick = findFirstTickAfter(ticks, market.eventStartTime * 1000);
      if (openTick) {
        updates.open_price = Math.round(openTick.value * 100) / 100; // Round to 2 decimals
        updates.open_timestamp = openTick.timestamp;
        updates.strike_price = updates.open_price; // Keep for backward compatibility
        updates.chainlink_timestamp = openTick.timestamp;
        updates.quality = determineQuality(openTick.timestamp, market.eventStartTime * 1000);
        openStored++;
        console.log(`Open price for ${market.slug}: $${updates.open_price} (${updates.quality}) at ${new Date(openTick.timestamp).toISOString()}`);
      }
    }
    
    // Handle close price (settlement)
    if (market.needsClosePrice) {
      const closeTick = findFirstTickAfter(ticks, market.eventEndTime * 1000);
      if (closeTick) {
        updates.close_price = Math.round(closeTick.value * 100) / 100; // Round to 2 decimals
        updates.close_timestamp = closeTick.timestamp;
        closeStored++;
        console.log(`Close price for ${market.slug}: $${updates.close_price} at ${new Date(closeTick.timestamp).toISOString()}`);
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
    console.log('=== Starting Chainlink price collector (deterministic, cron-ready) ===');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 1. Get markets that need prices (deterministic, not trade-based)
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
    
    // 2. Collect RTDS Chainlink ticks for ~30 seconds
    console.log('Collecting Chainlink ticks via RTDS for 30 seconds...');
    const ticksBySymbol = await collectChainlinkTicks(30000);
    
    // 3. Find and store the correct ticks for each market
    const { openStored, closeStored } = await storePrices(supabase, marketsNeeding, ticksBySymbol);
    
    // 4. Return summary
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
      ticksCollected: {
        BTC: ticksBySymbol.get('BTC')?.length || 0,
        ETH: ticksBySymbol.get('ETH')?.length || 0
      },
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
