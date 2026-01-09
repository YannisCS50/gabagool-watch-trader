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
 * Fetch ALL trades from Polymarket Data API using pagination
 */
async function fetchAllTradesFromDataApi(
  walletAddress: string,
  side: 'BUY' | 'SELL' = 'BUY'
): Promise<DataApiTrade[]> {
  const allTrades: DataApiTrade[] = [];
  const pageSize = 500;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const url = new URL(`${DATA_API_BASE}/trades`);
    url.searchParams.set('user', walletAddress.toLowerCase());
    url.searchParams.set('side', side);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));

    console.log(`[v26-sync-fills] Fetching trades offset=${offset}...`);

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
    const trades = Array.isArray(data) ? data : [];
    
    allTrades.push(...trades);
    console.log(`[v26-sync-fills] Got ${trades.length} trades (total: ${allTrades.length})`);

    if (trades.length < pageSize) {
      hasMore = false;
    } else {
      offset += pageSize;
      // Safety limit to prevent infinite loops
      if (offset > 10000) {
        console.log('[v26-sync-fills] Reached 10k trade limit, stopping pagination');
        hasMore = false;
      }
    }
  }

  return allTrades;
}

/**
 * Normalize a string key used for matching markets.
 */
function normalizeConditionId(value: string): string {
  return (value || '').toLowerCase().trim();
}

/**
 * Map outcome to UP/DOWN.
 * Data API fields vary by market; prefer outcome text, then fall back to outcomeIndex.
 */
function mapOutcomeToSide(outcome: string, outcomeIndex: number): 'UP' | 'DOWN' {
  const lower = (outcome || '').toLowerCase();

  // Prefer explicit text when available
  if (lower.includes('down')) return 'DOWN';
  if (lower.includes('up')) return 'UP';
  if (lower === 'no') return 'DOWN';
  if (lower === 'yes') return 'UP';

  // Fallback: common up/down outcomeIndex convention (but not guaranteed)
  if (outcomeIndex === 0) return 'UP';
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

    // Fetch ALL trades needing sync (no date limit - get everything since v26 started)
    const { data: trades, error: fetchError } = await supabase
      .from('v26_trades')
      .select('id, market_id, market_slug, side, shares, event_start_time, event_end_time, status, filled_shares, avg_fill_price, fill_matched_at')
      .or('fill_matched_at.is.null,status.in.(placed,open,partial,processing),filled_shares.eq.0')
      .order('event_start_time', { ascending: false })
      .limit(500);

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

    // Build lookup: market_slug -> array of v26_trades
    const tradesByCondition = new Map<string, V26Trade[]>();
    for (const t of trades) {
      const key = normalizeConditionId(t.market_slug);
      if (!tradesByCondition.has(key)) {
        tradesByCondition.set(key, []);
      }
      tradesByCondition.get(key)!.push(t);
    }

    const allConditionIds = Array.from(tradesByCondition.keys());
    console.log(`[v26-sync-fills] Looking for ${allConditionIds.length} unique market slugs`);

    // Fetch trades from Data API
    let apiTrades: DataApiTrade[] = [];
    let dataApiFailed = false;

    try {
      // Fetch ALL trades using pagination
      apiTrades = await fetchAllTradesFromDataApi(walletAddress, 'BUY');
      console.log(`[v26-sync-fills] Data API returned ${apiTrades.length} total trades`);
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
      // Group API trades by slug + side
      const apiTradesByKey = new Map<string, DataApiTrade[]>();

      // Log sample API slugs for debugging
      const sampleApiSlugs = apiTrades.slice(0, 10).map(at => at.slug);
      console.log(`[v26-sync-fills] Sample API slugs: ${JSON.stringify(sampleApiSlugs)}`);

      for (const at of apiTrades) {
        const slug = normalizeConditionId(at.slug);
        const side = mapOutcomeToSide(at.outcome, at.outcomeIndex);
        const key = `${slug}:${side}`;

        if (!apiTradesByKey.has(key)) {
          apiTradesByKey.set(key, []);
        }
        apiTradesByKey.get(key)!.push(at);
      }

      // Log sample v26 slugs for debugging
      const sampleV26Slugs = trades.slice(0, 10).map(t => t.market_slug);
      console.log(`[v26-sync-fills] Sample v26 slugs: ${JSON.stringify(sampleV26Slugs)}`);

      // Match and update each v26_trade
      for (const t of trades) {
        const slug = normalizeConditionId(t.market_slug);
        const side = (t.side || '').toUpperCase();
        const key = `${slug}:${side}`;

        const matchingApiTrades = apiTradesByKey.get(key) || [];

        if (matchingApiTrades.length === 0) {
          // Log first few misses for debugging
          if (results.length < 5) {
            console.log(`[v26-sync-fills] No match for key="${key}"`);
          }
          continue;
        }

        // Filter API trades to those that happened before market end.
        // Up/Down markets can be traded well before the event starts, so we do NOT enforce a strict lower bound.
        const eventEndMs = new Date(t.event_end_time).getTime();

        const relevantTrades = matchingApiTrades.filter((at) => {
          const tradeMs = at.timestamp * 1000;
          // Allow trades up to 1h after market end (clock skew / indexing delay)
          return tradeMs <= eventEndMs + 60 * 60 * 1000;
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
