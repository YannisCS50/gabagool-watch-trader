import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-runner-secret',
};

const RUNNER_SECRET = Deno.env.get('RUNNER_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

type Action = 'get-markets' | 'get-trades' | 'save-trade' | 'heartbeat' | 'offline' | 'get-pending-orders' | 'update-order';

interface RequestBody {
  action: Action;
  data?: Record<string, unknown>;
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Debug logging (presence/length only, not values)
    const providedSecret = req.headers.get('x-runner-secret');
    const authHeader = req.headers.get('authorization');
    
    console.log('[runner-proxy] 🔍 DEBUG Auth check:', {
      'x-runner-secret_present': !!providedSecret,
      'x-runner-secret_length': providedSecret?.length ?? 0,
      'authorization_present': !!authHeader,
      'authorization_length': authHeader?.length ?? 0,
      'env_RUNNER_SHARED_SECRET_present': !!RUNNER_SECRET,
      'env_RUNNER_SHARED_SECRET_length': RUNNER_SECRET?.length ?? 0,
      'secrets_match': providedSecret === RUNNER_SECRET,
    });
    
    // Validate secret
    if (!RUNNER_SECRET || providedSecret !== RUNNER_SECRET) {
      console.error('[runner-proxy] ❌ Invalid or missing secret - check env var RUNNER_SHARED_SECRET');
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body: RequestBody = await req.json();
    const { action, data } = body;

    console.log(`[runner-proxy] Action: ${action}`);

    switch (action) {
      case 'get-markets': {
        // Proxy to get-market-tokens function
        const response = await fetch(`${SUPABASE_URL}/functions/v1/get-market-tokens`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
        });
        const result = await response.json();
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'get-trades': {
        const slugs = data?.slugs as string[] | undefined;
        if (!slugs || slugs.length === 0) {
          return new Response(JSON.stringify({ success: true, trades: [] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { data: trades, error } = await supabase
          .from('live_trades')
          .select('market_slug, outcome, shares, total')
          .in('market_slug', slugs);

        if (error) {
          console.error('[runner-proxy] get-trades error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, trades: trades || [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-trade': {
        const trade = data?.trade as Record<string, unknown> | undefined;
        if (!trade) {
          return new Response(JSON.stringify({ success: false, error: 'Missing trade data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Get wallet address from config to tag this trade
        const { data: config } = await supabase
          .from('bot_config')
          .select('polymarket_address')
          .single();

        // Add wallet_address to trade
        const tradeWithWallet = {
          ...trade,
          wallet_address: config?.polymarket_address || null,
        };

        const { error } = await supabase.from('live_trades').insert(tradeWithWallet);

        if (error) {
          console.error('[runner-proxy] save-trade error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] ✅ Trade saved: ${trade.outcome} ${trade.shares}@${trade.price}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'heartbeat': {
        const heartbeat = data?.heartbeat as Record<string, unknown> | undefined;
        if (!heartbeat) {
          return new Response(JSON.stringify({ success: false, error: 'Missing heartbeat data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase
          .from('runner_heartbeats')
          .upsert(heartbeat, { onConflict: 'runner_id' });

        if (error) {
          console.error('[runner-proxy] heartbeat error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'offline': {
        const runnerId = data?.runner_id as string | undefined;
        if (!runnerId) {
          return new Response(JSON.stringify({ success: false, error: 'Missing runner_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase
          .from('runner_heartbeats')
          .update({ status: 'offline', last_heartbeat: new Date().toISOString() })
          .eq('runner_id', runnerId);

        if (error) {
          console.error('[runner-proxy] offline error:', error);
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'get-pending-orders': {
        // Fetch pending orders for the runner to execute
        const { data: orders, error } = await supabase
          .from('order_queue')
          .select('*')
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(10);

        if (error) {
          console.error('[runner-proxy] get-pending-orders error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Mark orders as "processing" to prevent double-execution
        if (orders && orders.length > 0) {
          const orderIds = orders.map(o => o.id);
          await supabase
            .from('order_queue')
            .update({ status: 'processing' })
            .in('id', orderIds);
          
          console.log(`[runner-proxy] ✅ Sending ${orders.length} orders to runner`);
        }

        return new Response(JSON.stringify({ success: true, orders: orders || [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'update-order': {
        const orderId = data?.order_id as string | undefined;
        const status = data?.status as string | undefined;
        const orderResult = data?.result as Record<string, unknown> | undefined;

        if (!orderId || !status) {
          return new Response(JSON.stringify({ success: false, error: 'Missing order_id or status' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const updateData: Record<string, unknown> = {
          status,
          executed_at: new Date().toISOString(),
        };

        if (orderResult) {
          if (orderResult.order_id) updateData.order_id = orderResult.order_id;
          if (orderResult.avg_fill_price) updateData.avg_fill_price = orderResult.avg_fill_price;
          if (orderResult.error) updateData.error_message = orderResult.error;
        }

        const { error } = await supabase
          .from('order_queue')
          .update(updateData)
          .eq('id', orderId);

        if (error) {
          console.error('[runner-proxy] update-order error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] ✅ Order ${orderId} updated to ${status}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      default:
        return new Response(JSON.stringify({ success: false, error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
  } catch (error) {
    console.error('[runner-proxy] Error:', error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
