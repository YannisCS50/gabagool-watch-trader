import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PolymarketTrade {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
}

interface PolymarketActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
}

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';

async function fetchUserTrades(address: string, offset = 0, limit = 100): Promise<PolymarketTrade[]> {
  try {
    const url = `${POLYMARKET_DATA_API}/trades?user=${address}&offset=${offset}&limit=${limit}`;
    console.log(`[Sync] Fetching trades: ${url}`);
    
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.error(`[Sync] Failed to fetch trades: ${response.status}`);
      return [];
    }
    
    const trades = await response.json();
    console.log(`[Sync] Fetched ${trades.length} trades at offset ${offset}`);
    return trades;
  } catch (error) {
    console.error('[Sync] Error fetching trades:', error);
    return [];
  }
}

async function fetchUserActivity(address: string, offset = 0, limit = 100): Promise<PolymarketActivity[]> {
  try {
    const url = `${POLYMARKET_DATA_API}/activity?user=${address}&offset=${offset}&limit=${limit}`;
    console.log(`[Sync] Fetching activity: ${url}`);
    
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.error(`[Sync] Failed to fetch activity: ${response.status}`);
      return [];
    }
    
    const activity = await response.json();
    console.log(`[Sync] Fetched ${activity.length} activities at offset ${offset}`);
    return activity;
  } catch (error) {
    console.error('[Sync] Error fetching activity:', error);
    return [];
  }
}

