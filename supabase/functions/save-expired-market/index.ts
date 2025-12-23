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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  console.log('=== Saving expired market ===');

  try {
    const body = await req.json();
    const marketData: ExpiredMarketData = body;

    if (!marketData.slug || !marketData.asset || !marketData.eventStartTime || !marketData.eventEndTime) {
      console.error('Missing required fields:', { slug: marketData.slug, asset: marketData.asset });
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: slug, asset, eventStartTime, eventEndTime'
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Determine result based on close price vs strike price
    let result: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
    if (marketData.closePrice && marketData.strikePrice) {
      result = marketData.closePrice > marketData.strikePrice ? 'UP' : 'DOWN';
      console.log(`[Result] Close: $${marketData.closePrice}, Strike: $${marketData.strikePrice} => ${result}`);
    }

    // Upsert the market data
    const { data, error } = await supabase
      .from('market_history')
      .upsert({
        slug: marketData.slug,
        asset: marketData.asset,
        question: marketData.question || null,
        event_start_time: marketData.eventStartTime,
        event_end_time: marketData.eventEndTime,
        strike_price: marketData.strikePrice || null,
        close_price: marketData.closePrice || null,
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
      result
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
