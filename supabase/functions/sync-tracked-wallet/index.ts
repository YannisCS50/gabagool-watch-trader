import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';

interface PolymarketTrade {
  id: string;
  timestamp: string;
  taker_side: string;
  maker_side: string;
  outcome: string;
  size: string;
  price: string;
  market_slug: string;
  maker_address?: string;
  taker_address?: string;
  asset_id?: string;
  fee_rate_bps?: string;
}

async function fetchTradesForWallet(walletAddress: string, limit = 100): Promise<PolymarketTrade[]> {
  const url = `${POLYMARKET_DATA_API}/trades?user=${walletAddress}&limit=${limit}`;
  console.log(`[SyncTrackedWallet] Fetching: ${url}`);
  
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

function extractAssetFromSlug(slug: string): string | null {
  const match = slug?.match(/^(btc|eth|sol|xrp)-/i);
  return match ? match[1].toUpperCase() : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get wallet from request or use default
    let walletAddress = '0xa20b482f97063f4f88ef621c9203e60814399940';
    
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      if (body.wallet_address) {
        walletAddress = body.wallet_address.toLowerCase();
      }
    }

    console.log(`[SyncTrackedWallet] Syncing trades for wallet: ${walletAddress}`);

    // Fetch latest trades
    const trades = await fetchTradesForWallet(walletAddress, 200);
    console.log(`[SyncTrackedWallet] Fetched ${trades.length} trades`);

    if (trades.length === 0) {
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'No trades found',
        wallet: walletAddress,
        synced: 0 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Transform and insert trades
    const tradeRows = trades.map((trade) => {
      const isMaker = trade.maker_address?.toLowerCase() === walletAddress;
      const side = isMaker ? trade.maker_side : trade.taker_side;
      
      return {
        wallet_address: walletAddress,
        trade_id: trade.id,
        timestamp: trade.timestamp,
        side: side?.toUpperCase() || 'UNKNOWN',
        asset: extractAssetFromSlug(trade.market_slug),
        market_slug: trade.market_slug,
        outcome: trade.outcome,
        size: parseFloat(trade.size) || 0,
        price: parseFloat(trade.price) || 0,
        fee: trade.fee_rate_bps ? parseFloat(trade.fee_rate_bps) / 10000 : null,
        raw_data: trade,
      };
    });

    // Upsert trades (ignore conflicts on trade_id)
    const { data, error } = await supabase
      .from('tracked_wallet_trades')
      .upsert(tradeRows, { 
        onConflict: 'trade_id',
        ignoreDuplicates: true 
      })
      .select('id');

    if (error) {
      console.error('[SyncTrackedWallet] Insert error:', error);
      throw error;
    }

    const insertedCount = data?.length || 0;
    console.log(`[SyncTrackedWallet] Inserted ${insertedCount} new trades`);

    return new Response(JSON.stringify({
      success: true,
      wallet: walletAddress,
      fetched: trades.length,
      synced: insertedCount,
      latest_trade: trades[0] ? {
        timestamp: trades[0].timestamp,
        side: trades[0].taker_side || trades[0].maker_side,
        size: trades[0].size,
        price: trades[0].price,
        market: trades[0].market_slug
      } : null
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[SyncTrackedWallet] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ 
      error: message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
