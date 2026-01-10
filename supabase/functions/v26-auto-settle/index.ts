// ============================================================
// V26 Auto-Settle - Automatically settle V26 trades using oracle data
// Runs on a schedule to settle trades where strike & close prices are known
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface UnsettledTrade {
  id: string;
  asset: string;
  market_slug: string;
  side: string;
  filled_shares: number | null;
  avg_fill_price: number | null;
  event_end_time: string;
}

interface StrikePrice {
  market_slug: string;
  asset: string;
  strike_price: number | null;
  close_price: number | null;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    console.log('[v26-auto-settle] Starting auto-settlement run...');

    // Fetch unsettled trades that ended more than 2 minutes ago (enough time for oracle data)
    const cutoffTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    
    const { data: unsettledTrades, error: tradesError } = await supabase
      .from('v26_trades')
      .select('id, asset, market_slug, side, filled_shares, avg_fill_price, event_end_time')
      .eq('status', 'filled')
      .is('result', null)
      .lt('event_end_time', cutoffTime)
      .order('event_end_time', { ascending: true });

    if (tradesError) {
      console.error('[v26-auto-settle] Error fetching trades:', tradesError);
      return new Response(JSON.stringify({ error: tradesError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!unsettledTrades || unsettledTrades.length === 0) {
      console.log('[v26-auto-settle] No unsettled trades found');
      return new Response(JSON.stringify({ settled: 0, pending: 0, message: 'No unsettled trades' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[v26-auto-settle] Found ${unsettledTrades.length} unsettled trades`);

    // Get unique market slugs
    const uniqueSlugs = [...new Set(unsettledTrades.map(t => t.market_slug))];

    // Fetch oracle data from strike_prices table
    const { data: oracleData, error: oracleError } = await supabase
      .from('strike_prices')
      .select('market_slug, asset, strike_price, close_price')
      .in('market_slug', uniqueSlugs);

    if (oracleError) {
      console.error('[v26-auto-settle] Error fetching oracle data:', oracleError);
      return new Response(JSON.stringify({ error: oracleError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create lookup map
    const oracleBySlug = new Map<string, StrikePrice>();
    for (const o of (oracleData || [])) {
      oracleBySlug.set(o.market_slug, o);
    }

    let settledCount = 0;
    let pendingCount = 0;
    const settledDetails: Array<{
      id: string;
      asset: string;
      slug: string;
      result: string;
      pnl: number;
    }> = [];

    // Process each trade
    for (const trade of unsettledTrades) {
      const oracle = oracleBySlug.get(trade.market_slug);

      // Check if we have complete oracle data
      if (!oracle || oracle.strike_price === null || oracle.close_price === null) {
        console.log(`[v26-auto-settle] Missing oracle data for ${trade.market_slug}`);
        pendingCount++;
        continue;
      }

      // Determine result: UP if close >= strike (per Polymarket rules), DOWN if close < strike
      const result: 'UP' | 'DOWN' = oracle.close_price >= oracle.strike_price ? 'UP' : 'DOWN';

      // Calculate PnL
      const didWin = trade.side === result;
      const shares = trade.filled_shares ?? 0;
      const avgPrice = trade.avg_fill_price ?? 0;
      const cost = shares * avgPrice;
      const payout = didWin ? shares : 0;
      const pnl = payout - cost;

      console.log(`[v26-auto-settle] Settling ${trade.asset} ${trade.market_slug}: strike=${oracle.strike_price}, close=${oracle.close_price} => ${result}, side=${trade.side}, pnl=${pnl.toFixed(2)}`);

      // Update the trade
      const { error: updateError } = await supabase
        .from('v26_trades')
        .update({
          result,
          pnl,
          settled_at: new Date().toISOString(),
        })
        .eq('id', trade.id);

      if (updateError) {
        console.error(`[v26-auto-settle] Error updating trade ${trade.id}:`, updateError);
        pendingCount++;
      } else {
        settledCount++;
        settledDetails.push({
          id: trade.id,
          asset: trade.asset,
          slug: trade.market_slug,
          result,
          pnl,
        });
      }
    }

    console.log(`[v26-auto-settle] Complete: settled=${settledCount}, pending=${pendingCount}`);

    return new Response(JSON.stringify({
      settled: settledCount,
      pending: pendingCount,
      total: unsettledTrades.length,
      details: settledDetails,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[v26-auto-settle] Unexpected error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
