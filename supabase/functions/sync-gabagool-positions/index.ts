import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Gabagool's correct wallet address
const GABAGOOL_WALLET = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const GABAGOOL_USERNAME = 'gabagool22';

interface PolymarketPosition {
  asset: string;
  market: string;
  curPrice: number;
  cashBalance: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  percentPnl: number;
  pnl: number;
  cashPnl?: number;
  redeemed: boolean;
  slug?: string;
  eventSlug?: string;
  title?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { includesClosed = false } = await req.json().catch(() => ({}));

    console.log(`[sync-gabagool] Fetching positions for ${GABAGOOL_USERNAME}...`);

    // Fetch active positions from Polymarket API
    const activeUrl = `https://data-api.polymarket.com/positions?user=${GABAGOOL_WALLET}&sizeThreshold=0.1`;
    console.log(`[sync-gabagool] Fetching active positions from: ${activeUrl}`);
    
    const activeRes = await fetch(activeUrl);
    if (!activeRes.ok) {
      throw new Error(`Failed to fetch active positions: ${activeRes.status}`);
    }
    
    const activePositions: PolymarketPosition[] = await activeRes.json();
    console.log(`[sync-gabagool] Found ${activePositions.length} active positions`);

    // Optionally fetch closed positions
    let closedPositions: PolymarketPosition[] = [];
    if (includesClosed) {
      const closedUrl = `https://data-api.polymarket.com/positions?user=${GABAGOOL_WALLET}&sizeThreshold=0.1&redeemed=true`;
      console.log(`[sync-gabagool] Fetching closed positions from: ${closedUrl}`);
      
      const closedRes = await fetch(closedUrl);
      if (closedRes.ok) {
        closedPositions = await closedRes.json();
        console.log(`[sync-gabagool] Found ${closedPositions.length} closed positions`);
      }
    }

    const allPositions = [...activePositions, ...closedPositions];
    const snapshotTime = new Date().toISOString();

    // Transform positions to snapshot format
    const snapshots = allPositions.map(pos => ({
      trader_username: GABAGOOL_USERNAME,
      market_slug: pos.slug || pos.eventSlug || pos.asset,
      market_title: pos.title || pos.market,
      outcome: pos.outcome,
      shares: pos.size,
      avg_price: pos.avgPrice,
      current_price: pos.curPrice,
      value: pos.currentValue,
      pnl: pos.cashPnl || pos.pnl || 0,
      pnl_percent: pos.percentPnl,
      is_closed: pos.redeemed || false,
      snapshot_at: snapshotTime,
    }));

    if (snapshots.length > 0) {
      const { error: insertError } = await supabase
        .from('position_snapshots')
        .insert(snapshots);

      if (insertError) {
        console.error('[sync-gabagool] Insert error:', insertError);
        throw insertError;
      }
      console.log(`[sync-gabagool] Inserted ${snapshots.length} position snapshots`);
    }

    // Also update the positions table with current state
    for (const pos of activePositions) {
      const { error: upsertError } = await supabase
        .from('positions')
        .upsert({
          trader_username: GABAGOOL_USERNAME,
          market: pos.market || pos.title || pos.asset,
          market_slug: pos.slug || pos.asset,
          outcome: pos.outcome,
          shares: pos.size,
          avg_price: pos.avgPrice,
          current_price: pos.curPrice,
          pnl: pos.pnl,
          pnl_percent: pos.percentPnl,
          updated_at: snapshotTime,
        }, {
          onConflict: 'market_slug,outcome,trader_username',
          ignoreDuplicates: false,
        });

      if (upsertError) {
        console.warn('[sync-gabagool] Upsert warning:', upsertError.message);
      }
    }

    // Summary stats
    const totalValue = activePositions.reduce((sum, p) => sum + p.currentValue, 0);
    const totalPnl = activePositions.reduce((sum, p) => sum + p.pnl, 0);
    const uniqueMarkets = new Set(activePositions.map(p => p.slug || p.asset)).size;

    const summary = {
      username: GABAGOOL_USERNAME,
      wallet: GABAGOOL_WALLET,
      activePositions: activePositions.length,
      closedPositions: closedPositions.length,
      uniqueMarkets,
      totalValue: Math.round(totalValue * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      snapshotAt: snapshotTime,
    };

    console.log('[sync-gabagool] Summary:', JSON.stringify(summary));

    return new Response(
      JSON.stringify({ 
        success: true, 
        summary,
        positions: activePositions.slice(0, 10), // Return first 10 for preview
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[sync-gabagool] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