async function fetchAllTrades(address: string): Promise<PolymarketTrade[]> {
  const allTrades: PolymarketTrade[] = [];
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const trades = await fetchUserTrades(address, offset, limit);
    if (trades.length === 0) break;
    
    allTrades.push(...trades);
    offset += limit;
    
    // Safety limit
    if (offset > 2000) {
      console.log('[Sync] Reached safety limit of 2000 trades');
      break;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  return allTrades;
}

// Convert Polymarket slug to our internal slug format
function normalizeSlug(eventSlug: string, slug: string, timestamp: number): string {
  // If it's already in our format (e.g., btc-updown-15m-1766920500), return as-is
  if (/^(btc|eth|sol|xrp)-updown-15m-\d+$/.test(slug)) {
    return slug;
  }
  
  // Try to extract asset and create internal slug
  const slugLower = (eventSlug || slug || '').toLowerCase();
  let asset = 'BTC';
  if (slugLower.includes('eth')) asset = 'ETH';
  else if (slugLower.includes('sol')) asset = 'SOL';
  else if (slugLower.includes('xrp')) asset = 'XRP';
  
  // For 15-minute markets, try to construct the slug
  if (slugLower.includes('15m') || slugLower.includes('updown')) {
    // Round timestamp to 15-minute interval
    const intervalMs = 15 * 60 * 1000;
    const intervalStart = Math.floor(timestamp / intervalMs) * intervalMs;
    const intervalSecs = Math.floor(intervalStart / 1000);
    return `${asset.toLowerCase()}-updown-15m-${intervalSecs}`;
  }
  
  // Return original slug for non-15m markets
  return slug || eventSlug;
}

// Determine outcome from trade data
function normalizeOutcome(outcome: string, outcomeIndex: number): string {
  const outcomeLower = (outcome || '').toLowerCase();
  if (outcomeLower === 'up' || outcomeLower === 'yes') return 'UP';
  if (outcomeLower === 'down' || outcomeLower === 'no') return 'DOWN';
  // Fallback to index
  return outcomeIndex === 0 ? 'UP' : 'DOWN';
}

// Extract asset from trade data
function extractAsset(trade: PolymarketTrade): string {
  const text = `${trade.title} ${trade.slug} ${trade.eventSlug}`.toLowerCase();
  if (text.includes('eth') || text.includes('ethereum')) return 'ETH';
  if (text.includes('sol') || text.includes('solana')) return 'SOL';
  if (text.includes('xrp')) return 'XRP';
  return 'BTC';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log('=== Starting Polymarket trade sync ===');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get the wallet address from bot_config
    const { data: config, error: configError } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    if (configError || !config?.polymarket_address) {
      console.error('[Sync] No wallet address configured');
      return new Response(JSON.stringify({
        success: false,
        error: 'No wallet address configured'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const walletAddress = config.polymarket_address;
    console.log(`[Sync] Syncing trades for wallet: ${walletAddress}`);

    // Get existing trades to avoid duplicates
    const { data: existingTrades } = await supabase
      .from('live_trades')
      .select('order_id, created_at');

    const existingOrderIds = new Set((existingTrades || []).map(t => t.order_id).filter(Boolean));
    console.log(`[Sync] Found ${existingOrderIds.size} existing trades in database`);

    // Fetch all trades from Polymarket
    const allTrades = await fetchAllTrades(walletAddress);
    console.log(`[Sync] Total trades from Polymarket: ${allTrades.length}`);

    // Filter to only crypto 15-minute markets
    const cryptoTrades = allTrades.filter(trade => {
      const text = `${trade.title} ${trade.slug} ${trade.eventSlug}`.toLowerCase();
      const isCrypto = text.includes('btc') || text.includes('bitcoin') || 
                       text.includes('eth') || text.includes('ethereum') ||
                       text.includes('sol') || text.includes('solana') ||
                       text.includes('xrp');
      const is15Min = text.includes('15') || text.includes('updown');
      return isCrypto && is15Min;
    });
    console.log(`[Sync] Crypto 15-min trades: ${cryptoTrades.length}`);

    // Filter out already imported trades
    const newTrades = cryptoTrades.filter(trade => {
      // Use transaction hash as unique identifier
      return !existingOrderIds.has(trade.transactionHash);
    });
    console.log(`[Sync] New trades to import: ${newTrades.length}`);

    if (newTrades.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: 'No new trades to import',
        totalFromApi: allTrades.length,
        cryptoTrades: cryptoTrades.length,
        newTrades: 0,
        durationMs: Date.now() - startTime
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Convert to our format and insert
    const tradesToInsert = newTrades.map(trade => {
      const asset = extractAsset(trade);
      const outcome = normalizeOutcome(trade.outcome, trade.outcomeIndex);
      const marketSlug = normalizeSlug(trade.eventSlug, trade.slug, trade.timestamp * 1000);
      const total = trade.size * trade.price;
      
      // Calculate event times from market slug
      const slugMatch = marketSlug.match(/(\d{10})$/);
      let eventStartTime = null;
      let eventEndTime = null;
      if (slugMatch) {
        const ts = parseInt(slugMatch[1], 10) * 1000;
        eventStartTime = new Date(ts).toISOString();
        eventEndTime = new Date(ts + 15 * 60 * 1000).toISOString();
      }

      return {
        market_slug: marketSlug,
        asset,
        outcome,
        shares: trade.size,
        price: trade.price,
        total,
        order_id: trade.transactionHash,
        status: 'filled', // Historical trades are always filled
        reasoning: `Synced from Polymarket (${trade.side})`,
        event_start_time: eventStartTime,
        event_end_time: eventEndTime,
        created_at: new Date(trade.timestamp * 1000).toISOString(),
        wallet_address: walletAddress, // Track which wallet this trade belongs to
      };
    });

    // Insert in batches
    const batchSize = 50;
    let insertedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < tradesToInsert.length; i += batchSize) {
      const batch = tradesToInsert.slice(i, i + batchSize);
      const { data, error } = await supabase
        .from('live_trades')
        .insert(batch)
        .select();

      if (error) {
        console.error(`[Sync] Batch insert error:`, error);
        errorCount += batch.length;
      } else {
        insertedCount += (data?.length || 0);
        console.log(`[Sync] Inserted batch ${i / batchSize + 1}: ${data?.length || 0} trades`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`=== Sync complete: ${insertedCount} trades in ${duration}ms ===`);

    return new Response(JSON.stringify({
      success: true,
      walletAddress,
      totalFromApi: allTrades.length,
      cryptoTrades: cryptoTrades.length,
      newTrades: newTrades.length,
      insertedTrades: insertedCount,
      errors: errorCount,
      durationMs: duration
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[Sync] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
