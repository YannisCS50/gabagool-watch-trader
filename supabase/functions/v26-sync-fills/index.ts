import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * v26-sync-fills: Robust fill synchronization via Polymarket Data API
 *
 * Uses the public data-api.polymarket.com endpoint (no auth required) to:
 * 1. Fetch recent trades for the bot's wallet
 * 2. Match them to v26_trades by conditionId/outcome/timestamp
 * 3. Update filled_shares, avg_fill_price, fill_matched_at
 *
 * Falls back to fill_logs if Data API fails.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';

interface DataApiTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string; // token ID
  conditionId: string;
  size: number;
  price: number;
  timestamp: number; // Unix seconds
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string; // "Yes" or "No"
  outcomeIndex: number;
  transactionHash: string;
}

interface V26Trade {
  id: string;
  market_id: string;
  market_slug: string;
  side: string; // UP or DOWN
  shares: number;
  event_start_time: string;
  event_end_time: string;
  status: string;
  filled_shares: number;
  avg_fill_price: number | null;
  fill_matched_at: string | null;
}

/**
 * Fetch trades from Polymarket Data API (public, no auth)
 */
async function fetchTradesFromDataApi(
  walletAddress: string,
  options: { limit?: number; side?: 'BUY' | 'SELL'; offset?: number } = {}
): Promise<DataApiTrade[]> {
  const { limit = 500, side = 'BUY', offset = 0 } = options;

  const url = new URL(`${DATA_API_BASE}/trades`);
  url.searchParams.set('user', walletAddress.toLowerCase());
  url.searchParams.set('side', side);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  console.log(`[v26-sync-fills] Fetching trades from ${url.toString().replace(walletAddress.toLowerCase(), walletAddress.slice(0, 10) + '...')}`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[v26-sync-fills] Data API returned ${response.status}: ${text.slice(0, 200)}`);
    throw new Error(`Data API error ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Extract market_id (conditionId) from v26_trades.market_id field
 * V26 stores condition IDs directly in market_id
 */
function normalizeConditionId(conditionId: string): string {
  return (conditionId || '').toLowerCase().trim();
}

/**
 * Map outcome string to UP/DOWN
 * Data API returns "Yes" or "No" - for Up/Down markets:
 * - outcomeIndex 0 = "Yes" = UP
 * - outcomeIndex 1 = "No" = DOWN
 */
function mapOutcomeToSide(outcome: string, outcomeIndex: number): 'UP' | 'DOWN' {
  // For updown markets, outcomeIndex 0 is typically "Up" (Yes), 1 is "Down" (No)
  if (outcomeIndex === 0) return 'UP';
  if (outcomeIndex === 1) return 'DOWN';
  // Fallback based on outcome string
  const lower = outcome.toLowerCase();
  if (lower.includes('up') || lower === 'yes') return 'UP';
  return 'DOWN';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log('[v26-sync-fills] Starting fill sync via Data API...');

    // Get wallet address from bot_config
    const { data: botConfig } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .single();

    const walletAddress = botConfig?.polymarket_address;
    if (!walletAddress) {
      console.error('[v26-sync-fills] No polymarket_address in bot_config');
      return new Response(
        JSON.stringify({ error: 'Missing polymarket_address in bot_config' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[v26-sync-fills] Using wallet: ${walletAddress.slice(0, 10)}...`);

    // Fetch trades needing sync (last 7 days, missing fill data or not final status)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, market_id, market_slug, side, shares, event_start_time, event_end_time, status, filled_shares, avg_fill_price, fill_matched_at')
      .gte('event_start_time', sevenDaysAgo)
      .or('fill_matched_at.is.null,status.in.(placed,open,partial,processing),filled_shares.eq.0')
      .limit(100);

    if (fetchError) {
      console.error('[v26-sync-fills] Error fetching trades:', fetchError);
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[v26-sync-fills] Found ${trades?.length || 0} trades to sync`);

    if (!trades || trades.length === 0) {
      return new Response(
        JSON.stringify({ success: true, synced: 0, failed: 0, source: 'none' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Build lookup: conditionId -> array of v26_trades
    const tradesByCondition = new Map<string, V26Trade[]>();
    for (const t of trades) {
      const cid = normalizeConditionId(t.market_id);
      if (!tradesByCondition.has(cid)) {
        tradesByCondition.set(cid, []);
      }
      tradesByCondition.get(cid)!.push(t);
    }

    const allConditionIds = Array.from(tradesByCondition.keys());
    console.log(`[v26-sync-fills] Looking for ${allConditionIds.length} unique conditionIds`);

    // Fetch trades from Data API
    let apiTrades: DataApiTrade[] = [];
    let dataApiFailed = false;

    try {
      // Fetch last 1000 trades (should cover past week for V26)
      apiTrades = await fetchTradesFromDataApi(walletAddress, { limit: 1000, side: 'BUY' });
      console.log(`[v26-sync-fills] Data API returned ${apiTrades.length} trades`);
    } catch (err) {
      console.error('[v26-sync-fills] Data API failed:', err);
      dataApiFailed = true;
    }

    const results: Array<{
      id: string;
      market_slug: string;
      success: boolean;
      source: 'data_api' | 'fill_logs' | null;
      error?: string;
    }> = [];

    // Process trades using Data API data
    if (!dataApiFailed && apiTrades.length > 0) {
      // Group API trades by conditionId + side
      const apiTradesByKey = new Map<string, DataApiTrade[]>();

      for (const at of apiTrades) {
        const cid = normalizeConditionId(at.conditionId);
        const side = mapOutcomeToSide(at.outcome, at.outcomeIndex);
        const key = `${cid}:${side}`;

        if (!apiTradesByKey.has(key)) {
          apiTradesByKey.set(key, []);
        }
        apiTradesByKey.get(key)!.push(at);
      }

      // Match and update each v26_trade
      for (const t of trades) {
        const cid = normalizeConditionId(t.market_id);
        const side = (t.side || '').toUpperCase();
        const key = `${cid}:${side}`;

        const matchingApiTrades = apiTradesByKey.get(key) || [];

        if (matchingApiTrades.length === 0) {
          // No matching trades found - check if we should use fill_logs fallback
          continue;
        }

        // Filter API trades to those within the event window
        const eventStartMs = new Date(t.event_start_time).getTime();
        const eventEndMs = new Date(t.event_end_time).getTime();

        const relevantTrades = matchingApiTrades.filter((at) => {
          const tradeMs = at.timestamp * 1000;
          // Allow trades from 10 min before market open to market end + 1 min
          return tradeMs >= eventStartMs - 600000 && tradeMs <= eventEndMs + 60000;
        });

        if (relevantTrades.length === 0) {
          continue;
        }

        // Aggregate fills
        let totalShares = 0;
        let totalValue = 0;
        let latestTs = 0;

        for (const at of relevantTrades) {
          totalShares += at.size;
          totalValue += at.size * at.price;
          if (at.timestamp > latestTs) latestTs = at.timestamp;
        }

        const filledShares = Math.round(totalShares);
        const avgPrice = totalShares > 0 ? totalValue / totalShares : null;
        const matchedAt = latestTs > 0 ? new Date(latestTs * 1000).toISOString() : null;

        // Only update if we found fills
        if (filledShares > 0) {
          const { error: updateError } = await supabase
            .from('v26_trades')
            .update({
              filled_shares: filledShares,
              avg_fill_price: avgPrice,
              fill_matched_at: matchedAt,
              status: 'filled',
            })
            .eq('id', t.id);

          if (updateError) {
            results.push({ id: t.id, market_slug: t.market_slug, success: false, source: 'data_api', error: updateError.message });
          } else {
            console.log(`[v26-sync-fills] ✓ ${t.market_slug} → ${filledShares} shares @ ${avgPrice?.toFixed(3) || '?'} via Data API`);
            results.push({ id: t.id, market_slug: t.market_slug, success: true, source: 'data_api' });
          }
        }
      }
    }

    // Fallback: use fill_logs for any remaining unsynced trades
    const syncedIds = new Set(results.filter((r) => r.success).map((r) => r.id));
    const remainingTrades = trades.filter((t) => !syncedIds.has(t.id));

    if (remainingTrades.length > 0) {
      console.log(`[v26-sync-fills] Using fill_logs fallback for ${remainingTrades.length} trades`);

      for (const t of remainingTrades) {
        const startTime = new Date(t.event_start_time).getTime();
        const endTime = new Date(t.event_end_time).getTime();

        // Look for fills in this market during the event window
        const { data: fills } = await supabase
          .from('fill_logs')
          .select('fill_qty, fill_price, ts, side')
          .eq('market_id', t.market_id)
          .eq('side', t.side)
          .gte('ts', startTime - 60000) // 1 min before
          .lte('ts', endTime + 60000); // 1 min after

        if (fills && fills.length > 0) {
          let totalSharesRaw = 0;
          let totalValue = 0;
          let latestTs = 0;

          for (const fill of fills) {
            const qty = Number(fill.fill_qty) || 0;
            const price = Number(fill.fill_price) || 0;
            const ts = Number(fill.ts) || 0;

            totalSharesRaw += qty;
            totalValue += qty * price;
            if (ts > latestTs) latestTs = ts;
          }

          const filledShares = Math.round(totalSharesRaw);
          const avgPrice = totalSharesRaw > 0 ? totalValue / totalSharesRaw : 0.48;
          const matchedAt = latestTs ? new Date(latestTs).toISOString() : new Date().toISOString();

          const { error: updateError } = await supabase
            .from('v26_trades')
            .update({
              status: 'filled',
              filled_shares: filledShares,
              avg_fill_price: avgPrice,
              fill_matched_at: matchedAt,
            })
            .eq('id', t.id);

          if (updateError) {
            results.push({ id: t.id, market_slug: t.market_slug, success: false, source: 'fill_logs', error: updateError.message });
          } else {
            console.log(`[v26-sync-fills] ✓ ${t.market_slug} → ${filledShares} shares @ ${avgPrice.toFixed(3)} via fill_logs`);
            results.push({ id: t.id, market_slug: t.market_slug, success: true, source: 'fill_logs' });
          }
        } else {
          // Check if market has ended - if so, mark as cancelled (no fills)
          const now = Date.now();
          const thirtyMinutesAfterEnd = endTime + 30 * 60 * 1000;

          if (now > thirtyMinutesAfterEnd && t.status === 'placed') {
            await supabase.from('v26_trades').update({ status: 'cancelled' }).eq('id', t.id);
            console.log(`[v26-sync-fills] ✗ ${t.market_slug} → marked cancelled (no fills found)`);
            results.push({ id: t.id, market_slug: t.market_slug, success: true, source: 'fill_logs' });
          }
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    console.log(`[v26-sync-fills] Done: ${successCount} synced, ${failCount} failed`);

    return new Response(
      JSON.stringify({
        success: true,
        synced: successCount,
        failed: failCount,
        total: trades.length,
        dataApiUsed: !dataApiFailed,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[v26-sync-fills] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
