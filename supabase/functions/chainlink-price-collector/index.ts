import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ChainlinkPrice {
  symbol: string;
  timestamp: number;
  value: number;
}

interface MarketToTrack {
  slug: string;
  asset: 'BTC' | 'ETH';
  eventStartTime: number;
}

// Parse timestamp from market slug like btc-updown-15m-1766485800
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

// Get the next scheduled market start times (every 15 mins: :00, :15, :30, :45)
function getUpcoming15MinSlots(count: number = 4): number[] {
  const now = Date.now();
  const currentMinute = new Date(now).getMinutes();
  const currentSlot = Math.floor(currentMinute / 15) * 15;
  
  const slots: number[] = [];
  const baseTime = new Date(now);
  baseTime.setMinutes(currentSlot, 0, 0);
  
  for (let i = 0; i <= count; i++) {
    const slotTime = new Date(baseTime.getTime() + i * 15 * 60 * 1000);
    slots.push(Math.floor(slotTime.getTime() / 1000));
  }
  
  return slots;
}

// Fetch active 15-min markets from DB that need strike prices
async function getMarketsNeedingStrikePrices(supabase: any): Promise<MarketToTrack[]> {
  // Get recent 15-min market slugs from trades
  const { data: trades, error } = await supabase
    .from('trades')
    .select('market_slug')
    .or('market_slug.ilike.%15m%')
    .gte('timestamp', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .order('timestamp', { ascending: false });
  
  if (error || !trades) {
    console.error('Error fetching trades:', error);
    return [];
  }
  
  // Get unique market slugs
  const uniqueSlugs = [...new Set(trades.map((t: any) => t.market_slug))].filter(Boolean);
  
  // Check which ones already have strike prices
  const { data: existingPrices, error: priceError } = await supabase
    .from('strike_prices')
    .select('market_slug')
    .in('market_slug', uniqueSlugs);
  
  const existingSlugs = new Set((existingPrices || []).map((p: any) => p.market_slug));
  
  // Filter to markets that don't have strike prices yet
  const marketsNeeding: MarketToTrack[] = [];
  
  for (const slug of uniqueSlugs) {
    if (existingSlugs.has(slug)) continue;
    
    const timestamp = parseTimestampFromSlug(slug as string);
    if (!timestamp) continue;
    
    const slugLower = (slug as string).toLowerCase();
    const asset: 'BTC' | 'ETH' = slugLower.includes('btc') ? 'BTC' : 'ETH';
    
    marketsNeeding.push({
      slug: slug as string,
      asset,
      eventStartTime: timestamp
    });
  }
  
  return marketsNeeding;
}

// Connect to Polymarket RTDS WebSocket and get Chainlink prices
async function fetchChainlinkPricesViaRTDS(): Promise<Map<string, ChainlinkPrice>> {
  return new Promise((resolve, reject) => {
    const prices = new Map<string, ChainlinkPrice>();
    const timeout = setTimeout(() => {
      ws.close();
      resolve(prices);
    }, 10000); // 10 second timeout
    
    const ws = new WebSocket('wss://rtds.polymarket.com');
    
    ws.onopen = () => {
      console.log('Connected to Polymarket RTDS');
      
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
            prices.set(symbol, {
              symbol,
              timestamp: payload.timestamp || Date.now(),
              value: payload.value
            });
            
            console.log(`Chainlink ${symbol}: $${payload.value} at ${new Date(payload.timestamp).toISOString()}`);
            
            // Once we have both BTC and ETH, we're done
            if (prices.has('BTC') && prices.has('ETH')) {
              clearTimeout(timeout);
              ws.close();
              resolve(prices);
            }
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
      resolve(prices);
    };
  });
}

// Store strike prices in database
async function storeStrikePrices(
  supabase: any, 
  markets: MarketToTrack[], 
  prices: Map<string, ChainlinkPrice>
): Promise<number> {
  let stored = 0;
  
  for (const market of markets) {
    const price = prices.get(market.asset);
    if (!price) {
      console.log(`No Chainlink price for ${market.asset}, skipping ${market.slug}`);
      continue;
    }
    
    // Only store if the market has started (we're recording the price AT market start)
    const now = Date.now();
    const marketStartMs = market.eventStartTime * 1000;
    
    // Market must have started but not ended (15 min window)
    if (now < marketStartMs) {
      console.log(`Market ${market.slug} hasn't started yet (starts at ${new Date(marketStartMs).toISOString()})`);
      continue;
    }
    
    if (now > marketStartMs + 15 * 60 * 1000) {
      console.log(`Market ${market.slug} already expired`);
      continue;
    }
    
    // Insert the strike price
    const { error } = await supabase
      .from('strike_prices')
      .upsert({
        market_slug: market.slug,
        asset: market.asset,
        strike_price: price.value,
        event_start_time: new Date(marketStartMs).toISOString(),
        chainlink_timestamp: price.timestamp
      }, {
        onConflict: 'market_slug'
      });
    
    if (error) {
      console.error(`Error storing strike price for ${market.slug}:`, error);
    } else {
      console.log(`Stored strike price for ${market.slug}: $${price.value}`);
      stored++;
    }
  }
  
  return stored;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting Chainlink price collector...');
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // 1. Get markets that need strike prices
    const marketsNeeding = await getMarketsNeedingStrikePrices(supabase);
    console.log(`Found ${marketsNeeding.length} markets needing strike prices`);
    
    if (marketsNeeding.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No markets need strike prices',
        marketsProcessed: 0,
        pricesStored: 0
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    // 2. Fetch current Chainlink prices via RTDS WebSocket
    console.log('Connecting to Polymarket RTDS for Chainlink prices...');
    const chainlinkPrices = await fetchChainlinkPricesViaRTDS();
    console.log(`Got ${chainlinkPrices.size} Chainlink prices`);
    
    // 3. Store strike prices for markets that just started
    const stored = await storeStrikePrices(supabase, marketsNeeding, chainlinkPrices);
    
    // 4. Return summary
    return new Response(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      marketsNeeding: marketsNeeding.length,
      marketsProcessed: marketsNeeding.map(m => ({
        slug: m.slug,
        asset: m.asset,
        eventStartTime: new Date(m.eventStartTime * 1000).toISOString()
      })),
      chainlinkPrices: Object.fromEntries(
        Array.from(chainlinkPrices.entries()).map(([k, v]) => [k, v.value])
      ),
      pricesStored: stored
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
