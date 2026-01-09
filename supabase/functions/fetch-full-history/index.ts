// ============================================================
// Fetch Full History - Get ALL trades from Polymarket Data API
// This function fetches complete trade history and computes accurate P&L
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DATA_API_BASE = 'https://data-api.polymarket.com';

interface PolymarketActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string;
  feesPaid?: number;
}

interface PnLSummary {
  totalBuys: number;
  totalSells: number;
  totalRedeems: number;
  netPnL: number;
  totalTrades: number;
  firstTradeDate: string | null;
  lastTradeDate: string | null;
  marketCount: number;
}

/**
 * Fetch ALL activity from Polymarket - no limits
 */
async function fetchAllActivity(wallet: string): Promise<PolymarketActivity[]> {
  const allActivity: PolymarketActivity[] = [];
  let offset = 0;
  const pageSize = 500;
  const maxPages = 200; // Allow up to 100,000 records
  let pagesLoaded = 0;

  console.log(`[fetch-full-history] Fetching ALL activity for ${wallet}...`);

  while (pagesLoaded < maxPages) {
    const url = `${DATA_API_BASE}/activity?user=${wallet}&limit=${pageSize}&offset=${offset}`;
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[fetch-full-history] API error: ${response.status}`);
        break;
      }

      const data = await response.json() as PolymarketActivity[];
      if (!data || data.length === 0) {
        console.log(`[fetch-full-history] No more data at offset ${offset}`);
        break;
      }
      
      allActivity.push(...data);
      pagesLoaded++;
      offset += pageSize;
      
      console.log(`[fetch-full-history] Page ${pagesLoaded}: ${data.length} records (total: ${allActivity.length})`);
      
      if (data.length < pageSize) {
        console.log(`[fetch-full-history] End of data reached`);
        break;
      }
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 50));
    } catch (error) {
      console.error(`[fetch-full-history] Error at offset ${offset}:`, error);
      break;
    }
  }

  return allActivity;
}

/**
 * Compute P&L from activity
 */
function computePnL(activities: PolymarketActivity[]): PnLSummary {
  let totalBuys = 0;
  let totalSells = 0;
  let totalRedeems = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const markets = new Set<string>();

  for (const a of activities) {
    const usdAmount = Number(a.usdcSize) || (Number(a.price) * Number(a.size)) || 0;
    const fee = Number(a.feesPaid) || 0;
    
    if (a.conditionId) markets.add(a.conditionId);
    
    if (!firstTs || a.timestamp < firstTs) firstTs = a.timestamp;
    if (!lastTs || a.timestamp > lastTs) lastTs = a.timestamp;

    const typeUpper = (a.type || '').toUpperCase();
    const sideUpper = (a.side || '').toUpperCase();

    if (typeUpper === 'TRADE') {
      if (sideUpper === 'BUY') {
        totalBuys += usdAmount + fee;
      } else if (sideUpper === 'SELL') {
        totalSells += usdAmount - fee;
      }
    } else if (typeUpper === 'REDEEM' || typeUpper === 'REDEMPTION' || typeUpper === 'CLAIM') {
      // For redeems: if usdcSize is 0, infer from shares (binary payout = shares * 1.0)
      if (usdAmount > 0) {
        totalRedeems += usdAmount;
      } else if (a.size > 0) {
        totalRedeems += a.size; // Inferred payout
      }
    } else if (typeUpper === 'MERGE') {
      totalRedeems += usdAmount;
    }
  }

  const netPnL = totalSells + totalRedeems - totalBuys;

  return {
    totalBuys,
    totalSells,
    totalRedeems,
    netPnL,
    totalTrades: activities.length,
    firstTradeDate: firstTs ? new Date(firstTs * 1000).toISOString() : null,
    lastTradeDate: lastTs ? new Date(lastTs * 1000).toISOString() : null,
    marketCount: markets.size,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Get wallet from bot_config
    const { data: config, error: configError } = await supabase
      .from('bot_config')
      .select('polymarket_address')
      .limit(1)
      .single();

    if (configError || !config?.polymarket_address) {
      return new Response(JSON.stringify({ error: 'No wallet configured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const wallet = config.polymarket_address;
    console.log(`[fetch-full-history] Using wallet: ${wallet}`);

    // Fetch ALL activity
    const activities = await fetchAllActivity(wallet);
    console.log(`[fetch-full-history] Fetched ${activities.length} total activities`);

    // Compute P&L
    const pnl = computePnL(activities);
    console.log(`[fetch-full-history] P&L Summary:`, JSON.stringify(pnl));

    // Activity breakdown
    const breakdown: Record<string, number> = {};
    for (const a of activities) {
      const key = `${a.type}:${a.side || 'N/A'}`;
      breakdown[key] = (breakdown[key] || 0) + 1;
    }

    return new Response(JSON.stringify({
      wallet,
      pnl,
      breakdown,
      message: `Fetched ${activities.length} activities from Data API`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[fetch-full-history] Error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
