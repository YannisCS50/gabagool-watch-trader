import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ExpiredMarketData {
  slug: string;
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP';
  question?: string;
  eventStartTime: string;
  eventEndTime: string;
  strikePrice?: number | null;
  closePrice?: number | null;
  upPriceAtClose?: number | null;
  downPriceAtClose?: number | null;
  upTokenId?: string;
  downTokenId?: string;
}

// Parse timestamp from slug (e.g., btc-updown-15m-1766485800 -> 1766485800)
function parseTimestampFromSlug(slug: string): number | null {
  const match = slug.match(/(\d{10})$/);
  return match ? parseInt(match[1], 10) : null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('=== Saving expired market ===');

  try {
    const body = await req.json();
    const marketData: ExpiredMarketData = body;

    if (!marketData.slug || !marketData.asset) {
      console.error('Missing required fields:', { slug: marketData.slug, asset: marketData.asset });
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: slug, asset'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check if market already exists with a result
    const { data: existing } = await supabase
      .from('market_history')
      .select('result, close_price, open_price')
      .eq('slug', marketData.slug)
      .maybeSingle();

    // Idempotent: skip if already resolved
    if (existing?.result && existing.result !== 'UNKNOWN' && existing.close_price) {
      console.log(`[Skip] Market ${marketData.slug} already resolved: ${existing.result}`);
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: 'Already resolved',
        result: existing.result
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Derive eventStartTime and eventEndTime from slug (slug = truth)
    const slugTimestamp = parseTimestampFromSlug(marketData.slug);
    let eventStartTime: string;
    let eventEndTime: string;
    
    if (slugTimestamp) {
      // Slug is truth for 15m markets
      eventStartTime = new Date(slugTimestamp * 1000).toISOString();
      eventEndTime = new Date((slugTimestamp + 15 * 60) * 1000).toISOString();
      console.log(`[Time] Derived from slug: start=${eventStartTime}, end=${eventEndTime}`);
    } else {
      // Fallback to provided times
      eventStartTime = marketData.eventStartTime;
      eventEndTime = marketData.eventEndTime;
    }

    // Fetch oracle prices from strike_prices table (the reliable source)
    const { data: oracleData } = await supabase
      .from('strike_prices')
      .select('open_price, close_price, strike_price')
      .eq('market_slug', marketData.slug)
      .maybeSingle();

    // Priority: oracle data > provided data
    const openPrice = oracleData?.open_price ?? oracleData?.strike_price ?? marketData.strikePrice ?? null;
    const closePrice = oracleData?.close_price ?? marketData.closePrice ?? null;

    // Calculate result from oracle prices
    let result: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
    if (openPrice !== null && closePrice !== null) {
      result = closePrice > openPrice ? 'UP' : 'DOWN';
      console.log(`[Result] Open: $${openPrice}, Close: $${closePrice} => ${result}`);
    } else {
      console.log(`[Result] Missing prices - open: ${openPrice}, close: ${closePrice} => UNKNOWN`);
    }

    // Upsert the market data
    const { data, error } = await supabase
      .from('market_history')
      .upsert({
        slug: marketData.slug,
        asset: marketData.asset,
        question: marketData.question || null,
        event_start_time: eventStartTime,
        event_end_time: eventEndTime,
        // Semantic naming: open_price is the "price to beat"
        open_price: openPrice,
        strike_price: openPrice, // Legacy alias
        close_price: closePrice,
        up_price_at_close: marketData.upPriceAtClose || null,
        down_price_at_close: marketData.downPriceAtClose || null,
        up_token_id: marketData.upTokenId || null,
        down_token_id: marketData.downTokenId || null,
        result,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'slug'
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving market:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`=== Saved market ${marketData.slug} with result ${result} ===`);

    return new Response(JSON.stringify({
      success: true,
      market: data,
      result,
      openPrice,
      closePrice
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
