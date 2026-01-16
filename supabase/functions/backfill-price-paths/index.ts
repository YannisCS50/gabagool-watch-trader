import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    console.log('[backfill-price-paths] Starting backfill...');

    // 1. Fetch signals that are missing price path data
    const { data: signals, error: signalsError } = await supabase
      .from('v29_signals_response')
      .select('id, signal_ts, direction, asset, market_slug')
      .is('price_at_1s', null)
      .not('signal_ts', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100); // Process in batches

    if (signalsError) {
      console.error('[backfill-price-paths] Error fetching signals:', signalsError);
      throw signalsError;
    }

    if (!signals || signals.length === 0) {
      console.log('[backfill-price-paths] No signals to backfill');
      return new Response(
        JSON.stringify({ success: true, message: 'No signals to backfill', processed: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[backfill-price-paths] Found ${signals.length} signals to process`);

    let processed = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const signal of signals) {
      try {
        const signalTs = Number(signal.signal_ts);
        const direction = signal.direction as 'UP' | 'DOWN';
        
        // Time offsets in milliseconds
        const offsets = [1000, 2000, 3000, 5000];
        const prices: Record<string, number | null> = {
          price_at_1s: null,
          price_at_2s: null,
          price_at_3s: null,
          price_at_5s: null,
        };

        // For each offset, find the closest tick
        for (let i = 0; i < offsets.length; i++) {
          const targetTs = signalTs + offsets[i];
          const columnName = `price_at_${offsets[i] / 1000}s`;
          
          // Query for ticks within ±500ms of target timestamp
          const { data: ticks, error: ticksError } = await supabase
            .from('v29_ticks')
            .select('ts, up_best_ask, up_best_bid, down_best_ask, down_best_bid')
            .eq('asset', signal.asset)
            .gte('ts', targetTs - 500)
            .lte('ts', targetTs + 500)
            .order('ts', { ascending: true })
            .limit(5);

          if (ticksError) {
            console.error(`[backfill-price-paths] Error fetching ticks for signal ${signal.id}:`, ticksError);
            continue;
          }

          if (ticks && ticks.length > 0) {
            // Find closest tick to target
            let closestTick = ticks[0];
            let minDiff = Math.abs(Number(ticks[0].ts) - targetTs);
            
            for (const tick of ticks) {
              const diff = Math.abs(Number(tick.ts) - targetTs);
              if (diff < minDiff) {
                minDiff = diff;
                closestTick = tick;
              }
            }

            // Get the relevant price based on direction
            // If we bought UP, we care about up_best_bid (what we can sell for)
            // If we bought DOWN, we care about down_best_bid
            const price = direction === 'UP' 
              ? closestTick.up_best_bid 
              : closestTick.down_best_bid;

            if (price !== null) {
              prices[columnName] = Number(price);
            }
          }
        }

        // Update if we found any prices
        const hasAnyPrice = Object.values(prices).some(p => p !== null);
        if (hasAnyPrice) {
          const { error: updateError } = await supabase
            .from('v29_signals_response')
            .update(prices)
            .eq('id', signal.id);

          if (updateError) {
            console.error(`[backfill-price-paths] Error updating signal ${signal.id}:`, updateError);
            errors.push(`Signal ${signal.id}: ${updateError.message}`);
          } else {
            updated++;
            console.log(`[backfill-price-paths] Updated signal ${signal.id} with prices:`, prices);
          }
        } else {
          console.log(`[backfill-price-paths] No ticks found for signal ${signal.id} at ts=${signalTs}`);
        }

        processed++;
      } catch (err) {
        console.error(`[backfill-price-paths] Error processing signal ${signal.id}:`, err);
        errors.push(`Signal ${signal.id}: ${String(err)}`);
      }
    }

    console.log(`[backfill-price-paths] Complete. Processed: ${processed}, Updated: ${updated}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        processed, 
        updated,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[backfill-price-paths] Fatal error:', error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
