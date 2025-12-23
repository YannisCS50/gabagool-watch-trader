import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('🗑️ Resetting paper trades...');

    // Delete all paper trade results first
    const { error: resultsError } = await supabase
      .from('paper_trade_results')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (resultsError) {
      console.error('Error deleting results:', resultsError);
      throw resultsError;
    }

    // Delete all paper trades
    const { error: tradesError } = await supabase
      .from('paper_trades')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    if (tradesError) {
      console.error('Error deleting trades:', tradesError);
      throw tradesError;
    }

    console.log(`✅ Reset complete: deleted all trades and results`);

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Paper trading reset complete - starting fresh with $1000'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Reset error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
