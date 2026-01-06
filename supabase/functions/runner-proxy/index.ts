import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-runner-secret',
};

const RUNNER_SECRET = Deno.env.get('RUNNER_SHARED_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const LEASE_ID = '00000000-0000-0000-0000-000000000001';

type Action =
  | 'get-markets'
  | 'get-trades'
  | 'save-trade'
  | 'heartbeat'
  | 'offline'
  | 'get-pending-orders'
  | 'update-order'
  | 'sync-positions'
  | 'save-price-ticks'
  | 'save-snapshot-logs'
  | 'save-fill-logs'
  | 'save-settlement-logs'
  | 'save-settlement-failure'
  // v7.3.2: Runner lease actions
  | 'lease-status'
  | 'lease-claim'
  | 'lease-renew'
  | 'lease-release'
  // NEW: Observability v1 actions
  | 'save-bot-event'
  | 'save-bot-events'
  | 'save-order-lifecycle'
  | 'save-inventory-snapshot'
  | 'save-inventory-snapshots'
  | 'save-funding-snapshot'
  // v6.3.0: Skew Explainability
  | 'save-hedge-intent'
  | 'update-hedge-intent';

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

        // v7.2.7 FIX: Only count FILLED trades for position calculation
        // Previously this counted ALL trades including pending/cancelled, causing
        // the ledger to show inflated positions and bypassing the 100 share cap.
        //
        // CRITICAL: Only status='filled' trades represent actual positions.
        // 'pending', 'cancelled', 'failed', 'partial' should NOT be counted.
        const { data: trades, error } = await supabase
          .from('live_trades')
          .select('market_slug, outcome, shares, total')
          .in('market_slug', slugs)
          .eq('status', 'filled');

        if (error) {
          console.error('[runner-proxy] get-trades error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] get-trades: returning ${trades?.length ?? 0} FILLED trades for ${slugs.length} markets`);

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

      case 'lease-status': {
        const { data: lease, error } = await supabase
          .from('runner_lease')
          .select('runner_id, locked_until')
          .eq('id', LEASE_ID)
          .single();

        if (error) {
          console.error('[runner-proxy] lease-status error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, lease }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'lease-claim': {
        const runnerId = data?.runner_id as string | undefined;
        const durationMsRaw = data?.lease_duration_ms;
        const durationMs = Number.isFinite(Number(durationMsRaw)) ? Number(durationMsRaw) : 60_000;

        if (!runnerId) {
          return new Response(JSON.stringify({ success: false, error: 'Missing runner_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const now = new Date();
        const nowIso = now.toISOString();
        const lockedUntilIso = new Date(now.getTime() + durationMs).toISOString();

        // Atomic claim: succeed only if expired OR already ours
        const { data: updated, error: updateError } = await supabase
          .from('runner_lease')
          .update({
            runner_id: runnerId,
            locked_until: lockedUntilIso,
            updated_at: nowIso,
          })
          .eq('id', LEASE_ID)
          .or(`locked_until.lt.${nowIso},runner_id.eq.${runnerId}`)
          .select('runner_id, locked_until');

        if (updateError) {
          console.error('[runner-proxy] lease-claim update error:', updateError);
          return new Response(JSON.stringify({ success: false, error: updateError.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const acquired = (updated?.[0]?.runner_id === runnerId);

        if (acquired) {
          return new Response(JSON.stringify({ success: true, acquired: true, lease: updated?.[0] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { data: lease } = await supabase
          .from('runner_lease')
          .select('runner_id, locked_until')
          .eq('id', LEASE_ID)
          .single();

        return new Response(JSON.stringify({ success: true, acquired: false, lease }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'lease-renew': {
        const runnerId = data?.runner_id as string | undefined;
        const durationMsRaw = data?.lease_duration_ms;
        const durationMs = Number.isFinite(Number(durationMsRaw)) ? Number(durationMsRaw) : 60_000;

        if (!runnerId) {
          return new Response(JSON.stringify({ success: false, error: 'Missing runner_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const now = new Date();
        const nowIso = now.toISOString();
        const lockedUntilIso = new Date(now.getTime() + durationMs).toISOString();

        const { data: updated, error } = await supabase
          .from('runner_lease')
          .update({
            locked_until: lockedUntilIso,
            updated_at: nowIso,
          })
          .eq('id', LEASE_ID)
          .eq('runner_id', runnerId)
          .select('runner_id, locked_until');

        if (error) {
          console.error('[runner-proxy] lease-renew error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const renewed = (updated?.[0]?.runner_id === runnerId);

        return new Response(JSON.stringify({ success: true, renewed, lease: updated?.[0] ?? null }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'lease-release': {
        const runnerId = data?.runner_id as string | undefined;
        if (!runnerId) {
          return new Response(JSON.stringify({ success: false, error: 'Missing runner_id' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const nowIso = new Date().toISOString();
        const pastIso = new Date(Date.now() - 1000).toISOString();

        const { data: updated, error } = await supabase
          .from('runner_lease')
          .update({
            runner_id: '',
            locked_until: pastIso,
            updated_at: nowIso,
          })
          .eq('id', LEASE_ID)
          .eq('runner_id', runnerId)
          .select('runner_id, locked_until');

        if (error) {
          console.error('[runner-proxy] lease-release error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const released = (updated?.length ?? 0) > 0;

        return new Response(JSON.stringify({ success: true, released }), {
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

      case 'sync-positions': {
        // Sync positions from Polymarket API and reconcile with our database
        // Receives positions data from runner, updates live_trades status
        const positions = data?.positions as Array<{
          conditionId: string;
          market: string;
          outcome: string;
          size: number;
          avgPrice: number;
          currentValue: number;
          initialValue: number;
          eventSlug?: string;
        }> | undefined;

        const wallet = data?.wallet as string | undefined;

        if (!positions || !wallet) {
          return new Response(JSON.stringify({ success: false, error: 'Missing positions or wallet' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] 🔄 Syncing ${positions.length} positions for wallet ${wallet.slice(0, 10)}...`);

        // Get recent live_trades that are pending/unknown
        const { data: pendingTrades, error: fetchError } = await supabase
          .from('live_trades')
          .select('id, market_slug, outcome, shares, status, order_id, created_at')
          .eq('wallet_address', wallet)
          .in('status', ['pending', 'unknown', 'placed'])
          .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

        if (fetchError) {
          console.error('[runner-proxy] sync-positions fetch error:', fetchError);
          return new Response(JSON.stringify({ success: false, error: fetchError.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Create a map of actual positions from Polymarket
        const positionMap = new Map<string, { shares: number; outcome: string }>();
        for (const p of positions) {
          const slug = p.eventSlug || p.market;
          const key = `${slug}-${p.outcome.toUpperCase()}`;
          positionMap.set(key, { shares: p.size, outcome: p.outcome });
        }

        let updated = 0;
        let cancelled = 0;

        // For each pending trade, check if it exists in actual positions
        for (const trade of (pendingTrades || [])) {
          const key = `${trade.market_slug}-${trade.outcome}`;
          const actualPosition = positionMap.get(key);

          if (actualPosition && actualPosition.shares >= trade.shares * 0.9) {
            // Position exists with enough shares - mark as filled
            const { error: updateError } = await supabase
              .from('live_trades')
              .update({ status: 'filled' })
              .eq('id', trade.id);
            
            if (!updateError) {
              updated++;
              console.log(`[runner-proxy] ✅ Confirmed fill: ${trade.outcome} ${trade.shares} on ${trade.market_slug}`);
            }
          } else {
            // No position found - likely cancelled or failed
            // Only mark as cancelled if the order is old enough (>5 min)
            const tradeAge = Date.now() - new Date(trade.created_at || 0).getTime();
            if (tradeAge > 5 * 60 * 1000) {
              const { error: updateError } = await supabase
                .from('live_trades')
                .update({ status: 'cancelled' })
                .eq('id', trade.id);
              
              if (!updateError) {
                cancelled++;
                console.log(`[runner-proxy] ❌ Marked cancelled: ${trade.outcome} ${trade.shares} on ${trade.market_slug}`);
              }
            }
          }
        }

        console.log(`[runner-proxy] 🔄 Sync complete: ${updated} filled, ${cancelled} cancelled`);

        return new Response(JSON.stringify({ 
          success: true, 
          updated,
          cancelled,
          totalPositions: positions.length 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-price-ticks': {
        // Insert BTC/ETH price ticks from runner (1-second cadence)
        const ticks = data?.ticks as Array<{
          asset: string;
          price: number;
          delta: number;
          delta_percent: number;
          source: string;
        }> | undefined;

        if (!ticks || ticks.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing ticks' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('price_ticks').insert(ticks);

        if (error) {
          console.error('[runner-proxy] save-price-ticks error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, count: ticks.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-snapshot-logs': {
        const logs = data?.logs as Array<Record<string, unknown>> | undefined;
        if (!logs || logs.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing logs' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const rows = logs.map((l) => ({
          ts: l.ts,
          iso: l.iso,
          market_id: l.marketId,
          asset: l.asset,
          seconds_remaining: l.secondsRemaining,
          spot_price: l.spotPrice,
          strike_price: l.strikePrice,
          delta: l.delta,
          up_bid: l.upBid,
          up_ask: l.upAsk,
          up_mid: l.upMid,
          down_bid: l.downBid,
          down_ask: l.downAsk,
          down_mid: l.downMid,
          spread_up: l.spreadUp,
          spread_down: l.spreadDown,
          combined_ask: l.combinedAsk,
          combined_mid: l.combinedMid,
          cheapest_ask_plus_other_mid: l.cheapestAskPlusOtherMid,
          orderbook_ready: l.orderbookReady,  // v6.2.0
          bot_state: l.botState,
          up_shares: l.upShares,
          down_shares: l.downShares,
          avg_up_cost: l.avgUpCost,
          avg_down_cost: l.avgDownCost,
          pair_cost: l.pairCost,
          skew: l.skew,
          no_liquidity_streak: l.noLiquidityStreak,
          adverse_streak: l.adverseStreak,
        }));

        const { error } = await supabase.from('snapshot_logs').insert(rows);
        if (error) {
          console.error('[runner-proxy] save-snapshot-logs error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, count: rows.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-fill-logs': {
        const logs = data?.logs as Array<Record<string, unknown>> | undefined;
        if (!logs || logs.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing logs' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const rows = logs.map((l) => ({
          ts: l.ts,
          iso: l.iso,
          market_id: l.marketId,
          asset: l.asset,
          side: l.side,
          order_id: l.orderId,
          client_order_id: l.clientOrderId,
          fill_qty: l.fillQty,
          fill_price: l.fillPrice,
          fill_notional: l.fillNotional,
          intent: l.intent,
          seconds_remaining: l.secondsRemaining,
          spot_price: l.spotPrice,
          strike_price: l.strikePrice,
          delta: l.delta,
          hedge_lag_ms: l.hedgeLagMs,
        }));

        const { error } = await supabase.from('fill_logs').insert(rows);
        if (error) {
          console.error('[runner-proxy] save-fill-logs error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, count: rows.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-settlement-logs': {
        const logs = data?.logs as Array<Record<string, unknown>> | undefined;
        if (!logs || logs.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing logs' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const rows = logs.map((l) => ({
          ts: l.ts,
          iso: l.iso,
          market_id: l.marketId,
          asset: l.asset,
          open_ts: l.openTs,
          close_ts: l.closeTs,
          final_up_shares: l.finalUpShares,
          final_down_shares: l.finalDownShares,
          avg_up_cost: l.avgUpCost,
          avg_down_cost: l.avgDownCost,
          pair_cost: l.pairCost,
          realized_pnl: l.realizedPnL,
          winning_side: l.winningSide,
          max_delta: l.maxDelta,
          min_delta: l.minDelta,
          time_in_low: l.timeInLow,
          time_in_mid: l.timeInMid,
          time_in_high: l.timeInHigh,
          count_dislocation_95: l.countDislocation95,
          count_dislocation_97: l.countDislocation97,
          last_180s_dislocation_95: l.last180sDislocation95,
          theoretical_pnl: l.theoreticalPnL,
          fees: l.fees,                       // v6.4.0: fees_paid_usd
          total_payout_usd: l.totalPayoutUsd, // v6.4.0: total_payout_usd
        }));

        const { error } = await supabase.from('settlement_logs').insert(rows);
        if (error) {
          console.error('[runner-proxy] save-settlement-logs error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, count: rows.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'save-settlement-failure': {
        // v4.4: Log settlement failure - THE critical metric
        const failure = data?.failure as {
          market_slug: string;
          asset: string;
          up_shares: number;
          down_shares: number;
          up_cost: number;
          down_cost: number;
          lost_side: string;
          lost_cost: number;
          seconds_remaining: number;
          reason: string;
          panic_hedge_attempted: boolean;
          wallet_address?: string;
        } | undefined;

        if (!failure) {
          return new Response(JSON.stringify({ success: false, error: 'Missing failure data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log('[runner-proxy] 🚨 SETTLEMENT FAILURE:', failure);

        const { error } = await supabase.from('settlement_failures').insert(failure);

        if (error) {
          console.error('[runner-proxy] save-settlement-failure error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save single bot event
      case 'save-bot-event': {
        const event = data?.event as {
          ts: number;
          run_id?: string;
          market_id?: string;
          asset: string;
          event_type: string;
          correlation_id?: string;
          reason_code?: string;
          data?: Record<string, unknown>;
        } | undefined;

        if (!event) {
          return new Response(JSON.stringify({ success: false, error: 'Missing event' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('bot_events').insert(event);
        if (error) {
          console.error('[runner-proxy] save-bot-event error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] ✅ Bot event saved: ${event.event_type}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save batch bot events
      case 'save-bot-events': {
        const events = data?.events as Array<{
          ts: number;
          run_id?: string;
          market_id?: string;
          asset: string;
          event_type: string;
          correlation_id?: string;
          reason_code?: string;
          data?: Record<string, unknown>;
        }> | undefined;

        if (!events || events.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing events' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('bot_events').insert(events);
        if (error) {
          console.error('[runner-proxy] save-bot-events error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] ✅ Saved ${events.length} bot events`);
        return new Response(JSON.stringify({ success: true, count: events.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save order lifecycle
      case 'save-order-lifecycle': {
        const order = data?.order as {
          client_order_id: string;
          exchange_order_id?: string;
          correlation_id?: string;
          market_id: string;
          asset: string;
          side: string;
          price: number;
          qty: number;
          status: string;
          intent_type: string;
          filled_qty?: number;
          avg_fill_price?: number;
          reserved_notional?: number;
          released_notional?: number;
          created_ts: number;
          last_update_ts: number;
        } | undefined;

        if (!order) {
          return new Response(JSON.stringify({ success: false, error: 'Missing order data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Upsert by client_order_id
        const { error } = await supabase
          .from('orders')
          .upsert(order, { onConflict: 'client_order_id' });

        if (error) {
          console.error('[runner-proxy] save-order-lifecycle error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] ✅ Order lifecycle saved: ${order.client_order_id} -> ${order.status}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save inventory snapshot
      case 'save-inventory-snapshot': {
        const snapshot = data?.snapshot as {
          ts: number;
          market_id: string;
          asset: string;
          up_shares: number;
          down_shares: number;
          avg_up_cost?: number;
          avg_down_cost?: number;
          pair_cost?: number;
          unpaired_shares?: number;
          unpaired_notional_usd?: number;  // v6.4.0
          paired_shares?: number;          // v6.4.0
          paired_delay_sec?: number;       // v6.4.0
          state: string;
          state_age_ms?: number;
          hedge_lag_ms?: number;
          trigger_type?: string;
        } | undefined;

        if (!snapshot) {
          return new Response(JSON.stringify({ success: false, error: 'Missing snapshot data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('inventory_snapshots').insert(snapshot);
        if (error) {
          console.error('[runner-proxy] save-inventory-snapshot error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save batch inventory snapshots
      case 'save-inventory-snapshots': {
        const snapshots = data?.snapshots as Array<{
          ts: number;
          market_id: string;
          asset: string;
          up_shares: number;
          down_shares: number;
          avg_up_cost?: number;
          avg_down_cost?: number;
          pair_cost?: number;
          unpaired_shares?: number;
          unpaired_notional_usd?: number;  // v6.4.0: unpaired exposure in USD
          paired_shares?: number;          // v6.4.0: explicit paired count
          paired_delay_sec?: number;       // v6.4.0: time to complete hedge
          state: string;
          state_age_ms?: number;
          hedge_lag_ms?: number;
          trigger_type?: string;
          skew_allowed_reason?: string;  // v6.3.0
        }> | undefined;

        if (!snapshots || snapshots.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Missing snapshots' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('inventory_snapshots').insert(snapshots);
        if (error) {
          console.error('[runner-proxy] save-inventory-snapshots error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ success: true, count: snapshots.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // NEW: Observability v1 - Save funding snapshot (CRITICAL)
      case 'save-funding-snapshot': {
        const snapshot = data?.snapshot as {
          ts: number;
          balance_total: number;
          balance_available: number;
          reserved_total?: number;
          reserved_by_market?: Record<string, number>;
          allowance_remaining?: number;
          spendable?: number;
          blocked_reason?: string;
          trigger_type?: string;
        } | undefined;

        if (!snapshot) {
          return new Response(JSON.stringify({ success: false, error: 'Missing snapshot data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('funding_snapshots').insert(snapshot);
        if (error) {
          console.error('[runner-proxy] save-funding-snapshot error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] 💰 Funding snapshot: bal=${snapshot.balance_available}/${snapshot.balance_total}, blocked=${snapshot.blocked_reason || 'NONE'}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // v6.3.0: Skew Explainability - Save hedge intent
      case 'save-hedge-intent': {
        const intent = data?.intent as {
          ts: number;
          correlation_id?: string;
          run_id?: string;
          market_id: string;
          asset: string;
          side: string;
          intent_type: string;
          intended_qty: number;
          filled_qty?: number;
          status: string;
          abort_reason?: string;
          price_at_intent?: number;
          price_at_resolution?: number;
          resolution_ts?: number;
        } | undefined;

        if (!intent) {
          return new Response(JSON.stringify({ success: false, error: 'Missing intent data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase.from('hedge_intents').insert(intent);
        if (error) {
          console.error('[runner-proxy] save-hedge-intent error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] 🎯 Hedge intent: ${intent.intent_type} ${intent.side} ${intent.intended_qty} status=${intent.status}`);
        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // v6.3.0: Skew Explainability - Update hedge intent
      case 'update-hedge-intent': {
        const correlationId = data?.correlation_id as string | undefined;
        const marketId = data?.market_id as string | undefined;
        const update = data?.update as {
          status?: string;
          filled_qty?: number;
          abort_reason?: string;
          price_at_resolution?: number;
          resolution_ts?: number;
        } | undefined;

        if (!correlationId || !marketId || !update) {
          return new Response(JSON.stringify({ success: false, error: 'Missing correlation_id, market_id or update data' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const { error } = await supabase
          .from('hedge_intents')
          .update(update)
          .eq('correlation_id', correlationId)
          .eq('market_id', marketId);

        if (error) {
          console.error('[runner-proxy] update-hedge-intent error:', error);
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        console.log(`[runner-proxy] 🔄 Hedge intent updated: ${correlationId} -> ${update.status}`);
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
