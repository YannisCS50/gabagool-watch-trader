import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-runner-secret',
};

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify runner secret
    const runnerSecret = req.headers.get('x-runner-secret');
    const expectedSecret = Deno.env.get('RUNNER_SHARED_SECRET');
    
    if (!runnerSecret || runnerSecret !== expectedSecret) {
      console.error('Invalid or missing runner secret');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch bot config
    const { data, error } = await supabase
      .from('bot_config')
      .select('*')
      .eq('id', '00000000-0000-0000-0000-000000000001')
      .single();

    if (error) {
      console.error('Error fetching config:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch config', details: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('✅ Bot config fetched successfully');

    // Return config in format expected by local-runner
    const config = {
      polymarket: {
        apiKey: data.polymarket_api_key || '',
        apiSecret: data.polymarket_api_secret || '',
        passphrase: data.polymarket_passphrase || '',
        privateKey: data.polymarket_private_key || '',
        address: data.polymarket_address || '',
      },
      backend: {
        url: data.backend_url || '',
        sharedSecret: data.runner_shared_secret || '',
      },
      vpn: {
        required: data.vpn_required ?? true,
        endpoint: data.vpn_endpoint || 'wg0',
      },
      trading: {
        assets: data.trade_assets || ['BTC', 'ETH'],
        maxNotionalPerTrade: data.max_notional_per_trade || 5,
        openingMaxPrice: data.opening_max_price || 0.52,
        minOrderIntervalMs: data.min_order_interval_ms || 1500,
        cloudflareBackoffMs: data.cloudflare_backoff_ms || 60000,
      },
      strategy: {
        enabled: data.strategy_enabled ?? true,
        minEdgeThreshold: data.min_edge_threshold || 0.02,
        maxPositionSize: data.max_position_size || 100,
      },
    };

    return new Response(
      JSON.stringify(config),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in get-bot-config:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
