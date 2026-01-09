import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * v26-sync-fills: Robust fill synchronization via Polymarket Data API
 *
 * Uses the public data-api.polymarket.com endpoint (no auth required) to:
 * 1. Fetch recent trades for each market slug
 * 2. Filter by wallet address (using proxyWallet or name field)
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
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  name?: string;
}

interface V26Trade {
  id: string;
  market_id: string;
  market_slug: string;
  side: string;
  shares: number;
  event_start_time: string;
  event_end_time: string;
  status: string;
  filled_shares: number;
  avg_fill_price: number | null;
  fill_matched_at: string | null;
}

/**
 * Fetch trades for a specific market slug from Polymarket Data API
 */
async function fetchTradesForSlug(slug: string): Promise<DataApiTrade[]> {
  const url = new URL(`${DATA_API_BASE}/trades`);
  url.searchParams.set('slug', slug);
  url.searchParams.set('side', 'BUY');
  url.searchParams.set('limit', '500');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    console.error(`[v26-sync-fills] Data API error for ${slug}: ${response.status}`);
    return [];
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Normalize a string key used for matching markets.
 */
function normalizeConditionId(value: string): string {
  return (value || '').toLowerCase().trim();
}

/**
 * Map outcome to UP/DOWN.
 */
function mapOutcomeToSide(outcome: string, outcomeIndex: number): 'UP' | 'DOWN' {
  const lower = (outcome || '').toLowerCase();

  if (lower.includes('down')) return 'DOWN';
  if (lower.includes('up')) return 'UP';
  if (lower === 'no') return 'DOWN';
  if (lower === 'yes') return 'UP';

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

    // Fetch ALL trades needing sync
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

    const results: Array<{
      id: string;
      market_slug: string;
      success: boolean;
      source: 'data_api' | 'fill_logs' | null;
      error?: string;
    }> = [];

    // Get unique slugs from our trades
    const uniqueSlugs = [...new Set(trades.map(t => t.market_slug))];
    console.log(`[v26-sync-fills] Fetching Data API trades for ${uniqueSlugs.length} unique slugs...`);

    // Fetch trades for each slug and filter by wallet
    const allApiTrades: DataApiTrade[] = [];
    const walletLower = walletAddress.toLowerCase();
    const walletPrefix = walletLower.slice(2, 12); // First 10 chars after 0x
    
    for (let i = 0; i < uniqueSlugs.length; i++) {
      const slug = uniqueSlugs[i];
      try {
        const slugTrades = await fetchTradesForSlug(slug);
        
        // Filter to only trades from our wallet
        const ourTrades = slugTrades.filter(t => {
          const proxyLower = (t.proxyWallet || '').toLowerCase();
          const nameLower = (t.name || '').toLowerCase();
          
          // Check if proxyWallet or name contains our wallet prefix
          return proxyLower.includes(walletPrefix) || 
                 nameLower.includes(walletPrefix) ||
                 nameLower.startsWith(walletLower);
        });
        
        allApiTrades.push(...ourTrades);
        
        if (ourTrades.length > 0) {
          console.log(`[v26-sync-fills] Found ${ourTrades.length} trades for ${slug}`);
        }
      } catch (err) {
        console.error(`[v26-sync-fills] Error fetching slug ${slug}:`, err);
      }
      
      // Small delay to avoid rate limiting
      if (i > 0 && i % 10 === 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log(`[v26-sync-fills] Total trades from Data API: ${allApiTrades.length}`);

    // Group API trades by slug + side
    const apiTradesByKey = new Map<string, DataApiTrade[]>();
    for (const at of allApiTrades) {
      const slug = normalizeConditionId(at.slug);
      const side = mapOutcomeToSide(at.outcome, at.outcomeIndex);
      const key = `${slug}:${side}`;
      if (!apiTradesByKey.has(key)) {
        apiTradesByKey.set(key, []);
      }
      apiTradesByKey.get(key)!.push(at);
    }

    // Match and update each v26_trade
    for (const t of trades) {
      const slug = normalizeConditionId(t.market_slug);
      const side = (t.side || '').toUpperCase();
      const key = `${slug}:${side}`;

      const matchingApiTrades = apiTradesByKey.get(key) || [];

      if (matchingApiTrades.length === 0) {
        continue;
      }

      // Filter API trades to those that happened before market end
      const eventEndMs = new Date(t.event_end_time).getTime();
      const relevantTrades = matchingApiTrades.filter((at) => {
        const tradeMs = at.timestamp * 1000;
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

    // Fallback: use fill_logs for any remaining unsynced trades
    const syncedIds = new Set(results.filter((r) => r.success).map((r) => r.id));
    const remainingTrades = trades.filter((t) => !syncedIds.has(t.id));

    if (remainingTrades.length > 0) {
      console.log(`[v26-sync-fills] Using fill_logs fallback for ${remainingTrades.length} trades`);

      for (const t of remainingTrades) {
        const endTime = new Date(t.event_end_time).getTime();

        // Look for fills for this market.
        // NOTE: v26 opening fills often happen BEFORE event_start_time, so we do not time-bound this query.
        const { data: fills } = await supabase
          .from('fill_logs')
          .select('fill_qty, fill_price, ts, side')
          .eq('market_id', t.market_id)
          .eq('side', t.side)
          .order('ts', { ascending: false })
          .limit(200);

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

          const avgPrice = totalSharesRaw > 0 ? totalValue / totalSharesRaw : 0.48;
          const matchedAt = latestTs ? new Date(latestTs).toISOString() : new Date().toISOString();

          const targetShares = Number(t.shares) || 0;
          const newStatus = totalSharesRaw >= targetShares - 1e-6 ? 'filled' : 'partial';

          const { error: updateError } = await supabase
            .from('v26_trades')
            .update({
              status: newStatus,
              filled_shares: totalSharesRaw,
              avg_fill_price: avgPrice,
              fill_matched_at: matchedAt,
            })
            .eq('id', t.id);

          if (updateError) {
            results.push({ id: t.id, market_slug: t.market_slug, success: false, source: 'fill_logs', error: updateError.message });
          } else {
            console.log(`[v26-sync-fills] ✓ ${t.market_slug} → ${totalSharesRaw.toFixed(4)} shares @ ${avgPrice.toFixed(3)} via fill_logs`);
            results.push({ id: t.id, market_slug: t.market_slug, success: true, source: 'fill_logs' });
          }
        } else {
          // Check if market has ended - if so, mark as cancelled
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