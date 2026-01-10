import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_URL = 'https://data-api.polymarket.com';

interface PolymarketPosition {
  conditionId: string;
  asset: string;
  title?: string;
  slug?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  redeemable?: boolean;
  endDate?: string;
  proxyWallet?: string;
}

interface ClaimablePosition {
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  endDate: string;
  wallet: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get wallet address from bot_config
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: config } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    if (!config?.polymarket_address) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No wallet configured',
        claimables: [],
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const walletAddress = config.polymarket_address.toLowerCase();
    console.log(`Fetching claimables for wallet: ${walletAddress}`);

    // Fetch positions from Polymarket Data API
    const allPositions: PolymarketPosition[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = 5;

    while (pageCount < maxPages) {
      pageCount++;
      let url = `${DATA_API_URL}/positions?user=${walletAddress}&sizeThreshold=0&limit=500`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

      console.log(`Fetching page ${pageCount}: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        console.error(`API error: HTTP ${response.status}`);
        break;
      }

      const data = await response.json();

      let positions: PolymarketPosition[];
      let nextCursor: string | null = null;

      if (Array.isArray(data)) {
        positions = data;
      } else if (data.positions && Array.isArray(data.positions)) {
        positions = data.positions;
        nextCursor = data.next_cursor || data.nextCursor || null;
      } else {
        console.log('Unexpected API response format');
        break;
      }

      allPositions.push(...positions);
      console.log(`Page ${pageCount}: ${positions.length} positions`);

      if (!nextCursor || nextCursor === cursor || positions.length === 0) break;
      cursor = nextCursor;
    }

    console.log(`Total positions fetched: ${allPositions.length}`);

    // Filter to only redeemable positions
    const claimables: ClaimablePosition[] = allPositions
      .filter(p => p.redeemable === true && (p.currentValue || 0) > 0.01)
      .map(p => ({
        conditionId: p.conditionId,
        title: p.title || 'Unknown Market',
        slug: p.slug || '',
        outcome: p.outcome,
        shares: p.size,
        avgPrice: p.avgPrice,
        currentValue: p.currentValue || 0,
        pnl: p.cashPnl || 0,
        pnlPercent: p.percentPnl || 0,
        endDate: p.endDate || '',
        wallet: walletAddress,
      }))
      .sort((a, b) => b.currentValue - a.currentValue);

    const totalClaimable = claimables.reduce((sum, c) => sum + c.currentValue, 0);
    const totalPnl = claimables.reduce((sum, c) => sum + c.pnl, 0);

    console.log(`Found ${claimables.length} claimable positions worth $${totalClaimable.toFixed(2)}`);

    return new Response(JSON.stringify({
      success: true,
      claimables,
      summary: {
        count: claimables.length,
        totalValue: totalClaimable,
        totalPnl: totalPnl,
      },
      wallet: walletAddress,
      fetchedAt: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error fetching claimables:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      claimables: [],
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
